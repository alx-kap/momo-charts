// The one error type of the momo script compiler. Every error has a stable code (E1xx syntax,
// E2xx rules, E3xx types, E4xx limits, R4xx at run time), a position (1-based line and column,
// `endCol` just past the last character) and, where it can, a fix the reader can act on.

export class ScriptError extends Error {
  constructor(code, message, line, col, endCol = col + 1, fix = null) {
    super(message);
    this.name = "ScriptError";
    this.code = code;
    this.line = line;
    this.col = col;
    this.endCol = endCol;
    this.fix = fix;
  }
}

export const fail = (code, message, line, col, endCol, fix) => {
  throw new ScriptError(code, message, line, col, endCol, fix);
};

// The plain object compile() returns for an error.
export const describe = (error) => ({
  line: error.line, col: error.col, endCol: error.endCol, code: error.code,
  message: error.message, fix: error.fix || null,
});

// Edit distance, for "did you mean".
export function distance(a, b) {
  if (a === b) return 0;
  let prev = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i++) {
    const row = [i];
    for (let j = 1; j <= b.length; j++) {
      row[j] = Math.min(prev[j] + 1, row[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    }
    prev = row;
  }
  return prev[b.length];
}

// The candidate closest to `word`, if it is close enough to be a typo.
export function didYouMean(word, candidates) {
  let best = null;
  let bestDistance = Infinity;
  const lower = word.toLowerCase();
  for (const name of candidates) {
    const d = Math.min(distance(word, name), distance(lower, name.toLowerCase()));
    if (d < bestDistance) { best = name; bestDistance = d; }
  }
  const allowed = word.length <= 3 ? 1 : word.length <= 7 ? 2 : 3;
  return best !== null && bestDistance <= allowed ? best : null;
}
