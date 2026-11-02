// Drives the desktop app headless and saves screenshots: first-run connect page, momo in two
// tabs, tabs restored after a relaunch, the offline page and the update pill. Every request
// that would change momo is refused (MOMO_DESKTOP_READONLY), and each run uses a throwaway
// data folder.
//
//   xvfb-run -a -s "-screen 0 1600x1000x24" node tools/check.mjs [server] [out-dir]
//
// server defaults to http://127.0.0.1:8790; screenshots go to out-dir (default: ./check-out).

import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { _electron as electron } from "playwright-core";

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const SERVER = process.argv[2] || "http://127.0.0.1:8790";
const OUT = path.resolve(process.argv[3] || "check-out");
fs.mkdirSync(OUT, { recursive: true });

const results = [];
const ok = (name, pass, detail = "") => {
  results.push({ name, pass, detail });
  console.log(`${pass ? "ok  " : "FAIL"} ${name}${detail ? ` · ${detail}` : ""}`);
};

// A fake GitHub releases list, for the update pill.
const releases = http.createServer((_request, response) => {
  response.setHeader("content-type", "application/json");
  response.end(JSON.stringify([{ tag_name: "desktop-v9.9.9", html_url: "https://example.com/r", draft: false, prerelease: false }]));
});
await new Promise((resolve) => releases.listen(0, "127.0.0.1", resolve));

async function launch(profile, extra = {}) {
  const started = Date.now();
  const app = await electron.launch({
    args: ["--no-sandbox", ROOT],
    env: {
      ...process.env, MOMO_DESKTOP_PROFILE: profile, MOMO_DESKTOP_READONLY: "1",
      MOMO_DESKTOP_RELEASES: "http://127.0.0.1:9/none", ...extra,
    },
  });
  return { app, started };
}

// A page (strip or tab) whose URL matches.
async function pageOf(app, test, timeout = 20000) {
  const end = Date.now() + timeout;
  while (Date.now() < end) {
    const page = app.context().pages().find((each) => test(each.url()));
    if (page) return page;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error("no such page");
}
const momoPages = (app) => app.context().pages().filter((page) => page.url().startsWith(SERVER));

// The chart is up: its canvas is sized and two frames have painted.
async function chartUp(page) {
  await page.waitForFunction(() => {
    const canvas = document.querySelector(".chart-pane canvas");
    return canvas && canvas.width > 0 && document.title.includes("·");
  }, null, { timeout: 30000 });
  await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))));
}

// The whole window: the strip and the visible tab, stitched by the main process.
async function shot(app, name) {
  const png = await app.evaluate(async ({ BrowserWindow, nativeImage }) => {
    const win = BrowserWindow.getAllWindows()[0];
    const strip = await win.webContents.capturePage();
    const view = win.contentView.children.find((child) => child.getVisible());
    const page = view ? await view.webContents.capturePage() : null;
    const [width, height] = win.getContentSize();
    const scale = strip.getSize().width / width;
    const canvas = Buffer.alloc(Math.round(width * scale) * Math.round(height * scale) * 4);
    const paste = (image, top) => {
      const bitmap = image.toBitmap();
      const { width: w, height: h } = image.getSize();
      for (let y = 0; y < h && top + y < height * scale; y++) {
        bitmap.copy(canvas, ((top + y) * Math.round(width * scale)) * 4, y * w * 4, (y + 1) * w * 4);
      }
    };
    paste(strip, 0);
    if (page) paste(page, Math.round(view.getBounds().y * scale));
    const image = nativeImage.createFromBitmap(canvas, { width: Math.round(width * scale), height: Math.round(height * scale) });
    return image.toPNG().toString("base64");
  });
  fs.writeFileSync(path.join(OUT, `${name}.png`), Buffer.from(png, "base64"));
}

// A shortcut as the OS would send it, so menu keys see it (Playwright's own keys skip them).
async function press(app, keyCode, modifiers = ["control"]) {
  await app.evaluate(({ BrowserWindow }, { keyCode, modifiers }) => {
    const view = BrowserWindow.getAllWindows()[0].contentView.children.find((child) => child.getVisible());
    for (const type of ["keyDown", "keyUp"]) view.webContents.sendInputEvent({ type, keyCode, modifiers });
  }, { keyCode, modifiers });
  await new Promise((resolve) => setTimeout(resolve, 400));
}

const stripTitles = (strip) => strip.$$eval(".tab", (tabs) => tabs.map((tab) => ({
  title: tab.querySelector(".title").textContent, active: tab.classList.contains("active"),
})));

async function openSymbol(page, symbol) {
  await page.keyboard.type(symbol);
  await page.keyboard.press("Enter");
  await page.waitForFunction((want) => document.title.startsWith(`${want} `), symbol, { timeout: 15000 });
}

const profile = fs.mkdtempSync(path.join(os.tmpdir(), "momo-desktop-"));
try {
  // 1. First run: the connect page, then momo.
  {
    const { app, started } = await launch(profile);
    const strip = await pageOf(app, (url) => url.endsWith("strip.html"));
    const connect = await pageOf(app, (url) => url.includes("connect.html"));
    await connect.waitForSelector("#setup:not([hidden])");
    await shot(app, "1-connect");
    ok("first run shows the connect page", true, `${Date.now() - started} ms to the page`);
    await connect.fill("#address", "127.0.0.1:1");
    await connect.click("#connect");
    await connect.waitForFunction(() => document.getElementById("error").textContent.length > 0);
    ok("a dead address is refused", true, await connect.textContent("#error"));
    await connect.fill("#address", SERVER.replace(/^http:\/\//, ""));
    const asked = Date.now();
    await connect.click("#connect");
    const page = await pageOf(app, (url) => url.startsWith(SERVER));
    await chartUp(page);
    ok("connecting loads momo", true, `${Date.now() - asked} ms to a painted chart`);

    // 2. Two tabs on different symbols.
    await openSymbol(page, "NVDA");
    await press(app, "T");
    const second = momoPages(app).find((each) => each !== page);
    ok("Ctrl+T opens a tab", Boolean(second));
    await chartUp(second);
    await openSymbol(second, "AAPL");
    await new Promise((resolve) => setTimeout(resolve, 300));
    let tabs = await stripTitles(strip);
    ok("the strip names each tab's chart", tabs.map((t) => t.title).join(",") === "NVDA,AAPL", JSON.stringify(tabs));
    await shot(app, "2-tabs");

    const switched = Date.now();
    await strip.click(".tab:first-child");
    await strip.waitForFunction(() => document.querySelector(".tab:first-child").classList.contains("active"));
    ok("clicking a tab shows it", true, `${Date.now() - switched} ms`);
    await shot(app, "3-first-tab");
    await press(app, "2");
    tabs = await stripTitles(strip);
    ok("Ctrl+2 picks the second tab", tabs[1]?.active === true);
    await press(app, "T");
    await press(app, "W");
    ok("Ctrl+W closes a tab", (await stripTitles(strip)).length === 2);
    await press(app, "1");
    await new Promise((resolve) => setTimeout(resolve, 900)); // the state is saved half a second after a change
    await app.close();
  }

  // 3. Relaunch: the same tabs, on the same charts.
  {
    const { app, started } = await launch(profile);
    const strip = await pageOf(app, (url) => url.endsWith("strip.html"));
    const page = await pageOf(app, (url) => url.startsWith(SERVER));
    await chartUp(page);
    ok("relaunch to a painted chart", true, `${Date.now() - started} ms from launch`);
    await new Promise((resolve) => setTimeout(resolve, 1500));
    const tabs = await stripTitles(strip);
    ok("tabs come back", tabs.map((t) => t.title).join(",") === "NVDA,AAPL", JSON.stringify(tabs));
    await shot(app, "4-restored");
    await app.close();
  }

  // 4. The server doesn't answer; 5. a newer version is out.
  {
    const offline = fs.mkdtempSync(path.join(os.tmpdir(), "momo-desktop-"));
    fs.writeFileSync(path.join(offline, "settings.json"), JSON.stringify({ server: "http://127.0.0.1:9" }));
    const { app } = await launch(offline, {
      MOMO_DESKTOP_RELEASES: `http://127.0.0.1:${releases.address().port}/`,
    });
    const strip = await pageOf(app, (url) => url.endsWith("strip.html"));
    const connect = await pageOf(app, (url) => url.includes("connect.html"));
    await connect.waitForSelector("#offline:not([hidden])");
    ok("an unreachable server shows the offline page", true);
    await strip.waitForSelector("#update:not([hidden])", { timeout: 15000 });
    await new Promise((resolve) => setTimeout(resolve, 600));
    ok("a newer release shows the update pill", true, await strip.getAttribute("#update", "title"));
    await shot(app, "5-offline-update");
    await app.close();
    fs.rmSync(offline, { recursive: true, force: true });
  }
} catch (error) {
  ok("check ran to the end", false, error.stack);
} finally {
  releases.close();
  fs.rmSync(profile, { recursive: true, force: true });
}

const failed = results.filter((result) => !result.pass);
console.log(`\n${results.length - failed.length}/${results.length} passed · screenshots in ${OUT}`);
process.exit(failed.length ? 1 : 0);
