// momo script editor helpers with no DOM, so node tests can run them: autocomplete, hover docs,
// a line diff, and the text edits behind the editor's keys.

import { GLOBALS, NAMESPACES, signature } from "./catalog.js";
import { KEYWORDS } from "./lexer.js";

const MAX_OFFERED = 12;
const TOKEN = /(#.*$|\/\/.*$)|(f?"(?:[^"\\]|\\.)*"?|f?'(?:[^'\\]|\\.)*'?)|(\b\d+(?:\.\d*)?(?:[eE][+-]?\d+)?\b|\.\d+\b)|([A-Za-z_]\w*(?:\.[A-Za-z_]\w*)*)/g;

export const escapeCode = (text) => text.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

const usable = (entry) => !entry.later;
const callable = (entry) => Array.isArray(entry.args);

function tokenClass(word) {
  if (KEYWORDS.has(word)) return "kw";
  if (word === "true" || word === "false" || word === "na") return "lit";
  if (word in GLOBALS || NAMESPACES.has(word.split(".")[0])) return "fn";
  return "";
}

// One line as coloured HTML.
export function highlight(line) {
  let html = "";
  let at = 0;
  for (const match of line.matchAll(TOKEN)) {
    html += escapeCode(line.slice(at, match.index));
    const [text, comment, string, number, word] = match;
    const cls = comment ? "cm" : string ? "st" : number ? "nu" : tokenClass(word);
    html += cls ? `<span class="t-${cls}">${escapeCode(text)}</span>` : escapeCode(text);
    at = match.index + text.length;
  }
  return html + escapeCode(line.slice(at));
}

// The names a script sets itself: `x = `, `var x = `, `def f(`, `for i in`.
function ownNames(source) {
  const names = new Set();
  for (const match of source.matchAll(/^[ \t]*(?:var[ \t]+)?([A-Za-z_]\w*)[ \t]*=(?!=)|^[ \t]*def[ \t]+([A-Za-z_]\w*)|^[ \t]*for[ \t]+([A-Za-z_]\w*)/gm)) {
    names.add(match[1] || match[2] || match[3]);
  }
  return names;
}

// What to offer for the word before the caret: { label, insert, detail }, starts-with first.
export function completions(word, source = "") {
  if (word.length < 2) return [];
  const lower = word.toLowerCase();
  const scored = [];
  const offer = (name, item) => {
    const at = name.toLowerCase().indexOf(lower);
    if (at < 0 || name === word) return;
    // In a namespace ("ta.s") only the member's start counts: `ta.sma`, not `ta.rsi`.
    if (lower.includes(".") ? at !== 0 : at > 0 && !name.includes(".")) return;
    scored.push({ ...item, rank: at === 0 ? 0 : 1 });
  };
  for (const [name, entry] of Object.entries(GLOBALS)) {
    if (usable(entry)) offer(name, { label: name, insert: callable(entry) ? `${name}()` : name, detail: entry.doc || "" });
  }
  for (const name of KEYWORDS) offer(name, { label: name, insert: name, detail: "" });
  for (const name of ownNames(source)) offer(name, { label: name, insert: name, detail: "" });
  const sorted = scored.sort((a, b) => a.rank - b.rank || a.label.localeCompare(b.label));
  const seen = new Set();
  return sorted.filter((item) => !seen.has(item.label) && seen.add(item.label)).slice(0, MAX_OFFERED);
}

// Hover docs for a name, or null.
export function hoverDoc(name) {
  const entry = GLOBALS[name];
  if (!entry || entry.later) return null;
  return { title: callable(entry) ? signature(entry) : name, doc: entry.doc || "", example: entry.example || "" };
}

// A line diff of `before` and `after`: [{ kind: "same" | "add" | "del", text }]. The common start
// and end are trimmed first; what is left past `limit` lines each way shows as replaced.
export function lineDiff(before, after, limit = 2000) {
  const a = before.split("\n");
  const b = after.split("\n");
  let start = 0;
  while (start < a.length && start < b.length && a[start] === b[start]) start++;
  let endA = a.length;
  let endB = b.length;
  while (endA > start && endB > start && a[endA - 1] === b[endB - 1]) { endA--; endB--; }
  const head = a.slice(0, start).map((text) => ({ kind: "same", text }));
  const tail = a.slice(endA).map((text) => ({ kind: "same", text }));
  const left = a.slice(start, endA);
  const right = b.slice(start, endB);
  const replaced = () => [...left.map((text) => ({ kind: "del", text })), ...right.map((text) => ({ kind: "add", text }))];
  if (!left.length || !right.length || left.length > limit || right.length > limit) return [...head, ...replaced(), ...tail];
  // Longest common subsequence, walked from the start.
  const n = left.length;
  const m = right.length;
  const table = Array.from({ length: n + 1 }, () => new Uint16Array(m + 1));
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      table[i][j] = left[i] === right[j] ? table[i + 1][j + 1] + 1 : Math.max(table[i + 1][j], table[i][j + 1]);
    }
  }
  const middle = [];
  let i = 0;
  let j = 0;
  while (i < n || j < m) {
    if (i < n && j < m && left[i] === right[j]) { middle.push({ kind: "same", text: left[i] }); i++; j++; }
    else if (i < n && (j === m || table[i + 1][j] >= table[i][j + 1])) middle.push({ kind: "del", text: left[i++] });
    else middle.push({ kind: "add", text: right[j++] });
  }
  return [...head, ...middle, ...tail];
}

// ⌘/: comment the lines, or uncomment them if all are comments. Blank lines stay blank.
export function toggleComment(text) {
  const lines = text.split("\n");
  const filled = lines.filter((line) => line.trim());
  const commented = filled.length > 0 && filled.every((line) => /^\s*#/.test(line));
  if (commented) return lines.map((line) => line.replace(/^(\s*)# ?/, "$1")).join("\n");
  const indent = Math.min(...filled.map((line) => line.match(/^ */)[0].length), 1e9);
  const at = Number.isFinite(indent) ? indent : 0;
  return lines.map((line) => (line.trim() ? `${line.slice(0, at)}# ${line.slice(at)}` : line)).join("\n");
}

// Tab on several lines, and ⇧Tab: four spaces in or out.
export const indentLines = (text) => text.split("\n").map((line) => (line.trim() ? `    ${line}` : line)).join("\n");
export const outdentLines = (text) => text.split("\n").map((line) => line.replace(/^ {1,4}/, "")).join("\n");

// The indent a new line starts with, given the text before the caret on this line.
export function nextIndent(before) {
  const indent = before.match(/^ */)[0];
  const code = before.replace(/(^|\s)(#|\/\/).*$/, "").trimEnd();
  return code.endsWith(":") ? `${indent}    ` : indent;
}
