// Runs the momo script sandbox check (../tools/script_sandbox_probe.js) inside the desktop app's
// own Chromium: connects the app to momo, then runs hand-written scripts through the real host
// and worker, as tools/script_sandbox_steps.py does in a browser. Read-only like check.mjs.
//
//   xvfb-run -a -s "-screen 0 1600x1000x24" node tools/sandbox-check.mjs [server]

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { _electron as electron } from "playwright-core";

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const SERVER = process.argv[2] || "http://127.0.0.1:8790";
const PROBE = fs.readFileSync(path.join(ROOT, "../tools/script_sandbox_probe.js"), "utf8");

const profile = fs.mkdtempSync(path.join(os.tmpdir(), "momo-desktop-"));
const app = await electron.launch({
  args: ["--no-sandbox", ROOT],
  env: { ...process.env, MOMO_DESKTOP_PROFILE: profile, MOMO_DESKTOP_READONLY: "1", MOMO_DESKTOP_RELEASES: "http://127.0.0.1:9/none" },
});
let failed = 0;
try {
  const find = async (test) => {
    for (let i = 0; i < 200; i++) {
      const page = app.context().pages().find((each) => test(each.url()));
      if (page) return page;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    throw new Error("no such page");
  };
  const connect = await find((url) => url.includes("connect.html"));
  await connect.waitForSelector("#setup:not([hidden])");
  await connect.click('[data-mode="server"]');
  await connect.fill("#address", SERVER.replace(/^http:\/\//, ""));
  await connect.click("#connect");
  const page = await find((url) => url.startsWith(SERVER));
  await page.waitForLoadState("load");
  const agent = await page.evaluate(() => navigator.userAgent.match(/Electron\/\S+/)[0]);
  const results = await page.evaluate(`(${PROBE})(${JSON.stringify(new URL("/static/js/script/host.js", SERVER).href)})`);
  for (const r of results) {
    if (!r.pass) failed++;
    if (!r.pass) console.log(`FAIL ${r.name} · ${r.detail}`);
  }
  console.log(`${agent}: ${results.length - failed}/${results.length} sandbox checks passed`);
} finally {
  await app.close();
  fs.rmSync(profile, { recursive: true, force: true });
}
process.exit(failed ? 1 : 0);
