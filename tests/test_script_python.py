"""momo script on the server (src/momo_scan/script/): the Python port of the language.

The JavaScript is the reference. The golden cases in tests/script_cases/ run here as they do in
node, the `ta` steppers are checked against what the JavaScript's steppers gave, and (when node is
installed) the lexer, parser, checker, catalogue and evaluator are compared with the JavaScript's
on the golden sources and a few hundred mutations of them.
"""

from __future__ import annotations

import ast
import json
import random
import shutil
import subprocess
import tokenize
from pathlib import Path

import pytest

from momo_scan.script import catalog
from momo_scan.script.checker import check
from momo_scan.script.compile import check_source
from momo_scan.script.errors import ScriptError, describe
from momo_scan.script.evaluator import run_script
from momo_scan.script.parser import parse
from momo_scan.script.ta import TA

ROOT = Path(__file__).resolve().parents[1]
CASES = ROOT / "tests" / "script_cases"
DUMP = ROOT / "tests" / "js" / "script" / "dump.mjs"
NAMES = sorted(p.stem for p in CASES.glob("*.json"))
TOLERANCE = 1e-9


def load_bars(name):
    return json.loads((CASES / "bars" / f"bars-{name}.json").read_text())


def same(a, b):
    """na (None or NaN) equals na; numbers match to 1e-9, relative above 1."""
    if a is None or (isinstance(a, float) and a != a):
        return b is None
    return b is not None and abs(a - b) <= TOLERANCE * max(1, abs(b))


def assert_series(actual, expected, label):
    assert len(actual) == len(expected), f"{label}: length"
    for i, e in enumerate(expected):
        assert same(float(actual[i]), e), f"{label}[{i}]: got {actual[i]}, expected {e}"


def assert_subset(actual, expected, path):
    """`expected` is a subset of `actual`: objects by key, lists element by element."""
    if isinstance(expected, dict):
        for key, value in expected.items():
            assert_subset(actual.get(key) if isinstance(actual, dict) else None, value,
                          f"{path}.{key}")
    elif isinstance(expected, list):
        assert actual is not None and len(actual) == len(expected), f"{path}: length"
        for i, e in enumerate(expected):
            assert_subset(actual[i], e, f"{path}[{i}]")
    elif isinstance(expected, (int, float)) and not isinstance(expected, bool):
        assert isinstance(actual, (int, float)) and same(actual, expected), \
            f"{path}: got {actual}, expected {expected}"
    else:
        assert actual == expected, f"{path}: got {actual!r}, expected {expected!r}"


def jsonable(value):
    """What a run returns as the JSON a client would get (NaN is null)."""
    return json.loads(json.dumps(value).replace("NaN", "null").replace("Infinity", "null"))


# ---- the golden cases -------------------------------------------------------------------


def test_there_are_golden_cases():
    assert len(NAMES) >= 50


@pytest.mark.parametrize("name", NAMES)
def test_golden(name):
    spec = json.loads((CASES / f"{name}.json").read_text())
    compiled = check_source((CASES / f"{name}.momo").read_text())
    expect = spec["expect"]

    if "errors" in expect:
        assert not compiled["ok"], "expected compile errors"
        got = [{"code": e["code"], "line": e["line"], "col": e["col"]} for e in compiled["errors"]]
        assert got == expect["errors"]
        for e in compiled["errors"]:
            assert e["message"] and e["endCol"] > e["col"] - 1
        return
    assert compiled["ok"], compiled.get("errors")
    out = run_script(compiled["ir"], load_bars(spec["bars"]), spec.get("inputs") or {},
                     spec.get("extra") or {})

    if "runError" in expect:
        assert not out["ok"], "expected a run error"
        assert_subset(out["error"], expect["runError"], "runError")
        return
    assert out["ok"], out.get("error")
    for key, values in (expect.get("plots") or {}).items():
        assert key in out["plots"], f"no plot {key}"
        assert_series(out["plots"][key]["values"], values, f"plots.{key}")
    for key, at in (expect.get("plotsAt") or {}).items():
        for i, v in at.items():
            assert same(out["plots"][key]["values"][int(i)], v), f"plots.{key}[{i}]"
    for key, values in (expect.get("plotColors") or {}).items():
        assert_series(out["plots"][key]["colors"], values, f"plotColors.{key}")
    for key, values in (expect.get("signals") or {}).items():
        assert key in out["signals"], f"no signal {key}"
        assert_series(out["signals"][key], values, f"signals.{key}")
    for key, at in (expect.get("signalsAt") or {}).items():
        for i, v in at.items():
            assert out["signals"][key][int(i)] == v, f"signals.{key}[{i}]"
    if expect.get("barColors"):
        assert_series(out["barColors"], expect["barColors"], "barColors")
    if expect.get("bgColors"):
        assert_series(out["bgColors"], expect["bgColors"], "bgColors")
    for key in ("markers", "levels", "stats", "logs"):
        if expect.get(key):
            assert_subset(jsonable(out[key]), expect[key], key)
    if expect.get("meta"):
        assert_subset(jsonable(compiled["meta"]), expect["meta"], "meta")
    for plot in out["plots"].values():
        assert isinstance(plot["values"], list)


# ---- the ta steppers against the JavaScript's values -----------------------------------------

TA_EXPECTED = json.loads((CASES / "ta" / "expected.json").read_text())


def na(v):
    return float("nan") if v is None else v


def ta_columns(set_name):
    if set_name == "holes":
        return {k: [na(x) for x in v] for k, v in TA_EXPECTED["holes"].items()}
    return load_bars(set_name)


@pytest.mark.parametrize("key", list(TA_EXPECTED["results"]))
def test_ta_matches_javascript(key):
    case = TA_EXPECTED["cases"][key]
    cols = ta_columns(case["set"])
    n = len(cols["close"])

    def feed(spec):
        if isinstance(spec, (int, float)):
            return [float(spec)] * n
        if spec == "hl2":
            return [(h + low) / 2 for h, low in zip(cols["high"], cols["low"], strict=True)]
        if spec == "close>open":
            return [c > o for c, o in zip(cols["close"], cols["open"], strict=True)]
        return cols[spec]

    feeds = [feed(spec) for spec in case["inputs"]]
    stepper = TA[case["name"]]([1, 1], *case["ctor"])
    outputs = case["outputs"]
    got = [[] for _ in range(outputs)]
    for bar in range(n):
        stepper.step(*[f[bar] for f in feeds])
        for j in range(outputs):
            got[j].append(getattr(stepper, f"o{j}") if outputs > 1 else stepper.v)
    for j, expected in enumerate(TA_EXPECTED["results"][key]):
        assert_series([float(v) for v in got[j]], expected, f"{key} output {j}")


def test_ta_rejects_bad_lengths():
    from momo_scan.script.limits import RunError

    for bad in (0, 2.5, 5001, float("nan")):
        with pytest.raises(RunError) as caught:
            TA["sma"]([3, 4], bad)
        assert caught.value.code == "R404" and (caught.value.line, caught.value.col) == (3, 4)


# ---- the language front end ------------------------------------------------------------------


def error_of(source):
    result = check_source(source)
    assert not result["ok"]
    return [(e["code"], e["line"], e["col"]) for e in result["errors"]]


def test_lexer_and_parser_errors():
    assert error_of("\tx = 1") == [("E101", 1, 1)]
    assert error_of("x = 1 $ 2") == [("E102", 1, 7)]
    assert error_of('x = "abc') == [("E103", 1, 5)]
    assert error_of('x = "a\\qb"') == [("E104", 1, 7)]
    assert error_of("x = 1e") == [("E105", 1, 5)]
    assert error_of("x = (1") == [("E111", 1, 5)]
    assert error_of("if true:\nx = 1") == [("E112", 1, 9)]
    assert error_of("x = 1\n    y = 2") == [("E113", 2, 1)]
    assert error_of("1 = x") == [("E114", 1, 1)]
    assert error_of("import math") == [("E115", 1, 1)]
    assert error_of("#momo 2\n") == [("E117", 1, 1)]
    assert error_of("x = a < b < c") == [("E119", 1, 11)]
    assert error_of('x = f"{}"') == [("E107", 1, 7)]


def test_columns_count_utf16_units_like_the_javascript():
    # An emoji is two UTF-16 units, so the `$` after it is two columns further than in Python.
    assert error_of("x = '\U0001f600' $") == [("E102", 1, 10)]


def test_deep_nesting_is_an_error_not_a_crash():
    assert error_of("x = " + "(" * 150 + "1" + ")" * 150) == [("E120", 1, 105)]
    assert error_of("x = " + "-" * 200 + "1")[0][0] == "E120"
    assert error_of("x = " + "1" * 100_001)[0][0] == "E401"


def test_the_header_and_slips_are_accepted():
    tree = parse("#momo 1\nx := True\nif x:\n    pass\nelse if x:\n    pass\n")
    assert tree["header"] == {"version": 1}
    assert [s["type"] for s in tree["body"]] == ["Assign", "If"]
    assert tree["body"][0]["value"] == {"type": "Bool", "line": 2, "col": 6, "value": True}


# ---- hostile input ----------------------------------------------------------------------------

SNIPPETS = ["(", ")", "[", "]", ",", ":", "=", "==", "!=", "**", "-", "not ", " and ", " or ",
            "if ", "else", "def ", "return ", "\n", "    ", "\t", "#", "//", '"', "'", 'f"{', "}",
            "na", "true", "ta.", "close", "[1]", "[-1]", "0", "1e999", "1e-999", "\u0430", "`",
            "$", "\\", "__x", "constructor", "toString", "plot(", "input.int(", "var ",
            "for i in range(", "while true:", "break", "xs.push(", "2 ** 2 ** 2", ".5", "1_0",
            "e", "\U0001f600", "\x00", "\u2028", "x.constructor()", "len(", "math.sqrt(",
            "ta.sma(close, ", "ta.sma(close, 3)", "color.blue.alpha(", "[1, 2, 3]"]


def case_sources():
    return [(CASES / f"{name}.momo").read_text() for name in NAMES
            if (CASES / f"{name}.momo").exists()]


def mutate(source, rnd):
    text = source
    for _ in range(rnd.randint(1, 3)):
        at = rnd.randint(0, len(text))
        kind = rnd.randint(0, 5)
        if kind <= 1:
            text = text[:at] + rnd.choice(SNIPPETS) + text[at:]
        elif kind == 2:
            text = text[:at] + text[at + 1 + rnd.randint(0, 8):]
        elif kind == 3:
            lines = text.split("\n")
            del lines[rnd.randrange(len(lines))]
            text = "\n".join(lines)
        elif kind == 4:
            lines = text.split("\n")
            lines.insert(rnd.randrange(len(lines)), rnd.choice(lines))
            text = "\n".join(lines)
        else:
            words = text.split(" ")
            a, b = rnd.randrange(len(words)), rnd.randrange(len(words))
            words[a], words[b] = words[b], words[a]
            text = " ".join(words)
    return text


def corpus(count, seed):
    rnd = random.Random(seed)
    base = case_sources()
    return base + [mutate(rnd.choice(base), rnd) for _ in range(count)]


def test_mutated_scripts_never_crash():
    """Whatever the text, check_source returns errors or a script, and a script runs or stops
    with a RunError: no other exception ever escapes."""
    bars = load_bars("trend")
    ran = 0
    for source in corpus(1500, 20261103):
        result = check_source(source)
        if result["ok"]:
            out = run_script(result["ir"], bars)
            assert out["ok"] or out["error"]["code"] in ("R402", "R403", "R404"), out
            ran += 1
        else:
            assert result["errors"] and all(e["code"][0] == "E" for e in result["errors"])
    assert ran > 100


def test_a_script_cannot_reach_python():
    hostile = [
        'indicator("x")\nplot(__import__("os").getcwd(), "p")',
        'indicator("x")\nplot(close.__class__, "p")',
        'indicator("x")\nplot(close.__dict__, "p")',
        'indicator("x")\nx = [].__class__.__bases__\nplot(close, "p")',
        'indicator("x")\nplot(open("/etc/passwd"), "p")',
        'indicator("x")\nplot(eval("1"), "p")',
        'indicator("x")\n__builtins__ = 1\nplot(close, "p")',
    ]
    for source in hostile:
        assert not check_source(source)["ok"], source


def test_the_package_never_executes_generated_code():
    banned = {"exec", "eval", "compile", "__import__"}
    modules = {"ast", "importlib", "pickle", "marshal", "ctypes", "code", "codeop"}
    for path in sorted((ROOT / "src" / "momo_scan" / "script").glob("*.py")):
        tree = ast.parse(path.read_text())
        for node in ast.walk(tree):
            if isinstance(node, ast.Call):
                func = node.func
                name = func.id if isinstance(func, ast.Name) else \
                    func.attr if isinstance(func, ast.Attribute) else ""
                owner = func.value.id if isinstance(func, ast.Attribute) \
                    and isinstance(func.value, ast.Name) else ""
                assert name not in banned or owner == "re", f"{path.name}:{node.lineno} {name}()"
            if isinstance(node, ast.Import):
                assert not modules & {a.name.split(".")[0] for a in node.names}, path.name
            if isinstance(node, ast.ImportFrom) and node.module:
                assert node.module.split(".")[0] not in modules, path.name


def test_grep_finds_no_exec_eval_or_compile():
    """A token-level grep (so docstrings and comments don't count) for the calls that would run
    generated code: a bare exec(, eval(, compile( or __import__(, or `builtins.` use."""
    for path in sorted((ROOT / "src" / "momo_scan" / "script").glob("*.py")):
        with path.open("rb") as f:
            tokens = [t for t in tokenize.tokenize(f.readline)
                      if t.type in (tokenize.NAME, tokenize.OP)]
        padded = [None, *tokens, None]
        for k, token in enumerate(tokens, 1):
            before, after = padded[k - 1], padded[k + 1]
            if token.string in {"exec", "eval", "compile", "__import__", "builtins"}:
                attribute = before is not None and before.string == "."
                called = after is not None and after.string == "("
                assert attribute or not called, f"{path.name}:{token.start[0]} {token.string}"
                assert token.string != "builtins", f"{path.name}:{token.start[0]}"


# ---- against the JavaScript (needs node) ------------------------------------------------------


def node_dump(op, payload):
    node = shutil.which("node")
    if node is None:
        pytest.skip("node is not installed")
    result = subprocess.run([node, str(DUMP), op], input=json.dumps(payload),
                            capture_output=True, text=True, timeout=300, check=True)
    return json.loads(result.stdout)


def plain(value, key=None):
    """JSON-comparable: no scopes, entries by name, whole floats as ints, no None."""
    if key == "scope" or key == "history" or callable(value):
        return None
    if key == "entry" and isinstance(value, dict) and "name" in value:
        return value["name"]
    if isinstance(value, (set, frozenset)):
        return sorted(value)
    if isinstance(value, float):
        if value != value or value in (float("inf"), float("-inf")):
            return {float("inf"): "Infinity", float("-inf"): "-Infinity"}.get(value, "NaN")
        if value == int(value) and abs(value) < 1e15:
            return int(value)
    if isinstance(value, dict):
        out = {}
        for k, x in value.items():
            n = plain(x, k)
            if n is not None:
                out[k] = n
        return out
    if isinstance(value, (list, tuple)):
        return [plain(x) for x in value]
    return value


def no_nulls(value):
    if isinstance(value, dict):
        return {k: no_nulls(v) for k, v in value.items() if v is not None}
    if isinstance(value, list):
        return [no_nulls(v) for v in value]
    return value


def comparable(value):
    return no_nulls(json.loads(json.dumps(plain(value))))


SIZE = 300
SEED = 7


def too_deep(js):
    return "crash" in js and "call stack" in js["crash"]


def test_catalogue_matches_javascript():
    js = node_dump("catalog", None)
    mine = {"globals": catalog.GLOBALS, "methods": catalog.METHODS,
            "namespaces": sorted(catalog.NAMESPACES),
            "histories": {}, "palette": catalog.PALETTE}
    for name, entry in catalog.GLOBALS.items():
        if entry.get("history"):
            names = [a["name"] for a in entry["args"] if a.get("fixed")]
            mine["histories"][name] = entry["history"]({n: i + 2 for i, n in enumerate(names)})
    js["namespaces"] = sorted(js["namespaces"])
    assert list(js["globals"]) == list(catalog.GLOBALS), "same names in the same order"
    for name, entry in js["globals"].items():
        assert plain(catalog.GLOBALS[name]) == json.loads(json.dumps(entry)) or \
            comparable(catalog.GLOBALS[name]) == no_nulls(entry), name
    assert comparable(mine["methods"]) == no_nulls(js["methods"])
    assert mine["namespaces"] == js["namespaces"]
    assert mine["histories"] == js["histories"]
    assert mine["palette"] == js["palette"]


def test_parser_matches_javascript():
    sources = corpus(SIZE, SEED)
    for source, js in zip(sources, node_dump("ast", sources), strict=True):
        if too_deep(js):
            continue
        try:
            got = {"ast": parse(source)}
        except ScriptError as e:
            got = {"error": describe(e)}
        assert comparable(got) == comparable(js), source


def test_checker_matches_javascript():
    sources = corpus(SIZE, SEED + 1)
    for source, js in zip(sources, node_dump("check", sources), strict=True):
        if too_deep(js):
            continue
        try:
            got = check(parse(source))
        except ScriptError as e:
            got = {"error": describe(e)}
        assert comparable(got) == comparable(js), source


def test_runs_match_javascript():
    rnd = random.Random(SEED + 2)
    jobs = []
    for source in corpus(SIZE, SEED + 2):
        for bars in (["ramp", "trend", "choppy", "intraday"] if len(jobs) < 280
                     else [rnd.choice(["ramp", "trend", "choppy", "intraday"])]):
            chart = {"interval": "5m" if bars == "intraday" else "D", "ticker": "NVDA"}
            jobs.append({"src": source, "bars": bars, "extra": {"chart": chart}})
    ran = 0
    for job, js in zip(jobs, node_dump("run", jobs), strict=True):
        result = check_source(job["src"])
        if not result["ok"]:
            got = {"compileErrors": [[e["code"], e["line"], e["col"]] for e in result["errors"]]}
        else:
            out = run_script(result["ir"], load_bars(job["bars"]), {}, job["extra"])
            out.pop("ms", None)
            out.pop("drawings", None)
            if not out["ok"]:
                out["error"].pop("message")
                js.get("error", {}).pop("message", None)
            got = jsonable(out)
            ran += 1
        assert close(got, js), (job["bars"], job["src"])
    assert ran > 100


def close(a, b):
    if isinstance(a, bool) or isinstance(b, bool):
        return bool(a) == bool(b) if isinstance(a, (bool, int)) and isinstance(b, (bool, int)) \
            else a == b
    if isinstance(a, (int, float)) and isinstance(b, (int, float)):
        return abs(a - b) <= TOLERANCE * max(1, abs(b))
    if isinstance(a, list) and isinstance(b, list):
        return len(a) == len(b) and all(close(x, y) for x, y in zip(a, b, strict=True))
    if isinstance(a, dict) and isinstance(b, dict):
        return a.keys() == b.keys() and all(close(a[k], b[k]) for k in a)
    return a == b
