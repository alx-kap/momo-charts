"""momo script checker: AST to typed IR, plus the rules (E2xx), types (E3xx) and limits (E4xx)
and the `meta` compile() returns (the port of checker.js).

The evaluator reads the IR, never the AST: user functions are inlined per call site, and each
site has its own types, so checking and elaborating are one pass. Errors are collected (not
raised), with "did you mean" for names.

IR expressions are dicts {k, t, fixed, ...} (t: number bool string color list plot void tuple,
or "error" after a reported problem, which silences follow-on errors). Kinds:
  num str bool color na, sym{sym}, ser{name}, hist{mode,...}, un{op,a}, bin{op,a,b},
  cond{test,a,b}, b2n{a}, n2b{a}, pure{entry,args}, isna{a}, nz{a,b}, len{a}, list{items},
  lget{list,index}, lm{name,list,args}, fstr{parts}, ta{stepper}, inl{body,res}, plotref{key}
Statements: set varinit unpack if for forlist while break continue expr ret out.
`fixed` marks values that are the same on every bar (lengths and history offsets need them).
"""

from __future__ import annotations

import math
import re

from . import jsnum
from .catalog import (
    GLOBALS,
    KWARG_ALIASES,
    METHODS,
    NAMESPACES,
    format_color,
    members,
    parse_color,
    signature,
    with_alpha,
)
from .errors import ScriptError, describe, did_you_mean
from .limits import LIMITS

SOURCES = ["open", "high", "low", "close", "volume", "hl2", "hlc3", "ohlc4"]
# Built-in series a script may reuse as a variable name (they're reference data, not syntax).
SHADOWABLE = frozenset(["year", "month", "day", "dayofweek", "hour", "minute", "ticker"])
ARITH = frozenset(["+", "-", "*", "/", "%", "**"])
ORDER = frozenset(["<", "<=", ">", ">="])
SIGNAL_NAME = re.compile(r"[A-Za-z][A-Za-z0-9_]{0,31}")
PLOT_STYLES = ["line", "steps", "histogram", "columns", "area", "circles"]

# A function nobody calls is checked without knowing its argument types, so only these count.
LENIENT_KEEPS = frozenset(["E201", "E203", "E204", "E207", "E208", "E209", "E211", "E212"])
ERROR_TYPE = {"k": "err", "t": "error", "fixed": False}
UNDEFINED = object()          # a literal that isn't one (JavaScript's `undefined`)

_MATH = {
    "Math.abs": abs, "Math.min": jsnum.js_min, "Math.max": jsnum.js_max,
    "Math.floor": jsnum.js_floor, "Math.ceil": jsnum.js_ceil, "Math.sqrt": jsnum.js_sqrt,
    "Math.exp": jsnum.js_exp, "Math.sign": jsnum.js_sign,
}


def is_err(e):
    return e["t"] == "error"


def is_num(v):
    return isinstance(v, (int, float)) and not isinstance(v, bool)


def is_integer(v):
    return is_num(v) and v - v == 0 and v == int(v)


def ucfirst(s):
    return s[:1].upper() + s[1:]


class Scope:
    def __init__(self, kind, parent=None):
        self.kind = kind
        self.parent = parent
        self.vars = {}
        self.info = {}       # name to {count, conditional, aug, isVar} from the pre-scan


def scan(body, info=None, conditional=False):
    """What the body assigns, for fixed-ness and "set later" reads."""
    if info is None:
        info = {}

    def note(name, aug=False, is_var=False, cond=False):
        entry = info.get(name)
        if entry is None:
            entry = {"count": 0, "conditional": False, "aug": False, "isVar": False}
            info[name] = entry
        entry["count"] += 1
        entry["conditional"] = entry["conditional"] or conditional or cond
        entry["aug"] = entry["aug"] or aug
        entry["isVar"] = entry["isVar"] or is_var

    for stmt in body:
        kind = stmt["type"]
        if kind == "Assign":
            note(stmt["target"]["id"], aug=stmt["op"] != "=", is_var=stmt["isVar"])
        elif kind == "Unpack":
            for t in stmt["targets"]:
                note(t["id"], cond=True)
        elif kind == "For":
            note(stmt["target"]["id"], cond=True)
            scan(stmt["body"], info, True)
        elif kind == "While":
            scan(stmt["body"], info, True)
        elif kind == "If":
            scan(stmt["body"], info, True)
            scan(stmt["orelse"], info, True)
    return info


# "Did you mean" compares a name with every other: a long script full of typos would take
# minutes. Past these, errors just don't suggest a name (the same in checker.js).
SUGGESTED_ERRORS = 10
SUGGESTED_NAMES = 300


def slug(title):
    key = re.sub(r"^_+|_+$", "", re.sub(r"[^a-z0-9]+", "_", title.lower()))
    if not re.match(r"[a-z]", key):
        key = re.sub(r"_$", "", f"p_{key}")
    return key or "plot"


def check(program, lenient=False):
    return Checker(lenient).run(program)


def _span_at(node):
    return {"line": node.get("line"), "col": node.get("col")}


class Checker:
    def __init__(self, lenient=False):
        self.lenient = bool(lenient)
        self.errors = []
        self.seen = set()
        self.syms = []
        self.sym_count = 0
        self.ta_count = 0
        self.hidden_count = 0
        self.call_count = 0
        self.steppers = []
        self.hidden = []
        self.inputs = []
        self.outputs = []           # meta.plots entries
        self.signals = []
        self.keys = set()
        self.names = set()          # signal / value names
        self.uses = set()           # built-in series read
        self.functions = {}
        self.stack = []
        self.max_length = 0
        self.max_offset = 0
        self.plot_count = 0
        self.indicator = None
        self.inst_count = 0
        self.all_defs = set()
        self.top = None

    # ---- reporting ------------------------------------------------------------------------

    def report(self, code, message, at, fix=None, end_col=None):
        if self.lenient and code not in LENIENT_KEEPS:
            return
        line = at.get("line")
        col = at.get("col")
        line = 1 if line is None else line
        col = 1 if col is None else col
        key = f"{code}:{line}:{col}:{message}"
        if key in self.seen:
            return
        self.seen.add(key)
        self.errors.append(ScriptError(code, message, line, col,
                                       col + 1 if end_col is None else end_col, fix))

    def span(self, node):
        """The width of a name or call in the source, for underlining."""
        kind = node.get("type")
        if kind == "Name":
            return node["col"] + len(node["id"])
        if kind == "Attr":
            return node["nameCol"] + len(node["name"])
        if kind == "Call":
            return self.span(node["callee"])
        return node["col"] + 1

    def fail(self, code, message, node, fix=None, _ignored=None):
        self.report(code, message, node, fix, self.span(node))
        return ERROR_TYPE

    # ---- entry point ----------------------------------------------------------------------

    def run(self, program):
        self.top = Scope("top")
        scan(program["body"], self.top.info)
        for s in program["body"]:
            if s["type"] == "Def":
                self.all_defs.add(s["name"])
        ctx = {"scope": self.top, "top": True, "cond": 0, "why": "", "loop": False, "fn": None}
        body = []
        rest = list(program["body"])
        first = rest.pop(0) if rest else None
        if first and self.is_call(first, "indicator"):
            self.indicator_call(first["expr"])
        else:
            self.report("E210", "A script starts with indicator(...).",
                        first or {"line": 1, "col": 1},
                        'Write indicator("My script", overlay=true) as the first line '
                        "after #momo 1.")
            if first:
                rest.insert(0, first)
        for stmt in rest:
            body.extend(self.stmt(stmt, ctx))
        for fn in list(self.functions.values()):
            if not fn["called"]:
                self.dry_run(fn)
        return self.finish(body)

    def is_call(self, stmt, name):
        return (stmt["type"] == "ExprStmt" and stmt["expr"]["type"] == "Call"
                and stmt["expr"]["callee"]["type"] == "Name"
                and stmt["expr"]["callee"]["id"] == name)

    def finish(self, body):
        errors = [describe(e) for e in sorted(self.errors, key=lambda e: (e.line, e.col))]
        if len(self.outputs) > LIMITS["plots"]:
            errors.append({"line": 1, "col": 1, "endCol": 2, "code": "E402",
                           "message": f"A script can draw at most {LIMITS['plots']} plots.",
                           "fix": None})
        ind = self.indicator or {"title": "Untitled", "short": "", "overlay": False,
                                 "format": "price", "precision": 2}
        meta = {
            "version": 1, "title": ind["title"], "short": ind["short"] or ind["title"],
            "overlay": ind["overlay"], "format": ind["format"], "precision": ind["precision"],
            "inputs": [i["meta"] for i in self.inputs], "plots": self.outputs,
            "signals": self.signals,
            "needs": {"tf": [], "symbols": [], "data": [],
                      "history": self.max_length + self.max_offset},
        }
        if errors:
            return {"ok": False, "errors": errors}
        return {
            "ok": True, "meta": meta,
            "ir": {"body": body, "syms": self.syms, "steppers": self.steppers,
                   "hidden": self.hidden, "inputs": self.inputs, "uses": self.uses,
                   "plots": self.outputs},
        }

    def dry_run(self, fn):
        """A function nobody calls is still checked, leniently: types are unknown without
        arguments."""
        saved = self.lenient
        marks = (len(self.syms), len(self.steppers), len(self.hidden))
        self.lenient = True
        args = [self.expr(p["default"], self.call_ctx()) if p["default"]
                else {"k": "ser", "name": "close", "t": "number", "fixed": False}
                for p in fn["node"]["params"]]
        self.inline(fn, {"line": fn["node"]["line"], "col": fn["node"]["col"]}, args, [],
                    self.call_ctx(), True)
        self.lenient = saved
        del self.syms[marks[0]:]
        del self.steppers[marks[1]:]
        del self.hidden[marks[2]:]

    def call_ctx(self):
        return {"scope": self.top, "top": False, "cond": 0, "why": "", "loop": False, "fn": None}

    # ---- indicator(), the first line ------------------------------------------------------

    def indicator_call(self, call):
        entry = GLOBALS["indicator"]
        args = self.bind(entry, call, self.call_ctx(), {"literals": True})
        if args is None:
            return
        title, overlay, short, format_, precision = [a["lit"] for a in args]
        self.indicator = {"title": title, "overlay": overlay, "short": short, "format": format_,
                          "precision": precision}

    # ---- statements -----------------------------------------------------------------------

    def stmts(self, body, ctx):
        out = []
        for s in body:
            out.extend(self.stmt(s, ctx))
        return out

    def stmt(self, node, ctx):
        kind = node["type"]
        if kind == "Assign":
            return self.assign(node, ctx)
        if kind == "Unpack":
            return self.unpack(node, ctx)
        if kind == "ExprStmt":
            return self.expr_stmt(node, ctx)
        if kind == "If":
            return self.if_stmt(node, ctx)
        if kind == "For":
            return self.for_stmt(node, ctx)
        if kind == "While":
            return self.while_stmt(node, ctx)
        if kind == "Def":
            self.def_(node, ctx)
            return []
        if kind == "Return":
            return self.return_stmt(node, ctx)
        if kind in ("Break", "Continue"):
            if not ctx["loop"]:
                self.report("E209", f"`{kind.lower()}` only works inside a loop.", node, None,
                            node["col"] + len(kind))
            return [{"k": kind.lower()}]
        if kind == "Pass":
            return []
        self.report("E213", "This isn't a statement momo script understands.", node)
        return []

    def inner(self, ctx, why, **extra):
        return {**ctx, "top": False, "cond": ctx["cond"] + 1,
                "why": ctx["why"] if ctx["cond"] else why, **extra}

    def if_stmt(self, node, ctx):
        test = self.coerce(self.expr(node["test"], ctx), "bool", node["test"])
        inner = self.inner(ctx, "an if")
        return [{"k": "if", "test": test, "body": self.stmts(node["body"], inner),
                 "orelse": self.stmts(node["orelse"], inner)}]

    def while_stmt(self, node, ctx):
        inner = self.inner(ctx, "a loop", loop=True)
        test = self.coerce(self.expr(node["test"], inner), "bool", node["test"])
        return [{"k": "while", "test": test, "body": self.stmts(node["body"], inner),
                 "line": node["line"], "col": node["col"]}]

    def for_stmt(self, node, ctx):
        inner = self.inner(ctx, "a loop", loop=True)
        iter_ = node["iter"]
        sym = self.assign_target(node["target"], {"k": "num", "t": "number", "fixed": False},
                                 ctx, True)
        if (iter_["type"] == "Call" and iter_["callee"]["type"] == "Name"
                and iter_["callee"]["id"] == "range" and not self.lookup(ctx, "range")):
            args = self.bind(GLOBALS["range"], iter_, ctx, {})
            if args is None:
                return []
            start, stop, step = [a["e"] for a in args]
            has_stop = not args[1].get("missing")
            return [{
                "k": "for", "sym": sym,
                "start": start if has_stop else {"k": "num", "t": "number", "fixed": True, "v": 0},
                "stop": stop if has_stop else start, "step": step,
                "body": self.stmts(node["body"], inner), "line": node["line"],
                "col": node["col"],
            }]
        list_ = self.expr(iter_, ctx)
        if not is_err(list_) and list_["t"] != "list":
            self.report("E301", "A `for` loop goes over range(n) or a list.", iter_,
                        "Write `for i in range(n):`.", self.span(iter_))
            return []
        return [{"k": "forlist", "sym": sym, "list": list_,
                 "body": self.stmts(node["body"], inner), "line": node["line"],
                 "col": node["col"]}]

    def def_(self, node, ctx):
        if not ctx["top"] or ctx["cond"] or ctx["fn"]:
            self.report("E207", "`def` goes at the top level of the script.", node,
                        "Move the function above, outside any if, loop or function.",
                        node["col"] + 3)
            return
        if self.reserved(node["name"], node, "function"):
            return
        for param in node["params"]:
            if self.reserved(param["name"], param, "name"):
                return
        if (node["name"] in self.functions or node["name"] in self.top.vars
                or node["name"] in self.top.info):
            self.report("E212", f"`{node['name']}` is already used for something else.", node,
                        None, node["col"] + 3 + len(node["name"]) + 1)
            return
        self.functions[node["name"]] = {"node": node, "called": False}

    def return_stmt(self, node, ctx):
        fn = ctx["fn"]
        if not fn:
            self.report("E209", "`return` only works inside a function.", node, None,
                        node["col"] + 6)
            return []
        values = []
        if node["value"]:
            items = node["value"]["items"] if node["value"]["type"] == "Tuple" \
                else [node["value"]]
            values = [self.expr(n, ctx) for n in items]
        out = []
        if fn["size"] is None:
            fn["size"] = len(values)
        elif fn["size"] != len(values) and values:
            s = fn["size"]
            self.report("E308", f"This function returns {s} value{'' if s == 1 else 's'} "
                        f"elsewhere but {len(values)} here.", node)
            return []
        for i, v in enumerate(values):
            if is_err(v):
                continue
            if v["t"] == "tuple":
                self.report("E308", "A function call that returns several values can't be "
                            "returned as one.", node["value"])
                continue
            while len(fn["res"]) <= i:
                fn["res"].append(None)
            slot = fn["res"][i]
            if not slot:
                slot = fn["res"][i] = self.new_sym(
                    f"ret{i}", "number" if v["t"] == "na" else v["t"], False, fn["prefix"], True)
                slot["js"] = f"r{fn['id']}_{i}"
            out.append({"k": "set", "sym": slot,
                        "v": self.fit(v, slot["t"], node["value"] or node)})
        out.append({"k": "ret", "label": fn["label"]})
        return out

    def expr_stmt(self, node, ctx):
        e = node["expr"]
        if e["type"] != "Call":
            self.report("E213", "This line does nothing; a statement should assign something or "
                        "call a function.", e, "Assign it to a name, or remove the line.",
                        self.span(e))
            return []
        callee = self.callee_name(e, ctx)
        entry = callee and GLOBALS.get(callee)
        if entry and entry["kind"] == "output":
            return self.output(e, entry, ctx, None)
        value = self.expr(e, ctx)
        if is_err(value):
            return []
        return [{"k": "expr", "e": value}]

    def callee_name(self, call, ctx):
        """"plot" or "ta.sma" for a call's callee, when it names a catalogue global (and not a
        user thing)."""
        dotted = self.flatten(call["callee"])
        if not dotted:
            return None
        root = dotted.split(".")[0]
        if self.lookup(ctx, root) or root in self.functions:
            return None
        return dotted if dotted in GLOBALS else None

    def flatten(self, node):
        if node["type"] == "Name":
            return node["id"]
        if node["type"] == "Attr":
            left = self.flatten(node["target"])
            return f"{left}.{node['name']}" if left else left
        return None

    # ---- assignment -----------------------------------------------------------------------

    def assign(self, node, ctx):
        name = node["target"]["id"]
        value_node = node["value"]
        if self.reserved(name, node["target"], "name"):
            return []
        callee = self.callee_name(value_node, ctx) if value_node["type"] == "Call" else None
        entry = callee and GLOBALS.get(callee)

        if entry and entry["kind"] == "input":
            return self.input_assign(node, entry, ctx)
        if entry and entry["kind"] == "output" and entry["returns"] == "plot":
            if node["op"] != "=" or node["isVar"]:
                self.report("E214", "A plot handle is assigned with a plain `=`.", node)
                return []
            handle = {}
            stmts = self.output(value_node, entry, ctx, handle)
            if handle.get("key"):
                sym = self.declare(ctx, node["target"], "plot", True, False)
                if sym:
                    sym["plotKey"] = handle["key"]
                    sym["defined"] = True
            return stmts

        prior = self.lookup(ctx, name, True)
        if node["isVar"] and prior and prior["defined"]:
            self.report("E212", f"`{name}` is set before this `var`.", node["target"],
                        f"Put the `var {name} = ...` line before any other assignment to "
                        f"{name}.", self.span(node["target"]))
            return []
        var_ctx = self.inner(ctx, "a `var` line (it only runs on the first bar)") \
            if node["isVar"] else ctx
        value = self.expr(value_node, var_ctx)
        if is_err(value):
            self.mark_defined(ctx, name)
            return []
        if value["t"] == "tuple":
            self.report("E308", "This returns several values; unpack them: a, b = f(...)",
                        value_node, None, self.span(value_node))
            return []
        if value["t"] == "void":
            self.report("E309", "This doesn't return a value.", value_node, None,
                        self.span(value_node))
            return []
        if value["t"] == "plot":
            self.report("E214", "Plot handles are assigned from plot(...) at the top level.",
                        value_node)
            return []

        sym = prior
        if node["op"] != "=":
            if not sym or not sym["defined"]:
                self.report("E203", f"`{name}` is changed here before it has a value.",
                            node["target"], f"Give it one first, like `var {name} = 0`.",
                            self.span(node["target"]))
                return []
            op = node["op"][0]
            left = self.read(sym)
            rhs = self.coerce(value, "number", value_node)
            value = self.bin(op, self.coerce(left, "number", node["target"]), rhs)
        sym = self.assign_target(node["target"], value, ctx, False, node["isVar"])
        if not sym:
            return []
        fitted = self.fit(value, sym["t"], value_node, name)
        if is_err(fitted):
            return []
        return [{"k": "varinit" if node["isVar"] else "set", "sym": sym, "v": fitted}]

    def unpack(self, node, ctx):
        for t in node["targets"]:
            if self.reserved(t["id"], t, "name"):
                return []
        value = self.expr(node["value"], ctx)
        if is_err(value):
            for t in node["targets"]:
                self.mark_defined(ctx, t["id"])
            return []
        types = value["types"] if value["t"] == "tuple" else None
        if not types:
            self.report("E308", "Only a function that returns several values can be unpacked.",
                        node["value"], None, self.span(node["value"]))
            for t in node["targets"]:
                self.mark_defined(ctx, t["id"])
            return []
        if len(types) != len(node["targets"]):
            self.report("E308", f"This returns {len(types)} values but {len(node['targets'])} "
                        "names are listed.", node["targets"][0], f"List {len(types)} names.",
                        node["targets"][0]["col"] + 1)
            for t in node["targets"]:
                self.mark_defined(ctx, t["id"])
            return []
        syms = [self.assign_target(t, {"k": "num", "t": types[i], "fixed": False}, ctx, False)
                for i, t in enumerate(node["targets"])]
        if any(not s for s in syms):
            return []
        return [{"k": "unpack", "syms": syms, "v": value}]

    def mark_defined(self, ctx, name):
        """Marks a name as set after an error so one slip doesn't report every later use."""
        sym = self.lookup(ctx, name, True)
        if not sym:
            sym = self.declare(ctx, {"id": name, "line": 1, "col": 1}, "number", False, False)
        if sym:
            sym["defined"] = True

    def assign_target(self, target, value, ctx, loop_var, is_var=False):
        """Finds or creates the symbol an assignment writes, checking its type against earlier
        ones."""
        name = target["id"]
        if self.reserved(name, target, "name"):
            return None
        sym = self.lookup(ctx, name, True)
        owner = ctx["scope"]
        if sym and sym["scope"] is not owner:
            sym = None
        first = not sym or not sym["defined"]
        t = "number" if value["t"] == "na" else value["t"]
        if first:
            info = owner.info.get(name) or {"count": 1, "conditional": True, "aug": False,
                                            "isVar": False}
            eligible = (not loop_var and info["count"] == 1 and not info["conditional"]
                        and not info["aug"] and not is_var and not ctx["cond"])
            if not sym:
                sym = self.declare(ctx, target, t, False, False)
            sym["t"] = "number" if sym["pre"] else t
            sym["defined"] = True
            sym["isVar"] = is_var or info["isVar"]
            sym["fixed"] = eligible and bool(value["fixed"])
            sym["constVal"] = self.const_of(value) if sym["fixed"] else None
            sym["boundVal"] = self.const_of(value, True) if sym["fixed"] else None
            return sym
        if sym["t"] == "plot":
            self.report("E214", f"`{name}` is a plot handle and can't be set again.", target)
            return None
        return sym

    def declare(self, ctx, target, t, fixed, pre):
        name = target["id"]
        sym = self.new_sym(name, t, fixed, ctx["fn"]["prefix"] if ctx["fn"] else "v_", False)
        sym["scope"] = ctx["scope"]
        sym["defined"] = not pre
        sym["pre"] = pre
        ctx["scope"].vars[name] = sym
        return sym

    def new_sym(self, name, t, fixed, prefix, defined):
        sym = {
            "id": self.sym_count, "name": name, "js": f"{prefix}{name}", "t": t, "fixed": fixed,
            "isVar": False, "hist": False, "defined": defined, "input": None, "scope": None,
        }
        self.sym_count += 1
        self.syms.append(sym)
        return sym

    def reserved(self, name, node, what):
        clash = (name in GLOBALS and name not in SHADOWABLE) or name in NAMESPACES
        if name.startswith("__"):
            self.report("E211", f"Names can't start with two underscores (`{name}`).", node,
                        f"Rename it, like `{name.lstrip('_')}`.", node["col"] + len(name))
            return True
        if clash:
            kind = "series" if name in GLOBALS and GLOBALS[name]["kind"] == "series" \
                else "built-in name"
            self.report("E211", f"`{name}` is a {kind} momo script already has, so it can't be "
                        f"{'a function' if what == 'function' else 'a variable'} name.", node,
                        f"Pick another name, like `{name}_` or `my_{name}`.",
                        node["col"] + len(name))
            return True
        return False

    # ---- inputs ---------------------------------------------------------------------------

    def input_assign(self, node, entry, ctx):
        name = node["target"]["id"]
        call = node["value"]
        if not ctx["top"] or ctx["cond"] or node["op"] != "=" or node["isVar"]:
            self.report("E214", "An input is set with `name = input.int(...)` at the top level "
                        "of the script.", node, None, node["col"] + len(name))
            return []
        info = self.top.info.get(name)
        if info and info["count"] > 1:
            self.report("E214", f"`{name}` is an input, so it can't be set again.",
                        node["target"],
                        f"Use another name for the second value: {name}2 = {name} + 1")
            return []
        kind = entry["name"][6:]
        args = self.bind(entry, call, ctx, {"literals": True, "sourceDefault": kind == "source"})
        if args is None:
            self.mark_defined(ctx, name)
            return []
        by = {a["name"]: args[i] for i, a in enumerate(entry["args"])}
        dflt = by["default"]["lit"]
        meta = {"key": name, "kind": kind, "default": dflt, "title": by["title"]["lit"] or name,
                "min": None, "max": None, "step": None, "options": None,
                "group": by["group"]["lit"] or "", "tooltip": by["tooltip"]["lit"] or ""}
        first_arg = call["args"][0] if call["args"] else call
        if kind in ("int", "float"):
            meta["min"] = by["min"]["lit"]
            meta["max"] = by["max"]["lit"]
            meta["step"] = by["step"]["lit"]
            if kind == "int" and not is_integer(dflt):
                self.report("E301", "An int input needs a whole number.", first_arg,
                            "Use input.float for decimals.")
            if meta["min"] is not None and meta["max"] is not None and meta["min"] > meta["max"]:
                self.report("E301", "min is above max.", call)
            if ((meta["min"] is not None and dflt < meta["min"])
                    or (meta["max"] is not None and dflt > meta["max"])):
                self.report("E301", f"The default {jsnum.js_str(dflt)} is outside min..max.",
                            first_arg)
        if kind == "choice":
            options = by["options"]["lit"]
            ok = isinstance(options, list) and len(options) > 0 \
                and all(isinstance(o, str) for o in options)
            if not ok:
                self.report("E215", 'options must be a list of text, like options=["Left", '
                            '"Right"].', call)
            elif dflt not in options:
                self.report("E301", f'The default "{dflt}" isn\'t one of the options.',
                            first_arg)
            meta["options"] = options
        if kind == "color":
            c = by["default"].get("color")
            meta["default"] = format_color(c) or "#2962ff"
        if kind == "source":
            meta["default"] = by["default"]["lit"]
        t = {"int": "number", "float": "number", "source": "number", "bool": "bool",
             "choice": "string", "color": "color"}[kind]
        sym = self.declare(ctx, node["target"], t, kind != "source", False)
        sym["defined"] = True
        sym["fixed"] = kind != "source"
        numeric = kind in ("int", "float")
        sym["constVal"] = meta["default"] if numeric else None
        sym["boundVal"] = (meta["max"] if meta["max"] is not None else meta["default"]) \
            if numeric else None
        input_ = {"k": "input", "kind": kind, "key": name, "t": t, "fixed": kind != "source",
                  "meta": meta, "def": meta["default"], "min": meta["min"], "max": meta["max"],
                  "id": len(self.inputs), "line": call["line"], "col": call["col"]}
        sym["input"] = input_
        self.inputs.append(input_)
        return []

    # ---- outputs --------------------------------------------------------------------------

    def unique_key(self, title):
        base = slug(title)
        key = base
        n = 2
        while key in self.keys:
            key = f"{base}_{n}"
            n += 1
        self.keys.add(key)
        return key

    def output(self, call, entry, ctx, handle):
        name = entry["name"]
        if name != "log" and (not ctx["top"] or ctx["cond"]):
            where = "inside a function" if ctx["fn"] else f"inside {ctx['why'] or 'an if'}"
            self.report("E207", f"{name}() has to be at the top level of the script, not "
                        f"{where}.", call,
                        "Compute the value you need there, then call it at the top level.",
                        self.span(call))
            return []
        if entry.get("later"):
            self.later(entry, call)
            return []
        args = self.bind(entry, call, ctx, {"variadic": entry.get("variadic")})
        if args is None:
            return []
        by = {a["name"]: args[i] for i, a in enumerate(entry["args"])}

        def lit(n):
            return by[n]["lit"] if n in by else None

        def color_of(a):
            return a["e"] if a is not None and a.get("e") else None

        def meta(extra):
            self.outputs.append(extra)
            return extra

        def color_text(c):
            return format_color(c["v"]) if c and c["k"] == "color" else None

        def color_series(c):
            return bool(c) and c["k"] != "color" and c["k"] != "na"

        if name == "plot":
            title = lit("title") or f"Plot {self.plot_count + 1}"
            self.plot_count += 1
            key = self.unique_key(title)
            style = lit("style")
            c = color_of(by["color"])
            m = {"key": key, "kind": style, "title": title, "color": color_text(c),
                 "colorSeries": color_series(c), "width": lit("width"), "style": style}
            if lit("format"):
                m["format"] = lit("format")
            meta(m)
            if handle is not None:
                handle["key"] = key
            return [{"k": "out", "what": "plot", "key": key, "v": by["src"]["e"], "color": c}]
        if name == "hline":
            title = lit("title") or "Line"
            key = self.unique_key(title)
            c = color_of(by["color"])
            meta({"key": key, "kind": "hline", "title": title, "color": color_text(c),
                  "width": 1, "style": lit("style"), "price": self.const_of(by["price"]["e"])})
            self.plot_count += 1
            if handle is not None:
                handle["key"] = key
            return []
        if name == "fill":
            refs = [by["a"]["e"], by["b"]["e"]]
            if any(is_err(r) for r in refs):
                return []
            key = self.unique_key("fill")
            c = color_of(by["color"])
            meta({"key": key, "kind": "fill", "title": "Fill", "color": color_text(c),
                  "colorSeries": color_series(c), "a": refs[0].get("key"),
                  "b": refs[1].get("key")})
            return [{"k": "out", "what": "fill", "key": key, "color": c}] \
                if c and c["k"] != "color" else []
        if name == "level":
            title = lit("title") or "Level"
            key = self.unique_key(title)
            c = color_of(by["color"])
            meta({"key": key, "kind": "level", "title": title, "color": color_text(c),
                  "width": 1, "style": lit("style")})
            return [{"k": "out", "what": "level", "key": key, "v": by["price"]["e"],
                     "show": by["show"]["e"], "color": c, "style": lit("style"),
                     "title": title}]
        if name == "marker":
            title = lit("title") or "Marker"
            key = self.unique_key(title)
            c = color_of(by["color"])
            at = by["at"]["e"]
            at_mode = at["v"] if at["k"] == "str" else "price"
            if at["k"] == "str" and at["v"] not in ("above", "below"):
                near = did_you_mean(at["v"], ["above", "below"])
                kw = next((k for k in call["kwargs"] if k["name"] == "at"), call)
                self.report("E305", f'at must be "above", "below" or a price, not "{at["v"]}".',
                            kw, f'Did you mean "{near}"?' if near else None)
            meta({"key": key, "kind": "marker", "title": title, "color": color_text(c),
                  "shape": lit("shape"), "at": at_mode})
            return [{"k": "out", "what": "marker", "key": key, "cond": by["cond"]["e"],
                     "at": self.coerce(at, "number", call) if at_mode == "price" else None,
                     "atMode": at_mode, "color": c, "shape": lit("shape"),
                     "text": by["text"]["e"]}]
        if name in ("barcolor", "bgcolor"):
            if not any(o["kind"] == name for o in self.outputs):
                meta({"key": self.unique_key(name), "kind": name,
                      "title": "Bar colour" if name == "barcolor" else "Background",
                      "color": None})
            return [{"k": "out", "what": name, "color": by["color"]["e"]}]
        if name == "stat":
            return [{"k": "out", "what": "stat", "title": lit("title"), "v": by["x"]["e"],
                     "color": color_of(by["color"]), "format": lit("format")}]
        if name in ("signal", "value"):
            label = lit("name")
            if label is None:
                return []
            if not SIGNAL_NAME.fullmatch(label):
                self.report("E215", "A signal name starts with a letter and uses letters, "
                            "digits and _ (32 at most).",
                            call["args"][0] if call["args"] else call)
                return []
            if label in self.names:
                self.report("E216", f'The name "{label}" is used twice.',
                            call["args"][0] if call["args"] else call,
                            "Give each signal() and value() its own name.")
                return []
            self.names.add(label)
            self.signals.append({"name": label, "kind": "bool" if name == "signal" else "number"})
            return [{"k": "out", "what": name, "name": label,
                     "v": by["cond"]["e"] if name == "signal" else by["x"]["e"]}]
        if name == "log":
            return [{"k": "out", "what": "log", "args": [a["e"] for a in args]}]
        self.report("E217", f"{name}() isn't available yet.", call)
        return []

    def later(self, entry, node):
        self.report("E217", f"{entry['name']} isn't available yet (planned: {entry['later']}).",
                    node, None, self.span(node))
        return ERROR_TYPE

    # ---- looking names up -----------------------------------------------------------------

    def lookup(self, ctx, name, own_only=False):
        """The symbol a name means here: this scope, then (inside a function) the top level."""
        scope = ctx["scope"] if ctx else self.top
        own = scope.vars.get(name)
        if own or own_only:
            return own or None
        return self.top.vars.get(name) if scope is not self.top else None

    def read(self, sym):
        return {"k": "sym", "t": sym["t"], "fixed": sym["fixed"], "sym": sym}

    # ---- expressions ----------------------------------------------------------------------

    def expr(self, node, ctx):
        kind = node["type"]
        if kind == "Num":
            return {"k": "num", "t": "number", "fixed": True, "v": node["value"]}
        if kind == "Str":
            if len(node["value"]) > LIMITS["string"]:
                self.report("E403", f"Text is limited to {LIMITS['string']} characters.", node)
            return {"k": "str", "t": "string", "fixed": True, "v": node["value"]}
        if kind == "Bool":
            return {"k": "bool", "t": "bool", "fixed": True, "v": node["value"]}
        if kind == "Na":
            return {"k": "na", "t": "na", "fixed": True}
        if kind == "Name":
            return self.name_expr(node, ctx)
        if kind == "FStr":
            return self.fstr(node, ctx)
        if kind == "List":
            return self.list_expr(node, ctx)
        if kind == "Tuple":
            return self.fail("E308", "A group of values with commas only works in `return a, b`.",
                             node, "Return them from a function and unpack: a, b = f(...)")
        if kind == "Unary":
            return self.unary(node, ctx)
        if kind == "Binary":
            return self.binary(node, ctx)
        if kind == "Cond":
            return self.cond_expr(node, ctx)
        if kind == "Index":
            return self.index(node, ctx)
        if kind == "Attr":
            return self.attr(node, ctx)
        if kind == "Call":
            return self.call(node, ctx)
        return self.fail("E213", "Unsupported expression.", node)

    def name_expr(self, node, ctx):
        name = node["id"]
        sym = self.lookup(ctx, name)
        if sym:
            if not sym["defined"]:
                return self.fail("E203", f"`{name}` is used before it is set.", node,
                                 f"Set `{name}` on an earlier line, or read last bar's value "
                                 f"with {name}[1].")
            if sym["t"] == "plot":
                return {"k": "plotref", "t": "plot", "fixed": True, "key": sym.get("plotKey")}
            return self.read(sym)
        entry = GLOBALS.get(name)
        if entry and entry["kind"] == "series":
            return self.series(name, entry, node)
        if name in self.functions or (entry and entry["kind"] != "series"):
            return self.fail("E309", f"`{name}` is a function; call it with ( ).", node,
                             f"{name}(...)")
        if name in NAMESPACES:
            picks = " or ".join(f"{name}.{m}" for m in members(name)[:2])
            return self.fail("E305", f"`{name}` is a group of built-ins; pick one, like "
                             f"{picks}.", node)
        return self.unknown(name, node, ctx)

    def unknown(self, name, node, ctx):
        scope = ctx["scope"] if ctx else self.top
        near = None
        if len(self.errors) < SUGGESTED_ERRORS:
            candidates = [*scope.vars, *self.top.vars, *self.functions,
                          *[n for n in GLOBALS if "." not in n], *NAMESPACES]
            near = did_you_mean(name, candidates[-SUGGESTED_NAMES:])
        if name in scope.info or name in self.top.info:
            return self.fail("E203", f"`{name}` is used before it is set.", node,
                             f"Set `{name}` on an earlier line.")
        return self.fail("E201", f"`{name}` isn't defined.", node,
                         f"Did you mean `{near}`?" if near else None)

    def series(self, name, entry, node):
        if entry.get("later"):
            return self.later(entry, node)
        self.uses.add(name)
        return {"k": "ser", "t": entry["type"], "fixed": bool(entry.get("fixed")), "name": name}

    def fstr(self, node, ctx):
        parts = []
        for p in node["parts"]:
            if isinstance(p, str):
                parts.append(p)
                continue
            e = self.expr(p["expr"], ctx)
            if not is_err(e) and e["t"] in ("list", "plot", "tuple", "void"):
                self.report("E301", "An f-string can show numbers, true/false, text and "
                            "colours.", p["expr"])
                parts.append({"e": ERROR_TYPE, "spec": p["spec"]})
            else:
                parts.append({"e": e, "spec": p["spec"]})
        fixed = all(isinstance(p, str) or p["e"]["fixed"] for p in parts)
        return {"k": "fstr", "t": "string", "fixed": fixed, "parts": parts}

    def list_expr(self, node, ctx):
        if len(node["items"]) > LIMITS["list"]:
            self.report("E404", f"A list holds at most {LIMITS['list']} items.", node)
        items = [self.coerce(self.expr(n, ctx), "number", n) for n in node["items"]]
        return {"k": "list", "t": "list", "fixed": False, "items": items}

    def unary(self, node, ctx):
        a = self.expr(node["operand"], ctx)
        if is_err(a):
            return a
        if node["op"] == "not":
            return {"k": "un", "op": "!", "t": "bool", "fixed": a["fixed"],
                    "a": self.coerce(a, "bool", node["operand"])}
        n = self.coerce(a, "number", node["operand"])
        if is_err(n):
            return n
        if n["k"] == "num":
            return {**n, "v": -n["v"]}
        return {"k": "un", "op": "-", "t": "number", "fixed": n["fixed"], "a": n}

    def bin(self, op, a, b):
        return {"k": "bin", "op": op, "t": "number" if op in ARITH else "bool",
                "fixed": a["fixed"] and b["fixed"], "a": a, "b": b}

    def binary(self, node, ctx):
        left = self.expr(node["left"], ctx)
        right = self.expr(node["right"], ctx)
        if is_err(left) or is_err(right):
            return ERROR_TYPE
        op = node["op"]
        if op in ("and", "or"):
            return {"k": "bin", "op": "&&" if op == "and" else "||", "t": "bool",
                    "fixed": left["fixed"] and right["fixed"],
                    "a": self.coerce(left, "bool", node["left"]),
                    "b": self.coerce(right, "bool", node["right"])}
        if op in ARITH or op in ORDER:
            a = self.coerce(left, "number", node["left"], f"`{op}` needs numbers")
            b = self.coerce(right, "number", node["right"], f"`{op}` needs numbers")
            return ERROR_TYPE if is_err(a) or is_err(b) else self.bin(op, a, b)
        # == and !=: numbers, text, true/false and colours compare with their own kind.
        kinds = {t for t in (left["t"], right["t"]) if t != "na"}
        if len(kinds) == 2 and not ("number" in kinds and ("bool" in kinds or "color" in kinds)):
            return self.fail("E301", f"Can't compare {self.say(left['t'])} with "
                             f"{self.say(right['t'])}.", node)
        if left["t"] in ("list", "plot") or right["t"] in ("list", "plot"):
            return self.fail("E301", "Lists can't be compared.", node)
        if "string" in kinds:
            return {"k": "bin", "op": "===" if op == "==" else "!==", "t": "bool",
                    "fixed": left["fixed"] and right["fixed"], "a": left, "b": right,
                    "text": True}
        a = self.coerce(left, "number", node["left"])
        b = self.coerce(right, "number", node["right"])
        return {"k": "bin", "op": op, "t": "bool", "fixed": a["fixed"] and b["fixed"], "a": a,
                "b": b}

    def cond_expr(self, node, ctx):
        test = self.coerce(self.expr(node["test"], ctx), "bool", node["test"])
        a = self.expr(node["then"], ctx)
        b = self.expr(node["else"], ctx)
        if is_err(test) or is_err(a) or is_err(b):
            return ERROR_TYPE
        if a["t"] == "na":
            t = "number" if b["t"] == "na" else b["t"]
        elif b["t"] == "na" or a["t"] == b["t"]:
            t = a["t"]
        elif a["t"] in ("number", "bool", "color") and b["t"] in ("number", "bool", "color"):
            if a["t"] == "color" or b["t"] == "color":
                t = "number" if a["t"] == "bool" or b["t"] == "bool" else "color"
            else:
                t = "number"
        else:
            return self.fail("E301", "The two sides of this condition are different kinds "
                             f"({self.say(a['t'])} and {self.say(b['t'])}).", node)
        if t in ("list", "plot"):
            return self.fail("E301", "A condition can choose between numbers, text, true/false "
                             "and colours.", node)
        return {"k": "cond", "t": t, "fixed": test["fixed"] and a["fixed"] and b["fixed"],
                "test": test, "a": self.fit(a, t, node["then"]),
                "b": self.fit(b, t, node["else"])}

    def say(self, t):
        return {"number": "a number", "bool": "true/false", "string": "text", "color": "a colour",
                "list": "a list", "na": "na", "plot": "a plot", "void": "nothing",
                "tuple": "several values"}.get(t, t)

    # ---- type coercion --------------------------------------------------------------------

    def coerce(self, e, want, node, lead=None):
        """Converts `e` for a place that wants type `want`; reports E301 when it can't."""
        if is_err(e):
            return e
        t = e["t"]
        if want == "any":
            if t in ("list", "plot", "tuple", "void"):
                return self.mismatch(e, "a number, true/false or text", node, lead)
            return {"k": "na", "t": "number", "fixed": True} if t == "na" else e
        if t == want:
            return e
        if t == "na":
            if want in ("list", "plot"):
                return self.mismatch(e, self.say(want), node, lead)
            return {"k": "na", "t": want, "fixed": True}
        if want == "number" and t == "bool":
            return {"k": "b2n", "t": "number", "fixed": e["fixed"], "a": e}
        if (want == "number" and t == "color") or (want == "color" and t == "number"):
            return {**e, "t": want}
        if want == "bool" and t in ("number", "color"):
            return {"k": "n2b", "t": "bool", "fixed": e["fixed"], "a": e}
        return self.mismatch(e, self.say(want), node, lead)

    def mismatch(self, e, wanted, node, lead):
        hint = 'Write a colour like color.red or "#ff9800".' \
            if e["t"] == "string" and wanted == "a colour" else None
        return self.fail("E301", f"{lead or 'Expected ' + wanted} but this is "
                         f"{self.say(e['t'])}.", node, hint)

    def fit(self, e, t, node, name=None):
        """Coerces a value stored in a variable of type `t` (E302 when it doesn't fit)."""
        if is_err(e):
            return e
        if e["t"] == t or e["t"] == "na":
            return self.coerce(e, t, node)
        ok = (t == "number" and e["t"] in ("bool", "color")) \
            or (t == "bool" and e["t"] in ("number", "color")) \
            or (t == "color" and e["t"] == "number")
        if ok:
            return self.coerce(e, t, node)
        return self.fail("E302", f"{'`' + name + '`' if name else 'This'} holds {self.say(t)} "
                         f"but is set to {self.say(e['t'])} here.", node,
                         "Use a different name for a value of another kind.")

    def const_of(self, e, bound=False):
        """The compile-time value of a fixed expression, or None. `bound`: for inputs, the
        largest value they can take (how much history a script may need)."""
        if not e or is_err(e):
            return None
        k = e["k"]
        if k == "num":
            return e["v"]
        if k == "bool":
            return 1 if e["v"] else 0
        if k in ("str", "color"):
            return e["v"]
        if k in ("b2n", "n2b"):
            return self.const_of(e["a"], bound)
        if k == "sym":
            v = e["sym"].get("boundVal" if bound else "constVal")
            return None if v is None else v
        if k == "input":
            if e["kind"] in ("int", "float"):
                if bound:
                    return e["max"] if e["max"] is not None else e["def"]
                return e["def"]
            return None
        if k == "un":
            a = self.const_of(e["a"], bound)
            return None if a is None else (-a if e["op"] == "-" else None)
        if k == "bin":
            a = self.const_of(e["a"], bound)
            b = self.const_of(e["b"], bound)
            if a is None or b is None or not is_num(a) or not is_num(b):
                return None
            op = e["op"]
            if op == "+":
                return a + b
            if op == "-":
                return a - b
            if op == "*":
                return a * b
            if op == "/":
                return None if b == 0 else a / b
            if op == "%":
                return None if b == 0 else jsnum.mod(a, b)
            if op == "**":
                return _raw_pow(a, b)
            return None
        if k == "pure":
            entry = e["entry"]
            if not entry.get("js") and entry.get("rt") != "round":
                return None
            values = [self.const_of(a, bound) for a in e["args"]]
            if any(not is_num(v) for v in values):
                return None
            if entry.get("rt") == "round":
                return jsnum.js_round(values[0])
            return _MATH[entry["js"]](*values)
        return None

    # ---- history and indexing -------------------------------------------------------------

    def history_target(self, node, ctx):
        """x[1] may come before x's first assignment in the text (last bar's value): the name
        is made now, as a number, and the later assignment fills it in."""
        if node["type"] == "Name":
            sym = self.lookup(ctx, node["id"])
            if (not sym and node["id"] not in GLOBALS and node["id"] not in NAMESPACES
                    and node["id"] in ctx["scope"].info):
                sym = self.declare(ctx, node, "number", False, True)
            if sym and sym["t"] != "plot":
                return self.read(sym)
        return self.expr(node, ctx)

    def index(self, node, ctx):
        target = self.history_target(node["target"], ctx)
        if is_err(target):
            self.expr(node["index"], ctx)
            return ERROR_TYPE
        idx_node = node["index"]
        if target["t"] == "list":
            i = self.coerce(self.expr(idx_node, ctx), "number", idx_node)
            return i if is_err(i) else {"k": "lget", "t": "number", "fixed": False,
                                        "list": target, "index": i}
        if target["t"] not in ("number", "bool", "color"):
            return self.fail("E306", f"Can't index {self.say(target['t'])}; only numbers, "
                             "true/false and lists have history or items.", node)
        off = self.expr(idx_node, ctx)
        if is_err(off):
            return off
        negative = (idx_node["type"] == "Unary" and idx_node["op"] == "-") \
            or (off["k"] == "num" and off["v"] < 0)
        c0 = self.const_of(off)
        if negative or (c0 is not None and c0 < 0):
            return self.fail("E206", "A script can't look at future bars, so a history index "
                             "can't be negative.", idx_node,
                             "Use x[1] for the previous bar. Pivots confirm themselves `right` "
                             "bars late on purpose.")
        offset = self.coerce(off, "number", idx_node)
        if is_err(offset):
            return offset
        if not offset["fixed"]:
            return self.fail("E304", "A history index must be the same on every bar: a number "
                             "or an input.", idx_node, "Use a literal like close[5], or an "
                             "input.int.")
        c = self.const_of(offset)
        if c == 0 and c is not None:
            return target
        self.max_offset = max(self.max_offset, 0 if c is None else c)
        t = "number" if target["t"] == "color" else target["t"]
        if target["k"] == "ser" and GLOBALS[target["name"]].get("array"):
            return {"k": "hist", "mode": "array", "name": target["name"], "t": t, "fixed": False,
                    "off": offset}
        if target["k"] == "sym":
            sym = target["sym"]
            sym["hist"] = True
            if sym["input"]:
                return {"k": "hist", "mode": "input", "sym": sym, "t": t, "fixed": False,
                        "off": offset}
            return {"k": "hist", "mode": "sym", "sym": sym,
                    "t": "number" if sym.get("pre") else t, "fixed": False, "off": offset}
        if ctx["cond"]:
            return self.fail("E205", "The history of an expression can't be read inside "
                             f"{ctx['why'] or 'an if'}, because it has to be tracked on every "
                             "bar.", node, "Assign the expression to a name above, then index "
                             "the name: x = a + b, then x[1].")
        id_ = self.hidden_count
        self.hidden_count += 1
        self.hidden.append({"id": id_, "t": t})
        return {"k": "hist", "mode": "hidden", "id": id_, "value": target, "t": t,
                "fixed": False, "off": offset}

    def attr(self, node, ctx):
        dotted = self.flatten(node)
        root = dotted.split(".")[0] if dotted else None
        if dotted and not self.lookup(ctx, root) and root not in self.functions:
            entry = GLOBALS.get(dotted)
            if entry:
                if entry["kind"] == "const":
                    return {"k": "color", "t": "color", "fixed": True, "v": entry["value"]}
                if entry["kind"] == "series":
                    return self.series(dotted, entry, node)
                return self.fail("E309", f"`{dotted}` is a function; call it with ( ).", node)
            if root in NAMESPACES and node["target"]["type"] == "Name":
                return self.fail("E202", f"`{node['name']}` isn't in `{root}`.",
                                 {**node, "col": node["nameCol"], "line": node["nameLine"]},
                                 self.suggest(node["name"], root))
            if root not in NAMESPACES and node["target"]["type"] == "Name":
                base = self.name_expr(node["target"], ctx)
                if is_err(base):
                    return base
        target = self.expr(node["target"], ctx)
        if is_err(target):
            return target
        at = {"line": node["nameLine"], "col": node["nameCol"]}
        methods = METHODS.get("color" if target["t"] == "color" else target["t"]) or {}
        if node["name"] in methods:
            return self.fail("E306", f"`{node['name']}` is a method; call it with ( ).", at,
                             f"{node['name']}(...)")
        return self.fail("E202", f"{ucfirst(self.say(target['t']))} has no `{node['name']}`.",
                         at)

    def suggest(self, name, namespace):
        near = did_you_mean(name, members(namespace))
        return f"Did you mean `{namespace}.{near}`?" if near \
            else f"{namespace} has: {', '.join(members(namespace))}."

    # ---- calls ----------------------------------------------------------------------------

    def call(self, node, ctx):
        callee = node["callee"]
        if callee["type"] == "Name":
            return self.call_name(node, callee["id"], ctx)
        # ns.fn(...) or value.method(...)
        dotted = self.flatten(callee)
        root = dotted.split(".")[0] if dotted else None
        if dotted and not self.lookup(ctx, root) and root not in self.functions:
            entry = GLOBALS.get(dotted)
            if entry:
                return self.call_entry(node, entry, ctx)
            if root in NAMESPACES and callee["target"]["type"] == "Name":
                return self.fail("E202", f"`{callee['name']}` isn't in `{root}`.",
                                 {"line": callee["nameLine"], "col": callee["nameCol"]},
                                 self.suggest(callee["name"], root))
        return self.method_call(node, ctx)

    def call_name(self, node, name, ctx):
        sym = self.lookup(ctx, name)
        if sym:
            return self.fail("E305", f"`{name}` is a value, not a function.", node["callee"])
        fn = self.functions.get(name)
        if fn:
            return self.call_user(node, fn, ctx)
        entry = GLOBALS.get(name)
        if entry and entry["kind"] not in ("series", "const"):
            return self.call_entry(node, entry, ctx)
        if name in NAMESPACES:
            return self.fail("E305", f"`{name}` is a group of built-ins; write "
                             f"{name}.something(...).", node["callee"])
        if name in self.all_defs:
            return self.fail("E201", f"The function `{name}` is defined below this line.",
                             node["callee"], "Move the `def` above its first use.")
        return self.unknown(name, node["callee"], ctx)

    def call_entry(self, node, entry, ctx):
        if entry.get("later"):
            return self.later(entry, node["callee"])
        kind = entry["kind"]
        if kind == "ta":
            return self.ta_call(node, entry, ctx)
        if kind == "pure":
            return self.pure_call(node, entry, ctx)
        if kind == "input":
            return self.fail("E214", "An input is set with `name = input.int(...)` at the top "
                             "level of the script.", node)
        if kind == "output":
            return self.fail("E207", f"{entry['name']}() is a statement at the top level of the "
                             "script; it can't be used as a value.", node)
        if kind == "special":
            return self.special_call(node, entry, ctx)
        return self.fail("E309", f"`{entry['name']}` can't be called.", node)

    def pure_call(self, node, entry, ctx):
        args = self.bind(entry, node, ctx, {"variadic": entry.get("variadic")})
        if args is None:
            return ERROR_TYPE
        exprs = [a["e"] for a in args]
        if any(is_err(e) for e in exprs):
            return ERROR_TYPE
        return {"k": "pure", "t": entry["returns"], "fixed": all(e["fixed"] for e in exprs),
                "entry": entry, "args": exprs}

    def special_call(self, node, entry, ctx):
        name = entry["name"]
        if name == "indicator":
            return self.fail("E210", "indicator(...) is the first line of the script, once.",
                             node)
        if name == "range":
            return self.fail("E309", "range(...) only works in a `for` loop.", node,
                             "Write `for i in range(10):`.")
        args = self.bind(entry, node, ctx, {})
        if args is None:
            return ERROR_TYPE
        exprs = [x["e"] for x in args]
        a = exprs[0] if exprs else None
        b = exprs[1] if len(exprs) > 1 else None
        if any(is_err(x["e"]) for x in args):
            return ERROR_TYPE
        if name == "na":
            return {"k": "isna", "t": "bool", "fixed": a["fixed"], "a": a}
        if name == "nz":
            return {"k": "nz", "t": "number", "fixed": a["fixed"] and b["fixed"], "a": a,
                    "b": b}
        if name == "len":
            return {"k": "len", "t": "number", "fixed": False, "a": a}
        return self.later(entry, node)

    def ta_call(self, node, entry, ctx):
        if ctx["cond"]:
            example = re.sub(r"^[\w, ]+ = ", "", entry["example"], count=1)
            return self.fail("E204", f"{entry['name']} runs inside {ctx['why'] or 'an if'}, so "
                             "it would skip bars.", node,
                             f"Compute it above, on every bar, then use the result: avg = "
                             f"{example}")
        args = self.bind(entry, node, ctx, {})
        if args is None:
            return ERROR_TYPE
        if any(is_err(a["e"]) for a in args):
            return ERROR_TYPE
        ctor = []
        step = []
        values = {}
        for i, a in enumerate(entry["args"]):
            (ctor if a.get("fixed") else step).append(args[i]["e"])
            if a.get("fixed"):
                values[a["name"]] = self.const_of(args[i]["e"])
        for i, a in enumerate(entry["args"]):
            c = values.get(a["name"])
            if not a.get("fixed") or not is_num(c):
                continue
            minimum = 0 if a["name"] == "nth" else 1
            if not is_integer(c) or c < minimum or c > LIMITS["length"]:
                if i < len(node["args"]):
                    at = node["args"][i]
                else:
                    at = next((k for k in node["kwargs"] if k["name"] == a["name"]), node)
                self.report("E301", f"{a['name']} must be a whole number from {minimum} to "
                            f"{LIMITS['length']}.", at, None, self.span(at))
        bounds = {}
        for i, a in enumerate(entry["args"]):
            if a.get("fixed"):
                bounds[a["name"]] = self.const_of(args[i]["e"], True)
        if entry.get("history"):
            lookback = entry["history"](bounds)
        else:
            lookback = max([0, *[v for v in bounds.values() if is_num(v)]])
        self.max_length = max(self.max_length, lookback or 0)
        id_ = self.ta_count
        self.ta_count += 1
        multi = isinstance(entry["returns"], list)
        stepper = {"id": id_, "entry": entry, "site": [node["line"], node["col"]], "ctor": ctor,
                   "step": step, "implicit": entry["implicit"]}
        self.steppers.append(stepper)
        for i in entry["implicit"]:
            self.uses.add(i)
        out = {"k": "ta", "t": "tuple" if multi else entry["returns"], "fixed": False,
               "stepper": stepper}
        if multi:
            out["types"] = ["number" for _ in entry["returns"]]
        return out

    # ---- argument binding -----------------------------------------------------------------

    def bind(self, entry, node, ctx, opts):
        """Matches a call's arguments to the entry's parameters. Returns [{e, lit, missing}] in
        parameter order, or None after reporting."""
        params = entry["args"]
        slots = [None] * len(params)
        extras = []
        ok = True

        def fail(message, at, fix=None):
            nonlocal ok
            self.fail("E303", message, at, fix)
            ok = False

        for i, arg in enumerate(node["args"]):
            if i >= len(params):
                if opts.get("variadic"):
                    extras.append({"node": arg, "param": params[-1]})
                    continue
                n = len(params)
                fail(f"{entry['name']} takes {n} argument{'' if n == 1 else 's'} but got "
                     f"{len(node['args'])}.", arg, f"Signature: {signature(entry)}")
                continue
            slots[i] = {"node": arg, "param": params[i]}
        unknown = False
        for kw in node["kwargs"]:
            alias = KWARG_ALIASES.get(kw["name"])
            key = alias if alias and not any(p["name"] == kw["name"] for p in params) \
                else kw["name"]
            i = next((j for j, p in enumerate(params) if p["name"] == key), -1)
            if i < 0:
                near = did_you_mean(kw["name"], [p["name"] for p in params])
                unknown = True
                fail(f"{entry['name']} has no argument `{kw['name']}`.", kw,
                     f"Did you mean `{near}`?" if near else f"Signature: {signature(entry)}")
            elif slots[i]:
                fail(f"`{key}` is given twice.", kw)
            else:
                slots[i] = {"node": kw["value"], "param": params[i]}
        for i, p in enumerate(params):
            if not slots[i] and "default" not in p and not unknown:
                fail(f"{entry['name']} needs `{p['name']}`.", node,
                     f"Signature: {signature(entry)}")
        if not ok:
            return None
        bound = [self.argument(entry, slots[i], ctx, opts) if slots[i] else self.default_arg(p)
                 for i, p in enumerate(params)]
        for extra in extras:
            bound.append(self.argument(entry, extra, ctx, opts))
        return None if any(b.get("bad") for b in bound) else bound

    def default_arg(self, p):
        d = p.get("default")
        if d is None:
            e = {"k": "na", "t": "na", "fixed": True}
        elif isinstance(d, bool):
            e = {"k": "bool", "t": "bool", "fixed": True, "v": d}
        elif is_num(d):
            e = {"k": "num", "t": "number", "fixed": True, "v": d}
        else:
            e = {"k": "str", "t": "string", "fixed": True, "v": d}
        if p["type"] == "color" and e["t"] == "na":
            e = {"k": "color", "t": "color", "fixed": True, "v": 0}
        if p["type"] == "number" and e["t"] == "na":
            e = {"k": "na", "t": "number", "fixed": True}
        return {"e": e, "lit": d, "missing": True}

    def argument(self, entry, slot, ctx, opts):
        """One argument: literal, fixed and type requirements, then the value."""
        node = slot["node"]
        param = slot["param"]
        where = f"{entry['name']}({param['name']})"
        if param.get("literal"):
            lit = self.literal(node, param, opts)
            if not lit["ok"]:
                if param["type"] == "string":
                    noun = "piece of text"
                elif param["type"] == "bool":
                    noun = "true or false"
                else:
                    noun = "literal value"
                self.report("E215", f"{param['name']} must be written out as a {noun}, not "
                            "worked out.", node,
                            f'Like {param["name"]}="..."' if param["type"] == "string" else None,
                            self.span(node))
                return {"bad": True}
            choices = param.get("choices")
            if choices and lit["value"] not in choices:
                near = did_you_mean(_js_text(lit["value"]), choices)
                listed = ", ".join(f'"{c}"' for c in choices)
                self.report("E305", f"{param['name']} must be one of {listed}, not "
                            f'"{_js_text(lit["value"])}".', node,
                            f'Did you mean "{near}"?' if near else None)
                return {"bad": True}
            if (param["type"] == "string" and isinstance(lit["value"], str)
                    and len(lit["value"]) > LIMITS["string"]):
                self.report("E403", f"Text is limited to {LIMITS['string']} characters.", node)
                return {"bad": True}
            e = self.literal_expr(lit)
            return {"e": e, "lit": lit["value"], "color": lit.get("color"), "ok": True}
        e = self.expr(node, ctx)
        if param["type"] == "color" and node["type"] == "Str":
            packed = parse_color(node["value"])
            if packed is None:
                self.report("E307", f'"{node["value"]}" isn\'t a colour.', node,
                            'Write "#rrggbb", like "#2962ff", or use color.blue.')
                return {"bad": True}
            e = {"k": "color", "t": "color", "fixed": True, "v": packed}
        if is_err(e):
            return {"bad": True, "e": e}
        if param["type"] == "any":
            if node["type"] == "Str" and entry["name"] == "marker":
                return {"e": e, "lit": node["value"]}
            e = self.coerce(e, "any", node)
        else:
            e = self.coerce(e, param["type"], node, f"{where} wants {self.say(param['type'])}")
            if param.get("fixed") and not is_err(e) and not e["fixed"]:
                self.report("E304", f"{param['name']} must be the same on every bar: a number "
                            "or an input, not a series.", node,
                            f"Use a literal like {'20' if param['name'] == 'length' else '14'}, "
                            "or an input.int.", self.span(node))
                return {"bad": True}
        if is_err(e):
            return {"bad": True, "e": e}
        lit = self.literal_of(node)
        return {"e": e, "lit": None if lit is UNDEFINED else lit}

    def literal(self, node, param, opts):
        """The plain value of a literal argument, or a failure."""
        lit = self.literal_of(node)
        if lit is not UNDEFINED:
            ptype = param["type"]
            if ptype == "number" and not is_num(lit):
                return {"ok": False}
            if ptype == "string" and not isinstance(lit, str) and lit is not None:
                return {"ok": False}
            if ptype == "bool" and not isinstance(lit, bool):
                return {"ok": False}
            if ptype == "color":
                if not isinstance(lit, str):
                    return {"ok": False}
                c = parse_color(lit)
                if c is None:
                    self.report("E307", f'"{lit}" isn\'t a colour.', node,
                                'Write "#rrggbb", like "#2962ff".')
                    return {"ok": False}
                return {"ok": True, "value": lit, "color": c}
            if ptype == "list" and not isinstance(lit, list):
                return {"ok": False}
            return {"ok": True, "value": lit}
        if param["type"] == "color" and node["type"] == "Attr":
            entry = GLOBALS.get(self.flatten(node))
            if entry and entry["kind"] == "const":
                return {"ok": True, "value": format_color(entry["value"]),
                        "color": entry["value"]}
        if (opts.get("sourceDefault") and param["name"] == "default" and node["type"] == "Name"
                and node["id"] in SOURCES):
            return {"ok": True, "value": node["id"]}
        return {"ok": False}

    def literal_of(self, node):
        """A literal's value (number, text, true/false, list of those), or UNDEFINED."""
        kind = node["type"]
        if kind in ("Num", "Str", "Bool"):
            return node["value"]
        if kind == "Na":
            return None
        if kind == "Unary":
            if node["op"] != "-":
                return UNDEFINED
            v = self.literal_of(node["operand"])
            return -v if v is not UNDEFINED and is_num(v) else UNDEFINED
        if kind == "List":
            items = [self.literal_of(n) for n in node["items"]]
            return UNDEFINED if any(v is UNDEFINED for v in items) else items
        return UNDEFINED

    def literal_expr(self, lit):
        v = lit["value"]
        if lit.get("color") is not None:
            return {"k": "color", "t": "color", "fixed": True, "v": lit["color"]}
        if isinstance(v, bool):
            return {"k": "bool", "t": "bool", "fixed": True, "v": v}
        if is_num(v):
            return {"k": "num", "t": "number", "fixed": True, "v": v}
        if isinstance(v, str):
            return {"k": "str", "t": "string", "fixed": True, "v": v}
        return {"k": "na", "t": "na", "fixed": True}

    # ---- methods on values ----------------------------------------------------------------

    def method_call(self, node, ctx):
        callee = node["callee"]
        target = self.expr(callee["target"], ctx)
        at = {"line": callee["nameLine"], "col": callee["nameCol"]}
        if is_err(target):
            for a in node["args"]:
                self.expr(a, ctx)
            return target
        type_ = target["t"]
        methods = METHODS.get(type_, {})
        entry = methods.get(callee["name"])
        if not entry:
            near = did_you_mean(callee["name"], list(methods))
            return self.fail("E202", f"{ucfirst(self.say(target['t']))} has no "
                             f"`{callee['name']}`.", at,
                             f"Did you mean `{near}`?" if near else None)
        if entry.get("later"):
            return self.later({**entry, "name": callee["name"]}, at)
        args = self.bind({**entry, "name": callee["name"]}, node, ctx, {})
        if args is None:
            return ERROR_TYPE
        exprs = [a["e"] for a in args]
        if type_ == "color":
            if target["k"] == "color" and exprs[0]["k"] == "num":
                return {"k": "color", "t": "color", "fixed": True,
                        "v": with_alpha(target["v"], exprs[0]["v"])}
            return {"k": "pure", "t": "color", "fixed": target["fixed"] and exprs[0]["fixed"],
                    "entry": {"rt": "alpha", "js": None, "name": "color.alpha"},
                    "args": [target, *exprs]}
        t = "void" if entry["returns"] == "void" else entry["returns"]
        return {"k": "lm", "t": t, "fixed": False, "name": callee["name"], "list": target,
                "args": exprs, "at": [node["line"], node["col"]]}

    # ---- user functions -------------------------------------------------------------------

    def call_user(self, node, fn, ctx):
        args = [self.expr(a, ctx) for a in node["args"]]
        kwargs = [{"name": k["name"], "value": self.expr(k["value"], ctx), "node": k}
                  for k in node["kwargs"]]
        return self.inline(fn, node, args, kwargs, ctx, False)

    def inline(self, fn, node, args, kwargs, ctx, dry):
        d = fn["node"]
        fn["called"] = fn["called"] or not dry
        if fn in self.stack:
            return self.fail("E208", f"`{d['name']}` calls itself, which momo script doesn't "
                             "allow.", node, "Use a loop, or a ta function such as ta.sma, "
                             "ta.highest or ta.cum instead.")
        if not dry:
            self.call_count += 1
            if self.call_count > LIMITS["calls"]:
                return self.fail("E405", "The functions in this script are called more than "
                                 f"{LIMITS['calls']} times once expanded.", node,
                                 "Call them less often, or simplify nested calls.")
        params = d["params"]
        if len(args) > len(params):
            n = len(params)
            return self.fail("E303", f"{d['name']} takes {n} argument{'' if n == 1 else 's'} "
                             f"but got {len(args)}.", node)
        given = {}
        for i, a in enumerate(args):
            given[params[i]["name"]] = a
        for k in kwargs:
            if not any(p["name"] == k["name"] for p in params):
                near = did_you_mean(k["name"], [p["name"] for p in params])
                return self.fail("E303", f"{d['name']} has no argument `{k['name']}`.",
                                 k["node"], f"Did you mean `{near}`?" if near else None)
            if k["name"] in given:
                return self.fail("E303", f"`{k['name']}` is given twice.", k["node"])
            given[k["name"]] = k["value"]
        id_ = self.inst_count
        self.inst_count += 1
        inst = {"id": id_, "label": f"L{id_}", "prefix": f"f{id_}_", "res": [], "size": None,
                "def": d}
        scope = Scope("fn", self.top)
        scan(d["body"], scope.info)
        for p in params:
            info = scope.info.get(p["name"]) or {"count": 0}
            scope.info[p["name"]] = {**info, "count": info["count"] + 1}
        fctx = {"scope": scope, "top": False, "cond": ctx["cond"],
                "why": f"a function called from {ctx['why']}" if ctx["cond"] else "",
                "loop": False, "fn": inst}
        body = []
        for p in params:
            value = given.get(p["name"])
            if not value:
                if not p["default"]:
                    return self.fail("E303", f"{d['name']} needs `{p['name']}`.", node)
                value = self.expr(p["default"], {**fctx, "scope": self.top})
            if is_err(value):
                sym = self.new_sym(p["name"], "number", False, inst["prefix"], True)
                sym["scope"] = scope
                scope.vars[p["name"]] = sym
                continue
            if value["t"] in ("tuple", "void", "plot"):
                self.report("E301", f"{d['name']}({p['name']}) can't take "
                            f"{self.say(value['t'])}.", node)
                continue
            t = "number" if value["t"] == "na" else value["t"]
            sym = self.new_sym(p["name"], t, False, inst["prefix"], True)
            sym["scope"] = scope
            info = scope.info[p["name"]]
            sym["fixed"] = bool(value["fixed"]) and info["count"] == 1 and not ctx["cond"]
            sym["constVal"] = self.const_of(value) if sym["fixed"] else None
            sym["boundVal"] = self.const_of(value, True) if sym["fixed"] else None
            scope.vars[p["name"]] = sym
            body.append({"k": "set", "sym": sym, "v": self.coerce(value, t, node)})
        self.stack.append(fn)
        body.extend(self.stmts(d["body"], fctx))
        self.stack.pop()
        if inst["size"] is None or inst["size"] == 0:
            return {"k": "inl", "t": "void", "fixed": False, "label": inst["label"],
                    "body": body, "res": []}
        res = inst["res"]
        if len([s for s in res if s]) != inst["size"]:
            return ERROR_TYPE
        for s in res:
            s["defined"] = True
        if len(res) > 1:
            return {"k": "inl", "t": "tuple", "types": [s["t"] for s in res], "fixed": False,
                    "label": inst["label"], "body": body, "res": res}
        return {"k": "inl", "t": res[0]["t"], "fixed": False, "label": inst["label"],
                "body": body, "res": res}


def _raw_pow(a, b):
    try:
        return math.pow(a, b)
    except OverflowError:
        return float("inf")
    except (ValueError, ZeroDivisionError):
        return float("nan")


def _js_text(value):
    return jsnum.js_str(value) if is_num(value) else str(value)
