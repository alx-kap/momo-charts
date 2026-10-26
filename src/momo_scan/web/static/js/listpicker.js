import { escapeHtml } from "./util.js";

// The watchlist switcher: a centered panel with a search box, recent lists and all lists.
//   pickWatchlist({ state: () => ({ lists: [{ id, name, count, flagged? }], active }), recent: [id], rename, duplicate, remove })
// resolves to { id } (open that list), { action } (new / import), or null if dismissed. Hover a
// row to rename it in place (double-click the name too), make a copy or delete it. Type to filter; ↑ ↓ Enter and Esc work; Shift+W opens it.
let open = null;

const SEARCH_ICON = `<svg viewBox="0 0 16 16" width="15" height="15" aria-hidden="true"><circle cx="7" cy="7" r="4.6" fill="none" stroke="currentColor" stroke-width="1.4"/><path d="M10.5 10.5 14 14" stroke="currentColor" stroke-width="1.4" stroke-linecap="round"/></svg>`;
const FLAG = `<svg class="flag" viewBox="0 0 10 12" width="9" height="11" aria-hidden="true"><path d="M1 0.5v11" stroke="currentColor" stroke-width="1.3"/><path d="M1.6 1h7.4l-2 2.6 2 2.6H1.6z" fill="currentColor"/></svg>`;
const PENCIL = `<svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true"><path d="M2.5 13.5l.6-3L11 2.6a1.4 1.4 0 0 1 2 0l.4.4a1.4 1.4 0 0 1 0 2L5.5 12.9z" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linejoin="round"/></svg>`;
const COPY = `<svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true"><rect x="5.5" y="5.5" width="8" height="8" rx="1.6" fill="none" stroke="currentColor" stroke-width="1.3"/><path d="M10.5 5.5V4a1.6 1.6 0 0 0-1.6-1.6H4A1.6 1.6 0 0 0 2.4 4v4.9A1.6 1.6 0 0 0 4 10.5h1.5" fill="none" stroke="currentColor" stroke-width="1.3"/></svg>`;
const TRASH = `<svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true"><path d="M3 4.5h10M6.5 4.5V3h3v1.5M4.5 4.5l.6 8.2c0 .5.4.8.9.8h4c.5 0 .9-.3.9-.8l.6-8.2" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round"/></svg>`;
const RECENT_MAX = 5;

export function pickWatchlist({ state, recent = [], rename, duplicate, remove }) {
  open?.finish(null);
  return new Promise((resolve) => {
    const back = document.createElement("div");
    back.className = "wlp-back";
    back.innerHTML = `<div class="wlp" role="dialog" aria-modal="true" aria-label="Watchlists">` +
      `<label class="wlp-search">${SEARCH_ICON}<input type="text" placeholder="Search lists…" spellcheck="false" autocomplete="off"><kbd>esc</kbd></label>` +
      `<div class="wlp-list"></div>` +
      `<div class="wlp-foot"><button type="button" data-action="new">New list…</button><button type="button" data-action="import">Import from TradingView…</button>` +
      `<span class="wlp-keys"><kbd>↑</kbd><kbd>↓</kbd> move <kbd>↵</kbd> open</span></div></div>`;
    const input = back.querySelector("input");
    const listEl = back.querySelector(".wlp-list");
    let query = "";
    let cursor = 0;
    let editing = null; // id of the list being renamed in place

    // Recent only earns its place once the full list is long enough to need a shortcut.
    const sections = () => {
      const { lists, active } = state();
      if (query) {
        const words = query.split(/\s+/);
        const found = lists.filter((list) => words.every((word) => list.name.toLowerCase().includes(word)));
        return found.length ? [{ items: found }] : [];
      }
      if (lists.length <= RECENT_MAX + 1) return [{ items: lists }];
      const byId = new Map(lists.map((list) => [list.id, list]));
      const recents = [...new Set([active, ...recent])].filter((id) => byId.has(id)).slice(0, RECENT_MAX);
      return [{ label: "Recent", items: recents.map((id) => byId.get(id)) }, { label: "All lists", items: lists }];
    };
    const flat = () => sections().flatMap((section) => section.items);

    const render = () => {
      const shown = sections();
      const all = shown.flatMap((section) => section.items);
      const { active } = state();
      cursor = Math.max(0, Math.min(cursor, all.length - 1));
      let index = -1;
      listEl.innerHTML = all.length ? shown.map((section) =>
        (section.label ? `<div class="wlp-group">${section.label}</div>` : "") + section.items.map((list) => {
          index += 1;
          const name = editing === list.id
            ? `<input class="wlp-edit" value="${escapeHtml(list.name)}" spellcheck="false" autocomplete="off">`
            : `<span class="wlp-name">${escapeHtml(list.name)}</span>`;
          return `<div class="wlp-row${list.id === active ? " on" : ""}${index === cursor ? " cur" : ""}${editing === list.id ? " editing" : ""}" data-id="${escapeHtml(list.id)}" data-i="${index}">` +
            `${list.flagged ? FLAG : ""}${name}<span class="wlp-count">${list.count}</span>` +
            `<span class="wlp-tools">${list.flagged ? "" : `<button type="button" data-tool="rename" title="Rename">${PENCIL}</button>` +
              `<button type="button" data-tool="duplicate" title="Make a copy">${COPY}</button>` +
              `<button type="button" data-tool="delete" class="danger" title="Delete">${TRASH}</button>`}</span></div>`;
        }).join("")).join("")
        : `<div class="wlp-empty">No list matches “${escapeHtml(query)}”</div>`;
      const edit = listEl.querySelector(".wlp-edit");
      if (edit) { edit.focus(); edit.select(); }
      else listEl.querySelector(".cur")?.scrollIntoView({ block: "nearest" });
    };

    const opener = document.activeElement;
    const finish = (result) => {
      if (open?.back !== back) return;
      open = null;
      document.removeEventListener("keydown", onKey, true);
      back.classList.add("leaving");
      setTimeout(() => back.remove(), 110);
      opener?.isConnected && opener.focus?.({ preventScroll: true });
      resolve(result);
    };

    const commitEdit = (save) => {
      const id = editing;
      const field = listEl.querySelector(".wlp-edit");
      if (id == null || !field) return;
      editing = null;
      const name = field.value.trim();
      if (save && name) rename(id, name);
      render();
      input.focus({ preventScroll: true });
    };
    const tool = async (id, which) => {
      if (which === "rename") { editing = id; return render(); }
      if (which === "duplicate") await duplicate(id);
      else await remove(id);
      render();
    };

    const onKey = (event) => {
      if (document.querySelector(".dlg-back")) return;
      if (editing != null) {
        if (event.key === "Enter" || event.key === "Escape") commitEdit(event.key === "Enter");
        else return event.stopPropagation(); // typing a name doesn't reach the app's hotkeys
        event.preventDefault();
        return event.stopPropagation();
      }
      if (event.key === "Escape") finish(null);
      else if (event.key === "Enter") { const pick = flat()[cursor]; if (pick) finish({ id: pick.id }); }
      else if (event.key === "ArrowDown" || event.key === "ArrowUp") {
        const total = flat().length;
        if (total) cursor = (cursor + (event.key === "ArrowDown" ? 1 : -1) + total) % total;
        render();
      } else if (event.target !== input && !event.metaKey && !event.ctrlKey && event.key.length === 1) {
        input.focus();
        return;
      } else return event.stopPropagation(); // typing here doesn't reach the app's hotkeys
      event.preventDefault();
      event.stopPropagation();
    };

    input.addEventListener("input", () => { query = input.value.trim().toLowerCase(); cursor = 0; render(); });
    back.addEventListener("pointerdown", (event) => { if (event.target === back) finish(null); });
    listEl.addEventListener("focusout", (event) => { if (event.target.matches(".wlp-edit")) commitEdit(true); });
    back.addEventListener("click", (event) => {
      const action = event.target.closest("[data-action]");
      if (action) return finish({ action: action.dataset.action });
      const row = event.target.closest(".wlp-row");
      if (!row || event.target.closest(".wlp-edit")) return;
      const button = event.target.closest("[data-tool]");
      if (button) return tool(row.dataset.id, button.dataset.tool);
      finish({ id: row.dataset.id });
    });
    listEl.addEventListener("dblclick", (event) => {
      const name = event.target.closest(".wlp-name");
      const row = name?.closest(".wlp-row");
      if (row && !state().lists.find((list) => list.id === row.dataset.id)?.flagged) tool(row.dataset.id, "rename");
    });
    listEl.addEventListener("mousemove", (event) => {
      const row = event.target.closest(".wlp-row");
      if (!row || row.classList.contains("cur")) return;
      listEl.querySelector(".cur")?.classList.remove("cur");
      row.classList.add("cur");
      cursor = Number(row.dataset.i);
    });

    document.body.appendChild(back);
    open = { back, finish };
    document.addEventListener("keydown", onKey, true);
    cursor = Math.max(0, flat().findIndex((list) => list.id === state().active));
    render();
    input.focus({ preventScroll: true });
  });
}

// "Add to watchlist": tick the lists a symbol belongs in. Each click applies at once.
//   pickAddTo({ symbol, lists: [{ id, name, count, has }], toggle: async (id) => has-now })
// Resolves when the panel closes. Type to filter; ↑ ↓ move, Enter or Space ticks, Esc closes.
export function pickAddTo({ symbol, lists, toggle }) {
  open?.finish(null);
  return new Promise((resolve) => {
    const back = document.createElement("div");
    back.className = "wlp-back";
    back.innerHTML = `<div class="wlp" role="dialog" aria-modal="true" aria-label="Add to watchlist">` +
      `<div class="wlp-title">Add <b>${escapeHtml(symbol)}</b> to watchlist</div>` +
      `<label class="wlp-search">${SEARCH_ICON}<input type="text" placeholder="Search lists…" spellcheck="false" autocomplete="off"><kbd>esc</kbd></label>` +
      `<div class="wlp-list"></div>` +
      `<div class="wlp-foot"><span class="wlp-keys"><kbd>↑</kbd><kbd>↓</kbd> move <kbd>↵</kbd> add or remove</span></div></div>`;
    const input = back.querySelector("input");
    const listEl = back.querySelector(".wlp-list");
    let query = "";
    let cursor = 0;
    const shown = () => lists.filter((list) => query.split(/\s+/).every((word) => list.name.toLowerCase().includes(word)));

    const render = () => {
      const rows = shown();
      cursor = Math.max(0, Math.min(cursor, rows.length - 1));
      listEl.innerHTML = rows.length ? rows.map((list, index) =>
        `<div class="wlp-row${index === cursor ? " cur" : ""}${list.has ? " has" : ""}" data-id="${escapeHtml(list.id)}" data-i="${index}">` +
        `<span class="wlp-name">${escapeHtml(list.name)}</span><span class="wlp-count">${list.count}</span>` +
        `<span class="wlp-box" aria-hidden="true"><svg viewBox="0 0 12 12" width="11" height="11"><path d="M2.2 6.3 4.8 8.9 9.8 3.4" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/></svg></span></div>`).join("")
        : `<div class="wlp-empty">No list matches “${escapeHtml(query)}”</div>`;
      listEl.querySelector(".cur")?.scrollIntoView({ block: "nearest" });
    };
    const flip = async (id) => {
      const list = lists.find((item) => item.id === id);
      if (!list || list.busy) return;
      list.busy = true;
      try {
        const has = await toggle(id);
        list.count += has === list.has ? 0 : has ? 1 : -1;
        list.has = has;
      } finally { list.busy = false; }
      render();
    };

    const opener = document.activeElement;
    const finish = () => {
      if (open?.back !== back) return;
      open = null;
      document.removeEventListener("keydown", onKey, true);
      back.classList.add("leaving");
      setTimeout(() => back.remove(), 110);
      opener?.isConnected && opener.focus?.({ preventScroll: true });
      resolve();
    };
    const onKey = (event) => {
      if (document.querySelector(".dlg-back")) return;
      if (event.key === "Escape") finish();
      else if (event.key === "Enter") { const pick = shown()[cursor]; if (pick) flip(pick.id); }
      else if (event.key === "ArrowDown" || event.key === "ArrowUp") {
        const total = shown().length;
        if (total) cursor = (cursor + (event.key === "ArrowDown" ? 1 : -1) + total) % total;
        render();
      } else if (event.target !== input && !event.metaKey && !event.ctrlKey && event.key.length === 1) {
        input.focus();
        return;
      } else return event.stopPropagation();
      event.preventDefault();
      event.stopPropagation();
    };
    input.addEventListener("input", () => { query = input.value.trim().toLowerCase(); cursor = 0; render(); });
    back.addEventListener("pointerdown", (event) => { if (event.target === back) finish(); });
    back.addEventListener("click", (event) => {
      const row = event.target.closest(".wlp-row");
      if (row) flip(row.dataset.id);
    });
    listEl.addEventListener("mousemove", (event) => {
      const row = event.target.closest(".wlp-row");
      if (!row || row.classList.contains("cur")) return;
      listEl.querySelector(".cur")?.classList.remove("cur");
      row.classList.add("cur");
      cursor = Number(row.dataset.i);
    });

    document.body.appendChild(back);
    open = { back, finish };
    document.addEventListener("keydown", onKey, true);
    render();
    input.focus({ preventScroll: true });
  });
}

// "Add symbols": one field, Enter adds. Resolves to the text, or null if dismissed.
export function askSymbolsPanel({ listName }) {
  open?.finish(null);
  return new Promise((resolve) => {
    const back = document.createElement("div");
    back.className = "wlp-back";
    back.innerHTML = `<div class="wlp wlp-add" role="dialog" aria-modal="true" aria-label="Add symbols">` +
      `<div class="wlp-title">Add symbols to <b>${escapeHtml(listName)}</b></div>` +
      `<label class="wlp-search"><svg viewBox="0 0 16 16" width="15" height="15" aria-hidden="true"><path d="M8 3v10M3 8h10" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/></svg>` +
      `<input type="text" placeholder="AAPL, NVDA, TSLA" spellcheck="false" autocomplete="off"></label>` +
      `<div class="wlp-foot"><span>Separate with commas or spaces</span><button type="button" class="wlp-go">Add</button></div></div>`;
    const input = back.querySelector("input");
    const opener = document.activeElement;
    const finish = (result) => {
      if (open?.back !== back) return;
      open = null;
      document.removeEventListener("keydown", onKey, true);
      back.classList.add("leaving");
      setTimeout(() => back.remove(), 110);
      opener?.isConnected && opener.focus?.({ preventScroll: true });
      resolve(result);
    };
    const accept = () => finish(input.value.trim() || null);
    const onKey = (event) => {
      if (document.querySelector(".dlg-back")) return;
      if (event.key === "Escape") finish(null);
      else if (event.key === "Enter") accept();
      else return event.stopPropagation();
      event.preventDefault();
      event.stopPropagation();
    };
    back.addEventListener("pointerdown", (event) => { if (event.target === back) finish(null); });
    back.querySelector(".wlp-go").addEventListener("click", accept);
    document.body.appendChild(back);
    open = { back, finish };
    document.addEventListener("keydown", onKey, true);
    input.focus({ preventScroll: true });
  });
}
