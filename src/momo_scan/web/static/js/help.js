import { $ } from "./util.js";

// ?: the keyboard shortcuts dialog, with a filter like TradingView's.

export const helpOpen = () => !$("help").hidden;

export function openHelp() {
  $("help").hidden = false;
  $("help-search").value = "";
  filter("");
  $("help-search").focus();
}

export function closeHelp() {
  $("help").hidden = true;
  $("help-search").blur();
}

function filter(query) {
  const words = query.trim().toLowerCase().split(/\s+/).filter(Boolean);
  let any = false;
  for (const section of $("help-body").querySelectorAll("section")) {
    const title = section.querySelector("h3").textContent.toLowerCase();
    let shown = 0;
    for (const row of section.querySelectorAll(".hk")) {
      const text = `${title} ${row.textContent.toLowerCase()}`;
      row.hidden = !words.every((word) => text.includes(word));
      if (!row.hidden) shown += 1;
    }
    section.hidden = !shown;
    any ||= shown > 0;
  }
  $("help-none").hidden = any;
}

export function bindHelp() {
  $("help").addEventListener("click", (event) => { if (event.target === $("help")) closeHelp(); });
  $("help-close").addEventListener("click", closeHelp);
  $("help-search").addEventListener("input", (event) => filter(event.target.value));
  $("help-search").addEventListener("keydown", (event) => {
    if (event.key !== "Escape") return;
    event.stopPropagation();
    closeHelp();
  });
}
