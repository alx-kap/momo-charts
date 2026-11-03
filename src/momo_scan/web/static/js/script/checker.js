// momo script checker: AST → typed IR, plus the rules (E2xx), types (E3xx), limits (E4xx) and
// the `meta` compile() returns. The code generator reads the IR, never the AST: user functions
// are inlined per call site, and each site has its own types, so checking and elaborating are
// one pass. Errors are collected (not thrown), with "did you mean" for names.
//
// IR expressions are { k, t, fixed, ... } (t: number bool string color list plot void tuple, or
// "error" after a reported problem, which silences follow-on errors). Kinds:
//   num str bool color na · sym{sym} · ser{name} · hist{mode,...} · un{op,a} · bin{op,a,b} ·
//   cond{test,a,b} · b2n{a} · n2b{a} · pure{entry,args} · isna{a} · nz{a,b} · len{a} · list{items} ·
//   lget{list,index} · lm{name,list,args} · fstr{parts} · ta{id,entry,ctor,step,site} ·
//   input{...} · inl{body,res} · plotref{key}
// Statements: set varinit unpack if for forlist while break continue expr block ret out.
// `fixed` marks values that are the same on every bar (lengths and history offsets need them).

import { GLOBALS, KWARG_ALIASES, METHODS, NAMESPACES, formatColor, members, parseColor, signature, withAlpha } from "./catalog.js";
import { ScriptError, describe, didYouMean } from "./errors.js";
import { LIMITS } from "./runtime.js";

export { LIMITS };


const SOURCES = ["open", "high", "low", "close", "volume", "hl2", "hlc3", "ohlc4"];
// Built-in series a script may reuse as a variable name (they're reference data, not syntax).
const SHADOWABLE = new Set(["year", "month", "day", "dayofweek", "hour", "minute", "ticker"]);
const ARITH = new Set(["+", "-", "*", "/", "%", "**"]);
const ORDER = new Set(["<", "<=", ">", ">="]);
const SIGNAL_NAME = /^[A-Za-z][A-Za-z0-9_]{0,31}$/;
const PLOT_STYLES = ["line", "steps", "histogram", "columns", "area", "circles"];

// A function nobody calls is checked without knowing its argument types, so only these count.
const LENIENT_KEEPS = new Set(["E201", "E203", "E204", "E207", "E208", "E209", "E211", "E212"]);
const ERROR_TYPE = { k: "err", t: "error", fixed: false };
const isErr = (e) => e.t === "error";

class Scope {
  constructor(kind, parent = null) {
    this.kind = kind;
    this.parent = parent;
    this.vars = new Map();
    this.info = new Map();       // name → { count, conditional, aug, isVar } from the pre-scan
  }
}

// What the body assigns, for fixed-ness and "set later" reads.
function scan(body, info = new Map(), conditional = false) {
  const note = (name, extra = {}) => {
    const entry = info.get(name) || { count: 0, conditional: false, aug: false, isVar: false };
    entry.count++;
    entry.conditional ||= conditional || !!extra.conditional;
    entry.aug ||= !!extra.aug;
    entry.isVar ||= !!extra.isVar;
    info.set(name, entry);
  };
  for (const stmt of body) {
    switch (stmt.type) {
      case "Assign": note(stmt.target.id, { aug: stmt.op !== "=", isVar: stmt.isVar }); break;
      case "Unpack": for (const t of stmt.targets) note(t.id, { conditional: true }); break;
      case "For": note(stmt.target.id, { conditional: true }); scan(stmt.body, info, true); break;
      case "While": scan(stmt.body, info, true); break;
      case "If": scan(stmt.body, info, true); scan(stmt.orelse, info, true); break;
      default:
    }
  }
  return info;
}

const slug = (title) => {
  let key = title.toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "");
  if (!/^[a-z]/.test(key)) key = `p_${key}`.replace(/_$/, "");
  return key || "plot";
};

export function check(program, options = {}) {
  return new Checker(options).run(program);
}

class Checker {
  constructor(options) {
    this.lenient = !!options.lenient;
    this.errors = [];
    this.seen = new Set();
    this.syms = [];
    this.symCount = 0;
    this.taCount = 0;
    this.hiddenCount = 0;
    this.callCount = 0;
    this.steppers = [];
    this.hidden = [];
    this.inputs = [];
    this.outputs = [];           // meta.plots entries
    this.signals = [];
    this.keys = new Set();
    this.names = new Set();      // signal / value names
    this.uses = new Set();       // built-in series read
    this.functions = new Map();
    this.stack = [];
    this.maxLength = 0;
    this.maxOffset = 0;
    this.plotCount = 0;
    this.indicator = null;
    this.instCount = 0;
    this.allDefs = new Set();
  }

  // ---- reporting ---------------------------------------------------------------------------

  report(code, message, at, fix = null, endCol) {
    if (this.lenient && !LENIENT_KEEPS.has(code)) return;
    const line = at.line ?? 1;
    const col = at.col ?? 1;
    const id = `${code}:${line}:${col}:${message}`;
    if (this.seen.has(id)) return;
    this.seen.add(id);
    this.errors.push(new ScriptError(code, message, line, col, endCol ?? col + 1, fix));
  }

  // The width of a name or call in the source, for underlining.
  span(node) {
    if (node.type === "Name") return node.col + node.id.length;
    if (node.type === "Attr") return node.nameCol + node.name.length;
    if (node.type === "Call") return this.span(node.callee);
    return node.col + 1;
  }

  fail(code, message, node, fix) {
    this.report(code, message, node, fix, this.span(node));
    return ERROR_TYPE;
  }

  // ---- entry point -------------------------------------------------------------------------

  run(program) {
    this.top = new Scope("top");
    scan(program.body, this.top.info);
    for (const s of program.body) if (s.type === "Def") this.allDefs.add(s.name);
    const ctx = { scope: this.top, top: true, cond: 0, why: "", loop: false, fn: null };
    const body = [];
    const [first, ...rest] = program.body;
    if (first && this.isCall(first, "indicator")) this.indicatorCall(first.expr);
    else {
      this.report("E210", "A script starts with indicator(...).", first || { line: 1, col: 1 },
        'Write indicator("My script", overlay=true) as the first line after #momo 1.');
      rest.unshift(...(first ? [first] : []));
    }
    for (const stmt of rest) body.push(...this.stmt(stmt, ctx));
    for (const fn of this.functions.values()) if (!fn.called) this.dryRun(fn);
    return this.finish(body);
  }

  isCall(stmt, name) {
    return stmt.type === "ExprStmt" && stmt.expr.type === "Call" && stmt.expr.callee.type === "Name" && stmt.expr.callee.id === name;
  }

  finish(body) {
    const errors = this.errors.sort((a, b) => a.line - b.line || a.col - b.col).map(describe);
    if (this.outputs.length > LIMITS.plots) {
      errors.push({ line: 1, col: 1, endCol: 2, code: "E402", message: `A script can draw at most ${LIMITS.plots} plots.`, fix: null });
    }
    const ind = this.indicator || { title: "Untitled", short: "", overlay: false, format: "price", precision: 2 };
    const meta = {
      version: 1, title: ind.title, short: ind.short || ind.title, overlay: ind.overlay, format: ind.format,
      precision: ind.precision, inputs: this.inputs.map((i) => i.meta), plots: this.outputs,
      signals: this.signals, needs: { tf: [], symbols: [], data: [], history: this.maxLength + this.maxOffset },
    };
    if (errors.length) return { ok: false, errors };
    return {
      ok: true, meta,
      ir: {
        body, syms: this.syms, steppers: this.steppers, hidden: this.hidden, inputs: this.inputs,
        uses: this.uses, plots: this.outputs,
      },
    };
  }

  // A function nobody calls is still checked, leniently: types are unknown without arguments.
  dryRun(fn) {
    const saved = this.lenient;
    const marks = [this.syms.length, this.steppers.length, this.hidden.length];
    this.lenient = true;
    const args = fn.node.params.map((p) => (p.default ? this.expr(p.default, this.callCtx()) : { k: "ser", name: "close", t: "number", fixed: false }));
    this.inline(fn, { line: fn.node.line, col: fn.node.col }, args, [], this.callCtx(), true);
    this.lenient = saved;
    this.syms.length = marks[0];
    this.steppers.length = marks[1];
    this.hidden.length = marks[2];
  }

  callCtx() { return { scope: this.top, top: false, cond: 0, why: "", loop: false, fn: null }; }

  // ---- indicator(), the first line ---------------------------------------------------------

  indicatorCall(call) {
    const entry = GLOBALS.indicator;
    const args = this.bind(entry, call, this.callCtx(), { literals: true });
    if (!args) return;
    const [title, overlay, short, format, precision] = args.map((a) => a.lit);
    this.indicator = { title, overlay, short, format, precision };
  }

  // ---- statements --------------------------------------------------------------------------

  stmts(body, ctx) {
    const out = [];
    for (const s of body) out.push(...this.stmt(s, ctx));
    return out;
  }

  stmt(node, ctx) {
    switch (node.type) {
      case "Assign": return this.assign(node, ctx);
      case "Unpack": return this.unpack(node, ctx);
      case "ExprStmt": return this.exprStmt(node, ctx);
      case "If": return this.ifStmt(node, ctx);
      case "For": return this.forStmt(node, ctx);
      case "While": return this.whileStmt(node, ctx);
      case "Def": this.def(node, ctx); return [];
      case "Return": return this.returnStmt(node, ctx);
      case "Break": case "Continue":
        if (!ctx.loop) this.report("E209", `\`${node.type.toLowerCase()}\` only works inside a loop.`, node, null, node.col + node.type.length);
        return [{ k: node.type.toLowerCase() }];
      case "Pass": return [];
      default:
        this.report("E213", "This isn't a statement momo script understands.", node);
        return [];
    }
  }

  inner(ctx, why, extra = {}) {
    return { ...ctx, top: false, cond: ctx.cond + 1, why: ctx.cond ? ctx.why : why, ...extra };
  }

  ifStmt(node, ctx) {
    const test = this.coerce(this.expr(node.test, ctx), "bool", node.test);
    const inner = this.inner(ctx, "an if");
    return [{ k: "if", test, body: this.stmts(node.body, inner), orelse: this.stmts(node.orelse, inner) }];
  }

  whileStmt(node, ctx) {
    const inner = this.inner(ctx, "a loop", { loop: true });
    const test = this.coerce(this.expr(node.test, inner), "bool", node.test);
    return [{ k: "while", test, body: this.stmts(node.body, inner), line: node.line, col: node.col }];
  }

  forStmt(node, ctx) {
    const inner = this.inner(ctx, "a loop", { loop: true });
    const iter = node.iter;
    const sym = this.assignTarget(node.target, { k: "num", t: "number", fixed: false }, ctx, true);
    if (iter.type === "Call" && iter.callee.type === "Name" && iter.callee.id === "range" && !this.lookup(ctx, "range")) {
      const args = this.bind(GLOBALS.range, iter, ctx, {});
      if (!args) return [];
      const [start, stop, step] = args.map((a) => a.e);
      const hasStop = !args[1].missing;
      return [{
        k: "for", sym, start: hasStop ? start : { k: "num", t: "number", fixed: true, v: 0 },
        stop: hasStop ? stop : start, step, body: this.stmts(node.body, inner), line: node.line, col: node.col,
      }];
    }
    const list = this.expr(iter, ctx);
    if (!isErr(list) && list.t !== "list") {
      this.report("E301", "A `for` loop goes over range(n) or a list.", iter, "Write `for i in range(n):`.", this.span(iter));
      return [];
    }
    return [{ k: "forlist", sym, list, body: this.stmts(node.body, inner), line: node.line, col: node.col }];
  }

  def(node, ctx) {
    if (!ctx.top || ctx.cond || ctx.fn) {
      this.report("E207", "`def` goes at the top level of the script.", node, "Move the function above, outside any if, loop or function.", node.col + 3);
      return;
    }
    if (this.reserved(node.name, node, "function")) return;
    if (this.functions.has(node.name) || this.top.vars.has(node.name) || this.top.info.has(node.name)) {
      this.report("E212", `\`${node.name}\` is already used for something else.`, node, null, node.col + 3 + node.name.length + 1);
      return;
    }
    this.functions.set(node.name, { node, called: false });
  }

  returnStmt(node, ctx) {
    const fn = ctx.fn;
    if (!fn) {
      this.report("E209", "`return` only works inside a function.", node, null, node.col + 6);
      return [];
    }
    let values = [];
    if (node.value) {
      const items = node.value.type === "Tuple" ? node.value.items : [node.value];
      values = items.map((n) => this.expr(n, ctx));
    }
    const out = [];
    if (fn.size === null) fn.size = values.length;
    else if (fn.size !== values.length && values.length) {
      this.report("E308", `This function returns ${fn.size} value${fn.size === 1 ? "" : "s"} elsewhere but ${values.length} here.`, node);
      return [];
    }
    values.forEach((v, i) => {
      if (isErr(v)) return;
      if (v.t === "tuple") { this.report("E308", "A function call that returns several values can't be returned as one.", node.value); return; }
      let slot = fn.res[i];
      if (!slot) {
        slot = fn.res[i] = this.newSym(`ret${i}`, v.t === "na" ? "number" : v.t, false, fn.prefix, true);
        slot.js = `r${fn.id}_${i}`;
      }
      out.push({ k: "set", sym: slot, v: this.fit(v, slot.t, node.value || node) });
    });
    out.push({ k: "ret", label: fn.label });
    return out;
  }

  exprStmt(node, ctx) {
    const e = node.expr;
    if (e.type !== "Call") {
      this.report("E213", "This line does nothing; a statement should assign something or call a function.", e,
        "Assign it to a name, or remove the line.", this.span(e));
      return [];
    }
    const callee = this.calleeName(e, ctx);
    const entry = callee && GLOBALS[callee];
    if (entry && entry.kind === "output") return this.output(e, entry, ctx, null);
    const value = this.expr(e, ctx);
    if (isErr(value)) return [];
    return [{ k: "expr", e: value }];
  }

  // "plot" or "ta.sma" for a call's callee, when it names a catalogue global (and not a user thing).
  calleeName(call, ctx) {
    const dotted = this.flatten(call.callee);
    if (!dotted) return null;
    const root = dotted.split(".")[0];
    if (this.lookup(ctx, root) || this.functions.has(root)) return null;
    return GLOBALS[dotted] ? dotted : null;
  }

  flatten(node) {
    if (node.type === "Name") return node.id;
    if (node.type === "Attr") {
      const left = this.flatten(node.target);
      return left && `${left}.${node.name}`;
    }
    return null;
  }

  // ---- assignment --------------------------------------------------------------------------

  assign(node, ctx) {
    const name = node.target.id;
    const valueNode = node.value;
    if (this.reserved(name, node.target, "name")) return [];
    const callee = valueNode.type === "Call" ? this.calleeName(valueNode, ctx) : null;
    const entry = callee && GLOBALS[callee];

    if (entry && entry.kind === "input") return this.inputAssign(node, entry, ctx);
    if (entry && entry.kind === "output" && entry.returns === "plot") {
      if (node.op !== "=" || node.isVar) { this.report("E214", "A plot handle is assigned with a plain `=`.", node); return []; }
      const handle = {};
      const stmts = this.output(valueNode, entry, ctx, handle);
      if (handle.key) {
        const sym = this.declare(ctx, node.target, "plot", true, false);
        if (sym) { sym.plotKey = handle.key; sym.defined = true; }
      }
      return stmts;
    }

    const prior = this.lookup(ctx, name, true);
    if (node.isVar && prior && prior.defined) {
      this.report("E212", `\`${name}\` is set before this \`var\`.`, node.target, `Put the \`var ${name} = ...\` line before any other assignment to ${name}.`, this.span(node.target));
      return [];
    }
    const varCtx = node.isVar ? this.inner(ctx, "a `var` line (it only runs on the first bar)") : ctx;
    let value = this.expr(valueNode, varCtx);
    if (isErr(value)) { this.markDefined(ctx, name); return []; }
    if (value.t === "tuple") {
      this.report("E308", "This returns several values; unpack them: a, b = f(...)", valueNode, null, this.span(valueNode));
      return [];
    }
    if (value.t === "void") {
      this.report("E309", "This doesn't return a value.", valueNode, null, this.span(valueNode));
      return [];
    }
    if (value.t === "plot") { this.report("E214", "Plot handles are assigned from plot(...) at the top level.", valueNode); return []; }

    let sym = prior;
    if (node.op !== "=") {
      if (!sym || !sym.defined) {
        this.report("E203", `\`${name}\` is changed here before it has a value.`, node.target, `Give it one first, like \`var ${name} = 0\`.`, this.span(node.target));
        return [];
      }
      const op = node.op[0];
      const left = this.read(sym);
      const rhs = this.coerce(value, "number", valueNode);
      value = this.bin(op, this.coerce(left, "number", node.target), rhs);
    }
    sym = this.assignTarget(node.target, value, ctx, false, node.isVar);
    if (!sym) return [];
    const fitted = this.fit(value, sym.t, valueNode, name);
    if (isErr(fitted)) return [];
    return [node.isVar ? { k: "varinit", sym, v: fitted } : { k: "set", sym, v: fitted }];
  }

  unpack(node, ctx) {
    for (const t of node.targets) if (this.reserved(t.id, t, "name")) return [];
    const value = this.expr(node.value, ctx);
    if (isErr(value)) { node.targets.forEach((t) => this.markDefined(ctx, t.id)); return []; }
    const types = value.t === "tuple" ? value.types : null;
    if (!types) {
      this.report("E308", "Only a function that returns several values can be unpacked.", node.value, null, this.span(node.value));
      node.targets.forEach((t) => this.markDefined(ctx, t.id));
      return [];
    }
    if (types.length !== node.targets.length) {
      this.report("E308", `This returns ${types.length} values but ${node.targets.length} names are listed.`, node.targets[0],
        `List ${types.length} names.`, node.targets[0].col + 1);
      node.targets.forEach((t) => this.markDefined(ctx, t.id));
      return [];
    }
    const syms = node.targets.map((t, i) => this.assignTarget(t, { k: "num", t: types[i], fixed: false }, ctx, false));
    if (syms.some((s) => !s)) return [];
    return [{ k: "unpack", syms, v: value }];
  }

  // Marks a name as set after an error so one slip doesn't report every later use.
  markDefined(ctx, name) {
    let sym = this.lookup(ctx, name, true);
    if (!sym) sym = this.declare(ctx, { id: name, line: 1, col: 1 }, "number", false, false);
    if (sym) sym.defined = true;
  }

  // Finds or creates the symbol an assignment writes, checking its type against earlier ones.
  assignTarget(target, value, ctx, loopVar, isVar = false) {
    const name = target.id;
    if (this.reserved(name, target, "name")) return null;
    let sym = this.lookup(ctx, name, true);
    const owner = ctx.scope;
    if (sym && sym.scope !== owner) sym = null;
    const first = !sym || !sym.defined;
    const t = value.t === "na" ? "number" : value.t;
    if (first) {
      const info = owner.info.get(name) || { count: 1, conditional: true, aug: false, isVar: false };
      const eligible = !loopVar && info.count === 1 && !info.conditional && !info.aug && !isVar && !ctx.cond;
      if (!sym) sym = this.declare(ctx, target, t, false, false);
      sym.t = sym.pre ? "number" : t;
      sym.defined = true;
      sym.isVar = isVar || info.isVar;
      sym.fixed = eligible && !!value.fixed;
      sym.constVal = sym.fixed ? this.constOf(value) : null;
      sym.boundVal = sym.fixed ? this.constOf(value, true) : null;
      return sym;
    }
    if (sym.t === "plot") { this.report("E214", `\`${name}\` is a plot handle and can't be set again.`, target); return null; }
    return sym;
  }

  declare(ctx, target, t, fixed, pre) {
    const name = target.id;
    const sym = this.newSym(name, t, fixed, ctx.fn ? ctx.fn.prefix : "v_", false);
    sym.scope = ctx.scope;
    sym.defined = !pre;
    sym.pre = pre;
    ctx.scope.vars.set(name, sym);
    return sym;
  }

  newSym(name, t, fixed, prefix, defined) {
    const sym = {
      id: this.symCount++, name, js: `${prefix}${name}`, t, fixed,
      isVar: false, hist: false, defined, input: null, scope: null,
    };
    this.syms.push(sym);
    return sym;
  }

  reserved(name, node, what) {
    const clash = (GLOBALS[name] && !SHADOWABLE.has(name)) || NAMESPACES.has(name);
    if (name.startsWith("__")) {
      this.report("E211", `Names can't start with two underscores (\`${name}\`).`, node, `Rename it, like \`${name.replace(/^_+/, "")}\`.`, node.col + name.length);
      return true;
    }
    if (clash) {
      const kind = GLOBALS[name] && GLOBALS[name].kind === "series" ? "series" : "built-in name";
      this.report("E211", `\`${name}\` is a ${kind} momo script already has, so it can't be ${what === "function" ? "a function" : "a variable"} name.`, node,
        `Pick another name, like \`${name}_\` or \`my_${name}\`.`, node.col + name.length);
      return true;
    }
    return false;
  }

  // ---- inputs ------------------------------------------------------------------------------

  inputAssign(node, entry, ctx) {
    const name = node.target.id;
    const call = node.value;
    if (!ctx.top || ctx.cond || node.op !== "=" || node.isVar) {
      this.report("E214", "An input is set with `name = input.int(...)` at the top level of the script.", node, null, node.col + name.length);
      return [];
    }
    const info = this.top.info.get(name);
    if (info && info.count > 1) {
      this.report("E214", `\`${name}\` is an input, so it can't be set again.`, node.target, `Use another name for the second value: ${name}2 = ${name} + 1`);
      return [];
    }
    const kind = entry.name.slice(6);
    const args = this.bind(entry, call, ctx, { literals: true, sourceDefault: kind === "source" });
    if (!args) { this.markDefined(ctx, name); return []; }
    const by = Object.fromEntries(entry.args.map((a, i) => [a.name, args[i]]));
    const dflt = by.default.lit;
    const meta = { key: name, kind, default: dflt, title: by.title.lit || name, min: null, max: null, step: null, options: null, group: by.group.lit || "", tooltip: by.tooltip.lit || "" };
    if (kind === "int" || kind === "float") {
      meta.min = by.min.lit; meta.max = by.max.lit; meta.step = by.step.lit;
      if (kind === "int" && !Number.isInteger(dflt)) this.report("E301", "An int input needs a whole number.", call.args[0] || call, "Use input.float for decimals.");
      if (meta.min !== null && meta.max !== null && meta.min > meta.max) this.report("E301", "min is above max.", call);
      if ((meta.min !== null && dflt < meta.min) || (meta.max !== null && dflt > meta.max)) {
        this.report("E301", `The default ${dflt} is outside min..max.`, call.args[0] || call);
      }
    }
    if (kind === "choice") {
      const options = by.options.lit;
      const ok = Array.isArray(options) && options.length && options.every((o) => typeof o === "string");
      if (!ok) this.report("E215", "options must be a list of text, like options=[\"Left\", \"Right\"].", call);
      else if (!options.includes(dflt)) this.report("E301", `The default "${dflt}" isn't one of the options.`, call.args[0] || call);
      meta.options = options;
    }
    if (kind === "color") {
      const c = by.default.color;
      meta.default = formatColor(c) || "#2962ff";
    }
    if (kind === "source") meta.default = by.default.lit;
    const t = { int: "number", float: "number", source: "number", bool: "bool", choice: "string", color: "color" }[kind];
    const sym = this.declare(ctx, node.target, t, kind !== "source", false);
    sym.defined = true;
    sym.fixed = kind !== "source";
    sym.constVal = kind === "int" || kind === "float" ? meta.default : null;
    sym.boundVal = kind === "int" || kind === "float" ? meta.max ?? meta.default : null;
    const input = { k: "input", kind, key: name, t, fixed: kind !== "source", meta, def: meta.default, min: meta.min, max: meta.max, id: this.inputs.length, line: call.line, col: call.col };
    sym.input = input;
    this.inputs.push(input);
    return [];
  }

  // ---- outputs -----------------------------------------------------------------------------

  uniqueKey(title) {
    let base = slug(title);
    let key = base;
    for (let n = 2; this.keys.has(key); n++) key = `${base}_${n}`;
    this.keys.add(key);
    return key;
  }

  output(call, entry, ctx, handle) {
    if (entry.name !== "log" && (!ctx.top || ctx.cond)) {
      const where = ctx.fn ? "inside a function" : `inside ${ctx.why || "an if"}`;
      this.report("E207", `${entry.name}() has to be at the top level of the script, not ${where}.`, call,
        "Compute the value you need there, then call it at the top level.", this.span(call));
      return [];
    }
    if (entry.later) { this.later(entry, call); return []; }
    const args = this.bind(entry, call, ctx, { variadic: entry.variadic });
    if (!args) return [];
    const by = Object.fromEntries(entry.args.map((a, i) => [a.name, args[i]]));
    const lit = (n) => by[n] && by[n].lit;
    const name = entry.name;
    const colorOf = (a) => (a && a.e ? a.e : null);
    const meta = (extra) => { this.outputs.push(extra); return extra; };

    switch (name) {
      case "plot": {
        const title = lit("title") || `Plot ${this.plotCount + 1}`;
        this.plotCount++;
        const key = this.uniqueKey(title);
        const style = lit("style");
        const c = colorOf(by.color);
        meta({
          key, kind: style, title, color: c && c.k === "color" ? formatColor(c.v) : null, colorSeries: !!c && c.k !== "color" && c.k !== "na",
          width: lit("width"), style, ...(lit("format") ? { format: lit("format") } : {}),
        });
        if (handle) handle.key = key;
        return [{ k: "out", what: "plot", key, v: by.src.e, color: c }];
      }
      case "hline": {
        const title = lit("title") || "Line";
        const key = this.uniqueKey(title);
        const c = colorOf(by.color);
        meta({ key, kind: "hline", title, color: c && c.k === "color" ? formatColor(c.v) : null, width: 1, style: lit("style"), price: this.constOf(by.price.e) });
        this.plotCount++;
        if (handle) handle.key = key;
        return [];
      }
      case "fill": {
        const refs = [by.a.e, by.b.e];
        if (refs.some(isErr)) return [];
        const key = this.uniqueKey("fill");
        const c = colorOf(by.color);
        meta({ key, kind: "fill", title: "Fill", color: c && c.k === "color" ? formatColor(c.v) : null, colorSeries: !!c && c.k !== "color" && c.k !== "na", a: refs[0].key, b: refs[1].key });
        return c && c.k !== "color" ? [{ k: "out", what: "fill", key, color: c }] : [];
      }
      case "level": {
        const title = lit("title") || "Level";
        const key = this.uniqueKey(title);
        const c = colorOf(by.color);
        meta({ key, kind: "level", title, color: c && c.k === "color" ? formatColor(c.v) : null, width: 1, style: lit("style") });
        return [{ k: "out", what: "level", key, v: by.price.e, show: by.show.e, color: c, style: lit("style"), title }];
      }
      case "marker": {
        const title = lit("title") || "Marker";
        const key = this.uniqueKey(title);
        const c = colorOf(by.color);
        const at = by.at.e;
        const atMode = at.k === "str" ? at.v : "price";
        if (at.k === "str" && at.v !== "above" && at.v !== "below") {
          const near = didYouMean(at.v, ["above", "below"]);
          this.report("E305", `at must be "above", "below" or a price, not "${at.v}".`, call.kwargs.find((k) => k.name === "at") || call, near ? `Did you mean "${near}"?` : null);
        }
        meta({ key, kind: "marker", title, color: c && c.k === "color" ? formatColor(c.v) : null, shape: lit("shape"), at: atMode });
        return [{ k: "out", what: "marker", key, cond: by.cond.e, at: atMode === "price" ? this.coerce(at, "number", call) : null, atMode, color: c, shape: lit("shape"), text: by.text.e }];
      }
      case "barcolor": case "bgcolor": {
        if (this.outputs.some((o) => o.kind === name)) {
          // A second barcolor()/bgcolor() layers on the first: later non-empty colours win.
        } else {
          meta({ key: this.uniqueKey(name), kind: name, title: name === "barcolor" ? "Bar colour" : "Background", color: null });
        }
        return [{ k: "out", what: name, color: by.color.e }];
      }
      case "stat":
        return [{ k: "out", what: "stat", title: lit("title"), v: by.x.e, color: colorOf(by.color), format: lit("format") }];
      case "signal": case "value": {
        const label = lit("name");
        if (label === undefined || label === null) return [];
        if (!SIGNAL_NAME.test(label)) {
          this.report("E215", "A signal name starts with a letter and uses letters, digits and _ (32 at most).", call.args[0] || call);
          return [];
        }
        if (this.names.has(label)) {
          this.report("E216", `The name "${label}" is used twice.`, call.args[0] || call, "Give each signal() and value() its own name.");
          return [];
        }
        this.names.add(label);
        this.signals.push({ name: label, kind: name === "signal" ? "bool" : "number" });
        return [{ k: "out", what: name, name: label, v: name === "signal" ? by.cond.e : by.x.e }];
      }
      case "log":
        return [{ k: "out", what: "log", args: args.map((a) => a.e) }];
      default:
        this.report("E217", `${name}() isn't available yet.`, call);
        return [];
    }
  }

  later(entry, node) {
    this.report("E217", `${entry.name} isn't available yet (planned: ${entry.later}).`, node, null, this.span(node));
    return ERROR_TYPE;
  }

  // ---- looking names up --------------------------------------------------------------------

  // The symbol a name means here: this scope, then (inside a function) the top level.
  lookup(ctx, name, ownOnly = false) {
    const scope = ctx ? ctx.scope : this.top;
    const own = scope.vars.get(name);
    if (own || ownOnly) return own || null;
    return scope !== this.top ? this.top.vars.get(name) || null : null;
  }

  read(sym) {
    return { k: "sym", t: sym.t, fixed: sym.fixed, sym };
  }

  // ---- expressions -------------------------------------------------------------------------

  expr(node, ctx) {
    switch (node.type) {
      case "Num": return { k: "num", t: "number", fixed: true, v: node.value };
      case "Str":
        if (node.value.length > LIMITS.string) this.report("E403", `Text is limited to ${LIMITS.string} characters.`, node);
        return { k: "str", t: "string", fixed: true, v: node.value };
      case "Bool": return { k: "bool", t: "bool", fixed: true, v: node.value };
      case "Na": return { k: "na", t: "na", fixed: true };
      case "Name": return this.nameExpr(node, ctx);
      case "FStr": return this.fstr(node, ctx);
      case "List": return this.listExpr(node, ctx);
      case "Tuple":
        return this.fail("E308", "A group of values with commas only works in `return a, b`.", node, "Return them from a function and unpack: a, b = f(...)");
      case "Unary": return this.unary(node, ctx);
      case "Binary": return this.binary(node, ctx);
      case "Cond": return this.condExpr(node, ctx);
      case "Index": return this.index(node, ctx);
      case "Attr": return this.attr(node, ctx);
      case "Call": return this.call(node, ctx);
      default: return this.fail("E213", "Unsupported expression.", node);
    }
  }

  nameExpr(node, ctx) {
    const name = node.id;
    const sym = this.lookup(ctx, name);
    if (sym) {
      if (!sym.defined) {
        return this.fail("E203", `\`${name}\` is used before it is set.`, node,
          `Set \`${name}\` on an earlier line, or read last bar's value with ${name}[1].`);
      }
      if (sym.t === "plot") return { k: "plotref", t: "plot", fixed: true, key: sym.plotKey };
      return this.read(sym);
    }
    const entry = GLOBALS[name];
    if (entry && entry.kind === "series") return this.series(name, entry, node);
    if (this.functions.has(name) || (entry && entry.kind !== "series")) {
      return this.fail("E309", `\`${name}\` is a function; call it with ( ).`, node, `${name}(...)`);
    }
    if (NAMESPACES.has(name)) {
      return this.fail("E305", `\`${name}\` is a group of built-ins; pick one, like ${members(name).slice(0, 2).map((m) => `${name}.${m}`).join(" or ")}.`, node);
    }
    return this.unknown(name, node, ctx);
  }

  unknown(name, node, ctx) {
    const scope = ctx ? ctx.scope : this.top;
    const candidates = [...scope.vars.keys(), ...this.top.vars.keys(), ...this.functions.keys(),
      ...Object.keys(GLOBALS).filter((n) => !n.includes(".")), ...NAMESPACES];
    const near = didYouMean(name, candidates);
    if (scope.info.has(name) || this.top.info.has(name)) {
      return this.fail("E203", `\`${name}\` is used before it is set.`, node, `Set \`${name}\` on an earlier line.`);
    }
    return this.fail("E201", `\`${name}\` isn't defined.`, node, near ? `Did you mean \`${near}\`?` : null);
  }

  series(name, entry, node) {
    if (entry.later) return this.later(entry, node);
    this.uses.add(name);
    const fixed = !!entry.fixed;
    return { k: "ser", t: entry.type, fixed, name };
  }

  fstr(node, ctx) {
    const parts = node.parts.map((p) => {
      if (typeof p === "string") return p;
      const e = this.expr(p.expr, ctx);
      if (!isErr(e) && (e.t === "list" || e.t === "plot" || e.t === "tuple" || e.t === "void")) {
        this.report("E301", "An f-string can show numbers, true/false, text and colours.", p.expr);
        return { e: ERROR_TYPE, spec: p.spec };
      }
      return { e, spec: p.spec };
    });
    const fixed = parts.every((p) => typeof p === "string" || p.e.fixed);
    return { k: "fstr", t: "string", fixed, parts };
  }

  listExpr(node, ctx) {
    if (node.items.length > LIMITS.list) this.report("E404", `A list holds at most ${LIMITS.list} items.`, node);
    const items = node.items.map((n) => this.coerce(this.expr(n, ctx), "number", n));
    return { k: "list", t: "list", fixed: false, items };
  }

  unary(node, ctx) {
    const a = this.expr(node.operand, ctx);
    if (isErr(a)) return a;
    if (node.op === "not") return { k: "un", op: "!", t: "bool", fixed: a.fixed, a: this.coerce(a, "bool", node.operand) };
    const n = this.coerce(a, "number", node.operand);
    if (isErr(n)) return n;
    if (n.k === "num") return { ...n, v: -n.v };
    return { k: "un", op: "-", t: "number", fixed: n.fixed, a: n };
  }

  bin(op, a, b) {
    return { k: "bin", op, t: ARITH.has(op) ? "number" : "bool", fixed: a.fixed && b.fixed, a, b };
  }

  binary(node, ctx) {
    const left = this.expr(node.left, ctx);
    const right = this.expr(node.right, ctx);
    if (isErr(left) || isErr(right)) return ERROR_TYPE;
    const op = node.op;
    if (op === "and" || op === "or") {
      return { k: "bin", op: op === "and" ? "&&" : "||", t: "bool", fixed: left.fixed && right.fixed,
        a: this.coerce(left, "bool", node.left), b: this.coerce(right, "bool", node.right) };
    }
    if (ARITH.has(op) || ORDER.has(op)) {
      const a = this.coerce(left, "number", node.left, `\`${op}\` needs numbers`);
      const b = this.coerce(right, "number", node.right, `\`${op}\` needs numbers`);
      return isErr(a) || isErr(b) ? ERROR_TYPE : this.bin(op, a, b);
    }
    // == and !=: numbers, text, true/false and colours compare with their own kind.
    const kinds = new Set([left.t, right.t].filter((t) => t !== "na"));
    if (kinds.size === 2 && !(kinds.has("number") && (kinds.has("bool") || kinds.has("color")))) {
      return this.fail("E301", `Can't compare ${this.say(left.t)} with ${this.say(right.t)}.`, node);
    }
    if (left.t === "list" || right.t === "list" || left.t === "plot" || right.t === "plot") {
      return this.fail("E301", "Lists can't be compared.", node);
    }
    if (kinds.has("string")) {
      return { k: "bin", op: op === "==" ? "===" : "!==", t: "bool", fixed: left.fixed && right.fixed, a: left, b: right, text: true };
    }
    const a = this.coerce(left, "number", node.left);
    const b = this.coerce(right, "number", node.right);
    return { k: "bin", op, t: "bool", fixed: a.fixed && b.fixed, a, b };
  }

  condExpr(node, ctx) {
    const test = this.coerce(this.expr(node.test, ctx), "bool", node.test);
    const a = this.expr(node.then, ctx);
    const b = this.expr(node.else, ctx);
    if (isErr(test) || isErr(a) || isErr(b)) return ERROR_TYPE;
    let t;
    if (a.t === "na") t = b.t === "na" ? "number" : b.t;
    else if (b.t === "na" || a.t === b.t) t = a.t;
    else if ((a.t === "number" || a.t === "bool" || a.t === "color") && (b.t === "number" || b.t === "bool" || b.t === "color")) {
      t = a.t === "color" || b.t === "color" ? (a.t === "bool" || b.t === "bool" ? "number" : "color") : "number";
    } else return this.fail("E301", `The two sides of this condition are different kinds (${this.say(a.t)} and ${this.say(b.t)}).`, node);
    if (t === "list" || t === "plot") return this.fail("E301", "A condition can choose between numbers, text, true/false and colours.", node);
    return { k: "cond", t, fixed: test.fixed && a.fixed && b.fixed, test, a: this.fit(a, t, node.then), b: this.fit(b, t, node.else) };
  }

  say(t) {
    return { number: "a number", bool: "true/false", string: "text", color: "a colour", list: "a list", na: "na", plot: "a plot", void: "nothing", tuple: "several values" }[t] || t;
  }

  // ---- type coercion -----------------------------------------------------------------------

  // Converts `e` for a place that wants type `want`; reports E301 when it can't.
  coerce(e, want, node, lead) {
    if (isErr(e)) return e;
    if (want === "any") {
      if (e.t === "list" || e.t === "plot" || e.t === "tuple" || e.t === "void") return this.mismatch(e, "a number, true/false or text", node, lead);
      return e.t === "na" ? { k: "na", t: "number", fixed: true } : e;
    }
    if (e.t === want) return e;
    if (e.t === "na") return want === "list" || want === "plot" ? this.mismatch(e, this.say(want), node, lead) : { k: "na", t: want, fixed: true };
    if (want === "number" && e.t === "bool") return { k: "b2n", t: "number", fixed: e.fixed, a: e };
    if ((want === "number" && e.t === "color") || (want === "color" && e.t === "number")) return { ...e, t: want };
    if (want === "bool" && (e.t === "number" || e.t === "color")) return { k: "n2b", t: "bool", fixed: e.fixed, a: e };
    return this.mismatch(e, this.say(want), node, lead);
  }

  mismatch(e, wanted, node, lead) {
    const hint = e.t === "string" && wanted === "a colour" ? 'Write a colour like color.red or "#ff9800".' : null;
    return this.fail("E301", `${lead || "Expected " + wanted} but this is ${this.say(e.t)}.`, node, hint);
  }

  // Coerces a value stored in a variable of type `t` (E302 when it doesn't fit).
  fit(e, t, node, name) {
    if (isErr(e)) return e;
    if (e.t === t || e.t === "na") return this.coerce(e, t, node);
    const ok = (t === "number" && (e.t === "bool" || e.t === "color")) || (t === "bool" && (e.t === "number" || e.t === "color")) ||
      (t === "color" && e.t === "number") || (t === "number" && e.t === "color");
    if (ok) return this.coerce(e, t, node);
    return this.fail("E302", `${name ? `\`${name}\`` : "This"} holds ${this.say(t)} but is set to ${this.say(e.t)} here.`, node,
      "Use a different name for a value of another kind.");
  }

  // The compile-time value of a fixed expression, or null.
  // `bound`: for inputs, the largest value they can take (how much history a script may need).
  constOf(e, bound = false) {
    if (!e || isErr(e)) return null;
    switch (e.k) {
      case "num": return e.v;
      case "bool": return e.v ? 1 : 0;
      case "str": return e.v;
      case "color": return e.v;
      case "b2n": case "n2b": return this.constOf(e.a, bound);
      case "sym": return (bound ? e.sym.boundVal : e.sym.constVal) ?? null;
      case "input": return e.kind === "int" || e.kind === "float" ? (bound ? e.max ?? e.def : e.def) : null;
      case "un": { const a = this.constOf(e.a, bound); return a === null ? null : e.op === "-" ? -a : null; }
      case "bin": {
        const a = this.constOf(e.a, bound);
        const b = this.constOf(e.b, bound);
        if (a === null || b === null || typeof a !== "number" || typeof b !== "number") return null;
        switch (e.op) {
          case "+": return a + b;
          case "-": return a - b;
          case "*": return a * b;
          case "/": return b === 0 ? null : a / b;
          case "%": return b === 0 ? null : ((a % b) + b) % b;
          case "**": return a ** b;
          default: return null;
        }
      }
      case "pure": {
        if (!e.entry.js && e.entry.rt !== "round") return null;
        const values = e.args.map((a) => this.constOf(a, bound));
        if (values.some((v) => typeof v !== "number")) return null;
        if (e.entry.rt === "round") return Math.round(values[0]);
        return globalThis.Math[e.entry.js.slice(5)](...values);
      }
      default: return null;
    }
  }

  // ---- history and indexing ----------------------------------------------------------------

  // x[1] may come before x's first assignment in the text (last bar's value): the name is made
  // now, as a number, and the later assignment fills it in.
  historyTarget(node, ctx) {
    if (node.type === "Name") {
      let sym = this.lookup(ctx, node.id);
      if (!sym && !GLOBALS[node.id] && !NAMESPACES.has(node.id) && ctx.scope.info.has(node.id)) {
        sym = this.declare(ctx, node, "number", false, true);
      }
      if (sym && sym.t !== "plot") return this.read(sym);
    }
    return this.expr(node, ctx);
  }

  index(node, ctx) {
    const target = this.historyTarget(node.target, ctx);
    if (isErr(target)) { this.expr(node.index, ctx); return ERROR_TYPE; }
    const idxNode = node.index;
    if (target.t === "list") {
      const i = this.coerce(this.expr(idxNode, ctx), "number", idxNode);
      return isErr(i) ? i : { k: "lget", t: "number", fixed: false, list: target, index: i };
    }
    if (target.t !== "number" && target.t !== "bool" && target.t !== "color") {
      return this.fail("E306", `Can't index ${this.say(target.t)}; only numbers, true/false and lists have history or items.`, node);
    }
    const off = this.expr(idxNode, ctx);
    if (isErr(off)) return off;
    const negative = (idxNode.type === "Unary" && idxNode.op === "-") || (off.k === "num" && off.v < 0);
    if (negative || (this.constOf(off) !== null && this.constOf(off) < 0)) {
      return this.fail("E206", "A script can't look at future bars, so a history index can't be negative.", idxNode,
        "Use x[1] for the previous bar. Pivots confirm themselves `right` bars late on purpose.");
    }
    const offset = this.coerce(off, "number", idxNode);
    if (isErr(offset)) return offset;
    if (!offset.fixed) {
      return this.fail("E304", "A history index must be the same on every bar: a number or an input.", idxNode,
        "Use a literal like close[5], or an input.int.");
    }
    const c = this.constOf(offset);
    if (c === 0) return target;
    this.maxOffset = Math.max(this.maxOffset, c === null ? 0 : c);
    const t = target.t === "color" ? "number" : target.t;
    if (target.k === "ser" && GLOBALS[target.name].array) {
      return { k: "hist", mode: "array", name: target.name, t, fixed: false, off: offset };
    }
    if (target.k === "sym") {
      const sym = target.sym;
      sym.hist = true;
      if (sym.input) return { k: "hist", mode: "input", sym, t, fixed: false, off: offset };
      return { k: "hist", mode: "sym", sym, t: sym.pre ? "number" : t, fixed: false, off: offset };
    }
    if (ctx.cond) {
      return this.fail("E205", `The history of an expression can't be read inside ${ctx.why || "an if"}, because it has to be tracked on every bar.`, node,
        "Assign the expression to a name above, then index the name: x = a + b, then x[1].");
    }
    const id = this.hiddenCount++;
    this.hidden.push({ id, t });
    return { k: "hist", mode: "hidden", id, value: target, t, fixed: false, off: offset };
  }

  attr(node, ctx) {
    const dotted = this.flatten(node);
    const root = dotted && dotted.split(".")[0];
    if (dotted && !this.lookup(ctx, root) && !this.functions.has(root)) {
      const entry = GLOBALS[dotted];
      if (entry) {
        if (entry.kind === "const") return { k: "color", t: "color", fixed: true, v: entry.value };
        if (entry.kind === "series") return this.series(dotted, entry, node);
        return this.fail("E309", `\`${dotted}\` is a function; call it with ( ).`, node);
      }
      if (NAMESPACES.has(root) && node.target.type === "Name") {
        return this.fail("E202", `\`${node.name}\` isn't in \`${root}\`.`, { ...node, col: node.nameCol, line: node.nameLine },
          this.suggest(node.name, root), node.nameCol + node.name.length);
      }
      if (!NAMESPACES.has(root) && node.target.type === "Name") return this.nameExpr(node.target, ctx);
    }
    const target = this.expr(node.target, ctx);
    if (isErr(target)) return target;
    const at = { line: node.nameLine, col: node.nameCol };
    const methods = METHODS[target.t === "color" ? "color" : target.t] || {};
    if (methods[node.name]) {
      return this.fail("E306", `\`${node.name}\` is a method; call it with ( ).`, at, `${node.name}(...)`, node.nameCol + node.name.length);
    }
    return this.fail("E202", `${this.say(target.t)[0].toUpperCase()}${this.say(target.t).slice(1)} has no \`${node.name}\`.`, at, null, node.nameCol + node.name.length);
  }

  suggest(name, namespace) {
    const near = didYouMean(name, members(namespace));
    return near ? `Did you mean \`${namespace}.${near}\`?` : `${namespace} has: ${members(namespace).join(", ")}.`;
  }

  // ---- calls -------------------------------------------------------------------------------

  call(node, ctx) {
    const callee = node.callee;
    if (callee.type === "Name") return this.callName(node, callee.id, ctx);
    // ns.fn(...) or value.method(...)
    const dotted = this.flatten(callee);
    const root = dotted && dotted.split(".")[0];
    if (dotted && !this.lookup(ctx, root) && !this.functions.has(root)) {
      const entry = GLOBALS[dotted];
      if (entry) return this.callEntry(node, entry, ctx);
      if (NAMESPACES.has(root) && callee.target.type === "Name") {
        return this.fail("E202", `\`${callee.name}\` isn't in \`${root}\`.`, { line: callee.nameLine, col: callee.nameCol },
          this.suggest(callee.name, root), callee.nameCol + callee.name.length);
      }
    }
    return this.methodCall(node, ctx);
  }

  callName(node, name, ctx) {
    const sym = this.lookup(ctx, name);
    if (sym) return this.fail("E305", `\`${name}\` is a value, not a function.`, node.callee, null, this.span(node.callee));
    const fn = this.functions.get(name);
    if (fn) return this.callUser(node, fn, ctx);
    const entry = GLOBALS[name];
    if (entry && entry.kind !== "series" && entry.kind !== "const") return this.callEntry(node, entry, ctx);
    if (NAMESPACES.has(name)) return this.fail("E305", `\`${name}\` is a group of built-ins; write ${name}.something(...).`, node.callee);
    if (this.allDefs.has(name)) {
      return this.fail("E201", `The function \`${name}\` is defined below this line.`, node.callee, "Move the `def` above its first use.", this.span(node.callee));
    }
    return this.unknown(name, node.callee, ctx);
  }

  callEntry(node, entry, ctx) {
    if (entry.later) return this.later(entry, node.callee);
    switch (entry.kind) {
      case "ta": return this.taCall(node, entry, ctx);
      case "pure": return this.pureCall(node, entry, ctx);
      case "input":
        return this.fail("E214", "An input is set with `name = input.int(...)` at the top level of the script.", node, null, this.span(node));
      case "output":
        return this.fail("E207", `${entry.name}() is a statement at the top level of the script; it can't be used as a value.`, node, null, this.span(node));
      case "special": return this.specialCall(node, entry, ctx);
      default:
        return this.fail("E309", `\`${entry.name}\` can't be called.`, node);
    }
  }

  pureCall(node, entry, ctx) {
    const args = this.bind(entry, node, ctx, { variadic: entry.variadic });
    if (!args) return ERROR_TYPE;
    const exprs = args.map((a) => a.e);
    if (exprs.some(isErr)) return ERROR_TYPE;
    const t = entry.returns;
    return { k: "pure", t, fixed: exprs.every((e) => e.fixed), entry, args: exprs };
  }

  specialCall(node, entry, ctx) {
    const name = entry.name;
    if (name === "indicator") return this.fail("E210", "indicator(...) is the first line of the script, once.", node, null, this.span(node));
    if (name === "range") return this.fail("E309", "range(...) only works in a `for` loop.", node, "Write `for i in range(10):`.", this.span(node));
    const args = this.bind(entry, node, ctx, {});
    if (!args) return ERROR_TYPE;
    const [a, b] = args.map((x) => x.e);
    if (args.some((x) => isErr(x.e))) return ERROR_TYPE;
    if (name === "na") return { k: "isna", t: "bool", fixed: a.fixed, a };
    if (name === "nz") return { k: "nz", t: "number", fixed: a.fixed && b.fixed, a, b };
    if (name === "len") return { k: "len", t: "number", fixed: false, a };
    return this.later(entry, node);
  }

  taCall(node, entry, ctx) {
    if (ctx.cond) {
      return this.fail("E204", `${entry.name} runs inside ${ctx.why || "an if"}, so it would skip bars.`, node,
        `Compute it above, on every bar, then use the result: avg = ${entry.example.replace(/^[\w, ]+ = /, "")}`, this.span(node));
    }
    const args = this.bind(entry, node, ctx, {});
    if (!args) return ERROR_TYPE;
    if (args.some((a) => isErr(a.e))) return ERROR_TYPE;
    const ctor = [];
    const step = [];
    const values = {};
    entry.args.forEach((a, i) => {
      (a.fixed ? ctor : step).push(args[i].e);
      if (a.fixed) values[a.name] = this.constOf(args[i].e);
    });
    entry.args.forEach((a, i) => {
      const c = values[a.name];
      if (!a.fixed || typeof c !== "number") return;
      const min = a.name === "nth" ? 0 : 1;
      if (!Number.isInteger(c) || c < min || c > LIMITS.length) {
        const at = node.args[i] || node.kwargs.find((k) => k.name === a.name) || node;
        this.report("E301", `${a.name} must be a whole number from ${min} to ${LIMITS.length}.`, at, null, this.span(at));
      }
    });
    const bounds = {};
    entry.args.forEach((a, i) => { if (a.fixed) bounds[a.name] = this.constOf(args[i].e, true); });
    const lookback = entry.history ? entry.history(bounds) : Math.max(0, ...Object.values(bounds).filter((v) => typeof v === "number"));
    this.maxLength = Math.max(this.maxLength, lookback || 0);
    const id = this.taCount++;
    const multi = Array.isArray(entry.returns);
    const stepper = { id, entry, site: [node.line, node.col], ctor, step, implicit: entry.implicit };
    this.steppers.push(stepper);
    for (const i of entry.implicit) this.uses.add(i);
    return {
      k: "ta", t: multi ? "tuple" : entry.returns, types: multi ? entry.returns.map(() => "number") : undefined,
      fixed: false, stepper,
    };
  }

  // ---- argument binding --------------------------------------------------------------------

  // Matches a call's arguments to the entry's parameters. Returns [{ e, lit, missing }] in
  // parameter order, or null after reporting.
  bind(entry, node, ctx, opts) {
    const params = entry.args;
    const slots = new Array(params.length).fill(null);
    let ok = true;
    const fail = (message, at, fix) => { this.fail("E303", message, at, fix); ok = false; };
    node.args.forEach((arg, i) => {
      if (i >= params.length) {
        if (opts.variadic) { (slots.extra ||= []).push({ node: arg, param: params[params.length - 1] }); return; }
        fail(`${entry.name} takes ${params.length} argument${params.length === 1 ? "" : "s"} but got ${node.args.length}.`, arg, `Signature: ${signature(entry)}`);
        return;
      }
      slots[i] = { node: arg, param: params[i] };
    });
    let unknown = false;
    for (const kw of node.kwargs) {
      const key = KWARG_ALIASES[kw.name] && !params.some((p) => p.name === kw.name) ? KWARG_ALIASES[kw.name] : kw.name;
      const i = params.findIndex((p) => p.name === key);
      if (i < 0) {
        const near = didYouMean(kw.name, params.map((p) => p.name));
        unknown = true;
        fail(`${entry.name} has no argument \`${kw.name}\`.`, kw, near ? `Did you mean \`${near}\`?` : `Signature: ${signature(entry)}`);
      } else if (slots[i]) {
        fail(`\`${key}\` is given twice.`, kw);
      } else slots[i] = { node: kw.value, param: params[i] };
    }
    params.forEach((p, i) => {
      if (!slots[i] && !Object.hasOwn(p, "default") && !unknown) {
        fail(`${entry.name} needs \`${p.name}\`.`, node, `Signature: ${signature(entry)}`);
      }
    });
    if (!ok) return null;
    const bound = params.map((p, i) => (slots[i] ? this.argument(entry, slots[i], ctx, opts) : this.defaultArg(p)));
    for (const extra of slots.extra || []) bound.push(this.argument(entry, extra, ctx, opts));
    return bound.some((b) => b.bad) ? null : bound;
  }

  defaultArg(p) {
    const d = p.default;
    let e;
    if (d === null || d === undefined) e = { k: "na", t: "na", fixed: true };
    else if (typeof d === "number") e = { k: "num", t: "number", fixed: true, v: d };
    else if (typeof d === "boolean") e = { k: "bool", t: "bool", fixed: true, v: d };
    else e = { k: "str", t: "string", fixed: true, v: d };
    if (p.type === "color" && e.t === "na") e = { k: "color", t: "color", fixed: true, v: 0 };
    if (p.type === "number" && e.t === "na") e = { k: "na", t: "number", fixed: true };
    return { e, lit: d === undefined ? null : d, missing: true };
  }

  // One argument: literal, fixed and type requirements, then the value.
  argument(entry, { node, param }, ctx, opts) {
    const where = `${entry.name}(${param.name})`;
    if (param.literal) {
      const lit = this.literal(node, param, opts);
      if (!lit.ok) {
        this.report("E215", `${param.name} must be written out as a ${param.type === "string" ? "piece of text" : param.type === "bool" ? "true or false" : "literal value"}, not worked out.`, node,
          param.type === "string" ? `Like ${param.name}="..."` : null, this.span(node));
        return { bad: true };
      }
      if (param.choices && !param.choices.includes(lit.value)) {
        const near = didYouMean(String(lit.value), param.choices);
        this.report("E305", `${param.name} must be one of ${param.choices.map((c) => `"${c}"`).join(", ")}, not "${lit.value}".`, node, near ? `Did you mean "${near}"?` : null);
        return { bad: true };
      }
      if (param.type === "string" && typeof lit.value === "string" && lit.value.length > LIMITS.string) {
        this.report("E403", `Text is limited to ${LIMITS.string} characters.`, node);
        return { bad: true };
      }
      const e = this.literalExpr(lit, param, node);
      return { e, lit: lit.value, color: lit.color, ok: true };
    }
    let e = this.expr(node, ctx);
    if (param.type === "color" && node.type === "Str") {
      const packed = parseColor(node.value);
      if (packed === null) {
        this.report("E307", `"${node.value}" isn't a colour.`, node, 'Write "#rrggbb", like "#2962ff", or use color.blue.');
        return { bad: true };
      }
      e = { k: "color", t: "color", fixed: true, v: packed };
    }
    if (isErr(e)) return { bad: true, e };
    if (param.type === "any") {
      if (node.type === "Str" && entry.name === "marker") return { e, lit: node.value };
      e = this.coerce(e, "any", node);
    } else {
      e = this.coerce(e, param.type, node, `${where} wants ${this.say(param.type)}`);
      if (param.fixed && !isErr(e) && !e.fixed) {
        this.report("E304", `${param.name} must be the same on every bar: a number or an input, not a series.`, node,
          `Use a literal like ${param.name === "length" ? "20" : "14"}, or an input.int.`, this.span(node));
        return { bad: true };
      }
    }
    if (isErr(e)) return { bad: true, e };
    return { e, lit: this.literalOf(node) };
  }

  // The plain value of a literal argument, or a failure.
  literal(node, param, opts) {
    const lit = this.literalOf(node);
    if (lit !== undefined) {
      if (param.type === "number" && typeof lit !== "number") return { ok: false };
      if (param.type === "string" && typeof lit !== "string" && lit !== null) return { ok: false };
      if (param.type === "bool" && typeof lit !== "boolean") return { ok: false };
      if (param.type === "color") {
        if (typeof lit !== "string") return { ok: false };
        const c = parseColor(lit);
        if (c === null) { this.report("E307", `"${lit}" isn't a colour.`, node, 'Write "#rrggbb", like "#2962ff".'); return { ok: false }; }
        return { ok: true, value: lit, color: c };
      }
      if (param.type === "list" && !Array.isArray(lit)) return { ok: false };
      return { ok: true, value: lit };
    }
    if (param.type === "color" && node.type === "Attr") {
      const entry = GLOBALS[this.flatten(node)];
      if (entry && entry.kind === "const") return { ok: true, value: formatColor(entry.value), color: entry.value };
    }
    if (opts.sourceDefault && param.name === "default" && node.type === "Name" && SOURCES.includes(node.id)) {
      return { ok: true, value: node.id };
    }
    return { ok: false };
  }

  // A literal's JS value (number, text, true/false, list of those), or undefined.
  literalOf(node) {
    switch (node.type) {
      case "Num": return node.value;
      case "Str": return node.value;
      case "Bool": return node.value;
      case "Na": return null;
      case "Unary": {
        if (node.op !== "-") return undefined;
        const v = this.literalOf(node.operand);
        return typeof v === "number" ? -v : undefined;
      }
      case "List": {
        const items = node.items.map((n) => this.literalOf(n));
        return items.some((v) => v === undefined) ? undefined : items;
      }
      default: return undefined;
    }
  }

  literalExpr(lit, param, node) {
    const v = lit.value;
    if (lit.color !== undefined) return { k: "color", t: "color", fixed: true, v: lit.color };
    if (typeof v === "number") return { k: "num", t: "number", fixed: true, v };
    if (typeof v === "boolean") return { k: "bool", t: "bool", fixed: true, v };
    if (typeof v === "string") return { k: "str", t: "string", fixed: true, v };
    if (v === null) return { k: "na", t: "na", fixed: true };
    void node; void param;
    return { k: "na", t: "na", fixed: true };
  }

  // ---- methods on values -------------------------------------------------------------------

  methodCall(node, ctx) {
    const callee = node.callee;
    const target = this.expr(callee.target, ctx);
    const at = { line: callee.nameLine, col: callee.nameCol };
    if (isErr(target)) { node.args.forEach((a) => this.expr(a, ctx)); return target; }
    const type = target.t;
    const methods = Object.hasOwn(METHODS, type) ? METHODS[type] : {};
    const entry = methods[callee.name];
    if (!entry) {
      const near = didYouMean(callee.name, Object.keys(methods));
      return this.fail("E202", `${this.say(target.t)[0].toUpperCase()}${this.say(target.t).slice(1)} has no \`${callee.name}\`.`, at,
        near ? `Did you mean \`${near}\`?` : null, callee.nameCol + callee.name.length);
    }
    if (entry.later) return this.later({ ...entry, name: callee.name }, at);
    const args = this.bind({ ...entry, name: callee.name }, node, ctx, {});
    if (!args) return ERROR_TYPE;
    const exprs = args.map((a) => a.e);
    if (type === "color") {
      if (target.k === "color" && exprs[0].k === "num") return { k: "color", t: "color", fixed: true, v: withAlpha(target.v, exprs[0].v) };
      return { k: "pure", t: "color", fixed: target.fixed && exprs[0].fixed, entry: { rt: "alpha", js: null, name: "color.alpha" }, args: [target, ...exprs] };
    }
    const t = entry.returns === "void" ? "void" : entry.returns;
    return { k: "lm", t, fixed: false, name: callee.name, list: target, args: exprs, at: [node.line, node.col] };
  }

  // ---- user functions ----------------------------------------------------------------------

  callUser(node, fn, ctx) {
    const args = node.args.map((a) => this.expr(a, ctx));
    const kwargs = node.kwargs.map((k) => ({ name: k.name, value: this.expr(k.value, ctx), node: k }));
    return this.inline(fn, node, args, kwargs, ctx, false);
  }

  inline(fn, node, args, kwargs, ctx, dry) {
    const def = fn.node;
    fn.called ||= !dry;
    if (this.stack.includes(fn)) {
      return this.fail("E208", `\`${def.name}\` calls itself, which momo script doesn't allow.`, node,
        "Use a loop, or a ta function such as ta.sma, ta.highest or ta.cum instead.");
    }
    if (!dry && ++this.callCount > LIMITS.calls) {
      return this.fail("E405", `The functions in this script are called more than ${LIMITS.calls} times once expanded.`, node, "Call them less often, or simplify nested calls.");
    }
    const params = def.params;
    if (args.length > params.length) {
      return this.fail("E303", `${def.name} takes ${params.length} argument${params.length === 1 ? "" : "s"} but got ${args.length}.`, node);
    }
    const given = new Map();
    args.forEach((a, i) => given.set(params[i].name, a));
    for (const k of kwargs) {
      if (!params.some((p) => p.name === k.name)) {
        const near = didYouMean(k.name, params.map((p) => p.name));
        return this.fail("E303", `${def.name} has no argument \`${k.name}\`.`, k.node, near ? `Did you mean \`${near}\`?` : null);
      }
      if (given.has(k.name)) return this.fail("E303", `\`${k.name}\` is given twice.`, k.node);
      given.set(k.name, k.value);
    }
    const id = this.instCount++;
    const inst = { id, label: `L${id}`, prefix: `f${id}_`, res: [], size: null, def };
    const scope = new Scope("fn", this.top);
    scan(def.body, scope.info);
    for (const p of params) {
      const info = scope.info.get(p.name) || { count: 0 };
      scope.info.set(p.name, { ...info, count: info.count + 1 });
    }
    const fctx = { scope, top: false, cond: ctx.cond, why: ctx.cond ? `a function called from ${ctx.why}` : "", loop: false, fn: inst };
    const body = [];
    for (const p of params) {
      let value = given.get(p.name);
      if (!value) {
        if (!p.default) return this.fail("E303", `${def.name} needs \`${p.name}\`.`, node);
        value = this.expr(p.default, { ...fctx, scope: this.top });
      }
      if (isErr(value)) { scope.vars.set(p.name, Object.assign(this.newSym(p.name, "number", false, inst.prefix, true), { scope })); continue; }
      if (value.t === "tuple" || value.t === "void" || value.t === "plot") {
        this.report("E301", `${def.name}(${p.name}) can't take ${this.say(value.t)}.`, node);
        continue;
      }
      const t = value.t === "na" ? "number" : value.t;
      const sym = this.newSym(p.name, t, false, inst.prefix, true);
      sym.scope = scope;
      const info = scope.info.get(p.name);
      sym.fixed = !!value.fixed && info.count === 1 && !ctx.cond;
      sym.constVal = sym.fixed ? this.constOf(value) : null;
      sym.boundVal = sym.fixed ? this.constOf(value, true) : null;
      scope.vars.set(p.name, sym);
      body.push({ k: "set", sym, v: this.coerce(value, t, node) });
    }
    this.stack.push(fn);
    body.push(...this.stmts(def.body, fctx));
    this.stack.pop();
    if (inst.size === null || inst.size === 0) return { k: "inl", t: "void", fixed: false, label: inst.label, body, res: [] };
    const res = inst.res;
    if (res.filter(Boolean).length !== inst.size) return ERROR_TYPE;
    for (const s of res) s.defined = true;
    if (res.length > 1) {
      return { k: "inl", t: "tuple", types: res.map((s) => s.t), fixed: false, label: inst.label, body, res };
    }
    return { k: "inl", t: res[0].t, fixed: false, label: inst.label, body, res };
  }
}
