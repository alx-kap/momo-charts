// The momo script code editor: a <textarea> over a highlighted <pre>, the standard technique with
// no packages. The textarea holds the text, the caret and the browser's undo; its letters are
// transparent and the <pre> behind shows them in colour. Edits made here go through
// document.execCommand("insertText") so undo keeps working.
//
//   const editor = createEditor(box, { onInput, onSave });
//   editor.value = "…"; editor.setProblems([{ line, col, endCol, code, message }]);
//
// Script text only ever reaches the page escaped, or as textContent.

import { completions, escapeCode as escapeHtml, highlight, hoverDoc, indentLines, nextIndent, outdentLines, toggleComment } from "./assist.js";

const LINE_HEIGHT = 20;
const PAD = 8;
const HOVER_MS = 350;
const PAIRS = { "(": ")", "[": "]", "{": "}", '"': '"', "'": "'" };
const CLOSERS = new Set([")", "]", "}", '"', "'"]);

export function createEditor(box, { onInput = () => {}, onSave = () => {} } = {}) {
  box.classList.add("ed");
  box.innerHTML = `<div class="ed-gutter"></div><div class="ed-view"><pre class="ed-marks" aria-hidden="true"></pre>` +
    `<pre class="ed-code" aria-hidden="true"></pre></div>` +
    `<textarea class="ed-input" wrap="off" spellcheck="false" autocapitalize="off" autocomplete="off" autocorrect="off" aria-label="Script source"></textarea>` +
    `<div class="ed-pop" hidden></div><div class="ed-hover" hidden></div>`;
  const input = box.querySelector(".ed-input");
  const gutter = box.querySelector(".ed-gutter");
  const code = box.querySelector(".ed-code");
  const marks = box.querySelector(".ed-marks");
  const pop = box.querySelector(".ed-pop");
  const hover = box.querySelector(".ed-hover");

  let problems = [];
  let lineCount = 0;
  let frame = 0;
  let offers = [];
  let picked = 0;
  let hoverTimer = 0;
  let cellWidth = 0;
  const cache = new Map();

  function cached(line) {
    let html = cache.get(line);
    if (html === undefined) {
      if (cache.size > 20000) cache.clear();
      html = highlight(line);
      cache.set(line, html);
    }
    return html;
  }

  function renderGutter(count) {
    const bad = new Set(problems.map((problem) => problem.line));
    gutter.innerHTML = Array.from({ length: count }, (_, i) =>
      `<div class="${bad.has(i + 1) ? "bad" : ""}">${i + 1}</div>`).join("");
    lineCount = count;
  }

  function renderMarks(lines) {
    const byLine = new Map();
    for (const problem of problems) if (!byLine.has(problem.line)) byLine.set(problem.line, problem);
    marks.innerHTML = lines.map((line, i) => {
      const problem = byLine.get(i + 1);
      if (!problem) return "";
      const start = Math.min(problem.col - 1, line.length);
      const end = Math.max(start + 1, Math.min(problem.endCol - 1, line.length));
      return `${escapeHtml(line.slice(0, start))}<u>${escapeHtml(line.slice(start, end) || " ")}</u>`;
    }).join("\n");
  }

  function render() {
    frame = 0;
    const lines = input.value.split("\n");
    code.innerHTML = `${lines.map(cached).join("\n")}\n`;
    renderMarks(lines);
    if (lines.length !== lineCount) renderGutter(lines.length);
    syncScroll();
  }
  const schedule = () => { frame ||= requestAnimationFrame(render); };

  function syncScroll() {
    const shift = `translate(${-input.scrollLeft}px, ${-input.scrollTop}px)`;
    code.style.transform = marks.style.transform = shift;
    gutter.style.transform = `translateY(${-input.scrollTop}px)`;
  }

  function cell() {
    if (!cellWidth) {
      const probe = document.createElement("span");
      probe.textContent = "0".repeat(100);
      code.append(probe);
      cellWidth = probe.getBoundingClientRect().width / 100 || 8;
      probe.remove();
    }
    return cellWidth;
  }

  // Where the caret's line and column sit, in the box.
  function caretPlace() {
    const before = input.value.slice(0, input.selectionStart);
    const line = before.split("\n").length - 1;
    const col = before.length - before.lastIndexOf("\n") - 1;
    return {
      left: gutter.offsetWidth + PAD + col * cell() - input.scrollLeft,
      top: PAD + (line + 1) * LINE_HEIGHT - input.scrollTop,
    };
  }

  // ---- edits, through the browser so undo works ------------------------------------------------

  function insert(text) {
    input.focus();
    const done = text ? document.execCommand("insertText", false, text) : document.execCommand("delete");
    if (done) return;
    input.setRangeText(text, input.selectionStart, input.selectionEnd, "end");
    input.dispatchEvent(new Event("input", { bubbles: true }));
  }

  // The selection grown to whole lines.
  function selectLines() {
    const value = input.value;
    const start = value.lastIndexOf("\n", input.selectionStart - 1) + 1;
    let end = input.selectionEnd;
    if (end > start && value[end - 1] === "\n") end--;
    const stop = value.indexOf("\n", end);
    input.setSelectionRange(start, stop < 0 ? value.length : stop);
    return value.slice(input.selectionStart, input.selectionEnd);
  }

  function replaceLines(change) {
    const before = selectLines();
    const start = input.selectionStart;
    const after = change(before);
    if (after !== before) insert(after);
    input.setSelectionRange(start, start + after.length);
  }

  // ---- autocomplete -----------------------------------------------------------------------------

  const closePop = () => { pop.hidden = true; offers = []; };

  function currentWord() {
    const value = input.value;
    const caret = input.selectionStart;
    const line = value.slice(value.lastIndexOf("\n", caret - 1) + 1, caret);
    if (/(^|\s)(#|\/\/)/.test(line) || (line.match(/"/g) || []).length % 2) return "";
    return (line.match(/[A-Za-z_][\w.]*$/) || [""])[0];
  }

  function showOffers() {
    offers = completions(currentWord(), input.value);
    if (!offers.length) { closePop(); return; }
    picked = 0;
    pop.replaceChildren(...offers.map((offer, i) => {
      const row = document.createElement("div");
      row.className = "ed-offer";
      row.dataset.i = i;
      const name = document.createElement("b");
      name.textContent = offer.label;
      const detail = document.createElement("span");
      detail.textContent = offer.detail;
      row.append(name, detail);
      return row;
    }));
    markOffer();
    const { left, top } = caretPlace();
    pop.style.left = `${Math.max(0, left)}px`;
    pop.style.top = `${Math.max(0, top)}px`;
    pop.hidden = false;
    if (pop.offsetTop + pop.offsetHeight > box.clientHeight) pop.style.top = `${Math.max(0, top - LINE_HEIGHT - pop.offsetHeight)}px`;
  }

  function markOffer() {
    [...pop.children].forEach((row, i) => row.classList.toggle("on", i === picked));
    pop.children[picked]?.scrollIntoView({ block: "nearest" });
  }

  function accept(offer) {
    const word = currentWord();
    input.setSelectionRange(input.selectionStart - word.length, input.selectionStart);
    insert(offer.insert);
    if (offer.insert.endsWith("()")) input.setSelectionRange(input.selectionStart - 1, input.selectionStart - 1);
    closePop();
  }

  // ---- hover docs ------------------------------------------------------------------------------

  function wordAt(x, y) {
    const rect = input.getBoundingClientRect();
    const line = input.value.split("\n")[Math.floor((y - rect.top - PAD + input.scrollTop) / LINE_HEIGHT)];
    if (line === undefined) return null;
    const col = Math.floor((x - rect.left - PAD + input.scrollLeft) / cell());
    for (const match of line.matchAll(/[A-Za-z_]\w*(?:\.[A-Za-z_]\w*)*/g)) {
      if (col >= match.index && col < match.index + match[0].length) return match[0];
    }
    return null;
  }

  function showHover(x, y) {
    const word = wordAt(x, y);
    const doc = word && hoverDoc(word);
    if (!doc) { hover.hidden = true; return; }
    const parts = [["b", doc.title], ["p", doc.doc], ["code", doc.example]].filter(([, text]) => text);
    hover.replaceChildren(...parts.map(([tag, text]) => {
      const el = document.createElement(tag);
      el.textContent = text;
      return el;
    }));
    const rect = box.getBoundingClientRect();
    hover.style.left = `${Math.min(x - rect.left, Math.max(0, box.clientWidth - 380))}px`;
    hover.style.top = `${y - rect.top + 16}px`;
    hover.hidden = false;
    if (hover.offsetTop + hover.offsetHeight > box.clientHeight) hover.style.top = `${Math.max(0, y - rect.top - hover.offsetHeight - 8)}px`;
  }

  // ---- keys ------------------------------------------------------------------------------------

  function onKey(event) {
    const mod = event.metaKey || event.ctrlKey;
    if (offers.length) {
      if (event.key === "ArrowDown" || event.key === "ArrowUp") {
        event.preventDefault();
        picked = (picked + (event.key === "ArrowDown" ? 1 : offers.length - 1)) % offers.length;
        markOffer();
        return;
      }
      if (event.key === "Enter" || event.key === "Tab") { event.preventDefault(); accept(offers[picked]); return; }
      if (event.key === "Escape") { event.preventDefault(); event.stopPropagation(); closePop(); return; }
    }
    if (event.key === "Escape") { event.stopPropagation(); return; } // the page's Esc would take the focus
    if (mod && event.key.toLowerCase() === "s") { event.preventDefault(); onSave(); return; }
    if (mod && event.key === "/") { event.preventDefault(); replaceLines(toggleComment); return; }
    const { selectionStart: start, selectionEnd: end, value } = input;
    if (event.key === "Tab") {
      event.preventDefault();
      if (event.shiftKey) replaceLines(outdentLines);
      else if (value.slice(start, end).includes("\n")) replaceLines(indentLines);
      else insert("    ");
      return;
    }
    if (event.key === "Enter" && !mod) {
      event.preventDefault();
      insert(`\n${nextIndent(value.slice(value.lastIndexOf("\n", start - 1) + 1, start))}`);
      return;
    }
    if (event.key === "Backspace" && start === end && start > 0 && PAIRS[value[start - 1]] === value[start] && value[start] !== undefined) {
      event.preventDefault();
      input.setSelectionRange(start - 1, start + 1);
      insert("");
      return;
    }
    if (mod || event.altKey) return;
    if (CLOSERS.has(event.key) && start === end && value[start] === event.key) {
      event.preventDefault();
      input.setSelectionRange(start + 1, start + 1);
      return;
    }
    const closer = PAIRS[event.key];
    if (!closer) return;
    const quote = closer === event.key;
    if (start === end && quote && /\w/.test(value[start - 1] || "")) return; // an apostrophe in a word
    event.preventDefault();
    const inner = value.slice(start, end);
    insert(event.key + inner + closer);
    input.setSelectionRange(start + 1, start + 1 + inner.length);
  }

  input.addEventListener("keydown", onKey);
  input.addEventListener("input", (event) => {
    hover.hidden = true;
    schedule();
    onInput(input.value);
    if (event.inputType === "insertText" || event.inputType === "deleteContentBackward") showOffers();
    else closePop();
  });
  input.addEventListener("scroll", () => { syncScroll(); closePop(); hover.hidden = true; });
  input.addEventListener("blur", () => setTimeout(closePop, 120));
  input.addEventListener("mousemove", (event) => {
    clearTimeout(hoverTimer);
    hover.hidden = true;
    const { clientX: x, clientY: y } = event;
    hoverTimer = setTimeout(() => showHover(x, y), HOVER_MS);
  });
  input.addEventListener("mouseleave", () => { clearTimeout(hoverTimer); hover.hidden = true; });
  pop.addEventListener("mousedown", (event) => {
    const row = event.target.closest(".ed-offer");
    if (!row) return;
    event.preventDefault();
    accept(offers[Number(row.dataset.i)]);
  });

  return {
    get value() { return input.value; },
    set value(text) {
      input.value = text;
      input.setSelectionRange(0, 0);
      input.scrollTop = input.scrollLeft = 0;
      closePop();
      render();
    },
    focus: () => input.focus(),
    setProblems(list) {
      problems = list;
      const lines = input.value.split("\n");
      renderMarks(lines);
      renderGutter(lines.length);
    },
    // Put the caret on a problem.
    reveal(line, col = 1) {
      const lines = input.value.split("\n");
      const at = lines.slice(0, line - 1).reduce((sum, text) => sum + text.length + 1, 0) + col - 1;
      input.focus();
      input.setSelectionRange(at, at);
      input.scrollTop = Math.max(0, (line - 3) * LINE_HEIGHT);
    },
  };
}
