// Shown in a tab instead of momo: "setup" picks where momo runs (on this computer, or a server
// at an address), "starting" waits for momo on this computer, and "offline" waits for the
// server to answer again (every few seconds, then less often) and reconnects by itself.

const query = new URLSearchParams(location.search);
const $ = (id) => document.getElementById(id);
let mode = null;

function show(id) {
  for (const section of document.querySelectorAll("section")) section.hidden = section.id !== id;
}

function pick(next) {
  mode = next;
  for (const choice of document.querySelectorAll(".choice")) {
    const on = choice.dataset.mode === mode;
    choice.classList.toggle("on", on);
    choice.setAttribute("aria-checked", String(on));
  }
  $("address").hidden = mode !== "server";
  $("error").textContent = "";
  if (mode === "server") { $("address").focus(); $("address").select(); }
}

async function setup() {
  show("setup");
  const info = await window.shell.invoke("connect:info");
  $("address").value = info.server || "";
  $("cancel").hidden = !info.mode;
  const local = document.querySelector('[data-mode="local"]');
  local.disabled = !info.local;
  if (!info.local) local.querySelector("span").textContent = "Not in this build of momo.";
  pick(info.mode || (info.local ? "local" : "server"));
}

for (const choice of document.querySelectorAll(".choice")) choice.addEventListener("click", () => pick(choice.dataset.mode));

$("form").addEventListener("submit", async (event) => {
  event.preventDefault();
  $("connect").disabled = true;
  $("connect").textContent = mode === "server" ? "Connecting…" : "Starting…";
  $("error").textContent = "";
  const result = mode === "server"
    ? await window.shell.invoke("connect:set", $("address").value)
    : await window.shell.invoke("connect:local");
  if (result.error) {
    $("error").textContent = result.error;
    $("connect").disabled = false;
    $("connect").textContent = "Continue";
  }
});
$("cancel").addEventListener("click", () => window.shell.send("connect:cancel"));
$("change").addEventListener("click", setup);
document.addEventListener("keydown", (event) => {
  if (event.key === "Escape" && !$("cancel").hidden && !$("setup").hidden) window.shell.send("connect:cancel");
});

async function offline() {
  show("offline");
  const server = query.get("server");
  if (server) $("server").textContent = server;
  else {
    // momo on this computer stopped, or couldn't start.
    const { failure } = await window.shell.invoke("connect:info");
    $("why").textContent = `${failure || "momo on this computer stopped."} momo tries again by itself.`;
  }
  let wait = 3;
  const retry = async () => {
    if ($("offline").hidden) return;
    $("status").textContent = "Trying again…";
    if (await window.shell.invoke("connect:retry")) return; // the tab loads momo
    $("status").textContent = `Next try in ${wait} s`;
    setTimeout(retry, wait * 1000);
    wait = Math.min(15, wait + 3);
  };
  setTimeout(retry, 1500);
}

if (query.get("mode") === "offline") offline();
else if (query.get("mode") === "starting") show("starting");
else setup();
