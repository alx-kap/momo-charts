// What the JavaScript compiler makes of a list of scripts, as JSON on stdout, so the Python
// port can be compared with it (tests/test_script_python.py). Not a test itself.
//   node dump.mjs ast|check|run|catalog   < JSON on stdin
// ast, check: a list of sources. run: a list of { src, bars, inputs, extra }. catalog: ignored.
import { readFileSync } from "node:fs";

import * as catalog from "../../../src/momo_scan/web/static/js/script/catalog.js";
import { check } from "../../../src/momo_scan/web/static/js/script/checker.js";
import { compile, execute } from "../../../src/momo_scan/web/static/js/script/compile.js";
import { ScriptError } from "../../../src/momo_scan/web/static/js/script/errors.js";
import { parse } from "../../../src/momo_scan/web/static/js/script/parser.js";
import { loadBars } from "./fixtures.mjs";

const input = JSON.parse(readFileSync(0, "utf8") || "null");
const reply = (value) => process.stdout.write(JSON.stringify(value));

const describe = (e) => ({ code: e.code, message: e.message, line: e.line, col: e.col, endCol: e.endCol, fix: e.fix });

// The IR points at symbols and catalogue entries (and symbols at scopes); flatten those.
const plain = (key, value) => {
  if (key === "scope" || key === "history" || typeof value === "function") return undefined;
  if (key === "entry" && value && value.name) return value.name;
  if (value instanceof Set) return [...value].sort();
  if (typeof value === "number" && !Number.isFinite(value)) return String(value);
  return value;
};

const nan = (v) => (typeof v === "number" && Number.isNaN(v) ? null : v);
const flat = (v) => {
  if (ArrayBuffer.isView(v)) return Array.from(v, nan);
  if (Array.isArray(v)) return v.map(flat);
  if (v && typeof v === "object") return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, flat(x)]));
  return nan(v);
};

switch (process.argv[2]) {
  case "ast":
    reply(input.map((source) => {
      try { return { ast: parse(source) }; } catch (e) {
        return e instanceof ScriptError ? { error: describe(e) } : { crash: String(e) };
      }
    }));
    break;
  case "check":
    reply(input.map((source) => {
      try { return JSON.parse(JSON.stringify(check(parse(source)), plain)); } catch (e) {
        return e instanceof ScriptError ? { error: describe(e) } : { crash: String(e) };
      }
    }));
    break;
  case "run":
    reply(input.map((job) => {
      const compiled = compile(job.src);
      if (!compiled.ok) return { compileErrors: compiled.errors.map((e) => [e.code, e.line, e.col]) };
      const out = execute(compiled.code, loadBars(job.bars).bars, job.inputs || {}, job.extra || {});
      delete out.ms;
      delete out.drawings;
      return flat(out);
    }));
    break;
  case "catalog": {
    const entries = (table) => Object.fromEntries(Object.entries(table).map(([name, e]) => [name, JSON.parse(JSON.stringify(e, plain))]));
    const histories = Object.fromEntries(Object.entries(catalog.GLOBALS).filter(([, e]) => e.history).map(([name, e]) => {
      const names = e.args.filter((a) => a.fixed).map((a) => a.name);
      const probe = Object.fromEntries(names.map((n, i) => [n, i + 2]));
      return [name, e.history(probe)];
    }));
    reply({
      globals: entries(catalog.GLOBALS),
      methods: Object.fromEntries(Object.entries(catalog.METHODS).map(([t, m]) => [t, entries(m)])),
      namespaces: [...catalog.NAMESPACES], histories, palette: catalog.PALETTE,
    });
    break;
  }
  default:
    throw new Error("usage: node dump.mjs ast|check|run|catalog");
}
