import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { test } from "node:test";

import {
  GLOBALS, METHODS, NAMESPACES, PALETTE, TYPES, allNames, formatColor, members, packColor, parseColor, signature,
} from "../../../src/momo_scan/web/static/js/script/catalog.js";
import { parse } from "../../../src/momo_scan/web/static/js/script/parser.js";

const REFERENCE = new URL("../../../docs/script-language.md", import.meta.url);

// ---- reading the reference -----------------------------------------------------------------

const spans = (text) => [...text.replace(/```[\s\S]*?```/g, "").matchAll(/`([^`]+)`/g)].map((m) => m[1]);
const words = (span) => span.replace(/\([^)]*\)/g, "").trim().split(/\s+/).filter(Boolean);

function section(markdown, title) {
  const start = markdown.indexOf(`\n## ${title}`);
  assert.ok(start >= 0, `the reference has no "## ${title}" section`);
  const rest = markdown.slice(start + 1);
  const end = rest.indexOf("\n## ", 3);
  return end < 0 ? rest : rest.slice(0, end);
}

// Bullets with their wrapped lines joined.
const bullets = (text) => text.split(/\n(?=- )/).filter((b) => b.startsWith("- ")).map((b) => b.replace(/\n\s+/g, " "));

// The paragraph (lines up to a blank one) that starts with `start`, on one line.
const paragraph = (text, start) => {
  const lines = text.split("\n");
  const from = lines.findIndex((l) => l.startsWith(start));
  assert.ok(from >= 0, `no paragraph starting ${start}`);
  const to = lines.findIndex((l, i) => i > from && !l.trim());
  return lines.slice(from, to < 0 ? undefined : to).join(" ");
};

const firstCells = (text) => text.split("\n").filter((l) => l.startsWith("| `")).map((l) => l.split("|")[1]);

function referenceNames(markdown) {
  const names = new Set();
  const add = (name) => names.add(name);

  const bars = section(markdown, "Bars and history");
  for (const bullet of bullets(bars)) {
    if (!/^- (Built-in series|Calendar|Chart):/.test(bullet)) continue;
    for (const span of spans(bullet)) for (const w of words(span)) add(w);
  }

  const library = section(markdown, "Library");
  for (const cell of firstCells(library)) for (const span of spans(cell)) for (const w of words(span)) add(`ta.${w}`);
  const mathParagraph = spans(paragraph(library, "`math."));
  for (const w of words(mathParagraph[0])) add(w.startsWith("math.") ? w : `math.${w}`);
  for (const w of mathParagraph.slice(1, 5)) add(w);
  for (const m of mathParagraph.join(" ").matchAll(/(?:^| )(na|nz)\(/g)) add(m[1]);
  const listLine = paragraph(library, "Lists:");
  for (const m of listLine.matchAll(/`xs\.(\w+)\(/g)) add(`list.${m[1]}`);
  if (/`len\(xs\)`/.test(listLine)) add("len");

  for (const m of section(markdown, "Inputs").matchAll(/\binput\.(\w+)\(/g)) add(`input.${m[1]}`);

  const out = section(markdown, "Output");
  for (const cell of firstCells(out)) add(words(spans(cell)[0])[0]);
  for (const m of out.matchAll(/`(signal|value)\(/g)) add(m[1]);
  if (/`g\.set\(/.test(out)) add("handle.set");
  if (/`g\.delete\(/.test(out)) add("handle.delete");

  const colours = section(markdown, "Colours");
  for (const w of words(spans(colours)[0])) add(w.startsWith("color.") ? w : `color.${w}`);
  if (/`color\.rgb\(/.test(colours)) add("color.rgb");
  if (/`c\.alpha\(/.test(colours)) add("color.alpha");

  const first = section(markdown, "The first two lines");
  if (/`indicator\(/.test(first)) add("indicator");

  const types = section(markdown, "Values and types");
  const barsRow = types.split("\n").find((l) => l.startsWith("| bars"));
  for (const w of words(barsRow.match(/`(\.open[^`]*)`/)[1])) add(`bars.${w.slice(1)}`);

  const other = section(markdown, "Other timeframes and symbols");
  if (/\btf\(/.test(other)) add("tf");
  if (/\bsymbol\(/.test(other)) add("symbol");
  const today = spans(other).find((s) => s.startsWith("today.open"));
  for (const w of words(today)) add(w.startsWith("today.") ? w : `today.${w}`);

  for (const span of spans(section(markdown, "momo data (later phase)"))) {
    if (/^[a-z]+\.[a-z0-9_]+$/.test(span)) add(span);
  }

  const expressions = section(markdown, "Expressions and statements");
  if (/\brange\(/.test(expressions)) add("range");
  return names;
}

const reference = existsSync(REFERENCE) ? readFileSync(REFERENCE, "utf8") : null;

test("the reference and the catalogue name the same functions", { skip: !reference && "docs/script-language.md isn't in this checkout" }, () => {
  const fromReference = referenceNames(reference);
  const fromCatalogue = new Set(allNames());
  const onlyReference = [...fromReference].filter((n) => !fromCatalogue.has(n)).sort();
  const onlyCatalogue = [...fromCatalogue].filter((n) => !fromReference.has(n)).sort();
  assert.deepEqual({ onlyReference, onlyCatalogue }, { onlyReference: [], onlyCatalogue: [] });
  assert.ok(fromCatalogue.size > 150);
});

// ---- the catalogue itself ------------------------------------------------------------------

const everyEntry = () => [
  ...Object.values(GLOBALS),
  ...Object.values(METHODS).flatMap((methods) => Object.values(methods)),
];

test("every entry has a doc, an example and valid argument types", () => {
  for (const entry of everyEntry()) {
    assert.ok(entry.doc && entry.doc.length > 8, `${entry.name} needs a doc`);
    assert.ok(entry.example, `${entry.name} needs an example`);
    const seenDefault = [];
    for (const a of entry.args) {
      assert.ok(TYPES.includes(a.type), `${entry.name}(${a.name}) has type ${a.type}`);
      if (Object.hasOwn(a, "default")) seenDefault.push(a.name);
      else if (!a.keywordOnly) assert.deepEqual(seenDefault, [], `${entry.name}: ${a.name} has no default after ${seenDefault}`);
    }
    assert.equal(new Set(entry.args.map((a) => a.name)).size, entry.args.length, `${entry.name} repeats an argument`);
  }
});

test("every example parses as momo script", () => {
  for (const entry of everyEntry()) {
    const example = /:$/.test(entry.example) ? `${entry.example}\n    pass\n` : entry.example;
    assert.doesNotThrow(() => parse(example), `${entry.name}: ${entry.example}`);
  }
});

test("ta entries say what they return and which bars they read", () => {
  const bars = new Set(["open", "high", "low", "close", "volume", "time"]);
  for (const [name, entry] of Object.entries(GLOBALS)) {
    if (entry.kind !== "ta") continue;
    assert.ok(name.startsWith("ta."));
    assert.ok(entry.returns === "number" || entry.returns === "bool" || (Array.isArray(entry.returns) && entry.returns.length > 1), name);
    for (const i of entry.implicit) assert.ok(bars.has(i), `${name} reads ${i}`);
    for (const a of entry.args) if (a.name.match(/length|fast|slow|signal|left|right|days|k_smooth|d_smooth|nth/)) assert.ok(a.fixed, `${name}.${a.name} must be fixed`);
  }
});

test("what is not built yet is marked with its phase", () => {
  const later = Object.values(GLOBALS).filter((e) => e.later).map((e) => e.name).sort();
  assert.deepEqual(later, [
    "box", "cot.net", "earnings.days_since_last", "earnings.days_to_next", "fund.eps_yoy", "fund.sales_yoy",
    "info.industry", "info.sector", "label", "line", "market.new_highs", "market.new_lows", "market.t2108",
    "rs.rank", "symbol", "ta.rvol_at_time", "tf", "theme.rank", "today.close", "today.high", "today.low",
    "today.open", "today.volume",
  ]);
  for (const e of Object.values(GLOBALS)) if (e.later) assert.match(e.later, /^phase \d+$/);
});

test("the palette, packed colours and parsing", () => {
  assert.equal(packColor(255, 0, 0), 0xff0000ff);
  assert.equal(packColor(0x29, 0x62, 0xff, 0x80), 0x2962ff80);
  assert.equal(parseColor("#2962ff"), 0x2962ffff);
  assert.equal(parseColor("#2962ff80"), 0x2962ff80);
  assert.equal(parseColor("#fff"), 0xffffffff);
  for (const bad of ["2962ff", "#12", "#gggggg", "red", "#1234567"]) assert.equal(parseColor(bad), null, bad);
  assert.equal(formatColor(0x2962ffff), "#2962ff");
  assert.equal(formatColor(0x2962ff80), "#2962ff80");
  assert.equal(formatColor(0), null);
  assert.equal(Object.keys(PALETTE).length, 17);
  assert.equal(GLOBALS["color.orange"].value, parseColor(PALETTE.orange));
});

test("lookups: namespaces, members, signatures, bare aliases", () => {
  assert.ok(NAMESPACES.has("ta") && NAMESPACES.has("math") && NAMESPACES.has("input") && NAMESPACES.has("color"));
  assert.ok(members("ta").includes("sma") && members("ta").includes("pivothigh"));
  assert.ok(members("input").sort().join() === "bool,choice,color,float,int,source");
  assert.equal(signature(GLOBALS["ta.sma"]), "ta.sma(src, length)");
  assert.equal(signature(GLOBALS["ta.change"]), "ta.change(src, length=1)");
  assert.equal(GLOBALS.abs.alias, "math.abs");
  assert.equal(GLOBALS.round.rt, "round");
  assert.equal(METHODS.list.push.owner, "list");
});
