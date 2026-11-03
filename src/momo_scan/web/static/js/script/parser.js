// momo script parser: tokens → the AST in docs/scripting.md ("Contracts"). Recursive descent,
// Python's grammar with the slips momo accepts (`True`, `:=`, `else if`, `#momo` header).
// Throws ScriptError (E110–E120) on the first syntax error; the checker finds the rest.
//
// One addition to the contract: `Tuple { items }`, which only `return a, b` produces (the
// checker rejects it anywhere else). Params, keyword arguments and `Attr` carry `line`/`col`
// (`Attr` the name's own position as `nameLine`/`nameCol`) so later errors can point at them.

import { ScriptError } from "./errors.js";
import { UNSUPPORTED, tokenize } from "./lexer.js";

const COMPARE = new Set(["<", "<=", ">", ">=", "==", "!="]);
const AUGMENTED = new Set(["+=", "-=", "*=", "/="]);
const MAX_EXPR_DEPTH = 100;
const MAX_BLOCK_DEPTH = 50;

// What to say about Python words momo script doesn't have.
const UNSUPPORTED_HELP = {
  import: "Everything is built in: ta.sma, math.abs, input.int, plot and the rest.",
  from: "Everything is built in: ta.sma, math.abs, input.int, plot and the rest.",
  class: "Use plain variables and lists of numbers.",
  lambda: "Write a `def` at the top of the script.",
  try: "There are no exceptions; missing data is `na`. Test with na(x).",
  except: "There are no exceptions; missing data is `na`. Test with na(x).",
  finally: "There are no exceptions; missing data is `na`. Test with na(x).",
  raise: "There are no exceptions; missing data is `na`. Test with na(x).",
  global: "Functions can read top-level names; assign them at the top level.",
  nonlocal: "Functions can read top-level names; assign them at the top level.",
  with: "There are no context managers.",
  del: "Use xs.remove(i) for a list; plain names need no cleanup.",
  assert: "Test with `if`, and use log() to look at values.",
  yield: "A function returns once with `return`.",
  async: "Scripts run once per bar, top to bottom.",
  await: "Scripts run once per bar, top to bottom.",
  as: "There are no imports to rename.",
  is: "Use `==` to compare, and na(x) to test for no value.",
  match: "Use `if` / `elif` / `else`.",
  case: "Use `if` / `elif` / `else`.",
};

export function parse(source, options = {}) {
  return new Parser(tokenize(source, options)).program();
}

export function parseTokens(tokens) {
  return new Parser(tokens).program();
}

class Parser {
  constructor(tokens) {
    this.tokens = tokens;
    this.p = 0;
    this.exprDepth = 0;
    this.blockDepth = 0;
  }

  // ---- token helpers -------------------------------------------------------------------------

  get tok() { return this.tokens[this.p]; }

  next() { return this.tokens[this.p++]; }

  isOp(value, token = this.tok) { return token.type === "OP" && token.value === value; }

  isKw(value, token = this.tok) { return token.type === "KEYWORD" && token.value === value; }

  describe(token = this.tok) {
    switch (token.type) {
      case "NEWLINE": return "the end of the line";
      case "EOF": return "the end of the script";
      case "INDENT": return "an indent";
      case "DEDENT": return "the end of the block";
      case "STR": return "a string";
      case "FSTR": return "an f-string";
      case "HEADER": return "the #momo line";
      default: return `\`${token.value}\``;
    }
  }

  error(code, message, token = this.tok, fix = null) {
    throw new ScriptError(code, message, token.line, token.col, Math.max(token.endCol, token.col + 1), fix);
  }

  expectOp(value, fix = null) {
    if (!this.isOp(value)) this.error("E110", `Expected \`${value}\` but found ${this.describe()}.`, this.tok, fix);
    return this.next();
  }

  node(type, token, fields = {}) {
    return { type, line: token.line, col: token.col, ...fields };
  }

  // ---- statements ----------------------------------------------------------------------------

  program() {
    let header = null;
    if (this.tok.type === "HEADER") {
      const token = this.next();
      if (!/^\d+$/.test(token.value)) {
        this.error("E116", "The first line should say which language version this is.", token, "Write `#momo 1`.");
      }
      const version = Number(token.value);
      if (version !== 1) {
        this.error("E117", `This script is for momo script version ${version}, which this momo doesn't know.`, token,
          version > 1 ? "Update momo, or write `#momo 1`." : "Write `#momo 1`.");
      }
      header = { version };
    }
    const first = this.tok;
    const body = [];
    while (this.tok.type !== "EOF") body.push(this.statement());
    return this.node("Program", first, { header, body });
  }

  // A block after `:`, either indented lines or a single simple statement on the same line.
  suite() {
    if (this.tok.type !== "NEWLINE") return [this.simple()];
    const newline = this.next();
    if (this.tok.type !== "INDENT") {
      this.error("E112", "Expected an indented block here.", newline, "Indent the next line by 4 spaces, or write `pass`.");
    }
    if (++this.blockDepth > MAX_BLOCK_DEPTH) this.error("E120", "Blocks are nested too deeply.", this.tok);
    this.next();
    const body = [];
    while (this.tok.type !== "DEDENT" && this.tok.type !== "EOF") body.push(this.statement());
    if (this.tok.type === "DEDENT") this.next();
    this.blockDepth--;
    return body;
  }

  colon(what) {
    return this.expectOp(":", `Add \`:\` at the end of the ${what} line.`);
  }

  statement() {
    const token = this.tok;
    if (token.type === "INDENT") this.error("E113", "This line is indented but nothing opened a block.", token, "Remove the extra indent.");
    if (token.type === "KEYWORD") {
      switch (token.value) {
        case "if": return this.ifStatement();
        case "for": return this.forStatement();
        case "while": return this.whileStatement();
        case "def": return this.defStatement();
        case "elif": case "else":
          this.error("E110", `\`${token.value}\` has no \`if\` before it.`, token);
          break;
        default:
      }
    }
    return this.simple();
  }

  ifStatement() {
    const token = this.next();
    const test = this.expr();
    this.colon("if");
    const body = this.suite();
    let orelse = [];
    if (this.isKw("elif")) {
      orelse = [this.ifStatement()];
    } else if (this.isKw("else")) {
      this.next();
      if (this.isKw("if")) {
        orelse = [this.ifStatement()];          // `else if` read as `elif`
      } else {
        this.expectOp(":", `Add \`:\` after \`else\`.`);
        orelse = this.suite();
      }
    }
    return this.node("If", token, { test, body, orelse });
  }

  forStatement() {
    const token = this.next();
    const name = this.tok;
    if (name.type !== "NAME") this.error("E110", `Expected a name after \`for\` but found ${this.describe()}.`, name);
    this.next();
    const target = this.node("Name", name, { id: name.value });
    if (!this.isKw("in")) this.error("E110", `Expected \`in\` but found ${this.describe()}.`, this.tok, "Write `for i in range(n):`.");
    this.next();
    const iter = this.expr();
    this.colon("for");
    return this.node("For", token, { target, iter, body: this.suite() });
  }

  whileStatement() {
    const token = this.next();
    const test = this.expr();
    this.colon("while");
    return this.node("While", token, { test, body: this.suite() });
  }

  defStatement() {
    const token = this.next();
    const name = this.tok;
    if (name.type !== "NAME") this.error("E110", `Expected a function name after \`def\` but found ${this.describe()}.`, name);
    this.next();
    this.expectOp("(");
    const params = [];
    const seen = new Set();
    while (!this.isOp(")")) {
      const param = this.tok;
      if (param.type !== "NAME") this.error("E110", `Expected a parameter name but found ${this.describe()}.`, param);
      this.next();
      if (seen.has(param.value)) this.error("E118", `The parameter \`${param.value}\` appears twice.`, param);
      seen.add(param.value);
      let fallback = null;
      if (this.isOp("=")) { this.next(); fallback = this.expr(); }
      else if (params.length && params[params.length - 1].default) {
        this.error("E118", "A parameter without a default can't follow one with a default.", param);
      }
      params.push({ name: param.value, default: fallback, line: param.line, col: param.col });
      if (!this.isOp(")")) this.expectOp(",", "Separate parameters with commas.");
    }
    this.next();
    this.colon("def");
    return this.node("Def", token, { name: name.value, params, body: this.suite() });
  }

  endOfLine() {
    if (this.tok.type === "NEWLINE") { this.next(); return; }
    if (this.tok.type === "EOF" || this.tok.type === "DEDENT") return;
    this.error("E110", `Expected the end of the line but found ${this.describe()}.`);
  }

  simple() {
    const token = this.tok;
    let stmt;
    if (token.type === "KEYWORD") {
      switch (token.value) {
        case "return": {
          this.next();
          let value = null;
          if (!["NEWLINE", "EOF", "DEDENT"].includes(this.tok.type)) {
            value = this.expr();
            if (this.isOp(",")) value = this.tuple(value);
          }
          stmt = this.node("Return", token, { value });
          break;
        }
        case "break": this.next(); stmt = this.node("Break", token); break;
        case "continue": this.next(); stmt = this.node("Continue", token); break;
        case "pass": this.next(); stmt = this.node("Pass", token); break;
        case "var": stmt = this.varStatement(); break;
        default:
          if (UNSUPPORTED.has(token.value)) {
            this.error("E115", `momo script has no \`${token.value}\`.`, token, UNSUPPORTED_HELP[token.value]);
          }
          this.error("E110", `Expected a statement but found ${this.describe()}.`, token);
      }
    } else {
      stmt = this.expressionStatement();
    }
    this.endOfLine();
    return stmt;
  }

  varStatement() {
    const token = this.next();
    const name = this.tok;
    if (name.type !== "NAME") this.error("E110", `Expected a name after \`var\` but found ${this.describe()}.`, name, "Write `var count = 0`.");
    this.next();
    if (!this.isOp("=") && !this.isOp(":=")) {
      this.error("E110", `Expected \`=\` but found ${this.describe()}.`, this.tok, `Give it a starting value: var ${name.value} = 0`);
    }
    this.next();
    const target = this.node("Name", name, { id: name.value });
    return this.node("Assign", token, { target, op: "=", value: this.expr(), isVar: true });
  }

  expressionStatement() {
    const first = this.expr();
    if (this.isOp(",")) {
      const items = this.tuple(first).items;
      const eq = this.tok;
      if (!this.isOp("=") && !this.isOp(":=")) {
        this.error("E110", "A list of names with commas must be unpacked with `=`.", eq,
          "Write `a, b = f(...)`, or `return a, b` in a function.");
      }
      for (const item of items) this.target(item);
      this.next();
      const value = this.expr();
      return this.node("Unpack", items[0], { targets: items, value });
    }
    const op = this.tok;
    if (op.type === "OP" && (op.value === "=" || op.value === ":=" || AUGMENTED.has(op.value))) {
      this.target(first);
      this.next();
      const value = this.expr();
      return this.node("Assign", first, {
        target: first, op: op.value === ":=" ? "=" : op.value, value, isVar: false,
      });
    }
    return this.node("ExprStmt", first, { expr: first });
  }

  target(node) {
    if (node.type === "Name") return;
    const what = {
      Num: "a number", Str: "a string", FStr: "a string", Bool: "`true`/`false`", Na: "`na`",
      Index: "a history value (x[1] is read-only)", Attr: "a name with a dot", Call: "a function call",
    }[node.type] || "this";
    throw new ScriptError("E114", `Can't assign to ${what}.`, node.line, node.col, node.col + 1,
      node.type === "Index" ? "Assign to a plain name; read its history with name[1]." : null);
  }

  tuple(first) {
    const items = [first];
    while (this.isOp(",")) {
      this.next();
      if (["NEWLINE", "EOF"].includes(this.tok.type) || this.isOp("=") || this.isOp(")")) break;
      items.push(this.expr());
    }
    return this.node("Tuple", first, { items });
  }

  // ---- expressions ---------------------------------------------------------------------------

  nest() {
    if (++this.exprDepth > MAX_EXPR_DEPTH) this.error("E120", "This expression is nested too deeply.", this.tok);
  }

  expr() {
    this.nest();
    const value = this.or();
    if (this.isKw("if")) {
      this.next();
      const test = this.or();
      if (!this.isKw("else")) this.error("E110", `Expected \`else\` but found ${this.describe()}.`, this.tok, "Write `a if cond else b`.");
      this.next();
      const other = this.expr();
      this.exprDepth--;
      return this.node("Cond", value, { test, then: value, else: other });
    }
    this.exprDepth--;
    return value;
  }

  or() {
    let left = this.and();
    while (this.isKw("or")) {
      this.next();
      left = this.node("Binary", left, { op: "or", left, right: this.and() });
    }
    return left;
  }

  and() {
    let left = this.not();
    while (this.isKw("and")) {
      this.next();
      left = this.node("Binary", left, { op: "and", left, right: this.not() });
    }
    return left;
  }

  not() {
    if (this.isKw("not")) {
      const token = this.next();
      this.nest();
      const operand = this.not();
      this.exprDepth--;
      return this.node("Unary", token, { op: "not", operand });
    }
    return this.comparison();
  }

  comparison() {
    const left = this.sum();
    if (this.tok.type === "OP" && COMPARE.has(this.tok.value)) {
      const op = this.next();
      const right = this.sum();
      if (this.tok.type === "OP" && COMPARE.has(this.tok.value)) {
        this.error("E119", "Chained comparisons aren't supported.", this.tok, "Write `a < b and b < c` instead of `a < b < c`.");
      }
      return this.node("Binary", left, { op: op.value, left, right });
    }
    return left;
  }

  sum() {
    let left = this.term();
    while (this.isOp("+") || this.isOp("-")) {
      const op = this.next();
      left = this.node("Binary", left, { op: op.value, left, right: this.term() });
    }
    return left;
  }

  term() {
    let left = this.unary();
    while (this.isOp("*") || this.isOp("/") || this.isOp("%")) {
      const op = this.next();
      left = this.node("Binary", left, { op: op.value, left, right: this.unary() });
    }
    return left;
  }

  unary() {
    if (this.isOp("-") || this.isOp("+")) {
      const op = this.next();
      this.nest();
      const operand = this.unary();
      this.exprDepth--;
      return op.value === "+" ? operand : this.node("Unary", op, { op: "-", operand });
    }
    return this.power();
  }

  power() {
    const base = this.postfix();
    if (this.isOp("**")) {
      this.next();
      this.nest();
      const exponent = this.unary();
      this.exprDepth--;
      return this.node("Binary", base, { op: "**", left: base, right: exponent });
    }
    return base;
  }

  postfix() {
    let node = this.atom();
    while (true) {
      if (this.isOp("(")) {
        if (node.type !== "Name" && node.type !== "Attr") {
          this.error("E110", "Only a name, like `plot` or `ta.sma`, can be called.", this.tok);
        }
        node = this.call(node);
      } else if (this.isOp("[")) {
        this.next();
        if (this.isOp("]")) this.error("E110", "Expected an index inside `[ ]`.", this.tok);
        const index = this.expr();
        this.expectOp("]");
        node = this.node("Index", node, { target: node, index });
      } else if (this.isOp(".")) {
        this.next();
        const name = this.tok;
        if (name.type !== "NAME") this.error("E110", `Expected a name after \`.\` but found ${this.describe()}.`, name);
        this.next();
        node = this.node("Attr", node, { target: node, name: name.value, nameLine: name.line, nameCol: name.col });
      } else {
        return node;
      }
    }
  }

  call(callee) {
    this.next();
    const args = [];
    const kwargs = [];
    while (!this.isOp(")")) {
      const t = this.tok;
      if (t.type === "NAME" && this.isOp("=", this.tokens[this.p + 1])) {
        this.next();
        this.next();
        if (kwargs.some((k) => k.name === t.value)) this.error("E118", `The argument \`${t.value}\` is given twice.`, t);
        kwargs.push({ name: t.value, value: this.expr(), line: t.line, col: t.col });
      } else {
        if (kwargs.length) {
          this.error("E118", "A positional argument can't follow a keyword argument.", t, "Put the arguments without a name first.");
        }
        args.push(this.expr());
      }
      if (!this.isOp(")")) this.expectOp(",", "Separate arguments with commas.");
    }
    this.next();
    return this.node("Call", callee, { callee, args, kwargs });
  }

  atom() {
    const token = this.tok;
    switch (token.type) {
      case "NUM": this.next(); return this.node("Num", token, { value: token.value });
      case "STR": this.next(); return this.node("Str", token, { value: token.value });
      case "FSTR": this.next(); return this.fstring(token);
      case "NAME": return this.name();
      case "OP":
        if (token.value === "(") return this.paren();
        if (token.value === "[") return this.list();
        break;
      default:
    }
    if (token.type === "KEYWORD" && UNSUPPORTED.has(token.value)) {
      this.error("E115", `momo script has no \`${token.value}\`.`, token, UNSUPPORTED_HELP[token.value]);
    }
    this.error("E110", `Expected a value but found ${this.describe()}.`, token);
    return null;
  }

  name() {
    const token = this.next();
    const callable = this.isOp("(");
    switch (token.value) {
      case "true": case "True": return this.node("Bool", token, { value: true });
      case "false": case "False": return this.node("Bool", token, { value: false });
      case "None": return this.node("Na", token);
      case "na": return callable ? this.node("Name", token, { id: "na" }) : this.node("Na", token);
      default: return this.node("Name", token, { id: token.value });
    }
  }

  paren() {
    const open = this.next();
    if (this.isOp(")")) this.error("E110", "Expected a value inside `( )`.", this.tok);
    const first = this.expr();
    if (this.isOp(",")) {
      const tuple = this.tuple(first);
      this.expectOp(")");
      return this.node("Tuple", open, { items: tuple.items });
    }
    this.expectOp(")");
    return first;
  }

  list() {
    const open = this.next();
    const items = [];
    while (!this.isOp("]")) {
      items.push(this.expr());
      if (!this.isOp("]")) this.expectOp(",", "Separate list items with commas.");
    }
    this.next();
    return this.node("List", open, { items });
  }

  fstring(token) {
    const parts = token.parts.map((part) => {
      if (typeof part === "string") return part;
      const inner = new Parser(tokenize(part.code, { inline: true, origin: { line: part.line, col: part.col } }));
      inner.exprDepth = this.exprDepth;
      const expr = inner.expr();
      if (inner.tok.type !== "EOF") inner.error("E107", `Unexpected ${inner.describe()} inside the f-string's \`{ }\`.`);
      return { expr, spec: part.spec };
    });
    return this.node("FStr", token, { parts });
  }
}
