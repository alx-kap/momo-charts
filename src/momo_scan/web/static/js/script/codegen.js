// momo script code generator: the checker's IR → the JavaScript source of a function
// `(rt, bars, inputs, extra)` that loops over typed arrays and returns the run() result.
//
// Nothing from the script's text is copied into the output. User names become `v_name` (or
// `f<k>_name` inside an inlined function), strings go through `lit` (JSON with every character
// outside printable ASCII, and < > & ` $, escaped), numbers through `num`, and everything else
// is a fixed template here. A test feeds hostile scripts and checks the output uses only the
// tokens this file produces.
//
// Shape of the output:
//   constants (bar columns, inputs) · `let` state (var names, steppers, history) · the bar loop:
//   per-bar `let`s, the statements, history commits · `return rt.result({...})`.
// `ta` calls and inlined functions are hoisted into statements ahead of the one that uses them,
// so they run on every bar even inside a lazy `a if c else b`, `and` or `or`.

import { LIMITS } from "./runtime.js";

const lit = (s) => JSON.stringify(s).replace(/[^\x20-\x7e]|[<>&`$]/g, (c) => `\\u${c.charCodeAt(0).toString(16).padStart(4, "0")}`);

function num(v) {
  if (!Number.isFinite(v)) return "NaN";
  if (Object.is(v, -0)) return "(-0)";
  return v < 0 ? `(${v})` : String(v);
}

const COLUMNS = ["open", "high", "low", "close", "volume", "time"];
const DERIVED = ["hl2", "hlc3", "ohlc4", "bar_index"];
const CALENDAR = ["year", "month", "day", "dayofweek", "hour", "minute"];

const DEFAULTS = { number: "NaN", bool: "false", string: '""', color: "0", list: "[]" };

export function generate(ir) {
  return new Generator(ir).run();
}

class Generator {
  constructor(ir) {
    this.ir = ir;
    this.temps = 0;
    this.loops = 0;
    this.columns = new Set();
    this.derived = new Set();
    this.helpers = new Set(["stepLimit"]);
    this.cal = false;
    this.chart = false;
    this.steppers = new Map();
    this.history = new Map();      // sym id → sym
    this.plots = new Map();        // key → { arr, colors }
    this.signals = new Map();      // name → arr
    this.arrays = [];              // declarations for output buffers
    this.barColors = false;
    this.bgColors = false;
    this.varFlags = [];
    this.hiddenDecls = [];
    this.empty = false;
  }

  helper(name) { this.helpers.add(name); return name; }

  temp() { return `t${this.temps++}`; }

  run() {
    const body = [];
    this.stmts(this.ir.body, body);
    const commits = [...this.history.values()].map((s) => `H_${s.js}[i] = ${s.t === "bool" ? `${s.js} ? 1 : 0` : s.js};`);

    const plain = [];
    const state = [];
    for (const sym of this.ir.syms) {
      if (sym.input || sym.t === "plot") continue;
      const init = DEFAULTS[sym.t] ?? "NaN";
      (sym.isVar ? state : plain).push(`${sym.js} = ${init}`);
    }

    const head = ['"use strict";', "const N = bars.close.length;"];
    for (const c of COLUMNS) if (this.columns.has(c)) head.push(`const ${c} = bars.${c};`);
    for (const d of DERIVED) if (this.derived.has(d)) head.push(`const ${d} = rt.sourceSeries(bars, ${lit(d)});`);
    if (this.chart || this.cal) head.push("const ch = rt.chart(extra);");
    if (this.cal) head.push("const cal = rt.calendar(bars.time, ch.intraday);");
    head.push(`const { ${[...this.helpers].sort().join(", ")} } = rt;`);
    for (const input of this.ir.inputs) head.push(this.inputDecl(input));
    for (const [id] of this.steppers) head.push(`let s${id} = null;`);
    for (const flag of this.varFlags) head.push(`let ${flag} = false;`);
    if (state.length) head.push(`let ${state.join(", ")};`);
    for (const sym of this.history.values()) head.push(`const H_${sym.js} = new Float64Array(N);`);
    head.push(...this.hiddenDecls);
    if (this.empty) head.push("const EMPTY = new Float64Array(0);");
    head.push("const MK = [], LV = [], ST = [], LG = [];", ...this.arrays, "let steps = 0;");

    const loop = ["for (let i = 0; i < N; i++) {"];
    if (plain.length) loop.push(`let ${plain.join(", ")};`);
    loop.push(...body, ...commits, "}");

    const plots = [...this.plots.entries()].map(([key, p]) => `[${lit(key)}, ${p.arr}, ${p.colors || "null"}]`);
    const signals = [...this.signals.entries()].map(([name, arr]) => `[${lit(name)}, ${arr}]`);
    const tail = [
      `return rt.result({ plots: [${plots.join(", ")}], markers: MK, barColors: ${this.barColors ? "BC" : "null"}, `
      + `bgColors: ${this.bgColors ? "BG" : "null"}, levels: LV, stats: ST, signals: [${signals.join(", ")}], logs: LG });`,
    ];
    return [...head, ...loop, ...tail].join("\n");
  }

  inputDecl(input) {
    const { id, kind, key, meta } = input;
    const name = `in${id}`;
    const k = lit(key);
    const bound = (v) => (v === null || v === undefined ? "null" : num(v));
    switch (kind) {
      case "int": return `const ${name} = rt.inputNumber(inputs, ${k}, ${num(meta.default)}, ${bound(meta.min)}, ${bound(meta.max)}, true);`;
      case "float": return `const ${name} = rt.inputNumber(inputs, ${k}, ${num(meta.default)}, ${bound(meta.min)}, ${bound(meta.max)}, false);`;
      case "bool": return `const ${name} = rt.inputBool(inputs, ${k}, ${meta.default ? "true" : "false"});`;
      case "choice": return `const ${name} = rt.inputChoice(inputs, ${k}, ${lit(meta.default)}, [${meta.options.map(lit).join(", ")}]);`;
      case "color": return `const ${name} = rt.inputColor(inputs, ${k}, ${lit(meta.default)});`;
      default: return `const ${name} = rt.inputSource(bars, inputs, ${k}, ${lit(meta.default)});`;
    }
  }

  // ---- statements ---------------------------------------------------------------------------

  stmts(list, out) {
    for (const s of list) this.stmt(s, out);
  }

  step(node) {
    return `if (++steps > ${LIMITS.loopSteps}) stepLimit([${node.line}, ${node.col}], i);`;
  }

  stmt(s, out) {
    const pre = [];
    switch (s.k) {
      case "set": {
        const v = this.ex(s.v, pre);
        out.push(...pre, `${s.sym.js} = ${v};`);
        return;
      }
      case "varinit": {
        const flag = `iv${s.sym.id}`;
        this.varFlags.push(flag);
        const v = this.ex(s.v, pre);
        out.push(`if (!${flag}) {`, `${flag} = true;`, ...pre, `${s.sym.js} = ${v};`, "}");
        return;
      }
      case "unpack": return this.unpack(s, out);
      case "if": {
        const test = this.ex(s.test, pre);
        out.push(...pre, `if (${test}) {`);
        this.stmts(s.body, out);
        if (s.orelse.length) { out.push("} else {"); this.stmts(s.orelse, out); }
        out.push("}");
        return;
      }
      case "for": return this.forRange(s, out);
      case "forlist": {
        const id = this.loops++;
        const list = this.ex(s.list, pre);
        out.push(...pre, "{", `const xs${id} = ${list};`, `for (let k${id} = 0; k${id} < xs${id}.length; k${id}++) {`, this.step(s), `${s.sym.js} = xs${id}[k${id}];`);
        this.stmts(s.body, out);
        out.push("}", "}");
        return;
      }
      case "while": {
        const test = this.ex(s.test, pre);
        out.push("while (true) {", ...pre, `if (!(${test})) break;`, this.step(s));
        this.stmts(s.body, out);
        out.push("}");
        return;
      }
      case "break": out.push("break;"); return;
      case "continue": out.push("continue;"); return;
      case "ret": out.push(`break ${s.label};`); return;
      case "expr": {
        const e = this.ex(s.e, pre);
        out.push(...pre);
        if (s.e.k === "lm") out.push(`${e};`);
        return;
      }
      case "out": return this.output(s, out);
      default: throw new Error(`codegen: unknown statement ${s.k}`);
    }
  }

  forRange(s, out) {
    const pre = [];
    const id = this.loops++;
    const start = this.ex(s.start, pre);
    const stop = this.ex(s.stop, pre);
    const step = this.ex(s.step, pre);
    out.push(...pre, "{", `const a${id} = ${start}, b${id} = ${stop}, c${id} = ${step};`,
      `for (let k${id} = a${id}; c${id} > 0 ? k${id} < b${id} : c${id} < 0 && k${id} > b${id}; k${id} += c${id}) {`,
      this.step(s), `${s.sym.js} = k${id};`);
    this.stmts(s.body, out);
    out.push("}", "}");
  }

  unpack(s, out) {
    const pre = [];
    if (s.v.k === "ta") {
      const { name } = this.ta(s.v, pre);
      out.push(...pre);
      s.syms.forEach((sym, j) => out.push(`${sym.js} = ${name}.o${j};`));
      return;
    }
    this.ex(s.v, pre);
    out.push(...pre);
    s.syms.forEach((sym, j) => out.push(`${sym.js} = ${s.v.res[j].js};`));
  }

  // ---- outputs ------------------------------------------------------------------------------

  // The buffers behind a plot key: values (none for a fill, which only carries colours) and,
  // when its colour changes bar to bar, colours.
  plotBuffers(key, colored, valueless = false) {
    let p = this.plots.get(key);
    if (!p) {
      const n = this.plots.size;
      p = { arr: valueless ? "EMPTY" : `P${n}`, colors: null, n };
      this.plots.set(key, p);
      if (valueless) this.empty = true;
      else this.arrays.push(`const ${p.arr} = new Float64Array(N);`);
    }
    if (colored && !p.colors) {
      p.colors = `C${p.n}`;
      this.arrays.push(`const ${p.colors} = new Uint32Array(N);`);
    }
    return p;
  }

  isConstColor(e) { return !e || e.k === "color" || e.k === "na"; }

  output(s, out) {
    const pre = [];
    switch (s.what) {
      case "plot": {
        const colored = !this.isConstColor(s.color);
        const p = this.plotBuffers(s.key, colored);
        const v = this.ex(s.v, pre);
        const c = colored ? this.ex(s.color, pre) : null;
        out.push(...pre, `${p.arr}[i] = ${this.helper("F")}(${v});`);
        if (colored) out.push(`${p.colors}[i] = ${c};`);
        return;
      }
      case "fill": {
        const p = this.plotBuffers(s.key, true, true);
        const c = this.ex(s.color, pre);
        out.push(...pre, `${p.colors}[i] = ${c};`);
        return;
      }
      case "level": {
        const price = this.ex(s.v, pre);
        const show = this.ex(s.show, pre);
        const color = s.color ? this.ex(s.color, pre) : "0";
        out.push(...pre, `if (i === N - 1 && ${show}) ${this.helper("level")}(LV, ${lit(s.key)}, ${price}, ${color}, ${lit(s.style)}, ${lit(s.title)});`);
        return;
      }
      case "marker": {
        const cond = this.ex(s.cond, pre);
        const price = s.atMode === "above" ? this.arrayRead("high") : s.atMode === "below" ? this.arrayRead("low") : this.ex(s.at, pre);
        const color = s.color ? this.ex(s.color, pre) : "0";
        const text = this.ex(s.text, pre);
        out.push(...pre, `if (${cond}) ${this.helper("mark")}(MK, ${lit(s.key)}, ${lit(s.shape)}, i, ${price}, ${color}, ${text});`);
        return;
      }
      case "barcolor": case "bgcolor": {
        const name = s.what === "barcolor" ? "BC" : "BG";
        if (!(s.what === "barcolor" ? this.barColors : this.bgColors)) {
          this.arrays.push(`const ${name} = new Uint32Array(N);`);
          if (s.what === "barcolor") this.barColors = true; else this.bgColors = true;
        }
        const c = this.ex(s.color, pre);
        const t = this.temp();
        out.push(...pre, `const ${t} = ${c};`, `if (${t}) ${name}[i] = ${t};`);
        return;
      }
      case "stat": {
        const v = this.ex(s.v, pre);
        const color = s.color ? this.ex(s.color, pre) : "0";
        out.push(...pre, `if (i === N - 1) ${this.helper("stat")}(ST, ${lit(s.title)}, ${v}, ${color}, ${lit(s.format)});`);
        return;
      }
      case "signal": case "value": {
        const arr = `SG${this.signals.size}`;
        this.signals.set(s.name, arr);
        this.arrays.push(s.what === "signal" ? `const ${arr} = new Uint8Array(N);` : `const ${arr} = new Float64Array(N);`);
        const v = this.ex(s.v, pre);
        out.push(...pre, s.what === "signal" ? `${arr}[i] = ${v} ? 1 : 0;` : `${arr}[i] = ${this.helper("F")}(${v});`);
        return;
      }
      case "log": {
        const args = s.args.map((a) => this.ex(a, pre));
        out.push(...pre, `${this.helper("logLine")}(LG, i, [${args.join(", ")}]);`);
        return;
      }
      default: throw new Error(`codegen: unknown output ${s.what}`);
    }
  }

  // ---- expressions: JS source for an IR node; statements it needs go to `pre` ----------------

  arrayRead(name) {
    if (COLUMNS.includes(name)) { this.columns.add(name); return `${name}[i]`; }
    if (name === "bar_index") return "i";
    if (DERIVED.includes(name)) { this.derived.add(name); return `${name}[i]`; }
    this.cal = true;
    return `cal.${name}[i]`;
  }

  arrayName(name) {
    if (COLUMNS.includes(name)) { this.columns.add(name); return name; }
    if (DERIVED.includes(name)) { this.derived.add(name); return name; }
    this.cal = true;
    return `cal.${name}`;
  }

  ex(e, pre) {
    switch (e.k) {
      case "num": return num(e.v);
      case "str": return lit(e.v);
      case "bool": return e.v ? "true" : "false";
      case "color": return String(e.v >>> 0);
      case "na": return DEFAULTS[e.t === "na" ? "number" : e.t] ?? "NaN";
      case "sym": return this.symRead(e.sym);
      case "ser": return this.series(e);
      case "hist": return this.hist(e, pre);
      case "un": return `(${e.op}${this.ex(e.a, pre)})`;
      case "bin": return this.binary(e, pre);
      case "cond": return `(${this.ex(e.test, pre)} ? ${this.ex(e.a, pre)} : ${this.ex(e.b, pre)})`;
      case "b2n": return `(${this.ex(e.a, pre)} ? 1 : 0)`;
      case "n2b": return `${this.helper("T")}(${this.ex(e.a, pre)})`;
      case "pure": return this.pure(e, pre);
      case "isna": return `${this.helper("isna")}(${this.ex(e.a, pre)})`;
      case "nz": return `${this.helper("nz")}(${this.ex(e.a, pre)}, ${this.ex(e.b, pre)})`;
      case "len": return `${this.ex(e.a, pre)}.length`;
      case "list": return `[${e.items.map((x) => this.ex(x, pre)).join(", ")}]`;
      case "lget": return `${this.helper("lget")}(${this.ex(e.list, pre)}, ${this.ex(e.index, pre)})`;
      case "lm": return this.listMethod(e, pre);
      case "fstr": return this.fstr(e, pre);
      case "ta": return this.ta(e, pre).name;
      case "inl": return this.inline(e, pre);
      default: throw new Error(`codegen: unknown expression ${e.k}`);
    }
  }

  symRead(sym) {
    if (!sym.input) return sym.js;
    const name = `in${sym.input.id}`;
    return sym.input.kind === "source" ? `${name}[i]` : name;
  }

  series(e) {
    switch (e.name) {
      case "first_bar": return "(i === 0)";
      case "last_bar": return "(i === N - 1)";
      case "session.regular": this.cal = true; return "(cal.regular[i] === 1)";
      case "session.new_day": this.cal = true; return "(cal.newDay[i] === 1)";
      case "timeframe.is_intraday": this.chart = true; return "ch.intraday";
      case "timeframe.is_daily": this.chart = true; return "ch.daily";
      case "timeframe.is_weekly": this.chart = true; return "ch.weekly";
      case "timeframe.is_monthly": this.chart = true; return "ch.monthly";
      case "ticker": this.chart = true; return "ch.ticker";
      default: return this.arrayRead(e.name);
    }
  }

  // x[k]: the value k bars ago, from the column, the input's array, or a history buffer.
  hist(e, pre) {
    let array;
    let bool = false;
    if (e.mode === "array") array = this.arrayName(e.name);
    else if (e.mode === "input") array = `in${e.sym.input.id}`;
    else if (e.mode === "sym") {
      this.history.set(e.sym.id, e.sym);
      array = `H_${e.sym.js}`;
      bool = e.t === "bool";
    } else {
      const id = e.id;
      array = `HH${id}`;
      this.hiddenDecls.push(`const ${array} = new Float64Array(N);`);
      bool = e.t === "bool";
      const t = this.temp();
      pre.push(`const ${t} = ${this.ex(e.value, pre)};`, `${array}[i] = ${bool ? `${t} ? 1 : 0` : t};`);
    }
    let read;
    if (e.off.k === "num" && Number.isInteger(e.off.v) && e.off.v >= 1) read = `(i >= ${e.off.v} ? ${array}[i - ${e.off.v}] : NaN)`;
    else read = `${this.helper("at")}(${array}, i, ${this.ex(e.off, pre)})`;
    return bool ? `(${read} === 1)` : read;
  }

  binary(e, pre) {
    const a = this.ex(e.a, pre);
    const b = this.ex(e.b, pre);
    switch (e.op) {
      case "/": return `${this.helper("div")}(${a}, ${b})`;
      case "%": return `${this.helper("mod")}(${a}, ${b})`;
      case "**": return `${this.helper("pow")}(${a}, ${b})`;
      case "!=": return `${this.helper("ne")}(${a}, ${b})`;
      case "+": case "-": case "*": case "<": case "<=": case ">": case ">=": case "==": case "===": case "!==": case "&&": case "||":
        return `(${a} ${e.op} ${b})`;
      default: throw new Error(`codegen: unknown operator ${e.op}`);
    }
  }

  pure(e, pre) {
    const args = e.args.map((a) => this.ex(a, pre)).join(", ");
    if (e.entry.js) return `${e.entry.js}(${args})`;
    return `${this.helper(e.entry.rt)}(${args})`;
  }

  listMethod(e, pre) {
    const list = this.ex(e.list, pre);
    const args = e.args.map((a) => this.ex(a, pre));
    switch (e.name) {
      case "push": return `${this.helper("lpush")}(${list}, ${args[0]}, [${e.at[0]}, ${e.at[1]}], i)`;
      case "pop": return `${this.helper("lpop")}(${list})`;
      case "remove": return `${this.helper("lremove")}(${list}, ${args[0]})`;
      case "clear": return `(${list}.length = 0)`;
      case "sum": return `${this.helper("lsum")}(${list})`;
      case "max": return `${this.helper("lmax")}(${list})`;
      case "min": return `${this.helper("lmin")}(${list})`;
      case "avg": return `${this.helper("lavg")}(${list})`;
      default: throw new Error(`codegen: unknown list method ${e.name}`);
    }
  }

  fstr(e, pre) {
    const parts = e.parts.map((p) => {
      if (typeof p === "string") return lit(p);
      const v = this.ex(p.e, pre);
      if (p.e.t === "color") return `${this.helper("fmtColor")}(${v})`;
      return `${this.helper("fmt")}(${v}, ${lit(p.spec)})`;
    });
    return `("" + ${parts.join(" + ")})`;
  }

  // A ta call: the stepper is made on the first bar, stepped once per bar, ahead of its statement.
  ta(e, pre) {
    const { stepper } = e;
    const name = `s${stepper.id}`;
    this.steppers.set(stepper.id, stepper);
    const short = stepper.entry.name.slice(3);
    const ctor = stepper.ctor.map((a) => this.ex(a, pre));
    const make = [`[${stepper.site[0]}, ${stepper.site[1]}]`, ...ctor].join(", ");
    pre.push(`if (${name} === null) ${name} = rt.ta.${short}(${make});`);
    const args = [...stepper.step.map((a) => this.ex(a, pre)), ...stepper.implicit.map((n) => this.arrayRead(n))];
    pre.push(`${name}.step(${args.join(", ")});`);
    if (Array.isArray(stepper.entry.returns)) return { name };
    const t = this.temp();
    pre.push(`const ${t} = ${name}.v;`);
    return { name: t };
  }

  // A user function inlined: its statements run in a labelled block ahead of the statement.
  inline(e, pre) {
    pre.push(`${e.label}: {`);
    this.stmts(e.body, pre);
    pre.push("}");
    return e.res.length ? e.res[0].js : "NaN";
  }
}
