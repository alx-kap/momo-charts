// Small JSON files in the app's data folder: settings.json (the server) and state.json (open
// windows and their tabs, so momo opens the way it was left).

const fs = require("node:fs");
const path = require("node:path");
const { app } = require("electron");

function file(name) {
  return path.join(app.getPath("userData"), name);
}

function read(name, fallback) {
  try {
    return { ...fallback, ...JSON.parse(fs.readFileSync(file(name), "utf8")) };
  } catch {
    return { ...fallback };
  }
}

// Written to a temporary file first, so a crash mid-write never leaves half a file.
function write(name, value) {
  const target = file(name);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(`${target}.tmp`, JSON.stringify(value, null, 2));
  fs.renameSync(`${target}.tmp`, target);
}

module.exports = { read, write };
