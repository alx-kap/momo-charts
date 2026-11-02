// Shown in a tab instead of momo: "setup" asks for the server's address, "offline" waits for
// the server to answer again (every few seconds, then less often) and reconnects by itself.

const query = new URLSearchParams(location.search);
const $ = (id) => document.getElementById(id);

async function setup() {
  $("offline").hidden = true;
  $("setup").hidden = false;
  const { server } = await window.shell.invoke("connect:info");
  $("address").value = server || "";
  $("cancel").hidden = !server;
  $("address").focus();
  $("address").select();
}

$("form").addEventListener("submit", async (event) => {
  event.preventDefault();
  $("connect").disabled = true;
  $("connect").textContent = "Connecting…";
  $("error").textContent = "";
  const result = await window.shell.invoke("connect:set", $("address").value);
  if (result.error) {
    $("error").textContent = result.error;
    $("connect").disabled = false;
    $("connect").textContent = "Connect";
  }
});
$("cancel").addEventListener("click", () => window.shell.send("connect:cancel"));
$("change").addEventListener("click", setup);
document.addEventListener("keydown", (event) => {
  if (event.key === "Escape" && !$("cancel").hidden && !$("setup").hidden) window.shell.send("connect:cancel");
});

function offline() {
  $("server").textContent = query.get("server");
  $("offline").hidden = false;
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
else setup();
