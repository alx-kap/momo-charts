// Builds the Python that local mode runs (src/local.js): a standalone CPython for one platform
// plus momo's server installed beside it, in runtime/<os>-<arch>/{python,site}. The release
// workflow runs it before electron-builder, which ships the folder as resources/runtime.
//
//   node tools/runtime.mjs                        this computer's platform, momo from ../
//   node tools/runtime.mjs --os mac --arch x64    another one (the packages are fetched for it)
//   node tools/runtime.mjs --source ../../momo-charts
//
// Needs uv (https://docs.astral.sh/uv/). CPython comes from python-build-standalone.

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const PYTHON = "3.13.1";
const BUILD = "20250106";
const TRIPLES = {
  "mac-arm64": "aarch64-apple-darwin",
  "mac-x64": "x86_64-apple-darwin",
  "win-x64": "x86_64-pc-windows-msvc",
  "linux-x64": "x86_64-unknown-linux-gnu",
};

const args = Object.fromEntries(process.argv.slice(2).join(" ").split(/\s*--/).filter(Boolean).map((pair) => pair.split(/\s+/)));
const os = args.os || { darwin: "mac", win32: "win", linux: "linux" }[process.platform];
const arch = args.arch || process.arch;
const source = path.resolve(ROOT, args.source || "..");
const key = `${os}-${arch}`;
const triple = TRIPLES[key];
if (!triple) throw new Error(`No Python for ${key}; one of ${Object.keys(TRIPLES).join(", ")}`);

const out = path.join(ROOT, "runtime", key);
fs.rmSync(out, { recursive: true, force: true });
fs.mkdirSync(out, { recursive: true });

const name = `cpython-${PYTHON}+${BUILD}-${triple}-install_only_stripped.tar.gz`;
const url = `https://github.com/astral-sh/python-build-standalone/releases/download/${BUILD}/${encodeURIComponent(name)}`;
console.log(`${key}: ${name}`);
const response = await fetch(url);
if (!response.ok) throw new Error(`${url}: ${response.status}`);
const archive = path.join(out, "python.tar.gz");
fs.writeFileSync(archive, Buffer.from(await response.arrayBuffer()));
execFileSync("tar", ["-xzf", "python.tar.gz"], { cwd: out, stdio: "inherit" });
fs.rmSync(archive);

// What a server never uses: Python's own tests, IDLE, Tk, pip's installer.
const lib = os === "win" ? path.join(out, "python", "Lib") : path.join(out, "python", "lib", `python${PYTHON.split(".").slice(0, 2).join(".")}`);
for (const unused of ["test", "idlelib", "tkinter", "turtledemo", "ensurepip"]) {
  fs.rmSync(path.join(lib, unused), { recursive: true, force: true });
}

// momo's server and its packages, built for that platform (no Python of its own is run).
console.log(`${key}: momo from ${source}`);
execFileSync("uv", [
  "pip", "install", "--quiet", "--target", path.join(out, "site"),
  "--python-platform", triple, "--python-version", PYTHON.split(".").slice(0, 2).join("."),
  source,
], { stdio: "inherit" });

const size = (dir) => fs.readdirSync(dir, { withFileTypes: true, recursive: true })
  .filter((entry) => entry.isFile()).reduce((sum, entry) => sum + fs.statSync(path.join(entry.parentPath, entry.name)).size, 0);
console.log(`${key}: ${(size(out) / 1e6).toFixed(0)} MB in ${path.relative(ROOT, out)}`);
