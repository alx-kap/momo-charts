// momo script lexer: source text → tokens with positions. Blocks are 4-space indents, reported
// as INDENT / DEDENT tokens. Throws ScriptError (E101–E107) on the first problem.
//
// Token: { type, value, line, col, endCol } with type one of
//   NAME KEYWORD NUM STR FSTR OP NEWLINE INDENT DEDENT EOF HEADER (and COMMENT with `comments`).
// An FSTR's `parts` are strings and { code, spec, line, col } (the expression's source and where
// it starts), which the parser reads with the same lexer.

import { ScriptError } from "./errors.js";

export const KEYWORDS = new Set([
  "if", "elif", "else", "for", "while", "def", "return", "break", "continue", "pass", "in",
  "and", "or", "not", "var",
]);
// Python words momo script doesn't have. They lex as keywords so the parser can say so.
export const UNSUPPORTED = new Set([
  "import", "from", "class", "lambda", "try", "except", "finally", "with", "global", "nonlocal",
  "del", "assert", "yield", "async", "await", "raise", "as", "is", "match", "case",
]);

const TWO = new Set(["**", "<=", ">=", "==", "!=", "+=", "-=", "*=", "/=", ":="]);
const ONE = new Set(["+", "-", "*", "/", "%", "<", ">", "=", "(", ")", "[", "]", ",", ".", ":"]);
const OPEN = { "(": ")", "[": "]" };
const CLOSE = new Set([")", "]"]);
const ESCAPES = { n: "\n", t: "\t", '"': '"', "'": "'", "\\": "\\" };
const SPEC = /^,?(\.\d+)?[f%]?$/;

// Characters people bring from Pine, C and JavaScript: what to write instead.
const SLIPS = {
  "!": "use `not` (and `!=` for not-equal)",
  "&": "use `and`",
  "|": "use `or`",
  "?": "write `a if cond else b`",
  ";": "put each statement on its own line",
  "{": "momo script has no braces; lists use [ ]",
  "}": "momo script has no braces; lists use [ ]",
  "\\": "keep a statement on one line, or break it inside ( )",
  "$": "momo script names use letters, digits and _",
  "@": "momo script has no decorators",
  "`": "use \"double\" or 'single' quotes for text",
  "~": "momo script has no `~`",
  "^": "momo script has no `^`; use `**` for powers",
};

const isDigit = (c) => c >= "0" && c <= "9";
const isStart = (c) => (c >= "a" && c <= "z") || (c >= "A" && c <= "Z") || c === "_";
const isWord = (c) => isStart(c) || isDigit(c);
const show = (c) => {
  const point = c.codePointAt(0);
  return point < 0x20 || point > 0x7e ? `U+${point.toString(16).toUpperCase().padStart(4, "0")}` : c;
};

export function tokenize(source, options = {}) {
  const { comments = false, inline = false, origin = { line: 1, col: 1 } } = options;
  const text = source.replace(/^﻿/, "").replace(/\r\n?/g, "\n");
  const tokens = [];
  const indents = [0];
  const brackets = [];
  let pos = 0;
  let line = origin.line;
  let lineStart = -(origin.col - 1);
  let atLineStart = !inline;
  const col = (p = pos) => p - lineStart + 1;
  const error = (code, message, p, end = p + 1, fix = null) => {
    throw new ScriptError(code, message, line, col(p), col(end), fix);
  };
  let pending = false;                      // a line has tokens that a NEWLINE hasn't closed
  const push = (type, value, start, end, extra) => {
    if (type !== "COMMENT" && type !== "INDENT" && type !== "DEDENT") pending = type !== "NEWLINE" && type !== "HEADER";
    tokens.push({ type, value, line, col: col(start), endCol: col(end), ...extra });
  };
  const last = () => tokens[tokens.length - 1];

  const readComment = () => {
    const start = pos;
    while (pos < text.length && text[pos] !== "\n") pos++;
    return { start, value: text.slice(start, pos) };
  };

  while (pos < text.length) {
    if (atLineStart && !brackets.length) {
      let j = pos;
      while (text[j] === " ") j++;
      if (text[j] === "\t") error("E101", "Tabs aren't allowed in indentation.", j, j + 1, "Indent with 4 spaces.");
      const c = text[j];
      const comment = c === "#" || (c === "/" && text[j + 1] === "/");
      if (j >= text.length || c === "\n" || comment) {
        pos = j;
        if (comment) {
          const { start, value } = readComment();
          const header = !tokens.length && /^#momo(\s|$)/.test(value);
          if (header) push("HEADER", value.slice(5).trim(), start, pos);
          else if (comments) push("COMMENT", value, start, pos);
        }
        if (text[pos] === "\n") { pos++; line++; lineStart = pos; }
        continue;
      }
      const width = j - pos;
      if (width % 4) error("E106", "Indent blocks by 4 spaces.", pos, j, "Use a multiple of 4 spaces.");
      const top = indents[indents.length - 1];
      if (width > top) {
        if (width !== top + 4) error("E106", "This line is indented too far.", pos, j, `Indent by ${top + 4} spaces.`);
        indents.push(width);
        push("INDENT", width, pos, j);
      } else {
        while (width < indents[indents.length - 1]) { indents.pop(); push("DEDENT", width, j, j); }
        if (width !== indents[indents.length - 1]) {
          error("E106", "This line doesn't line up with any block above it.", pos, j);
        }
      }
      pos = j;
      atLineStart = false;
    }

    const c = text[pos];
    if (c === " ") { pos++; continue; }
    if (c === "\t") error("E101", "Tabs aren't allowed.", pos, pos + 1, "Use spaces.");
    if (c === "\n") {
      if (!brackets.length && !inline && pending) {
        push("NEWLINE", "\n", pos, pos + 1);
      }
      pos++; line++; lineStart = pos;
      atLineStart = !inline && !brackets.length;
      continue;
    }
    if (c === "#" || (c === "/" && text[pos + 1] === "/")) {
      const { start, value } = readComment();
      if (comments) push("COMMENT", value, start, pos);
      continue;
    }

    if (isDigit(c) || (c === "." && isDigit(text[pos + 1] || "") && !isOperand(last()))) {
      pos = readNumber();
      continue;
    }

    if (isStart(c)) {
      const start = pos;
      while (pos < text.length && isWord(text[pos])) pos++;
      const word = text.slice(start, pos);
      if ((word === "f" || word === "F") && (text[pos] === '"' || text[pos] === "'")) {
        pos = readString(pos, true, start);
      } else {
        const keyword = KEYWORDS.has(word) || UNSUPPORTED.has(word);
        push(keyword ? "KEYWORD" : "NAME", word, start, pos);
      }
      continue;
    }

    if (c === '"' || c === "'") { pos = readString(pos, false, pos); continue; }

    const two = text.slice(pos, pos + 2);
    if (two === "=>") error("E102", "`=>` is Pine's function arrow.", pos, pos + 2, "Write `def name(args):` and indent the body.");
    if (TWO.has(two)) { push("OP", two, pos, pos + 2); pos += 2; continue; }
    if (ONE.has(c)) {
      if (c in OPEN) brackets.push({ c, p: pos, line, col: col() });
      else if (CLOSE.has(c)) {
        const open = brackets.pop();
        if (!open || OPEN[open.c] !== c) {
          error("E111", `Unmatched \`${c}\`.`, pos, pos + 1, open ? `Close \`${open.c}\` from line ${open.line} with \`${OPEN[open.c]}\`.` : `Remove the \`${c}\`.`);
        }
      }
      push("OP", c, pos, pos + 1);
      pos++;
      continue;
    }
    const slip = SLIPS[c];
    error("E102", `Unexpected character \`${show(c)}\`.`, pos, pos + 1, slip ? slip[0].toUpperCase() + slip.slice(1) + "." : null);
  }

  if (brackets.length) {
    const open = brackets[brackets.length - 1];
    throw new ScriptError("E111", `\`${open.c}\` is never closed.`, open.line, open.col, open.col + 1, `Add \`${OPEN[open.c]}\`.`);
  }
  if (!inline) {
    if (pending) push("NEWLINE", "\n", pos, pos);
    while (indents.length > 1) { indents.pop(); push("DEDENT", 0, pos, pos); }
  }
  push("EOF", "", pos, pos);
  return tokens;

  function isOperand(token) {
    return !!token && (token.type === "NAME" || token.type === "NUM" || token.type === "STR"
      || token.type === "FSTR" || (token.type === "OP" && (token.value === ")" || token.value === "]")));
  }

  function digits(p) {
    let q = p;
    while (isDigit(text[q] || "") || text[q] === "_") q++;
    return q;
  }

  function readNumber() {
    const start = pos;
    let q = digits(pos);
    if (text[q] === "." && !(text[q + 1] === "." )) q = digits(q + 1);
    if (text[q] === "e" || text[q] === "E") {
      let r = q + 1;
      if (text[r] === "+" || text[r] === "-") r++;
      if (!isDigit(text[r] || "")) error("E105", "This number has an `e` with no exponent.", start, r, "Write the exponent digits, like 1e6.");
      q = digits(r);
    }
    const raw = text.slice(start, q);
    if (isWord(text[q] || "")) error("E105", `\`${raw}${text[q]}\` isn't a number.`, start, q + 1, "Put a space or an operator after the number.");
    if (/__|_$|^_|_\.|\._|_[eE]|[eE]_|[eE][+-]_/.test(raw)) error("E105", `\`${raw}\` has a misplaced underscore.`, start, q, "Use _ only between digits, like 1_000_000.");
    push("NUM", parseFloat(raw.replace(/_/g, "")), start, q);
    return q;
  }

  // Reads one escape at text[p] === "\\"; returns [character, next position].
  function readEscape(p) {
    const e = text[p + 1];
    if (e === undefined || e === "\n") error("E103", "This string isn't closed on this line.", p, p + 1, "Close it with the same quote it started with.");
    if (!(e in ESCAPES)) error("E104", `Unknown escape \`\\${e}\`.`, p, p + 2, "Strings accept \\n \\t \\\" \\' and \\\\ only.");
    return [ESCAPES[e], p + 2];
  }

  function checkChar(ch, p) {
    const point = ch.codePointAt(0);
    if (point < 0x20 || point === 0x7f || point === 0x2028 || point === 0x2029) {
      error("E104", `A string can't hold the control character ${show(ch)}.`, p, p + 1, "Use an escape like \\n instead.");
    }
  }

  function readString(p, isF, start) {
    const quote = text[p];
    const unclosed = () => error("E103", "This string isn't closed on this line.", start, p, `Close it with ${quote}.`);
    let q = p + 1;
    let out = "";
    const parts = [];
    while (true) {
      const ch = text[q];
      if (ch === undefined || ch === "\n") { p = q; unclosed(); }
      if (ch === quote) { q++; break; }
      if (ch === "\\") { const [value, next] = readEscape(q); out += value; q = next; continue; }
      if (isF && ch === "{") {
        if (text[q + 1] === "{") { out += "{"; q += 2; continue; }
        const braceStart = q;
        let depth = 0;
        let r = q + 1;
        let colon = -1;
        while (true) {
          const d = text[r];
          if (d === undefined || d === "\n") error("E107", "This `{` in an f-string is never closed.", braceStart, braceStart + 1, "Add `}`.");
          if (d === quote && !depth && colon < 0) error("E107", "This `{` in an f-string is never closed.", braceStart, braceStart + 1, "Add `}`.");
          if ((d === '"' || d === "'") && d !== quote && colon < 0) {
            r = text.indexOf(d, r + 1);
            if (r < 0) error("E107", "A string inside this f-string isn't closed.", braceStart, braceStart + 1);
          } else if (d === "(" || d === "[") depth++;
          else if (d === ")" || d === "]") depth--;
          else if (d === ":" && !depth && colon < 0) colon = r;
          else if (d === "}" && !depth) break;
          r++;
        }
        const code = text.slice(braceStart + 1, colon < 0 ? r : colon);
        const spec = colon < 0 ? "" : text.slice(colon + 1, r);
        if (!code.trim()) error("E107", "This f-string has an empty `{}`.", braceStart, r + 1, "Put an expression inside, like {x:.2f}.");
        if (!SPEC.test(spec)) error("E107", `\`${spec}\` isn't a format.`, colon, r, "Use .2f (decimals), , (thousands) or % (percent), like {x:,.0f}.");
        if (out) { parts.push(out); out = ""; }
        parts.push({ code, spec, line, col: col(braceStart + 1) });
        q = r + 1;
        continue;
      }
      if (isF && ch === "}") {
        if (text[q + 1] === "}") { out += "}"; q += 2; continue; }
        error("E107", "A lone `}` in an f-string.", q, q + 1, "Write `}}` for a literal brace.");
      }
      checkChar(ch, q);
      out += ch;
      q++;
    }
    if (isF) {
      if (out || !parts.length) parts.push(out);
      push("FSTR", "", start, q, { parts });
    } else {
      push("STR", out, start, q);
    }
    return q;
  }
}
