// Regenerates tests/script_cases/bars/*.json (columnar bars) deterministically: node tests/js/script/make-fixtures.mjs
// Three sets: a steady uptrend (daily), a choppy one with gaps, flat runs and zero volume
// (daily), and four sessions of 5-minute bars (times are New York wall-clock seconds).
import { writeFileSync } from "node:fs";

function rng(seed) {
  let a = seed >>> 0;
  const uniform = () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  const normal = () => Math.sqrt(-2 * Math.log(uniform() + 1e-12)) * Math.cos(2 * Math.PI * uniform());
  return { uniform, normal };
}

const round = (v, d = 4) => Math.round(v * 10 ** d) / 10 ** d;

function series({ seed, n, start, drift, vol, gap = 0, times, volume, flat = [], zero = [] }) {
  const { uniform, normal } = rng(seed);
  const cols = { time: [], open: [], high: [], low: [], close: [], volume: [] };
  let close = start;
  for (let i = 0; i < n; i++) {
    const jump = gap && uniform() < gap ? normal() * vol * 4 : 0;
    const open = close * (1 + jump / 100 + normal() * vol * 0.2 / 100);
    let c = open * (1 + drift / 100 + normal() * vol / 100);
    let high = Math.max(open, c) * (1 + uniform() * vol * 0.6 / 100);
    let low = Math.min(open, c) * (1 - uniform() * vol * 0.6 / 100);
    if (flat.includes(i)) { c = open; high = open; low = open; }
    cols.time.push(times(i));
    cols.open.push(round(open));
    cols.high.push(round(high));
    cols.low.push(round(low));
    cols.close.push(round(c));
    cols.volume.push(zero.includes(i) ? 0 : Math.round(volume * (0.5 + uniform() * 1.2) * (1 + Math.abs(c / open - 1) * 20)));
    close = c;
  }
  return cols;
}

// Weekdays from 2024-01-02 as UTC midnight seconds.
const dayTimes = (n) => {
  const out = [];
  let t = Date.UTC(2024, 0, 2) / 1000;
  while (out.length < n) {
    const dow = new Date(t * 1000).getUTCDay();
    if (dow !== 0 && dow !== 6) out.push(t);
    t += 86400;
  }
  return (i) => out[i];
};
const daily = dayTimes(400);

const intraday = (i) => {
  const day = Math.floor(i / 78);
  const slot = i % 78;
  return Date.UTC(2024, 2, 4 + day) / 1000 + (9 * 60 + 30 + slot * 5) * 60;
};

const sets = {
  trend: series({ seed: 11, n: 300, start: 100, drift: 0.12, vol: 1.1, times: daily, volume: 2_000_000 }),
  choppy: series({
    seed: 29, n: 400, start: 22, drift: -0.02, vol: 3.2, gap: 0.08, times: daily, volume: 600_000,
    flat: [120, 121, 122, 123, 124], zero: [50, 51, 200],
  }),
  intraday: series({ seed: 47, n: 78 * 4, start: 512, drift: 0.01, vol: 0.18, times: intraday, volume: 90_000 }),
};

for (const [name, cols] of Object.entries(sets)) {
  const path = new URL(`../../script_cases/bars/bars-${name}.json`, import.meta.url);
  writeFileSync(path, JSON.stringify(cols) + "\n");
  console.log(name, cols.close.length, "bars");
}
