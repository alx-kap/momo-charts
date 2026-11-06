import assert from "node:assert/strict";
import { test } from "node:test";

import {
  completions, escapeCode, highlight, hoverDoc, indentLines, lineDiff, nextIndent, outdentLines, toggleComment,
} from "../../../src/momo_scan/web/static/js/script/assist.js";
import { compile } from "../../../src/momo_scan/web/static/js/script/compile.js";

test("typing ta.s offers sma, stdev and sum", () => {
  const labels = completions("ta.s").map((offer) => offer.label);
  for (const name of ["ta.sma", "ta.stdev", "ta.sum"]) assert.ok(labels.includes(name), name);
  assert.ok(labels.every((label) => label.startsWith("ta.s")));
  assert.equal(completions("ta.sm")[0].insert, "ta.sma()");
});

test("completions know the script's own names and leave what's typed alone", () => {
  const source = "length = 5\nvar total = 0\ndef squeeze(a):\n    return a\n";
  const labels = (word) => completions(word, source).map((offer) => offer.label);
  assert.ok(labels("len").includes("length"));
  assert.ok(labels("to").includes("total"));
  assert.ok(labels("sq").includes("squeeze"));
  assert.ok(!labels("length").includes("length"));
  assert.deepEqual(completions("x"), []);
});

test("hover docs come from the catalogue", () => {
  const doc = hoverDoc("ta.sma");
  assert.match(doc.title, /^ta\.sma\(/);
  assert.ok(doc.doc && doc.example);
  assert.equal(hoverDoc("nothing"), null);
});

test("highlighting colours each kind and escapes the rest", () => {
  const html = highlight('x = ta.sma(close, 20) # <b> "note"');
  assert.match(html, /<span class="t-fn">ta\.sma<\/span>/);
  assert.match(html, /<span class="t-nu">20<\/span>/);
  assert.match(html, /<span class="t-cm"># &#60;b&#62; &#34;note&#34;<\/span>/);
  assert.equal(highlight("<img src=x>").includes("<img"), false);
  assert.equal(highlight('"<script>"').includes("<script"), false);
  assert.match(highlight('s = "a # b"'), /t-st/);
  assert.equal(escapeCode("a&b"), "a&#38;b");
  for (const line of ["if x:", 'plot(close, "a")', "x = 'unclosed", '"\\"']) {
    assert.equal(highlight(line).replace(/<[^>]+>/g, "").replace(/&#(\d+);/g, (_, n) => String.fromCharCode(n)), line);
  }
});

test("a line diff keeps order and marks changes", () => {
  const kinds = (a, b) => lineDiff(a, b).map(({ kind, text }) => `${kind[0]}:${text}`);
  assert.deepEqual(kinds("a\nb\nc", "a\nx\nc"), ["s:a", "d:b", "a:x", "s:c"]);
  assert.deepEqual(kinds("a", "a"), ["s:a"]);
  assert.deepEqual(kinds("a\nb", "a\nb\nc"), ["s:a", "s:b", "a:c"]);
  assert.deepEqual(kinds("a\nb\nc", "c\nb"), ["d:a", "d:b", "s:c", "a:b"]);
  const many = lineDiff("x\n".repeat(3000), "y\n".repeat(3000), 100);
  assert.equal(many.filter((line) => line.kind === "add").length, 3000);
});

test("the editor's text edits", () => {
  assert.equal(toggleComment("    a\n\n    b"), "    # a\n\n    # b");
  assert.equal(toggleComment("    # a\n\n    # b"), "    a\n\n    b");
  assert.equal(indentLines("a\n\nb"), "    a\n\n    b");
  assert.equal(outdentLines("      a\n  b"), "  a\nb");
  assert.equal(nextIndent("if x:"), "    ");
  assert.equal(nextIndent("    if x:  # why"), "        ");
  assert.equal(nextIndent("    x = 1"), "    ");
});

test("the starting script compiles", async () => {
  const { readFile } = await import("node:fs/promises");
  const panel = await readFile(new URL("../../../src/momo_scan/web/static/js/script/panel.js", import.meta.url), "utf8");
  const template = panel.match(/const NEW_SCRIPT = \(name\) => `(.*)`;/)[1];
  const source = template.replace("${JSON.stringify(name)}", JSON.stringify('My "new" one')).replace(/\\n/g, "\n");
  const built = compile(source);
  assert.ok(built.ok, JSON.stringify(built.errors));
});
