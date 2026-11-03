"""momo script parser: tokens to the AST in docs/scripting.md "Contracts" (the port of parser.js).

Recursive descent, Python's grammar with the slips momo accepts (`True`, `:=`, `else if`, the
`#momo` header). Raises ScriptError (E110-E120) on the first syntax error; the checker finds the
rest. Nodes are dicts {type, line, col, ...fields}.
"""

from __future__ import annotations

import re
import sys

from .errors import ScriptError
from .lexer import UNSUPPORTED, tokenize

COMPARE = frozenset(["<", "<=", ">", ">=", "==", "!="])
AUGMENTED = frozenset(["+=", "-=", "*=", "/="])
MAX_EXPR_DEPTH = 100
MAX_BLOCK_DEPTH = 50
RECURSION_LIMIT = 12000

_EVERYTHING = "Everything is built in: ta.sma, math.abs, input.int, plot and the rest."
_NO_EXCEPTIONS = "There are no exceptions; missing data is `na`. Test with na(x)."
_NO_NAMES = "Functions can read top-level names; assign them at the top level."
_ONCE_PER_BAR = "Scripts run once per bar, top to bottom."
_IF_ELIF = "Use `if` / `elif` / `else`."
# What to say about Python words momo script doesn't have.
UNSUPPORTED_HELP = {
    "import": _EVERYTHING,
    "from": _EVERYTHING,
    "class": "Use plain variables and lists of numbers.",
    "lambda": "Write a `def` at the top of the script.",
    "try": _NO_EXCEPTIONS,
    "except": _NO_EXCEPTIONS,
    "finally": _NO_EXCEPTIONS,
    "raise": _NO_EXCEPTIONS,
    "global": _NO_NAMES,
    "nonlocal": _NO_NAMES,
    "with": "There are no context managers.",
    "del": "Use xs.remove(i) for a list; plain names need no cleanup.",
    "assert": "Test with `if`, and use log() to look at values.",
    "yield": "A function returns once with `return`.",
    "async": _ONCE_PER_BAR,
    "await": _ONCE_PER_BAR,
    "as": "There are no imports to rename.",
    "is": "Use `==` to compare, and na(x) to test for no value.",
    "match": _IF_ELIF,
    "case": _IF_ELIF,
}

_TARGET_WORDS = {
    "Num": "a number", "Str": "a string", "FStr": "a string", "Bool": "`true`/`false`",
    "Na": "`na`", "Index": "a history value (x[1] is read-only)",
    "Attr": "a name with a dot", "Call": "a function call",
}
_VERSION = re.compile(r"^[0-9]+$")


def parse(source, comments=False):
    allow_deep_nesting()
    return Parser(tokenize(source, comments=comments)).program()


def allow_deep_nesting():
    """The depth limits (100 expressions, 50 blocks) need more Python stack than the default."""
    if sys.getrecursionlimit() < RECURSION_LIMIT:
        sys.setrecursionlimit(RECURSION_LIMIT)


def parse_tokens(tokens):
    return Parser(tokens).program()


def node(type, token, **fields):
    """A node at the position of `token` (a lexer token or another node)."""
    if isinstance(token, dict):
        return {"type": type, "line": token["line"], "col": token["col"], **fields}
    return {"type": type, "line": token.line, "col": token.col, **fields}


class Parser:
    def __init__(self, tokens):
        self.tokens = tokens
        self.p = 0
        self.expr_depth = 0
        self.block_depth = 0

    # ---- token helpers --------------------------------------------------------------------

    @property
    def tok(self):
        return self.tokens[self.p]

    def next(self):
        token = self.tokens[self.p]
        self.p += 1
        return token

    def is_op(self, value, token=None):
        token = token or self.tok
        return token.type == "OP" and token.value == value

    def is_kw(self, value):
        token = self.tok
        return token.type == "KEYWORD" and token.value == value

    def describe(self, token=None):
        token = token or self.tok
        kind = token.type
        if kind == "NEWLINE":
            return "the end of the line"
        if kind == "EOF":
            return "the end of the script"
        if kind == "INDENT":
            return "an indent"
        if kind == "DEDENT":
            return "the end of the block"
        if kind == "STR":
            return "a string"
        if kind == "FSTR":
            return "an f-string"
        if kind == "HEADER":
            return "the #momo line"
        return f"`{_js_text(token.value)}`"

    def error(self, code, message, token=None, fix=None):
        token = token or self.tok
        raise ScriptError(code, message, token.line, token.col, max(token.end_col, token.col + 1),
                          fix)

    def expect_op(self, value, fix=None):
        if not self.is_op(value):
            self.error("E110", f"Expected `{value}` but found {self.describe()}.", self.tok, fix)
        return self.next()

    # ---- statements -----------------------------------------------------------------------

    def program(self):
        header = None
        if self.tok.type == "HEADER":
            token = self.next()
            if not _VERSION.match(token.value):
                self.error("E116", "The first line should say which language version this is.",
                           token, "Write `#momo 1`.")
            version = int(token.value)
            if version != 1:
                self.error("E117", f"This script is for momo script version {version}, "
                           "which this momo doesn't know.", token,
                           "Update momo, or write `#momo 1`." if version > 1
                           else "Write `#momo 1`.")
            header = {"version": version}
        first = self.tok
        body = []
        while self.tok.type != "EOF":
            body.append(self.statement())
        return node("Program", first, header=header, body=body)

    def suite(self):
        """A block after `:`, indented lines or one simple statement on the same line."""
        if self.tok.type != "NEWLINE":
            return [self.simple()]
        newline = self.next()
        if self.tok.type != "INDENT":
            self.error("E112", "Expected an indented block here.", newline,
                       "Indent the next line by 4 spaces, or write `pass`.")
        self.block_depth += 1
        if self.block_depth > MAX_BLOCK_DEPTH:
            self.error("E120", "Blocks are nested too deeply.", self.tok)
        self.next()
        body = []
        while self.tok.type not in ("DEDENT", "EOF"):
            body.append(self.statement())
        if self.tok.type == "DEDENT":
            self.next()
        self.block_depth -= 1
        return body

    def colon(self, what):
        return self.expect_op(":", f"Add `:` at the end of the {what} line.")

    def statement(self):
        token = self.tok
        if token.type == "INDENT":
            self.error("E113", "This line is indented but nothing opened a block.", token,
                       "Remove the extra indent.")
        if token.type == "KEYWORD":
            word = token.value
            if word == "if":
                return self.if_statement()
            if word == "for":
                return self.for_statement()
            if word == "while":
                return self.while_statement()
            if word == "def":
                return self.def_statement()
            if word in ("elif", "else"):
                self.error("E110", f"`{word}` has no `if` before it.", token)
        return self.simple()

    def if_statement(self):
        token = self.next()
        test = self.expr()
        self.colon("if")
        body = self.suite()
        orelse = []
        if self.is_kw("elif"):
            orelse = [self.if_statement()]
        elif self.is_kw("else"):
            self.next()
            if self.is_kw("if"):
                orelse = [self.if_statement()]          # `else if` read as `elif`
            else:
                self.expect_op(":", "Add `:` after `else`.")
                orelse = self.suite()
        return node("If", token, test=test, body=body, orelse=orelse)

    def for_statement(self):
        token = self.next()
        name = self.tok
        if name.type != "NAME":
            self.error("E110", f"Expected a name after `for` but found {self.describe()}.", name)
        self.next()
        target = node("Name", name, id=name.value)
        if not self.is_kw("in"):
            self.error("E110", f"Expected `in` but found {self.describe()}.", self.tok,
                       "Write `for i in range(n):`.")
        self.next()
        iter_ = self.expr()
        self.colon("for")
        return node("For", token, target=target, iter=iter_, body=self.suite())

    def while_statement(self):
        token = self.next()
        test = self.expr()
        self.colon("while")
        return node("While", token, test=test, body=self.suite())

    def def_statement(self):
        token = self.next()
        name = self.tok
        if name.type != "NAME":
            self.error("E110",
                       f"Expected a function name after `def` but found {self.describe()}.", name)
        self.next()
        self.expect_op("(")
        params = []
        seen = set()
        while not self.is_op(")"):
            param = self.tok
            if param.type != "NAME":
                self.error("E110", f"Expected a parameter name but found {self.describe()}.",
                           param)
            self.next()
            if param.value in seen:
                self.error("E118", f"The parameter `{param.value}` appears twice.", param)
            seen.add(param.value)
            fallback = None
            if self.is_op("="):
                self.next()
                fallback = self.expr()
            elif params and params[-1]["default"]:
                self.error("E118",
                           "A parameter without a default can't follow one with a default.",
                           param)
            params.append({"name": param.value, "default": fallback, "line": param.line,
                           "col": param.col})
            if not self.is_op(")"):
                self.expect_op(",", "Separate parameters with commas.")
        self.next()
        self.colon("def")
        return node("Def", token, name=name.value, params=params, body=self.suite())

    def end_of_line(self):
        if self.tok.type == "NEWLINE":
            self.next()
            return
        if self.tok.type in ("EOF", "DEDENT"):
            return
        self.error("E110", f"Expected the end of the line but found {self.describe()}.")

    def simple(self):
        token = self.tok
        if token.type == "KEYWORD":
            word = token.value
            if word == "return":
                self.next()
                value = None
                if self.tok.type not in ("NEWLINE", "EOF", "DEDENT"):
                    value = self.expr()
                    if self.is_op(","):
                        value = self.tuple(value)
                stmt = node("Return", token, value=value)
            elif word == "break":
                self.next()
                stmt = node("Break", token)
            elif word == "continue":
                self.next()
                stmt = node("Continue", token)
            elif word == "pass":
                self.next()
                stmt = node("Pass", token)
            elif word == "var":
                stmt = self.var_statement()
            else:
                if word in UNSUPPORTED:
                    self.error("E115", f"momo script has no `{word}`.", token,
                               UNSUPPORTED_HELP.get(word))
                self.error("E110", f"Expected a statement but found {self.describe()}.", token)
        else:
            stmt = self.expression_statement()
        self.end_of_line()
        return stmt

    def var_statement(self):
        token = self.next()
        name = self.tok
        if name.type != "NAME":
            self.error("E110", f"Expected a name after `var` but found {self.describe()}.", name,
                       "Write `var count = 0`.")
        self.next()
        if not self.is_op("=") and not self.is_op(":="):
            self.error("E110", f"Expected `=` but found {self.describe()}.", self.tok,
                       f"Give it a starting value: var {name.value} = 0")
        self.next()
        target = node("Name", name, id=name.value)
        return node("Assign", token, target=target, op="=", value=self.expr(), isVar=True)

    def expression_statement(self):
        first = self.expr()
        if self.is_op(","):
            items = self.tuple(first)["items"]
            eq = self.tok
            if not self.is_op("=") and not self.is_op(":="):
                self.error("E110", "A list of names with commas must be unpacked with `=`.", eq,
                           "Write `a, b = f(...)`, or `return a, b` in a function.")
            for item in items:
                self.target(item)
            self.next()
            value = self.expr()
            return node("Unpack", items[0], targets=items, value=value)
        op = self.tok
        if op.type == "OP" and (op.value in ("=", ":=") or op.value in AUGMENTED):
            self.target(first)
            self.next()
            value = self.expr()
            return node("Assign", first, target=first, op="=" if op.value == ":=" else op.value,
                        value=value, isVar=False)
        return node("ExprStmt", first, expr=first)

    def target(self, n):
        if n["type"] == "Name":
            return
        what = _TARGET_WORDS.get(n["type"], "this")
        raise ScriptError("E114", f"Can't assign to {what}.", n["line"], n["col"], n["col"] + 1,
                          "Assign to a plain name; read its history with name[1]."
                          if n["type"] == "Index" else None)

    def tuple(self, first):
        items = [first]
        while self.is_op(","):
            self.next()
            if self.tok.type in ("NEWLINE", "EOF") or self.is_op("=") or self.is_op(")"):
                break
            items.append(self.expr())
        return node("Tuple", first, items=items)

    # ---- expressions ----------------------------------------------------------------------

    def nest(self):
        self.expr_depth += 1
        if self.expr_depth > MAX_EXPR_DEPTH:
            self.error("E120", "This expression is nested too deeply.", self.tok)

    def expr(self):
        self.nest()
        value = self.or_()
        if self.is_kw("if"):
            self.next()
            test = self.or_()
            if not self.is_kw("else"):
                self.error("E110", f"Expected `else` but found {self.describe()}.", self.tok,
                           "Write `a if cond else b`.")
            self.next()
            other = self.expr()
            self.expr_depth -= 1
            return node("Cond", value, test=test, then=value, **{"else": other})
        self.expr_depth -= 1
        return value

    def or_(self):
        left = self.and_()
        while self.is_kw("or"):
            self.next()
            left = node("Binary", left, op="or", left=left, right=self.and_())
        return left

    def and_(self):
        left = self.not_()
        while self.is_kw("and"):
            self.next()
            left = node("Binary", left, op="and", left=left, right=self.not_())
        return left

    def not_(self):
        if self.is_kw("not"):
            token = self.next()
            self.nest()
            operand = self.not_()
            self.expr_depth -= 1
            return node("Unary", token, op="not", operand=operand)
        return self.comparison()

    def comparison(self):
        left = self.sum()
        if self.tok.type == "OP" and self.tok.value in COMPARE:
            op = self.next()
            right = self.sum()
            if self.tok.type == "OP" and self.tok.value in COMPARE:
                self.error("E119", "Chained comparisons aren't supported.", self.tok,
                           "Write `a < b and b < c` instead of `a < b < c`.")
            return node("Binary", left, op=op.value, left=left, right=right)
        return left

    def sum(self):
        left = self.term()
        while self.is_op("+") or self.is_op("-"):
            op = self.next()
            left = node("Binary", left, op=op.value, left=left, right=self.term())
        return left

    def term(self):
        left = self.unary()
        while self.is_op("*") or self.is_op("/") or self.is_op("%"):
            op = self.next()
            left = node("Binary", left, op=op.value, left=left, right=self.unary())
        return left

    def unary(self):
        if self.is_op("-") or self.is_op("+"):
            op = self.next()
            self.nest()
            operand = self.unary()
            self.expr_depth -= 1
            return operand if op.value == "+" else node("Unary", op, op="-", operand=operand)
        return self.power()

    def power(self):
        base = self.postfix()
        if self.is_op("**"):
            self.next()
            self.nest()
            exponent = self.unary()
            self.expr_depth -= 1
            return node("Binary", base, op="**", left=base, right=exponent)
        return base

    def postfix(self):
        n = self.atom()
        while True:
            if self.is_op("("):
                if n["type"] not in ("Name", "Attr"):
                    self.error("E110", "Only a name, like `plot` or `ta.sma`, can be called.",
                               self.tok)
                n = self.call(n)
            elif self.is_op("["):
                self.next()
                if self.is_op("]"):
                    self.error("E110", "Expected an index inside `[ ]`.", self.tok)
                index = self.expr()
                self.expect_op("]")
                n = node("Index", n, target=n, index=index)
            elif self.is_op("."):
                self.next()
                name = self.tok
                if name.type != "NAME":
                    self.error("E110",
                               f"Expected a name after `.` but found {self.describe()}.", name)
                self.next()
                n = node("Attr", n, target=n, name=name.value, nameLine=name.line,
                         nameCol=name.col)
            else:
                return n

    def call(self, callee):
        self.next()
        args = []
        kwargs = []
        while not self.is_op(")"):
            t = self.tok
            if t.type == "NAME" and self.is_op("=", self.tokens[self.p + 1]):
                self.next()
                self.next()
                if any(k["name"] == t.value for k in kwargs):
                    self.error("E118", f"The argument `{t.value}` is given twice.", t)
                kwargs.append({"name": t.value, "value": self.expr(), "line": t.line,
                               "col": t.col})
            else:
                if kwargs:
                    self.error("E118", "A positional argument can't follow a keyword argument.",
                               t, "Put the arguments without a name first.")
                args.append(self.expr())
            if not self.is_op(")"):
                self.expect_op(",", "Separate arguments with commas.")
        self.next()
        return node("Call", callee, callee=callee, args=args, kwargs=kwargs)

    def atom(self):
        token = self.tok
        kind = token.type
        if kind == "NUM":
            self.next()
            return node("Num", token, value=token.value)
        if kind == "STR":
            self.next()
            return node("Str", token, value=token.value)
        if kind == "FSTR":
            self.next()
            return self.fstring(token)
        if kind == "NAME":
            return self.name()
        if kind == "OP":
            if token.value == "(":
                return self.paren()
            if token.value == "[":
                return self.list()
        if kind == "KEYWORD" and token.value in UNSUPPORTED:
            self.error("E115", f"momo script has no `{token.value}`.", token,
                       UNSUPPORTED_HELP.get(token.value))
        self.error("E110", f"Expected a value but found {self.describe()}.", token)

    def name(self):
        token = self.next()
        callable_ = self.is_op("(")
        word = token.value
        if word in ("true", "True"):
            return node("Bool", token, value=True)
        if word in ("false", "False"):
            return node("Bool", token, value=False)
        if word == "None":
            return node("Na", token)
        if word == "na":
            return node("Name", token, id="na") if callable_ else node("Na", token)
        return node("Name", token, id=word)

    def paren(self):
        opened = self.next()
        if self.is_op(")"):
            self.error("E110", "Expected a value inside `( )`.", self.tok)
        first = self.expr()
        if self.is_op(","):
            tup = self.tuple(first)
            self.expect_op(")")
            return node("Tuple", opened, items=tup["items"])
        self.expect_op(")")
        return first

    def list(self):
        opened = self.next()
        items = []
        while not self.is_op("]"):
            items.append(self.expr())
            if not self.is_op("]"):
                self.expect_op(",", "Separate list items with commas.")
        self.next()
        return node("List", opened, items=items)

    def fstring(self, token):
        parts = []
        for part in token.parts:
            if isinstance(part, str):
                parts.append(part)
                continue
            inner = Parser(tokenize(part["code"], inline=True,
                                    origin=(part["line"], part["col"])))
            inner.expr_depth = self.expr_depth
            expr = inner.expr()
            if inner.tok.type != "EOF":
                inner.error("E107", f"Unexpected {inner.describe()} inside the f-string's `{{ }}`.")
            parts.append({"expr": expr, "spec": part["spec"]})
        return node("FStr", token, parts=parts)


def _js_text(value):
    """A token value as JavaScript prints it in a template string (numbers without `.0`)."""
    if isinstance(value, float):
        if value == int(value) and abs(value) < 1e21:
            return str(int(value))
        return repr(value)
    return str(value)
