// New versions of the app itself. Releases are published on GitHub (momo-charts) with tags
// like "desktop-v0.2.0"; the app checks at launch and every few hours, and a newer one shows
// a small "Update available" pill in the tab strip. Until the Mac build is signed, the pill
// opens the release page to download it.

const { app, net } = require("electron");

const RELEASES = process.env.MOMO_DESKTOP_RELEASES
  || "https://api.github.com/repos/alx-kap/momo-charts/releases?per_page=20";
const TAG = /^desktop-v(\d+\.\d+\.\d+)$/;
const EVERY = 6 * 60 * 60 * 1000;

let found = null; // { version, url } of a newer release
const listeners = new Set();

function newer(a, b) {
  const [x, y] = [a, b].map((version) => version.split(".").map(Number));
  for (let i = 0; i < 3; i++) if (x[i] !== y[i]) return x[i] > y[i];
  return false;
}

// The newest published desktop release, or null. Throws when GitHub can't be reached.
async function latest() {
  const response = await net.fetch(RELEASES, {
    headers: { accept: "application/vnd.github+json" }, signal: AbortSignal.timeout(10000),
  });
  if (!response.ok) throw new Error(`GitHub answered ${response.status}`);
  let best = null;
  for (const release of await response.json()) {
    const match = TAG.exec(release.tag_name || "");
    if (!match || release.draft || release.prerelease) continue;
    if (!best || newer(match[1], best.version)) best = { version: match[1], url: release.html_url };
  }
  return best;
}

// Checks once; returns the newer release or null. Errors are the caller's.
async function check() {
  const release = await latest();
  found = release && newer(release.version, app.getVersion()) ? release : null;
  for (const listener of listeners) listener(found);
  return found;
}

function start() {
  const quietly = () => check().catch(() => {});
  setTimeout(quietly, 5000);
  setInterval(quietly, EVERY);
}

module.exports = { check, start, available: () => found, onChange: (fn) => listeners.add(fn) };
