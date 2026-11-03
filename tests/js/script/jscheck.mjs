// Checks that the JavaScript the compiler generates holds only the generator's own tokens:
// its fixed identifiers, the runtime's names, `v_`/`f<k>_` prefixed script names, numbers, plain
// printable strings, and a small set of operators. Nothing from a script's text can be a bare
// identifier, a property name, a comment, a template literal or a regex.
import * as runtime from "../../../src/momo_scan/web/static/js/script/runtime.js";

const KEYWORDS = new Set(["const", "let", "for", "if", "else", "while", "break", "continue", "return", "new", "null", "true", "false", "NaN", "Infinity"]);
const GLOBALS = new Set(["Math", "Float64Array", "Uint8Array", "Uint32Array", "rt", "bars", "inputs", "extra"]);
// The keys of the object the generated code returns.
const RESULT_KEYS = new Set(["plots", "markers", "barColors", "bgColors", "levels", "stats", "signals", "logs"]);
const COLUMNS = new Set(["open", "high", "low", "close", "volume", "time", "hl2", "hlc3", "ohlc4", "bar_index"]);
const GENERATED = [
  /^(N|i|steps|ch|cal|MK|LV|ST|LG|BC|BG|EMPTY)$/,
  /^(s|t|k|a|b|c|xs|in|P|C|SG|HH|L|iv)\d+$/,
  /^r\d+_\d+$/,
  /^f\d+_[A-Za-z0-9_]+$/,
  /^v_[A-Za-z0-9_]+$/,
  /^H_(v_[A-Za-z0-9_]+|f\d+_[A-Za-z0-9_]+|r\d+_\d+)$/,
];
const PROPERTIES = new Set([
  ...Object.keys(runtime), ...Object.keys(runtime.ta),
  "length", "step", "v", "o0", "o1", "o2", "abs", "min", "max", "floor", "ceil", "sqrt", "exp", "sign",
  "open", "high", "low", "close", "volume", "time", "year", "month", "day", "dayofweek", "hour", "minute", "regular", "newDay",
  "intraday", "daily", "weekly", "monthly", "ticker",
]);
const OPERATORS = new Set(["+", "-", "*", "<", ">", "<=", ">=", "===", "!==", "==", "=", "!", "&&", "||", "++", "+=", "?", ":"]);
const PUNCTUATION = new Set(["(", ")", "{", "}", "[", "]", ",", ";", "."]);
const STRING = /^"(?:[\x20\x21\x23\x25\x27-\x3b\x3d\x3f-\x5b\x5d-\x5f\x61-\x7e]|\\["\\nrtbf]|\\u[0-9a-f]{4})*"$/;
const NUMBER = /^(?:0|[1-9]\d*)(?:\.\d+)?(?:e[+-]\d+)?$/;

export function problems(code) {
  const found = [];
  const bad = (message) => found.push(message);
  let i = 0;
  let previous = null;
  const opened = [];                 // for each open bracket: did it follow a name or a closing bracket (an index)?
  while (i < code.length) {
    const c = code[i];
    if (c === " " || c === "\n") { i++; continue; }
    const point = code.charCodeAt(i);
    if (point < 0x20 || point > 0x7e) { bad(`non-ASCII or control character at ${i}`); i++; continue; }
    let token;
    if (c === '"') {
      let j = i + 1;
      while (j < code.length && code[j] !== '"') j += code[j] === "\\" ? 2 : 1;
      token = code.slice(i, j + 1);
      if (!STRING.test(token)) bad(`unsafe string literal ${token.slice(0, 40)}`);
      if (previous === "[" && opened[opened.length - 1] === true) bad(`a string used as an index: ${token}`);
      previous = "string";
    } else if (/[A-Za-z_$]/.test(c)) {
      let j = i;
      while (j < code.length && /[A-Za-z0-9_$]/.test(code[j])) j++;
      token = code.slice(i, j);
      if (previous === ".") {
        if (!PROPERTIES.has(token)) bad(`unknown property .${token}`);
      } else if (!(KEYWORDS.has(token) || GLOBALS.has(token) || RESULT_KEYS.has(token) || COLUMNS.has(token) || token in runtime || GENERATED.some((re) => re.test(token)))) {
        bad(`unknown identifier ${token}`);
      }
      if (token.includes("$")) bad(`identifier with $: ${token}`);
      previous = "name";
    } else if (/[0-9]/.test(c)) {
      let j = i;
      while (j < code.length && /[0-9.e]/.test(code[j]) || ((code[j] === "+" || code[j] === "-") && code[j - 1] === "e")) j++;
      token = code.slice(i, j);
      if (!NUMBER.test(token)) bad(`odd number ${token}`);
      previous = "number";
    } else if (PUNCTUATION.has(c)) {
      token = c;
      if (c === "[") opened.push(previous === "name" || previous === ")" || previous === "]");
      if (c === "]") opened.pop();
      previous = c;
    } else if ("+-*<>=!&|?:".includes(c)) {
      let j = i;
      while (j < code.length && "+-*<>=!&|?:".includes(code[j])) j++;
      token = code.slice(i, j);
      if (!OPERATORS.has(token)) bad(`odd operator ${token}`);
      previous = "operator";
    } else if (c === "/") {
      bad(`a slash at ${i}: comment, division or regex`);
      token = c;
    } else {
      bad(`unexpected character ${JSON.stringify(c)} at ${i}`);
      token = c;
    }
    i += token.length;
  }
  return found;
}
