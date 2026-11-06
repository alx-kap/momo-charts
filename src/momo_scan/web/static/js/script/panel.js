// The script editor's dock under the chart (docs/scripting.md, "The editor"): open, edit and save
// stored scripts. 150 ms after typing stops the text is checked, and if it compiles charts show it
// as a draft; every 2 s the draft is saved on the server, so it follows the account. Save makes it
// the version charts use. Every name, note, log line and error is set with textContent.

import { activePane, chartPane } from "../chart.js";
import { addStored, refreshStoredScripts } from "../chartsettings.js";
import { confirmDialog, promptDialog } from "../dialog.js";
import { fetchBars } from "../feed.js";
import { forgetScript, listScripts, previewDraft, runSource } from "../scripts.js";
import { actions } from "../state.js";
import { $, api, store, toast } from "../util.js";
import { activeListName, activeSymbols } from "../watchlists.js";
import { lineDiff } from "./assist.js";
import { compile } from "./compile.js";
import { createEditor } from "./editor.js";

const PREVIEW_MS = 150;
const DRAFT_MS = 2000;
const MIN_HEIGHT = 180;
const TEST_SYMBOLS = 50;
const TEST_BARS = 520;
const TEST_AT_ONCE = 4;
const NEW_SCRIPT = (name) => `#momo 1\nindicator(${JSON.stringify(name)}, overlay=true)\n\nlength = input.int(20, "Length", min=1)\nplot(ta.sma(close, length), "Average")\n`;

let editor = null;
let script = null;        // the open script: { id, name, head, source } (source: the head's text)
let serverDraft = null;   // the draft text the server holds
let previewing = false;   // charts show this script's draft
let previewTimer = 0;
let draftTimer = 0;
let bottomTab = "problems";
let selected = null;      // the version picked in History
let testToken = 0;
let closing = Promise.resolve();

const scriptUrl = (path = "") => `/api/scripts/${script.id}${path}`;
const send = (url, method, body) => api(url, { method, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
const dirty = () => Boolean(script) && editor.value !== script.source;
const shout = (error) => toast(error.message, 3000);
const panes = () => [chartPane("left"), chartPane("right")].filter(Boolean);
const redraw = () => { for (const pane of panes()) if (pane.scriptOnChart(script.id)) pane.scriptsChanged(); };
const row = (tag, className, text = "") => {
  const el = document.createElement(tag);
  el.className = className;
  el.textContent = text;
  return el;
};

function setStatus() {
  $("sd-name").textContent = script ? script.name : "No script open";
  $("sd-status").textContent = !script ? "" : dirty() ? `v${script.head} · Draft` : `v${script.head}`;
  for (const id of ["sd-save", "sd-history", "sd-add", "sd-test", "sd-more"]) $(id).disabled = !script;
  $("sd-save").disabled = !dirty();
  $("sd-add").disabled = !script || panes().some((pane) => pane.scriptOnChart(script.id));
}

// ---- problems and console ----------------------------------------------------------------------

function showProblems(errors) {
  editor.setProblems(errors);
  $("sd-tab-problems").textContent = errors.length ? `Problems (${errors.length})` : "Problems";
  $("sd-problems").replaceChildren(...errors.map((error) => {
    const line = row("button", "sd-problem");
    line.append(row("span", "sd-at", `${error.line}:${error.col}`), row("b", "", error.code), row("span", "", error.message));
    if (error.fix) line.append(row("span", "sd-fix", error.fix));
    line.addEventListener("click", () => editor.reveal(error.line, error.col));
    return line;
  }));
  $("sd-problems").classList.toggle("empty", !errors.length);
}

const barDate = (bars, i) => {
  const time = bars[i]?.time;
  if (time === undefined) return "";
  return typeof time === "string" ? time : new Date(time * 1000).toISOString().slice(0, 16).replace("T", " ");
};

// The text run over the active chart's bars: what it logged, or where it stopped.
async function runHere(text) {
  const pane = activePane();
  const bars = pane?.barsShown() || [];
  if (!bars.length) return;
  const result = await runSource(text, bars, pane.scriptChartInfo());
  if (!script || editor.value !== text || result.errors) return;
  const console = $("sd-console");
  if (!result.ok) {
    const { code, message, i } = result.error;
    console.replaceChildren(row("div", "sd-log bad", `${code} ${message}${i >= 0 ? ` (bar ${barDate(bars, i)})` : ""}`));
    return;
  }
  console.replaceChildren(...result.logs.map(({ i, text: said }) => {
    const line = row("div", "sd-log");
    line.append(row("span", "sd-at", barDate(bars, i)), row("span", "", said));
    return line;
  }));
  $("sd-tab-console").textContent = result.logs.length ? `Console (${result.logs.length})` : "Console";
}

// ---- typing: check, preview, draft ---------------------------------------------------------------

function checkNow() {
  const text = editor.value;
  const built = compile(text);
  showProblems(built.ok ? [] : built.errors);
  if (!built.ok) return; // the chart keeps the last text that compiled
  if (dirty()) {
    previewing = true;
    previewDraft(script.id, text);
    redraw();
  } else if (previewing) {
    stopPreview();
  }
  runHere(text);
}

function stopPreview() {
  if (!previewing || !script) return;
  previewing = false;
  previewDraft(script.id, null);
  redraw();
}

async function saveDraft() {
  clearTimeout(draftTimer);
  draftTimer = 0;
  if (!script) return;
  const text = editor.value;
  const draft = text === script.source ? null : text;
  if (draft === serverDraft) return;
  await send(scriptUrl("/draft"), "PUT", { source: text });
  serverDraft = draft;
}

function onInput() {
  if (!script) return;
  setStatus();
  clearTimeout(previewTimer);
  previewTimer = setTimeout(checkNow, PREVIEW_MS);
  clearTimeout(draftTimer);
  draftTimer = setTimeout(() => saveDraft().catch(shout), DRAFT_MS);
}

// A page closing takes its timers with it: send what's waiting (keepalive carries up to 64 KB).
function flushDraft() {
  if (!draftTimer || !script) return;
  fetch(scriptUrl("/draft"), {
    method: "PUT", keepalive: true, headers: { "Content-Type": "application/json", "X-Momo": "1" }, body: JSON.stringify({ source: editor.value }),
  }).catch(() => {});
}

// ---- open, save, and the rest of the toolbar ------------------------------------------------------

function show(saved) {
  script = { id: saved.id, name: saved.name, head: saved.head, source: saved.source };
  serverDraft = saved.draft;
  editor.value = saved.draft ?? saved.source;
  store.set("scriptOpen", saved.id);
  closeHistory();
  setStatus();
  showConsoleText();
  checkNow();
}

const showConsoleText = () => {
  $("sd-console").replaceChildren();
  $("sd-test-out").replaceChildren();
  $("sd-tab-console").textContent = "Console";
};

async function leave() {
  if (!script) return;
  await saveDraft().catch(shout);
  closeHistory();
  stopPreview();
}

async function openScript(id) {
  showDock(true);
  if (script?.id === id) { editor.focus(); return; }
  await leave();
  try {
    show(await api(`/api/scripts/${id}`));
    editor.focus();
  } catch (error) {
    shout(error);
  }
}

function clearEditor() {
  script = null;
  serverDraft = null;
  editor.value = "";
  store.set("scriptOpen", null);
  showProblems([]);
  showConsoleText();
  setStatus();
}

async function newScript(source = null) {
  const name = await promptDialog({ title: source ? "Duplicate as" : "New script", placeholder: "Name", ok: "Create" });
  if (!name?.trim()) return;
  try {
    const made = await send("/api/scripts", "POST", { name, source: source ?? NEW_SCRIPT(name.trim()) });
    await leave();
    showDock(true);
    show(made);
    editor.focus();
    refreshStoredScripts();
  } catch (error) {
    shout(error);
  }
}

async function save(note = "") {
  if (!dirty()) return;
  clearTimeout(previewTimer);
  clearTimeout(draftTimer);
  draftTimer = 0;
  const text = editor.value;
  try {
    const saved = await send(scriptUrl("/versions"), "POST", { source: text, note });
    script.head = saved.head;
    script.source = saved.source;
    serverDraft = editor.value === saved.source ? null : serverDraft;
    previewing = false;
    previewDraft(script.id, null);
    forgetScript(script.id);
    redraw();
    setStatus();
    refreshStoredScripts();
    showProblems(saved.errors);
    if (saved.errors.length) toast(`Saved v${saved.head} with ${saved.errors.length} error${saved.errors.length > 1 ? "s" : ""}`, 3000);
    else toast(`Saved v${saved.head}`);
    if (!$("sd-side").hidden) openHistory();
    if (editor.value !== text) onInput(); // typed while the save was on its way
  } catch (error) {
    shout(error);
  }
}

async function addToChart() {
  await addStored(script.id);
  setStatus();
}

async function deleteScript() {
  if (!await confirmDialog({ title: `Delete “${script.name}”?`, message: "It stays in the trash for 30 days.", ok: "Delete", danger: true })) return;
  try {
    await send(scriptUrl(), "DELETE");
    clearTimeout(draftTimer);
    clearTimeout(previewTimer);
    draftTimer = 0;
    closeHistory();
    stopPreview();
    clearEditor();
    refreshStoredScripts();
  } catch (error) {
    shout(error);
  }
}

async function rename() {
  const name = await promptDialog({ title: "Rename script", value: script.name, ok: "Rename" });
  if (!name?.trim() || name.trim() === script.name) return;
  try {
    script.name = (await send(scriptUrl(), "PATCH", { name })).name;
    setStatus();
    refreshStoredScripts();
  } catch (error) {
    shout(error);
  }
}

async function saveWithNote() {
  const note = await promptDialog({ title: `Save v${script.head + 1}`, placeholder: "What changed", ok: "Save" });
  if (note !== null) await save(note);
}

// ---- the two menus --------------------------------------------------------------------------------

function closeMenu() {
  $("sd-menu").hidden = true;
}

function openMenu(anchor, items) {
  const menu = $("sd-menu");
  if (!menu.hidden && menu.dataset.for === anchor.id) { closeMenu(); return; }
  menu.dataset.for = anchor.id;
  menu.replaceChildren(...items.map(({ label, run, heading, note }) => {
    if (heading) return row("div", "sd-menu-h", heading);
    const item = row("button", "", label);
    if (note) item.append(row("em", "", note));
    item.addEventListener("click", () => { closeMenu(); run(); });
    return item;
  }));
  menu.hidden = false;
  const box = anchor.getBoundingClientRect();
  const dock = $("script-dock").getBoundingClientRect();
  menu.style.left = `${Math.min(box.left - dock.left, dock.width - menu.offsetWidth - 8)}px`;
  menu.style.top = `${box.bottom - dock.top + 4}px`;
}

async function scriptsMenu() {
  const anchor = $("sd-open");
  let scripts = [];
  try {
    scripts = await listScripts();
  } catch (error) {
    shout(error);
  }
  const live = scripts.filter((item) => !item.in_trash);
  const trash = scripts.filter((item) => item.in_trash);
  openMenu(anchor, [
    { label: "New script", run: () => newScript() },
    ...live.map((item) => ({ label: item.name, note: `v${item.head}${item.has_draft ? " · draft" : ""}`, run: () => openScript(item.id) })),
    ...(trash.length ? [{ heading: "Trash" }] : []),
    ...trash.map((item) => ({ label: item.name, note: "restore", run: () => undelete(item.id) })),
  ]);
}

async function undelete(id) {
  try {
    await send(`/api/scripts/${id}/undelete`, "POST");
    refreshStoredScripts();
    await openScript(id);
  } catch (error) {
    shout(error);
  }
}

const moreMenu = () => openMenu($("sd-more"), [
  { label: "Save with a note…", run: saveWithNote },
  { label: "Rename…", run: rename },
  { label: "Duplicate…", run: () => newScript(editor.value) },
  { label: "Delete…", run: deleteScript },
]);

// ---- history ---------------------------------------------------------------------------------------

function closeHistory() {
  if (!$("sd-side").hidden && script) for (const pane of panes()) pane.setGhost(script.id, null);
  $("sd-side").hidden = true;
  selected = null;
}

async function openHistory() {
  try {
    const { versions } = await api(scriptUrl("/versions"));
    for (const pane of panes()) pane.setGhost(script.id, null);
    $("sd-side").hidden = false;
    $("sd-diff").replaceChildren();
    $("sd-versions").replaceChildren(...versions.map((version) => {
      const item = row("button", "sd-version");
      item.dataset.version = version.version;
      item.append(row("b", "", `v${version.version}`), row("span", "sd-at", new Date(version.created_at).toLocaleString([], { dateStyle: "short", timeStyle: "short" })));
      if (version.note) item.append(row("span", "sd-note", version.note));
      item.addEventListener("click", () => pickVersion(version.version));
      return item;
    }));
  } catch (error) {
    shout(error);
  }
}

// Picking a version: a line diff against the text in the editor, and that version dashed on the chart.
async function pickVersion(version) {
  selected = version;
  for (const item of $("sd-versions").children) item.classList.toggle("on", Number(item.dataset.version) === version);
  try {
    const old = await api(scriptUrl(`/versions/${version}`));
    if (selected !== version) return;
    const lines = lineDiff(old.source, editor.value).filter((line) => line.kind !== "same");
    const diff = $("sd-diff");
    const restore = row("button", "sd-restore", `Restore v${version}`);
    restore.addEventListener("click", () => restoreVersion(version));
    diff.replaceChildren(restore, ...(lines.length
      ? lines.map(({ kind, text }) => row("div", `sd-line ${kind}`, `${kind === "add" ? "+" : "-"} ${text}`))
      : [row("div", "sd-same", "The same as the editor.")]));
    let shown = false;
    for (const pane of panes()) if (pane.setGhost(script.id, version)) shown = true;
    if (!shown) diff.append(row("div", "sd-same", "Add the script to the chart to see this version on it."));
  } catch (error) {
    shout(error);
  }
}

async function restoreVersion(version) {
  if (dirty() && !await confirmDialog({
    title: `Restore v${version}?`, message: "Your unsaved changes are replaced. Every saved version stays in History.", ok: "Restore", danger: true,
  })) return;
  clearTimeout(draftTimer);
  clearTimeout(previewTimer);
  draftTimer = 0;
  try {
    const saved = await send(scriptUrl("/restore"), "POST", { version });
    previewing = false;
    previewDraft(script.id, null);
    forgetScript(script.id);
    closeHistory();
    show(saved);
    redraw();
    refreshStoredScripts();
    toast(saved.saved ? `Restored v${version} as v${saved.head}` : `v${saved.head} is already this text`);
  } catch (error) {
    shout(error);
  }
}

// ---- test on a watchlist ------------------------------------------------------------------------

async function testOnList() {
  const token = ++testToken;
  const text = editor.value;
  const pane = activePane();
  const interval = pane?.interval() || "1D";
  const listed = activeSymbols().slice(0, TEST_SYMBOLS);
  const symbols = listed.length ? listed : [pane?.shown().symbol].filter(Boolean); // an empty list: this chart
  const out = $("sd-test-out");
  pickTab("test");
  out.replaceChildren(row("div", "sd-same", `Running on ${symbols.length} of ${listed.length ? activeListName() : "this chart"}, ${interval}…`));
  const rows = [];
  const queue = [...symbols];
  const worker = async () => {
    while (queue.length && token === testToken) {
      const symbol = queue.shift();
      try {
        const { bars } = await fetchBars(symbol, null, interval, TEST_BARS, false);
        const result = await runSource(text, bars, { interval, ticker: symbol.split(":").pop() });
        rows.push({ symbol, ...result });
      } catch (error) {
        rows.push({ symbol, ok: false, error: { code: "L001", message: error.message } });
      }
    }
  };
  await Promise.all(Array.from({ length: TEST_AT_ONCE }, worker));
  if (token !== testToken) return;
  const failed = rows.filter((item) => !item.ok);
  const empty = rows.filter((item) => item.ok && item.empty);
  const slowest = rows.reduce((best, item) => (item.ok && item.ms > (best?.ms ?? -1) ? item : best), null);
  const summary = `${rows.length} symbol${rows.length === 1 ? "" : "s"} · ${failed.length} failed · ${empty.length} with nothing to show` +
    (slowest ? ` · slowest ${slowest.symbol.split(":").pop()} ${slowest.ms.toFixed(1)} ms` : "");
  const describe = (item) => (item.errors ? `${item.errors[0].code} ${item.errors[0].message}` : `${item.error.code} ${item.error.message}`);
  out.replaceChildren(row("div", "sd-summary", summary),
    ...failed.map((item) => row("div", "sd-log bad", `${item.symbol.split(":").pop()}: ${describe(item)}`)),
    ...empty.map((item) => row("div", "sd-log", `${item.symbol.split(":").pop()}: every value is na`)));
}

// ---- the dock ---------------------------------------------------------------------------------------

function pickTab(name) {
  bottomTab = name;
  for (const [tab, box] of [["problems", "sd-problems"], ["console", "sd-console"], ["test", "sd-test-out"]]) {
    $(`sd-tab-${tab}`).classList.toggle("on", tab === bottomTab);
    $(box).hidden = tab !== bottomTab;
  }
}

export function showDock(on) {
  const dock = $("script-dock");
  if (dock.hidden === !on) return;
  dock.hidden = !on;
  store.set("scriptDock", on);
  $("script-button").classList.toggle("active", on);
  if (on) {
    setStatus();
    editor.focus();
  } else {
    closeMenu();
    clearTimeout(previewTimer);
    closing = closeScript();
  }
}

// Closing the dock: the draft is saved, charts go back to the head, the text leaves the page.
async function closeScript() {
  await leave();
  script = null;
  serverDraft = null;
  editor.value = "";
  showProblems([]);
  showConsoleText();
  setStatus();
}

function bindResize() {
  const dock = $("script-dock");
  const limit = (height) => Math.max(MIN_HEIGHT, Math.min(height, window.innerHeight * 0.75));
  dock.style.height = `${limit(store.get("scriptDockHeight", 320))}px`;
  $("sd-resize").addEventListener("pointerdown", (event) => {
    const handle = event.currentTarget;
    const startY = event.clientY;
    const start = dock.offsetHeight;
    handle.setPointerCapture(event.pointerId);
    const move = (e) => { dock.style.height = `${limit(start + startY - e.clientY)}px`; };
    const up = () => {
      handle.removeEventListener("pointermove", move);
      handle.removeEventListener("pointerup", up);
      store.set("scriptDockHeight", dock.offsetHeight);
    };
    handle.addEventListener("pointermove", move);
    handle.addEventListener("pointerup", up);
  });
}

export function bindScriptEditor() {
  editor = createEditor($("sd-editor"), { onInput, onSave: () => save() });
  bindResize();
  actions.openScript = openScript;
  actions.newScript = () => newScript();
  $("script-button").addEventListener("click", async () => {
    const dock = $("script-dock");
    showDock(dock.hidden);
    await closing;
    if (dock.hidden || script) return;
    const last = store.get("scriptOpen", null);
    if (last) { await openScript(last); return; }
    setStatus();
  });
  $("sd-open").addEventListener("click", scriptsMenu);
  $("sd-save").addEventListener("click", () => save());
  $("sd-history").addEventListener("click", () => ($("sd-side").hidden ? openHistory() : closeHistory()));
  $("sd-history-close").addEventListener("click", closeHistory);
  $("sd-add").addEventListener("click", addToChart);
  $("sd-test").addEventListener("click", testOnList);
  $("sd-more").addEventListener("click", moreMenu);
  $("sd-close").addEventListener("click", () => showDock(false));
  for (const tab of ["problems", "console", "test"]) $(`sd-tab-${tab}`).addEventListener("click", () => pickTab(tab));
  document.addEventListener("pointerdown", (event) => {
    if (!event.target.closest("#sd-menu, #sd-open, #sd-more")) closeMenu();
  });
  window.addEventListener("pagehide", flushDraft);
  pickTab(bottomTab);
  setStatus();
  if (store.get("scriptDock", false)) {
    const last = store.get("scriptOpen", null);
    if (last) openScript(last);
    else showDock(true);
  }
}
