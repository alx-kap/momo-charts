// The momo script sandbox check, run inside a page that serves momo (Chromium via
// tools/script_sandbox_steps.py, Electron via desktop/tools/sandbox-check.mjs). It is one async
// arrow function: give it the URL or path of host.js, get back [{ name, pass, detail }].
//
// Everything goes through the real host and the real worker with hand-written `code`: no
// compiler, no hook. The code tries what a hostile script might and writes what happened into
// its logs, which the host hands back like any other output.
async (hostPath) => {
  const hostUrl = new URL(hostPath, location.href).href;
  const { createHost } = await import(hostUrl);
  const results = [];
  const check = (name, pass, detail = "") => results.push({ name, pass: Boolean(pass), detail: String(detail) });
  const bars = (n = 3) => Object.fromEntries(["time", "open", "high", "low", "close", "volume"].map((c) => [c, Float64Array.from({ length: n }, (_, i) => i + 1)]));
  const tail = "return rt.result({ plots: [], markers: [], barColors: null, bgColors: null, levels: [], stats: [], signals: [], logs: LG });";
  const wrap = (body) => `"use strict"; const LG = []; const log = (t) => rt.logLine(LG, 0, [t]);\n${body}\n${tail}`;

  // ---- 1. what a hostile script can reach ----
  const probes = {
    fetch: 'fetch("/api/health")',
    "self.fetch": 'self.fetch("/api/health")',
    "prototype fetch": 'Object.getPrototypeOf(self).fetch("/api/health")',
    XMLHttpRequest: 'new XMLHttpRequest()',
    WebSocket: 'new WebSocket("ws://127.0.0.1:8790/")',
    EventSource: 'new EventSource("/api/health")',
    importScripts: 'importScripts("/static/js/script/runtime.js")',
    indexedDB: 'indexedDB.open("momo")',
    caches: 'caches.open("momo")',
    BroadcastChannel: 'new BroadcastChannel("momo")',
    Worker: 'new Worker("/static/js/script/worker.js")',
    SharedWorker: 'new SharedWorker("/static/js/script/worker.js")',
    WebAssembly: 'new WebAssembly.Memory({ initial: 1 })',
    navigator: 'navigator.sendBeacon("/api/x", "y")',
    postMessage: 'postMessage({ id: 1, ok: true })',
    "self.postMessage": 'self.postMessage({ id: 1, ok: true })',
    "prototype postMessage": 'Object.getPrototypeOf(self).postMessage({ id: 1 })',
    "set onmessage": 'self.onmessage = () => {}',
    addEventListener: 'self.addEventListener("message", () => {})',
    "EventTarget listener": 'EventTarget.prototype.addEventListener.call(self, "message", () => {})',
    "Object.prototype": 'Object.prototype.polluted = 1',
    "Array.prototype": 'Array.prototype.map = () => 0',
    "Function.prototype": 'Function.prototype.call = () => 0',
    "Math.max": 'Math.max = () => 0',
    "typed array prototype": 'Float64Array.prototype.fill = () => 0',
    "Error.prototype": 'Error.prototype.name = "x"',
    "runtime limits": 'rt.LIMITS.runMs = 1',
    "runtime ta": 'rt.ta.sma = null',
    "runtime export": 'rt.RunError.prototype.code = 1',
    "new global": 'globalThis.leaked = 1',
  };
  const body = Object.entries(probes).map(([name, stmt]) => `try { ${stmt}; log(${JSON.stringify(name)} + ": ALLOWED"); } catch (e) { log(${JSON.stringify(name)} + ": blocked " + e.name); }`).join("\n")
    + '\ntry { log("eval: " + (eval("1 + 2") === 3 ? "works" : "wrong")); } catch (e) { log("eval: " + e.name); }'
    + '\ntry { log("Function: " + (new Function("return 4")() === 4 ? "works" : "wrong")); } catch (e) { log("Function: " + e.name); }'
    + '\nlet chain = ""; for (let o = self; o; o = Object.getPrototypeOf(o)) for (const n of ["fetch", "XMLHttpRequest", "WebSocket", "importScripts", "indexedDB", "caches", "postMessage"]) { { const d = Object.getOwnPropertyDescriptor(o, n); if (d && (d.get || d.set || d.value !== undefined)) chain += n + " "; } }'
    + '\nlog("prototype chain: " + (chain ? "LEAK " + chain : "clean"));';
  const host = createHost();
  const probe = await host.run({ code: wrap(body), bars: bars() });
  check("probe code ran", probe.ok, probe.ok ? "" : JSON.stringify(probe.error));
  const said = Object.fromEntries((probe.logs || []).map((l) => l.text.split(": ")).map(([k, ...v]) => [k, v.join(": ")]));
  for (const name of Object.keys(probes)) {
    check(`blocked: ${name}`, (said[name] || "").startsWith("blocked"), said[name]);
  }
  check("prototype chain has none of the hidden names", said["prototype chain"] === "clean", said["prototype chain"]);
  check("eval and Function still work (CSP allows them; the language can't reach them)", said.eval === "works" && said.Function === "works", `${said.eval} / ${said.Function}`);

  // ---- 2. a run that throws leaves the worker usable; state doesn't leak between runs ----
  const thrown = await host.run({ code: wrap('throw new TypeError("boom");'), bars: bars() });
  check("a throwing script gives R405", !thrown.ok && thrown.error.code === "R405", JSON.stringify(thrown.error));
  const after = await host.run({ code: wrap('log("still here");'), bars: bars() });
  check("the worker still runs the next script", after.ok && after.logs[0].text === "still here");
  check("a throw doesn't respawn the worker", host.stats().spawns === 1, JSON.stringify(host.stats()));

  // ---- 3. the 250 ms limit ----
  const started = performance.now();
  const loop = await host.run({ code: wrap("for (;;) {}"), bars: bars() });
  const took = performance.now() - started;
  check("an infinite loop stops with R401", !loop.ok && loop.error.code === "R401" && loop.error.message === "Stopped: took too long", JSON.stringify(loop.error));
  check("...in about 250 ms of running (boot time excluded)", took < 1500, `${Math.round(took)} ms from call to answer`);
  const next = await host.run({ code: wrap('log("next ok");'), bars: bars() });
  check("the next script runs on the replacement worker", next.ok && next.logs[0].text === "next ok", JSON.stringify(next.error || ""));
  check("one timeout, one respawn", host.stats().timeouts === 1 && host.stats().spawns === 2, JSON.stringify(host.stats()));
  const again = await host.run({ code: wrap("for (;;) {}"), bars: bars(4) });
  check("a second loop stops too", !again.ok && again.error.code === "R401");
  const lookup = await host.run({ code: wrap('log("and again");'), bars: bars(4) });
  check("and the host recovers again", lookup.ok);

  // ---- 4. the host refuses answers that aren't data ----
  const forged = {
    "a plain array of numbers": 'plots: { a: { values: [1, 2, 3] } }',
    "a colour as text": 'barColors: ["#ff0000", "#00ff00", "#0000ff"]',
    "colours of the wrong length": 'barColors: new Uint32Array(7)',
    "a plot of the wrong length": 'plots: { a: { values: new Float64Array(5) } }',
    "a marker with CSS in its colour": 'markers: [{ key: "m", i: 0, price: 1, shape: "dot", color: "red", text: "x" }]',
    "a marker with an unknown shape": 'markers: [{ key: "m", i: 0, price: 1, shape: "<img>", color: 0, text: "x" }]',
    "text over the cap": 'markers: [{ key: "m", i: 0, price: 1, shape: "dot", color: 0, text: "x".repeat(300) }]',
    "a marker off the end": 'markers: [{ key: "m", i: 9, price: 1, shape: "dot", color: 0, text: "x" }]',
    "drawings that aren't built yet": 'drawings: { lines: [{ x: 1 }], boxes: [], labels: [] }',
  };
  for (const [name, field] of Object.entries(forged)) {
    // rt.result is bypassed on purpose: this is a worker that answers with whatever it likes.
    const code = `"use strict"; const base = rt.result({ plots: [], markers: [], barColors: null, bgColors: null, levels: [], stats: [], signals: [], logs: [] }); return { ...base, ${field} };`;
    const r = await host.run({ code, bars: bars() });
    check(`refused: ${name}`, !r.ok && r.error.code === "R405", JSON.stringify(r.error || "accepted"));
  }
  const honest = await host.run({ code: wrap('log("fine");'), bars: bars() });
  check("an honest script is still accepted after refusals", honest.ok);

  // ---- 5. cache, transfer, pool ----
  const h2 = createHost();
  const sum = wrap('log("sum " + inputs.k);');
  const first = await h2.run({ code: sum, bars: bars(), inputs: { k: 1 } });
  const second = await h2.run({ code: sum, bars: bars(), inputs: { k: 1 } });
  const third = await h2.run({ code: sum, bars: bars(), inputs: { k: 2 } });
  check("same code, inputs and bars hit the cache", second === first && h2.stats().hits === 1, JSON.stringify(h2.stats()));
  check("other inputs miss it", third !== first && third.logs[0].text === "sum 2");
  const kept = bars();
  await h2.run({ code: wrap('log("copy");'), bars: kept });
  check("bars are copied by default", kept.close.length === 3);
  const given = bars(5);
  await h2.run({ code: wrap('log("moved");'), bars: given, transfer: true });
  check("transfer: true hands the arrays over", given.close.length === 0);
  h2.close();

  const pool = createHost({ size: 4 });
  const spans = await Promise.all([1, 2, 3, 4].map((k) => pool.run({
    code: wrap('const t0 = Date.now(); while (Date.now() - t0 < 120) {} log(t0 + "," + Date.now());'), bars: bars(2 + k),
  })));
  const iv = spans.map((r) => (r.ok ? r.logs[0].text.split(",").map(Number) : null));
  const overlap = iv.every(Boolean) && Math.max(...iv.map((s) => s[0])) < Math.min(...iv.map((s) => s[1]));
  check("a pool of 4 runs four scripts at once", overlap && pool.stats().workers === 4, JSON.stringify(iv));
  pool.close();

  // ---- 6. real compiled scripts give the worker's answer the in-page runtime gives ----
  const { compile, execute } = await import(new URL("./compile.js", hostUrl).href);
  const real = bars(300);
  for (let i = 0; i < 300; i++) {
    const w = 100 + 10 * Math.sin(i / 7) + (i % 5);
    real.open[i] = w; real.close[i] = w + Math.cos(i); real.high[i] = w + 3; real.low[i] = w - 3; real.volume[i] = 1000 + i;
    real.time[i] = 1_700_000_000 + i * 86400;
  }
  const sources = {
    "markers, levels and stats": `#momo 1
indicator("T", overlay=true)
marker(close > open, "Up", shape="triangle_up")
marker(close < open, "Down", shape="triangle_down", at="below", color=color.red)
level(ta.highest(high, 3), "Top", color=color.orange, style="dashed")
stat("Range", high - low, format="number")
stat("Side", "long" if close > open else "short")
plot(ta.sma(close, 20), "sma")
plot(ta.rsi(close, 14), "rsi")
signal("up", close > open)
barcolor(color.green if close > open else color.red)`,
  };
  for (const [name, source] of Object.entries(sources)) {
    const c = compile(source);
    if (!c.ok) { check(`compiles: ${name}`, false, JSON.stringify(c.errors)); continue; }
    const local = execute(c.code, real, {}, {});
    const sent = await host.run({ code: c.code, bars: real });
    const same = (a, b) => a.length === b.length && a.every((v, i) => Object.is(v, b[i]));
    const plotsEqual = sent.ok && local.ok && Object.keys(local.plots).every((k) => same(local.plots[k].values, sent.plots[k].values));
    check(`worker and page agree: ${name}`, plotsEqual && JSON.stringify(local.markers) === JSON.stringify(sent.markers)
      && JSON.stringify(local.levels.map(({ title, ...l }) => l)) === JSON.stringify(sent.levels.map(({ title, ...l }) => l)), sent.ok ? "" : JSON.stringify(sent.error));
  }
  const loopy = compile('#momo 1\nindicator("T", overlay=true)\nn = 0\nwhile true:\n    n += 1\nplot(n)\n');
  const spawned = host.stats().spawns;
  const stopped = await host.run({ code: loopy.code, bars: bars(5) });
  check("a compiled runaway loop stops with R402 at its position", !stopped.ok && stopped.error.code === "R402" && stopped.error.line === 4, JSON.stringify(stopped.error));
  const fine = await host.run({ code: wrap('log("ok");'), bars: bars() });
  check("and the worker runs on", fine.ok);
  check("a step-limit error costs no respawn", host.stats().spawns === spawned, JSON.stringify(host.stats()));
  host.close();
  return results;
}
