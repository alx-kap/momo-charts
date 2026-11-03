"""momo script lexer: source text to tokens with positions (the port of lexer.js).

Blocks are 4-space indents, reported as INDENT / DEDENT tokens. Raises ScriptError (E101-E107)
on the first problem. Positions count UTF-16 code units, as the JavaScript does, so both
languages report the same column for the same source.

Token types: NAME KEYWORD NUM STR FSTR OP NEWLINE INDENT DEDENT EOF HEADER (and COMMENT with
`comments`). An FSTR's `parts` are strings and dicts {code, spec, line, col}.
"""

from __future__ import annotations

import re

from .errors import ScriptError

KEYWORDS = frozenset([
    "if", "elif", "else", "for", "while", "def", "return", "break", "continue", "pass", "in",
    "and", "or", "not", "var",
])
# Python words momo script doesn't have. They lex as keywords so the parser can say so.
UNSUPPORTED = frozenset([
    "import", "from", "class", "lambda", "try", "except", "finally", "with", "global",
    "nonlocal", "del", "assert", "yield", "async", "await", "raise", "as", "is", "match", "case",
])

TWO = frozenset(["**", "<=", ">=", "==", "!=", "+=", "-=", "*=", "/=", ":="])
ONE = frozenset(["+", "-", "*", "/", "%", "<", ">", "=", "(", ")", "[", "]", ",", ".", ":"])
OPEN = {"(": ")", "[": "]"}
CLOSE = frozenset([")", "]"])
ESCAPES = {"n": "\n", "t": "\t", '"': '"', "'": "'", "\\": "\\"}
SPEC = re.compile(r"^,?(\.[0-9]+)?[f%]?\Z")
HEADER = re.compile(r"^#momo(\s|$)")
BAD_UNDERSCORE = re.compile(r"__|_$|^_|_\.|\._|_[eE]|[eE]_|[eE][+-]_")

# Characters people bring from Pine, C and JavaScript: what to write instead.
SLIPS = {
    "!": "use `not` (and `!=` for not-equal)",
    "&": "use `and`",
    "|": "use `or`",
    "?": "write `a if cond else b`",
    ";": "put each statement on its own line",
    "{": "momo script has no braces; lists use [ ]",
    "}": "momo script has no braces; lists use [ ]",
    "\\": "keep a statement on one line, or break it inside ( )",
    "$": "momo script names use letters, digits and _",
    "@": "momo script has no decorators",
    "`": "use \"double\" or 'single' quotes for text",
    "~": "momo script has no `~`",
    "^": "momo script has no `^`; use `**` for powers",
}


class Token:
    __slots__ = ("type", "value", "line", "col", "end_col", "parts")

    def __init__(self, type, value, line, col, end_col, parts=None):
        self.type = type
        self.value = value
        self.line = line
        self.col = col
        self.end_col = end_col
        self.parts = parts

    def __repr__(self):
        return f"Token({self.type}, {self.value!r}, {self.line}:{self.col})"


def _is_digit(c):
    return "0" <= c <= "9" and len(c) == 1


def _is_start(c):
    return len(c) == 1 and (("a" <= c <= "z") or ("A" <= c <= "Z") or c == "_")


def _is_word(c):
    return _is_start(c) or _is_digit(c)


def _show(c):
    point = ord(c)
    return f"U+{point:04X}" if point < 0x20 or point > 0x7E else c


def utf16(text: str) -> str:
    """The text with every astral character split into its two surrogates, as JavaScript sees it."""
    if text.isascii() or all(ord(c) <= 0xFFFF for c in text):
        return text
    out = []
    for c in text:
        point = ord(c)
        if point > 0xFFFF:
            point -= 0x10000
            out.append(chr(0xD800 + (point >> 10)) + chr(0xDC00 + (point & 0x3FF)))
        else:
            out.append(c)
    return "".join(out)


def from_utf16(text: str) -> str:
    """Joins surrogate pairs back into characters (for string values)."""
    if all(not 0xD800 <= ord(c) <= 0xDFFF for c in text):
        return text
    return text.encode("utf-16-le", "surrogatepass").decode("utf-16-le", "replace")


def tokenize(source, comments=False, inline=False, origin=(1, 1)):
    return _Lexer(source, comments, inline, origin).run()


class _Lexer:
    def __init__(self, source, comments, inline, origin):
        text = utf16(source)
        if text.startswith("﻿"):
            text = text[1:]
        self.text = text.replace("\r\n", "\n").replace("\r", "\n")
        self.comments = comments
        self.inline = inline
        self.tokens = []
        self.indents = [0]
        self.brackets = []
        self.pos = 0
        self.line = origin[0]
        self.line_start = -(origin[1] - 1)
        self.pending = False       # a line has tokens that a NEWLINE hasn't closed

    # ---- helpers --------------------------------------------------------------------------

    def at(self, p):
        return self.text[p] if 0 <= p < len(self.text) else ""

    def col(self, p=None):
        return (self.pos if p is None else p) - self.line_start + 1

    def error(self, code, message, p, end=None, fix=None):
        end = p + 1 if end is None else end
        raise ScriptError(code, message, self.line, self.col(p), self.col(end), fix)

    def push(self, type, value, start, end, parts=None):
        if type not in ("COMMENT", "INDENT", "DEDENT"):
            self.pending = type not in ("NEWLINE", "HEADER")
        self.tokens.append(Token(type, value, self.line, start - self.line_start + 1,
                                 end - self.line_start + 1, parts))

    def read_comment(self):
        start = self.pos
        while self.pos < len(self.text) and self.text[self.pos] != "\n":
            self.pos += 1
        return start, self.text[start:self.pos]

    def is_operand(self, token):
        return token is not None and (
            token.type in ("NAME", "NUM", "STR", "FSTR")
            or (token.type == "OP" and token.value in (")", "]")))

    # ---- main loop ------------------------------------------------------------------------

    def run(self):
        text = self.text
        n = len(text)
        at_line_start = not self.inline
        while self.pos < n:
            if at_line_start and not self.brackets:
                j = self.pos
                while self.at(j) == " ":
                    j += 1
                if self.at(j) == "\t":
                    self.error("E101", "Tabs aren't allowed in indentation.", j, j + 1,
                               "Indent with 4 spaces.")
                c = self.at(j)
                comment = c == "#" or (c == "/" and self.at(j + 1) == "/")
                if j >= n or c == "\n" or comment:
                    self.pos = j
                    if comment:
                        start, value = self.read_comment()
                        header = not self.tokens and HEADER.match(value)
                        if header:
                            self.push("HEADER", value[5:].strip(), start, self.pos)
                        elif self.comments:
                            self.push("COMMENT", value, start, self.pos)
                    if self.at(self.pos) == "\n":
                        self.pos += 1
                        self.line += 1
                        self.line_start = self.pos
                    continue
                width = j - self.pos
                if width % 4:
                    self.error("E106", "Indent blocks by 4 spaces.", self.pos, j,
                               "Use a multiple of 4 spaces.")
                top = self.indents[-1]
                if width > top:
                    if width != top + 4:
                        self.error("E106", "This line is indented too far.", self.pos, j,
                                   f"Indent by {top + 4} spaces.")
                    self.indents.append(width)
                    self.push("INDENT", width, self.pos, j)
                else:
                    while width < self.indents[-1]:
                        self.indents.pop()
                        self.push("DEDENT", width, j, j)
                    if width != self.indents[-1]:
                        self.error("E106", "This line doesn't line up with any block above it.",
                                   self.pos, j)
                self.pos = j
                at_line_start = False

            pos = self.pos
            c = self.at(pos)
            if c == " ":
                self.pos += 1
                continue
            if c == "\t":
                self.error("E101", "Tabs aren't allowed.", pos, pos + 1, "Use spaces.")
            if c == "\n":
                if not self.brackets and not self.inline and self.pending:
                    self.push("NEWLINE", "\n", pos, pos + 1)
                self.pos += 1
                self.line += 1
                self.line_start = self.pos
                at_line_start = not self.inline and not self.brackets
                continue
            if c == "#" or (c == "/" and self.at(pos + 1) == "/"):
                start, value = self.read_comment()
                if self.comments:
                    self.push("COMMENT", value, start, self.pos)
                continue

            last = self.tokens[-1] if self.tokens else None
            if _is_digit(c) or (c == "." and _is_digit(self.at(pos + 1))
                                and not self.is_operand(last)):
                self.pos = self.read_number()
                continue

            if _is_start(c):
                start = pos
                while self.pos < n and _is_word(text[self.pos]):
                    self.pos += 1
                word = text[start:self.pos]
                if word in ("f", "F") and self.at(self.pos) in ('"', "'"):
                    self.pos = self.read_string(self.pos, True, start)
                else:
                    keyword = word in KEYWORDS or word in UNSUPPORTED
                    self.push("KEYWORD" if keyword else "NAME", word, start, self.pos)
                continue

            if c == '"' or c == "'":
                self.pos = self.read_string(pos, False, pos)
                continue

            d = self.at(pos + 1)
            if d == "=" or (d == "*" and c == "*") or (d == ">" and c == "="):
                two = c + d
                if two == "=>":
                    self.error("E102", "`=>` is Pine's function arrow.", pos, pos + 2,
                               "Write `def name(args):` and indent the body.")
                if two in TWO:
                    self.push("OP", two, pos, pos + 2)
                    self.pos += 2
                    continue
            if c in ONE:
                if c in OPEN:
                    self.brackets.append((c, pos, self.line, self.col()))
                elif c in CLOSE:
                    opened = self.brackets.pop() if self.brackets else None
                    if not opened or OPEN[opened[0]] != c:
                        fix = (f"Close `{opened[0]}` from line {opened[2]} with "
                               f"`{OPEN[opened[0]]}`." if opened else f"Remove the `{c}`.")
                        self.error("E111", f"Unmatched `{c}`.", pos, pos + 1, fix)
                self.push("OP", c, pos, pos + 1)
                self.pos += 1
                continue
            slip = SLIPS.get(c)
            self.error("E102", f"Unexpected character `{_show(c)}`.", pos, pos + 1,
                       slip[0].upper() + slip[1:] + "." if slip else None)

        if self.brackets:
            c, _, line, col = self.brackets[-1]
            raise ScriptError("E111", f"`{c}` is never closed.", line, col, col + 1,
                              f"Add `{OPEN[c]}`.")
        if not self.inline:
            if self.pending:
                self.push("NEWLINE", "\n", self.pos, self.pos)
            while len(self.indents) > 1:
                self.indents.pop()
                self.push("DEDENT", 0, self.pos, self.pos)
        self.push("EOF", "", self.pos, self.pos)
        return self.tokens

    # ---- numbers and strings --------------------------------------------------------------

    def digits(self, p):
        q = p
        while _is_digit(self.at(q)) or self.at(q) == "_":
            q += 1
        return q

    def read_number(self):
        start = self.pos
        text = self.text
        q = self.digits(start)
        if self.at(q) == "." and self.at(q + 1) != ".":
            q = self.digits(q + 1)
        if self.at(q) in ("e", "E"):
            r = q + 1
            if self.at(r) in ("+", "-"):
                r += 1
            if not _is_digit(self.at(r)):
                self.error("E105", "This number has an `e` with no exponent.", start, r,
                           "Write the exponent digits, like 1e6.")
            q = self.digits(r)
        raw = text[start:q]
        if _is_word(self.at(q)):
            self.error("E105", f"`{raw}{self.at(q)}` isn't a number.", start, q + 1,
                       "Put a space or an operator after the number.")
        if BAD_UNDERSCORE.search(raw):
            self.error("E105", f"`{raw}` has a misplaced underscore.", start, q,
                       "Use _ only between digits, like 1_000_000.")
        value = float(raw.replace("_", ""))
        if value in (float("inf"), float("-inf")):
            self.error("E105", f"`{raw}` is too large a number.", start, q,
                       "Numbers go up to about 1.7e308.")
        self.push("NUM", value, start, q)
        return q

    def read_escape(self, p):
        e = self.at(p + 1)
        if e == "" or e == "\n":
            self.error("E103", "This string isn't closed on this line.", p, p + 1,
                       "Close it with the same quote it started with.")
        if e not in ESCAPES:
            self.error("E104", f"Unknown escape `\\{e}`.", p, p + 2,
                       "Strings accept \\n \\t \\\" \\' and \\\\ only.")
        return ESCAPES[e], p + 2

    def check_char(self, ch, p):
        point = ord(ch)
        if point < 0x20 or point == 0x7F or point in (0x2028, 0x2029):
            self.error("E104", f"A string can't hold the control character {_show(ch)}.", p,
                       p + 1, "Use an escape like \\n instead.")

    def read_string(self, p, is_f, start):
        text = self.text
        quote = text[p]
        q = p + 1
        out = ""
        parts = []
        while True:
            ch = self.at(q)
            if ch == "" or ch == "\n":
                self.error("E103", "This string isn't closed on this line.", start, q,
                           f"Close it with {quote}.")
            if ch == quote:
                q += 1
                break
            if ch == "\\":
                value, q = self.read_escape(q)
                out += value
                continue
            if is_f and ch == "{":
                if self.at(q + 1) == "{":
                    out += "{"
                    q += 2
                    continue
                brace_start = q
                depth = 0
                r = q + 1
                colon = -1
                while True:
                    d = self.at(r)
                    if d == "" or d == "\n":
                        self.error("E107", "This `{` in an f-string is never closed.",
                                   brace_start, brace_start + 1, "Add `}`.")
                    if d == quote and not depth and colon < 0:
                        self.error("E107", "This `{` in an f-string is never closed.",
                                   brace_start, brace_start + 1, "Add `}`.")
                    if d in ('"', "'") and d != quote and colon < 0:
                        r = text.find(d, r + 1)
                        if r < 0:
                            self.error("E107", "A string inside this f-string isn't closed.",
                                       brace_start, brace_start + 1)
                    elif d in ("(", "["):
                        depth += 1
                    elif d in (")", "]"):
                        depth -= 1
                    elif d == ":" and not depth and colon < 0:
                        colon = r
                    elif d == "}" and not depth:
                        break
                    r += 1
                code = text[brace_start + 1:r if colon < 0 else colon]
                spec = "" if colon < 0 else text[colon + 1:r]
                if not code.strip():
                    self.error("E107", "This f-string has an empty `{}`.", brace_start, r + 1,
                               "Put an expression inside, like {x:.2f}.")
                if not SPEC.match(spec):
                    self.error("E107", f"`{spec}` isn't a format.", colon, r,
                               "Use .2f (decimals), , (thousands) or % (percent), like {x:,.0f}.")
                if out:
                    parts.append(out)
                    out = ""
                parts.append({"code": code, "spec": spec, "line": self.line,
                              "col": self.col(brace_start + 1)})
                q = r + 1
                continue
            if is_f and ch == "}":
                if self.at(q + 1) == "}":
                    out += "}"
                    q += 2
                    continue
                self.error("E107", "A lone `}` in an f-string.", q, q + 1,
                           "Write `}}` for a literal brace.")
            self.check_char(ch, q)
            out += ch
            q += 1
        if is_f:
            if out or not parts:
                parts.append(out)
            self.push("FSTR", "", start, q, parts)
        else:
            self.push("STR", out, start, q)
        return q
