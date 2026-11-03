"""The evaluator: the checker's typed IR becomes a tree of Python closures, one small function
per node, and the tree runs over the bars (what codegen.js does for the browser, without
generating anything).

No Python source is built from a script, and nothing in this package calls exec, eval or compile
(a test greps for them): a bug here can give a wrong number, not run code. The semantics are
codegen.js's, statement for statement:

- `ta` calls and inlined functions are hoisted into closures that run ahead of the statement
  using them, so they run on every bar even inside a lazy `a if c else b`, `and` or `or`.
- Plain names reset to na (or false, "", 0, []) at the start of each bar; `var` names persist.
- A loop step counts toward one budget per run (R402); lists are capped (R403); `ta` lengths are
  checked when the call first runs (R404).

Every closure takes the bar index `i`. Statement closures return None, or BREAK, CONTINUE or
RETURN for the enclosing loop or inlined function.
"""

from __future__ import annotations

import operator
import time

from . import jsnum
from . import runtime as rt
from .jsnum import NAN, u32
from .limits import LIMITS, RunError
from .parser import allow_deep_nesting
from .ta import TA

BREAK, CONTINUE, RETURN = 1, 2, 3

# Operators with a plain Python equivalent, called directly on constants and variables.
_FAST = {"+": operator.add, "-": operator.sub, "*": operator.mul, "<": operator.lt,
         "<=": operator.le, ">": operator.gt, ">=": operator.ge, "==": operator.eq}

DEFAULTS = {"number": NAN, "bool": False, "string": "", "color": 0}

_MATH = {
    "Math.abs": abs, "Math.min": jsnum.js_min, "Math.max": jsnum.js_max,
    "Math.floor": jsnum.js_floor, "Math.ceil": jsnum.js_ceil, "Math.sqrt": jsnum.js_sqrt,
    "Math.exp": jsnum.js_exp, "Math.sign": jsnum.js_sign,
}
_RT = {"round": rt.round_, "log": rt.log, "pow": rt.pow_, "clamp": rt.clamp, "rgb": rt.rgb,
       "alpha": rt.alpha}


def run_script(ir, bars, inputs=None, extra=None):
    """Runs a checked script over the bars. Returns {ok, ms, plots, markers, ...} or
    {ok: False, error: {code, message, line, col, i}}: the shape of the browser's run()."""
    allow_deep_nesting()
    started = time.perf_counter()
    try:
        result = Evaluator(ir, bars, inputs or {}, extra or {}).run()
    except RunError as e:
        return {"ok": False, "error": e.describe()}
    return {"ok": True, "ms": (time.perf_counter() - started) * 1000, **result}


class Evaluator:
    def __init__(self, ir, bars, inputs, extra):
        self.ir = ir
        self.bars = bars
        self.n = len(bars["close"])
        self.inputs = inputs
        self.extra = extra
        self.derived = {}
        self.cal = None
        self.ch = rt.chart(extra)
        self.T = []                 # hoisted `ta` results, one slot per call
        self.steps = [0]
        self.history = {}           # sym id to its H array
        self.plots = {}             # key to {values, colors}
        self.signals = {}           # name to array
        self.markers = []
        self.levels = []
        self.stats = []
        self.logs = []
        self.bar_colors = None
        self.bg_colors = None
        self.var_flags = {}
        self.hidden = {}
        self.slots = {}             # sym id to its place in V
        self.build_symbols()
        self.build_inputs()

    # ---- symbols and inputs --------------------------------------------------------------

    def build_symbols(self):
        plain = []
        state = []
        for sym in self.ir["syms"]:
            if sym["input"] or sym["t"] == "plot":
                continue
            (state if sym["isVar"] else plain).append(sym)
        self.plain = plain
        self.defaults = [self.default_of(s["t"]) for s in plain]
        self.list_slots = [k for k, s in enumerate(plain) if s["t"] == "list"]
        for k, sym in enumerate(plain + state):
            self.slots[sym["id"]] = k
        self.V = [self.default_of(s["t"]) for s in plain + state]
        self.n_plain = len(plain)

    @staticmethod
    def default_of(t):
        return [] if t == "list" else DEFAULTS.get(t, NAN)

    def build_inputs(self):
        self.in_values = {}
        for inp in self.ir["inputs"]:
            meta = inp["meta"]
            kind = inp["kind"]
            key = inp["key"]
            if kind == "int" or kind == "float":
                value = rt.input_number(self.inputs, key, meta["default"], meta["min"],
                                        meta["max"], kind == "int")
            elif kind == "bool":
                value = rt.input_bool(self.inputs, key, meta["default"])
            elif kind == "choice":
                value = rt.input_choice(self.inputs, key, meta["default"], meta["options"])
            elif kind == "color":
                value = rt.input_color(self.inputs, key, meta["default"])
            else:
                value = rt.input_source(self.bars, self.derived, self.inputs, key,
                                        meta["default"])
            self.in_values[inp["id"]] = value

    # ---- the run -------------------------------------------------------------------------

    def run(self):
        n = self.n
        body = self.stmts(self.ir["body"])
        commits = self.commits()
        V = self.V
        n_plain = self.n_plain
        defaults = self.defaults
        list_slots = self.list_slots
        for i in range(n):
            V[:n_plain] = defaults
            for k in list_slots:
                V[k] = []
            for s in body:
                s(i)
            for c in commits:
                c(i)
        return self.result()

    def commits(self):
        """After each bar: the values later bars read back with x[n]."""
        out = []
        V = self.V
        for sym_id, (sym, array) in self.history.items():
            k = self.slots[sym_id]
            if sym["t"] == "bool":
                out.append(lambda i, k=k, array=array: array.__setitem__(
                    i, 1.0 if V[k] else 0.0))
            else:
                out.append(lambda i, k=k, array=array: array.__setitem__(i, V[k]))
        return out

    def result(self):
        plots = {}
        for key, p in self.plots.items():
            plots[key] = {"values": p["values"], "colors": p["colors"]} if p["colors"] \
                is not None else {"values": p["values"]}
        out = {"plots": plots, "markers": self.markers, "levels": self.levels,
               "drawings": {"lines": [], "boxes": [], "labels": []}, "stats": self.stats,
               "signals": dict(self.signals), "logs": self.logs}
        if self.bar_colors is not None:
            out["barColors"] = self.bar_colors
        if self.bg_colors is not None:
            out["bgColors"] = self.bg_colors
        return out

    # ---- statements ----------------------------------------------------------------------

    def stmts(self, items):
        out = []
        for s in items:
            out.append(self.stmt(s))
        return out

    def block(self, items):
        """One closure running a list of statements, passing on break/continue/return."""
        fns = self.stmts(items)
        if not fns:
            return lambda i: None
        if len(fns) == 1:
            return fns[0]

        def run(i):
            for f in fns:
                code = f(i)
                if code:
                    return code
            return None
        return run

    def with_pre(self, pre, f):
        """The statement closure f, run after the hoisted closures in `pre`."""
        if not pre:
            return f
        if len(pre) == 1:
            p0 = pre[0]

            def one(i):
                p0(i)
                return f(i)
            return one

        def many(i):
            for p in pre:
                p(i)
            return f(i)
        return many

    def stmt(self, s):
        kind = s["k"]
        pre = []
        if kind == "set":
            k = self.slots[s["sym"]["id"]]
            v = self.ex(s["v"], pre)
            V = self.V
            if not pre:
                def set_(i):
                    V[k] = v(i)
                return set_
            if len(pre) == 1:
                p0 = pre[0]

                def set_one(i):
                    p0(i)
                    V[k] = v(i)
                return set_one

            def set_pre(i):
                for p in pre:
                    p(i)
                V[k] = v(i)
            return set_pre
        if kind == "varinit":
            k = self.slots[s["sym"]["id"]]
            flag = self.var_flags.setdefault(s["sym"]["id"], [False])
            v = self.ex(s["v"], pre)
            V = self.V

            def varinit(i):
                if not flag[0]:
                    flag[0] = True
                    for p in pre:
                        p(i)
                    V[k] = v(i)
            return varinit
        if kind == "unpack":
            return self.unpack(s)
        if kind == "if":
            test = self.ex(s["test"], pre)
            body = self.block(s["body"])
            orelse = self.block(s["orelse"]) if s["orelse"] else None
            if orelse is None:
                def if_(i):
                    if test(i):
                        return body(i)
            else:
                def if_(i):
                    return body(i) if test(i) else orelse(i)
            return self.with_pre(pre, if_)
        if kind == "for":
            return self.for_range(s)
        if kind == "forlist":
            return self.for_list(s)
        if kind == "while":
            return self.while_(s)
        if kind == "break":
            return lambda i: BREAK
        if kind == "continue":
            return lambda i: CONTINUE
        if kind == "ret":
            return lambda i: RETURN
        if kind == "expr":
            e = self.ex(s["e"], pre)
            if s["e"]["k"] == "lm":
                def effect(i):
                    e(i)
                return self.with_pre(pre, effect)
            return self.with_pre(pre, lambda i: None)
        if kind == "out":
            return self.output(s)
        raise ValueError(f"evaluator: unknown statement {kind}")

    def step_check(self, node):
        steps = self.steps
        where = (node["line"], node["col"])
        limit = LIMITS["loop_steps"]

        def step(i):
            steps[0] += 1
            if steps[0] > limit:
                raise RunError("R402", f"This loop ran more than {limit:,} steps in one run.",
                               where, i)
        return step

    def for_range(self, s):
        pre = []
        k = self.slots[s["sym"]["id"]]
        start = self.ex(s["start"], pre)
        stop = self.ex(s["stop"], pre)
        step_ = self.ex(s["step"], pre)
        body = self.block(s["body"])
        step = self.step_check(s)
        V = self.V

        def loop(i):
            a = start(i)
            b = stop(i)
            c = step_(i)
            kk = a
            while (kk < b if c > 0 else c < 0 and kk > b):
                step(i)
                V[k] = kk
                code = body(i)
                if code == BREAK:
                    break
                if code == RETURN:
                    return RETURN
                kk += c
            return None
        return self.with_pre(pre, loop)

    def for_list(self, s):
        pre = []
        k = self.slots[s["sym"]["id"]]
        list_ = self.ex(s["list"], pre)
        body = self.block(s["body"])
        step = self.step_check(s)
        V = self.V

        def loop(i):
            xs = list_(i)
            j = 0
            while j < len(xs):
                step(i)
                V[k] = xs[j]
                code = body(i)
                if code == BREAK:
                    break
                if code == RETURN:
                    return RETURN
                j += 1
            return None
        return self.with_pre(pre, loop)

    def while_(self, s):
        pre = []
        test = self.ex(s["test"], pre)
        body = self.block(s["body"])
        step = self.step_check(s)

        def loop(i):
            while True:
                for p in pre:
                    p(i)
                if not test(i):
                    break
                step(i)
                code = body(i)
                if code == BREAK:
                    break
                if code == RETURN:
                    return RETURN
            return None
        return loop

    def unpack(self, s):
        pre = []
        ks = [self.slots[sym["id"]] for sym in s["syms"]]
        V = self.V
        if s["v"]["k"] == "ta":
            holder = self.ta(s["v"], pre)[0]

            def from_ta(i):
                for p in pre:
                    p(i)
                st = holder[0]
                for j, k in enumerate(ks):
                    V[k] = getattr(st, f"o{j}")
            return from_ta
        self.ex(s["v"], pre)
        sources = [self.slots[r["id"]] for r in s["v"]["res"]]

        def from_inl(i):
            for p in pre:
                p(i)
            for k, src in zip(ks, sources, strict=True):
                V[k] = V[src]
        return from_inl

    # ---- outputs -------------------------------------------------------------------------

    def plot_buffers(self, key, colored, valueless=False):
        p = self.plots.get(key)
        if p is None:
            p = {"values": [] if valueless else [NAN] * self.n, "colors": None}
            self.plots[key] = p
        if colored and p["colors"] is None:
            p["colors"] = [0] * self.n
        return p

    @staticmethod
    def is_const_color(e):
        return not e or e["k"] == "color" or e["k"] == "na"

    def output(self, s):
        pre = []
        what = s["what"]
        n = self.n
        if what == "plot":
            colored = not self.is_const_color(s["color"])
            p = self.plot_buffers(s["key"], colored)
            v = self.ex(s["v"], pre)
            c = self.ex(s["color"], pre) if colored else None
            values = p["values"]
            colors = p["colors"]
            if colored:
                def plot_colored(i):
                    values[i] = rt.F(v(i))
                    colors[i] = u32(c(i))
                return self.with_pre(pre, plot_colored)

            def plot(i):
                x = v(i)
                values[i] = x if x - x == 0 else NAN
            return self.with_pre(pre, plot)
        if what == "fill":
            p = self.plot_buffers(s["key"], True, True)
            c = self.ex(s["color"], pre)
            colors = p["colors"]

            def fill(i):
                colors[i] = u32(c(i))
            return self.with_pre(pre, fill)
        if what == "level":
            price = self.ex(s["v"], pre)
            show = self.ex(s["show"], pre)
            color = self.ex(s["color"], pre) if s["color"] else (lambda i: 0)
            key, style, title = s["key"], s["style"], rt.text_out(s["title"])
            levels = self.levels

            def level(i):
                if i == n - 1 and show(i):
                    rt.level(levels, key, price(i), color(i), style, title)
            return self.with_pre(pre, level)
        if what == "marker":
            cond = self.ex(s["cond"], pre)
            mode = s["atMode"]
            if mode == "above":
                price = self.array_read("high")
            elif mode == "below":
                price = self.array_read("low")
            else:
                price = self.ex(s["at"], pre)
            color = self.ex(s["color"], pre) if s["color"] else (lambda i: 0)
            text = self.ex(s["text"], pre)
            key, shape = s["key"], s["shape"]
            markers = self.markers

            def marker(i):
                if cond(i):
                    rt.mark(markers, key, shape, i, price(i), color(i), text(i))
            return self.with_pre(pre, marker)
        if what in ("barcolor", "bgcolor"):
            if what == "barcolor":
                if self.bar_colors is None:
                    self.bar_colors = [0] * n
                array = self.bar_colors
            else:
                if self.bg_colors is None:
                    self.bg_colors = [0] * n
                array = self.bg_colors
            c = self.ex(s["color"], pre)

            def shade(i):
                t = c(i)
                if t == t and t:
                    array[i] = u32(t)
            return self.with_pre(pre, shade)
        if what == "stat":
            v = self.ex(s["v"], pre)
            color = self.ex(s["color"], pre) if s["color"] else (lambda i: 0)
            title, format_ = s["title"], s["format"]
            stats = self.stats

            def stat(i):
                if i == n - 1:
                    rt.stat(stats, rt.text_out(title), v(i), color(i), format_)
            return self.with_pre(pre, stat)
        if what in ("signal", "value"):
            array = [0] * n if what == "signal" else [NAN] * n
            self.signals[s["name"]] = array
            v = self.ex(s["v"], pre)
            if what == "signal":
                def signal(i):
                    array[i] = 1 if v(i) else 0
                return self.with_pre(pre, signal)

            def value(i):
                array[i] = rt.F(v(i))
            return self.with_pre(pre, value)
        if what == "log":
            args = [self.ex(a, pre) for a in s["args"]]
            logs = self.logs

            def log(i):
                rt.log_line(logs, i, [a(i) for a in args])
            return self.with_pre(pre, log)
        raise ValueError(f"evaluator: unknown output {what}")

    # ---- expressions: a closure per IR node; hoisted work goes to `pre` ------------------

    def array_of(self, name):
        if name in rt.COLUMNS:
            return self.bars[name]
        if name in rt.DERIVED:
            return rt.source_series(self.bars, self.derived, name)
        return self.calendar()[name]

    def calendar(self):
        if self.cal is None:
            self.cal = rt.calendar(self.bars["time"], self.ch["intraday"])
        return self.cal

    def array_read(self, name):
        array = self.array_of(name)
        if name == "bar_index":
            return lambda i: float(i)
        return lambda i: array[i]

    def ex(self, e, pre):
        kind = e["k"]
        if kind == "num":
            v = e["v"]
            return lambda i: v
        if kind == "str":
            v = rt.text_out(e["v"])
            return lambda i: v
        if kind == "bool":
            v = e["v"]
            return lambda i: v
        if kind == "color":
            v = u32(e["v"])
            return lambda i: v
        if kind == "na":
            t = "number" if e["t"] == "na" else e["t"]
            if t == "list":
                return lambda i: []
            v = DEFAULTS.get(t, NAN)
            return lambda i: v
        if kind == "sym":
            return self.sym_read(e["sym"])
        if kind == "ser":
            return self.series(e)
        if kind == "hist":
            return self.hist(e, pre)
        if kind == "un":
            a = self.ex(e["a"], pre)
            if e["op"] == "!":
                return lambda i: not a(i)
            return lambda i: -a(i)
        if kind == "bin":
            return self.binary(e, pre)
        if kind == "cond":
            test = self.ex(e["test"], pre)
            a = self.ex(e["a"], pre)
            b = self.ex(e["b"], pre)
            return lambda i: a(i) if test(i) else b(i)
        if kind == "b2n":
            a = self.ex(e["a"], pre)
            return lambda i: 1.0 if a(i) else 0.0
        if kind == "n2b":
            a = self.ex(e["a"], pre)

            def n2b(i):
                x = a(i)
                return x == x and x != 0
            return n2b
        if kind == "pure":
            return self.pure(e, pre)
        if kind == "isna":
            a = self.ex(e["a"], pre)

            def isna(i):
                x = a(i)
                return x != x
            return isna
        if kind == "nz":
            a = self.ex(e["a"], pre)
            b = self.ex(e["b"], pre)

            def nz(i):
                x = a(i)
                return b(i) if x != x else x
            return nz
        if kind == "len":
            a = self.ex(e["a"], pre)
            return lambda i: float(len(a(i)))
        if kind == "list":
            items = [self.ex(x, pre) for x in e["items"]]
            return lambda i: [f(i) for f in items]
        if kind == "lget":
            xs = self.ex(e["list"], pre)
            idx = self.ex(e["index"], pre)
            return lambda i: rt.lget(xs(i), idx(i))
        if kind == "lm":
            return self.list_method(e, pre)
        if kind == "fstr":
            return self.fstr(e, pre)
        if kind == "ta":
            T = self.T
            slot = self.ta(e, pre)[1]
            return lambda i: T[slot]
        if kind == "inl":
            return self.inline(e, pre)
        raise ValueError(f"evaluator: unknown expression {kind}")

    def sym_read(self, sym):
        if sym["input"]:
            inp = sym["input"]
            value = self.in_values[inp["id"]]
            if inp["kind"] == "source":
                return lambda i: value[i]
            return lambda i: value
        k = self.slots[sym["id"]]
        V = self.V
        return lambda i: V[k]

    def series(self, e):
        name = e["name"]
        n = self.n
        if name == "first_bar":
            return lambda i: i == 0
        if name == "last_bar":
            return lambda i: i == n - 1
        if name == "session.regular":
            regular = self.calendar()["regular"]
            return lambda i: regular[i] == 1
        if name == "session.new_day":
            new_day = self.calendar()["newDay"]
            return lambda i: new_day[i] == 1
        flags = {"timeframe.is_intraday": "intraday", "timeframe.is_daily": "daily",
                 "timeframe.is_weekly": "weekly", "timeframe.is_monthly": "monthly"}
        if name in flags:
            v = self.ch[flags[name]]
            return lambda i: v
        if name == "ticker":
            v = self.ch["ticker"]
            return lambda i: v
        return self.array_read(name)

    def hist(self, e, pre):
        mode = e["mode"]
        bool_ = False
        if mode == "array":
            array = self.array_of(e["name"])
        elif mode == "input":
            array = self.in_values[e["sym"]["input"]["id"]]
        elif mode == "sym":
            sym = e["sym"]
            if sym["id"] not in self.history:
                self.history[sym["id"]] = (sym, [0.0] * self.n)
            array = self.history[sym["id"]][1]
            bool_ = e["t"] == "bool"
        else:
            array = [0.0] * self.n
            bool_ = e["t"] == "bool"
            value = self.ex(e["value"], pre)
            if bool_:
                def commit_hidden(i):
                    array[i] = 1.0 if value(i) else 0.0
            else:
                def commit_hidden(i):
                    array[i] = value(i)
            pre.append(commit_hidden)
        off = e["off"]
        if off["k"] == "num" and off["v"] == int(off["v"]) and off["v"] >= 1:
            k = int(off["v"])

            def read(i):
                return array[i - k] if i >= k else NAN
        else:
            offset = self.ex(off, pre)

            def read(i):
                return rt.at(array, i, offset(i))
        if bool_:
            return lambda i: read(i) == 1
        return read

    def operand(self, e, pre):
        """("c", value) for a constant, ("v", slot) for a variable, else ("f", closure)."""
        if e["k"] == "num":
            return "c", e["v"]
        if e["k"] == "sym" and not e["sym"]["input"]:
            return "v", self.slots[e["sym"]["id"]]
        return "f", self.ex(e, pre)

    def binary(self, e, pre):
        op = e["op"]
        fast = _FAST.get(op)
        if fast is not None:
            (ak, av), (bk, bv) = self.operand(e["a"], pre), self.operand(e["b"], pre)
            V = self.V
            if ak == "v" and bk == "v":
                return lambda i: fast(V[av], V[bv])
            if ak == "v" and bk == "c":
                return lambda i: fast(V[av], bv)
            if ak == "f" and bk == "c":
                return lambda i: fast(av(i), bv)
            if ak == "f" and bk == "v":
                return lambda i: fast(av(i), V[bv])
            if ak == "v" and bk == "f":
                return lambda i: fast(V[av], bv(i))
            if ak == "c" and bk == "f":
                return lambda i: fast(av, bv(i))
            if ak == "c" and bk == "v":
                return lambda i: fast(av, V[bv])
            if ak == "f" and bk == "f":
                return lambda i: fast(av(i), bv(i))
            a = (lambda i: av) if ak == "c" else None
            b = (lambda i: bv) if bk == "c" else None
            return lambda i: fast(a(i), b(i))
        a = self.ex(e["a"], pre)
        b = self.ex(e["b"], pre)
        if op == "/":
            def div(i):
                y = b(i)
                x = a(i)
                return NAN if y == 0 else x / y
            return div
        if op == "%":
            return lambda i: jsnum.mod(a(i), b(i))
        if op == "**":
            return lambda i: jsnum.js_pow(a(i), b(i))
        if op == "!=":
            def ne(i):
                x = a(i)
                y = b(i)
                return x != y and x == x and y == y
            return ne
        if op == "===":
            return lambda i: a(i) == b(i)
        if op == "!==":
            return lambda i: a(i) != b(i)
        if op == "&&":
            return lambda i: a(i) and b(i)
        if op == "||":
            return lambda i: a(i) or b(i)
        raise ValueError(f"evaluator: unknown operator {op}")

    def pure(self, e, pre):
        args = [self.ex(a, pre) for a in e["args"]]
        entry = e["entry"]
        fn = _MATH[entry["js"]] if entry.get("js") else _RT[entry["rt"]]
        if len(args) == 1:
            a0 = args[0]
            return lambda i: fn(a0(i))
        if len(args) == 2:
            a0, a1 = args
            return lambda i: fn(a0(i), a1(i))
        return lambda i: fn(*[a(i) for a in args])

    def list_method(self, e, pre):
        xs = self.ex(e["list"], pre)
        args = [self.ex(a, pre) for a in e["args"]]
        name = e["name"]
        if name == "push":
            where = (e["at"][0], e["at"][1])
            a0 = args[0]
            return lambda i: rt.lpush(xs(i), a0(i), where, i)
        if name == "pop":
            return lambda i: rt.lpop(xs(i))
        if name == "remove":
            a0 = args[0]
            return lambda i: rt.lremove(xs(i), a0(i))
        if name == "clear":
            return lambda i: xs(i).clear()
        fn = {"sum": rt.lsum, "max": rt.lmax, "min": rt.lmin, "avg": rt.lavg}[name]
        return lambda i: fn(xs(i))

    def fstr(self, e, pre):
        parts = []
        for p in e["parts"]:
            if isinstance(p, str):
                text = rt.text_out(p)
                parts.append(lambda i, text=text: text)
                continue
            v = self.ex(p["e"], pre)
            spec = p["spec"]
            if p["e"]["t"] == "color":
                parts.append(lambda i, v=v: rt.fmt_color(v(i)))
            else:
                parts.append(lambda i, v=v, spec=spec: rt.fmt(v(i), spec))
        return lambda i: "".join([f(i) for f in parts])

    def ta(self, e, pre):
        """Hoists a `ta` call: the stepper is made the first time it runs and stepped once per
        bar, ahead of the statement. Returns the stepper's holder and its temp slot."""
        stepper = e["stepper"]
        short = stepper["entry"]["name"][3:]
        ctor = [self.ex(a, pre) for a in stepper["ctor"]]
        site = (stepper["site"][0], stepper["site"][1])
        make = TA[short]
        holder = [None]
        args = [self.ex(a, pre) for a in stepper["step"]]
        args += [self.array_read(name) for name in stepper["implicit"]]
        T = self.T
        slot = -1
        if not isinstance(stepper["entry"]["returns"], list):
            T.append(NAN)
            slot = len(T) - 1

        count = len(args)
        a0 = args[0] if count > 0 else None
        a1 = args[1] if count > 1 else None
        a2 = args[2] if count > 2 else None

        def run(i):
            st = holder[0]
            if st is None:
                st = holder[0] = make(site, *[c(i) for c in ctor])
            if count == 1:
                st.step(a0(i))
            elif count == 2:
                st.step(a0(i), a1(i))
            elif count == 3:
                st.step(a0(i), a1(i), a2(i))
            else:
                st.step(*[a(i) for a in args])
            if slot >= 0:
                T[slot] = st.v
        pre.append(run)
        return holder, slot

    def inline(self, e, pre):
        body = self.block(e["body"])

        def run(i):
            body(i)
        pre.append(run)
        if not e["res"]:
            return lambda i: NAN
        k = self.slots[e["res"][0]["id"]]
        V = self.V
        return lambda i: V[k]

