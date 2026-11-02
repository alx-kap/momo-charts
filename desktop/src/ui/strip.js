// The tab strip. The main process owns the tabs and sends their state ("tabs"); the strip draws
// it and sends back what the user did. A tab activates on press, like a browser's, and drags
// sideways to reorder; a middle click closes it.

const tabsBox = document.getElementById("tabs");
const newButton = document.getElementById("new");
const tabElements = () => [...tabsBox.querySelectorAll(".tab")];
const elements = new Map(); // tab id -> element
let drawn = false;
let dragging = null;

document.body.classList.add(window.shell.platform);
newButton.addEventListener("click", () => window.shell.strip("new"));
newButton.title = `New tab (${window.shell.platform === "darwin" ? "⌘T" : "Ctrl+T"})`;
document.getElementById("update").addEventListener("click", () => window.shell.strip("update"));

function make(id) {
  const tab = document.createElement("div");
  tab.className = "tab";
  tab.setAttribute("role", "tab");
  tab.innerHTML = '<i class="ring"></i><i class="link"></i><span class="title"></span>'
    + '<button class="close" aria-label="Close tab"><svg width="8" height="8" viewBox="0 0 8 8">'
    + '<path d="M1 1l6 6M7 1L1 7" stroke="currentColor" stroke-width="1.3" stroke-linecap="round"/></svg></button>';
  tab.querySelector(".close").addEventListener("pointerdown", (event) => event.stopPropagation());
  tab.querySelector(".close").addEventListener("click", () => window.shell.strip("close", { id }));
  tab.addEventListener("auxclick", (event) => {
    if (event.button === 1) window.shell.strip("close", { id });
  });
  tab.addEventListener("pointerdown", (event) => {
    if (event.button !== 0) return;
    window.shell.strip("activate", { id });
    drag(tab, id, event);
  });
  return tab;
}

// Follow the pointer; the tab trades places with a neighbour once it passes that one's middle.
function drag(tab, id, down) {
  const grab = down.clientX - tab.getBoundingClientRect().left;
  let moved = false;
  tab.setPointerCapture(down.pointerId);
  const move = (event) => {
    if (!moved && Math.abs(event.clientX - down.clientX) < 4) return;
    moved = true;
    dragging = tab;
    tab.classList.add("dragging");
    const end = newButton.getBoundingClientRect().left;
    const left = Math.max(tabsBox.getBoundingClientRect().left, Math.min(event.clientX - grab, end - tab.offsetWidth));
    // Its slot: after every other tab whose middle (as if this one were gone) it has passed.
    tab.style.transform = "";
    const others = tabElements().filter((other) => other !== tab);
    const own = tab.getBoundingClientRect().left;
    const centre = left + tab.offsetWidth / 2;
    const index = others.filter((other) => {
      const box = other.getBoundingClientRect();
      return box.left + box.width / 2 - (box.left > own ? tab.offsetWidth : 0) < centre;
    }).length;
    if (tab.nextElementSibling !== (others[index] || newButton)) tabsBox.insertBefore(tab, others[index] || newButton);
    const slot = tab.getBoundingClientRect().left;
    tab.style.transform = `translateX(${left - slot}px)`;
  };
  const up = () => {
    tab.removeEventListener("pointermove", move);
    tab.removeEventListener("pointerup", up);
    tab.removeEventListener("pointercancel", up);
    if (!moved) return;
    tab.classList.add("settling");
    tab.style.transform = "";
    tab.addEventListener("transitionend", () => tab.classList.remove("settling", "dragging"), { once: true });
    setTimeout(() => tab.classList.remove("settling", "dragging"), 200);
    dragging = null;
    window.shell.strip("move", { id, index: tabElements().indexOf(tab) });
  };
  tab.addEventListener("pointermove", move);
  tab.addEventListener("pointerup", up);
  tab.addEventListener("pointercancel", up);
}

window.shell.on("tabs", (state) => {
  document.body.classList.toggle("fullscreen", state.fullscreen);
  const seen = new Set();
  state.tabs.forEach((info, index) => {
    let tab = elements.get(info.id);
    if (!tab) {
      tab = make(info.id);
      elements.set(info.id, tab);
      if (drawn) tab.classList.add("opening");
    }
    tab.classList.toggle("active", info.id === state.active);
    tab.classList.toggle("loading", info.loading);
    tab.classList.toggle("offline", info.offline);
    tab.classList.toggle("linked", Boolean(info.link));
    tab.style.setProperty("--link", info.link || "transparent");
    tab.setAttribute("aria-selected", String(info.id === state.active));
    const title = info.title || (info.loading ? "" : "momo");
    tab.querySelector(".title").textContent = title;
    tab.title = title;
    if (!dragging && tabElements()[index] !== tab) tabsBox.insertBefore(tab, tabElements()[index] || newButton);
    seen.add(info.id);
  });
  for (const [id, tab] of elements) {
    if (!seen.has(id)) { tab.remove(); elements.delete(id); }
  }
  document.getElementById("dev").hidden = !state.dev;
  const update = document.getElementById("update");
  update.hidden = !state.update;
  update.title = state.update ? `momo ${state.update} is ready to download` : "";
  drawn = true;
});
