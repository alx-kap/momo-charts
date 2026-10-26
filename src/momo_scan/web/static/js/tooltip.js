// Hover tooltips for icon-only controls: a one-word popup after a short delay. The native title
// is moved to data-tip so the browser's own tooltip doesn't double up. Elements with visible text
// keep their normal title.
const DELAY = 450;
let tip, timer, target;

// One-word names where a title's first word would mislead.
const WORDS = [
  [/^Copy a picture/, "Snapshot"], [/^Layout/, "Layout"], [/^Keyboard/, "Shortcuts"],
  [/^Remove all/, "Clear"], [/^Remove the selected/, "Delete"], [/^Remove/, "Remove"],
  [/^Horizontal ray/, "H-ray"], [/^Horizontal/, "H-line"], [/^Vertical/, "V-line"],
  [/^Clone/, "Clone"], [/^(Show|Hide) drawings/, "Visibility"], [/^Fold|^Show the drawing/, "Fold"],
  [/^Drag to move/, "Move"], [/^New category/, "New"], [/^Add/, "Add"], [/^Dock/, "Dock"],
  [/^Pick a colour/, "Eyedropper"], [/^Rename, delete/, "More"], [/^Note, delete/, "More"],
  [/^Hide or show the indicator/, "Legend"], [/^Sound/, "Sound"], [/^How to play/, "Guide"],
  [/^Filter setups/, "Filter"], [/^Save the chart/, "Save"],
];
const isIcon = (el) => !/[\p{L}\p{N}]/u.test(el.textContent);
const word = (t) => (WORDS.find(([re]) => re.test(t)) || [])[1] || t.split(/[\s:(,]/)[0];

function hide() {
  clearTimeout(timer);
  target = null;
  if (tip) tip.hidden = true;
}

function show(el) {
  const text = el.dataset.tip;
  if (!text) return;
  tip ||= Object.assign(document.body.appendChild(document.createElement("div")), { id: "tooltip" });
  tip.textContent = text;
  tip.hidden = false;
  const r = el.getBoundingClientRect();
  const w = tip.offsetWidth, h = tip.offsetHeight;
  const left = Math.max(6, Math.min(innerWidth - w - 6, r.left + r.width / 2 - w / 2));
  const top = r.bottom + 8 + h > innerHeight ? r.top - h - 8 : r.bottom + 8;
  tip.style.left = `${left}px`;
  tip.style.top = `${Math.max(6, top)}px`;
}

export function bindTooltips() {
  document.addEventListener("mouseover", (e) => {
    const el = e.target.closest?.("[title], [data-tip]");
    if (el === target) return;
    hide();
    if (!el || (!el.dataset.tip && !isIcon(el))) return;
    if (el.hasAttribute("title")) {
      const full = el.getAttribute("title");
      el.removeAttribute("title");
      el.dataset.tip = word(full);
      if (!el.getAttribute("aria-label")) el.setAttribute("aria-label", full.split(" · ")[0]);
    }
    target = el;
    timer = setTimeout(() => show(el), DELAY);
  });
  document.addEventListener("mousedown", hide, true);
  document.addEventListener("scroll", hide, true);
  document.addEventListener("keydown", hide, true);
  document.addEventListener("mouseleave", hide);
}
