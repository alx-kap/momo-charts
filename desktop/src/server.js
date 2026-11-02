// The momo server the app shows: its address, and whether it answers.

const { net } = require("electron");

// "127.0.0.1:8790/" → "http://127.0.0.1:8790"; null when it isn't an address.
function normalize(text) {
  const trimmed = String(text || "").trim();
  if (!trimmed) return null;
  try {
    const url = new URL(/^https?:\/\//i.test(trimmed) ? trimmed : `http://${trimmed}`);
    return url.origin;
  } catch {
    return null;
  }
}

// True when the server answers its health check within a few seconds.
async function reachable(origin) {
  try {
    const response = await net.fetch(`${origin}/api/health`, {
      signal: AbortSignal.timeout(4000), cache: "no-store",
    });
    return response.ok;
  } catch {
    return false;
  }
}

module.exports = { normalize, reachable };
