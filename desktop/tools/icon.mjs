// Renders build/icon.svg to build/icon.png (1024 px, transparent), which electron-builder turns
// into the Mac, Windows and Linux icons. Needs a Chromium: Playwright's, or CHROMIUM=path.
//
//   node tools/icon.mjs

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright-core";

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const cache = path.join(os.homedir(), ".cache/ms-playwright");
const found = fs.existsSync(cache) && fs.readdirSync(cache).filter((name) => /^chromium-\d+$/.test(name)).sort().at(-1);
const executablePath = process.env.CHROMIUM || (found && path.join(cache, found, "chrome-linux64/chrome"));

const browser = await chromium.launch({ executablePath });
const page = await browser.newPage({ viewport: { width: 1024, height: 1024 } });
const svg = fs.readFileSync(path.join(ROOT, "build/icon.svg"), "utf8");
await page.setContent(`<body style="margin:0;background:transparent">${svg}</body>`);
await page.screenshot({ path: path.join(ROOT, "build/icon.png"), omitBackground: true });
await browser.close();
console.log("build/icon.png");
