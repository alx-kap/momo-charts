// momo on this computer: the app's own Python (runtime/, from tools/runtime.mjs) runs the
// momo-charts server on a local port, with its data in the app's folder (…/momo/local). The
// port is picked once and kept, so the page's own storage (its origin) stays the same.

const { spawn } = require("node:child_process");
const fs = require("node:fs");
const net = require("node:net");
const path = require("node:path");
const { app } = require("electron");
const { reachable } = require("./server");

const OS = { darwin: "mac", win32: "win", linux: "linux" }[process.platform];
let child = null;
let origin = null;
let starting = null; // the start under way
let failure = null; // why the last start failed

// The bundled Python and its packages; null in a build without them.
function runtime() {
  const root = app.isPackaged
    ? path.join(process.resourcesPath, "runtime")
    : path.join(__dirname, "..", "runtime", `${OS}-${process.arch}`);
  const python = process.platform === "win32"
    ? path.join(root, "python", "python.exe")
    : path.join(root, "python", "bin", "python3");
  return fs.existsSync(python) ? { python, site: path.join(root, "site") } : null;
}

const home = () => path.join(app.getPath("userData"), "local");

// The kept port when it's still free, else a free one the system picks.
function freePort(port) {
  return new Promise((resolve) => {
    const probe = net.createServer();
    probe.once("error", () => (port ? freePort(0).then(resolve) : resolve(0)));
    probe.listen(port || 0, "127.0.0.1", () => {
      const picked = probe.address().port;
      probe.close(() => resolve(picked));
    });
  });
}

// Start the server (once; a second call waits for the first) and resolve its address once it
// answers. `port` is the kept one; `onPort` keeps a new one.
function start({ port, onPort }) {
  if (origin && child) return Promise.resolve(origin);
  starting ||= run(port, onPort).finally(() => { starting = null; });
  return starting;
}

async function run(kept, onPort) {
  failure = null;
  const found = runtime();
  if (!found) throw fail("This build of momo can't run on this computer.");
  const dir = home();
  fs.mkdirSync(path.join(dir, "config"), { recursive: true });
  fs.mkdirSync(path.join(dir, "data"), { recursive: true });
  const config = path.join(dir, "config", "momo.toml");
  if (!fs.existsSync(config)) fs.copyFileSync(path.join(__dirname, "local", "momo.toml"), config);
  const port = await freePort(kept);
  if (port !== kept) onPort(port);
  const log = fs.openSync(path.join(dir, "server.log"), "w");
  const proc = spawn(found.python, ["-c", "from momo_scan.cli import app; app()", "serve", "--port", String(port), "--config", "config/momo.toml"], {
    cwd: dir,
    stdio: ["ignore", log, log],
    windowsHide: true,
    env: {
      ...process.env, PYTHONPATH: found.site, PYTHONNOUSERSITE: "1", PYTHONUNBUFFERED: "1",
      PYTHONPYCACHEPREFIX: path.join(dir, "pycache"),
    },
  });
  fs.closeSync(log);
  child = proc;
  let exited = false;
  proc.once("exit", () => {
    exited = true;
    if (child === proc) { child = null; origin = null; }
  });
  const address = `http://127.0.0.1:${port}`;
  // The first start compiles Python's files, which takes a few seconds; later ones are quick.
  for (const deadline = Date.now() + 60_000; Date.now() < deadline && !exited;) {
    if (await reachable(address)) {
      origin = address;
      return origin;
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  stop();
  throw fail(exited ? `momo stopped as it started: ${lastLine(dir)}` : "momo took too long to start.");
}

function fail(message) {
  failure = message;
  return new Error(message);
}

function lastLine(dir) {
  try {
    const lines = fs.readFileSync(path.join(dir, "server.log"), "utf8").trim().split("\n");
    return lines.at(-1).slice(0, 200) || "no output";
  } catch {
    return "no output";
  }
}

function stop() {
  child?.kill();
  child = null;
  origin = null;
}

module.exports = {
  available: () => Boolean(runtime()),
  origin: () => origin,
  starting: () => Boolean(starting),
  failure: () => failure,
  home,
  start,
  stop,
};
