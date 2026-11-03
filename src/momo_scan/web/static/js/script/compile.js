// momo script compiler: source text → { ok, meta, code } or { ok: false, errors }. The pieces,
// in order: lexer + parser (syntax, stops at the first error), checker (rules and types, all
// errors), code generator. `code` is the body of a function (rt, bars, inputs, extra) that
// returns the run() result in docs/scripting.md; `instantiate` and `execute` build and call it
// (the sandbox worker does the same with the same runtime module).

import { generate } from "./codegen.js";
import { check } from "./checker.js";
import { ScriptError, describe } from "./errors.js";
import { parse } from "./parser.js";
import * as runtime from "./runtime.js";

const failure = (code, message, fix = null) => ({ ok: false, errors: [{ line: 1, col: 1, endCol: 2, code, message, fix }] });

export function compile(source) {
  if (typeof source !== "string") return failure("E110", "The script should be text.");
  if (source.length > runtime.LIMITS.source) {
    return failure("E401", `A script can be at most ${runtime.LIMITS.source.toLocaleString("en-US")} characters; this one has ${source.length.toLocaleString("en-US")}.`,
      "Split it into two scripts, or remove what you don't use.");
  }
  let ast;
  try {
    ast = parse(source);
  } catch (e) {
    if (e instanceof ScriptError) return { ok: false, errors: [describe(e)] };
    if (e instanceof RangeError) return failure("E120", "This script is nested too deeply.");
    throw e;
  }
  const checked = check(ast);
  if (!checked.ok) return checked;
  return { ok: true, meta: checked.meta, code: generate(checked.ir) };
}

// The function a compiled script's `code` makes. `rt` is the runtime module.
export function instantiate(code, rt = runtime) {
  const fn = new Function("rt", "bars", "inputs", "extra", code);
  return (bars, inputs = {}, extra = {}) => fn(rt, bars, inputs, extra);
}

// Runs a script and returns the worker's reply shape: { ok, ms, ...result } or { ok: false, error }.
export function execute(code, bars, inputs = {}, extra = {}, rt = runtime) {
  const started = performance.now();
  try {
    const result = instantiate(code, rt)(bars, inputs, extra);
    return { ok: true, ms: performance.now() - started, ...result };
  } catch (e) {
    if (e instanceof rt.RunError) {
      return { ok: false, error: { code: e.code, message: e.message, line: e.line, col: e.col, i: e.i } };
    }
    throw e;
  }
}
