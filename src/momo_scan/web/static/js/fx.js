// Practice-mode motion helpers. Everything settles instantly when the OS asks for reduced motion.
export const reducedMotion = () => window.matchMedia("(prefers-reduced-motion: reduce)").matches;

export function retrigger(element, className) {
  element.classList.remove(className);
  void element.offsetWidth;
  element.classList.add(className);
}

const easeOut = (t) => 1 - (1 - t) ** 3;
const running = new WeakMap();

// Roll a number from its current value to `to`, calling onStep for audible ticks.
export function countTo(element, to, { format, ms = 600, onStep = null } = {}) {
  const from = Number(element.dataset.value ?? 0);
  element.dataset.value = String(to);
  cancelAnimationFrame(running.get(element));
  if (reducedMotion() || from === to || ms <= 0) {
    element.textContent = format(to);
    return;
  }
  const start = performance.now();
  let shown = null;
  const frame = (now) => {
    const t = Math.min(1, (now - start) / ms);
    const text = format(from + (to - from) * easeOut(t));
    if (text !== shown) {
      element.textContent = text;
      if (shown !== null && onStep) onStep();
      shown = text;
    }
    if (t < 1) running.set(element, requestAnimationFrame(frame));
  };
  running.set(element, requestAnimationFrame(frame));
}

// Cumulative curve of `values` (starting from zero) as an SVG line with a soft fill.
export function drawCurve(svg, values, { width = 120, height = 40, pad = 3, animate = true } = {}) {
  const points = [0, ...values];
  const low = Math.min(0, ...points);
  const high = Math.max(0, ...points);
  const span = high - low || 1;
  const x = (i) => pad + (i / Math.max(points.length - 1, 1)) * (width - pad * 2);
  const y = (v) => pad + (1 - (v - low) / span) * (height - pad * 2);
  const line = points.map((v, i) => `${i ? "L" : "M"}${x(i).toFixed(1)},${y(v).toFixed(1)}`).join("");
  const area = `${line}L${x(points.length - 1).toFixed(1)},${y(0).toFixed(1)}L${x(0).toFixed(1)},${y(0).toFixed(1)}Z`;
  const last = points[points.length - 1];
  const tone = last > 0 ? "up" : last < 0 ? "down" : "flat";
  const id = `${svg.id || "curve"}-fill`;
  svg.setAttribute("viewBox", `0 0 ${width} ${height}`);
  svg.setAttribute("class", `curve ${tone}`);
  svg.innerHTML =
    `<defs><linearGradient id="${id}" x1="0" y1="0" x2="0" y2="1">` +
    `<stop offset="0" stop-color="currentColor" stop-opacity=".28"/>` +
    `<stop offset="1" stop-color="currentColor" stop-opacity="0"/></linearGradient></defs>` +
    `<line class="zero" x1="${pad}" x2="${width - pad}" y1="${y(0).toFixed(1)}" y2="${y(0).toFixed(1)}"/>` +
    `<path class="area" d="${area}" fill="url(#${id})"/>` +
    `<path class="line" d="${line}" pathLength="100"/>` +
    `<circle class="head" cx="${x(points.length - 1).toFixed(1)}" cy="${y(last).toFixed(1)}" r="2.2"/>`;
  if (animate && !reducedMotion()) retrigger(svg, "draw");
}

// Slot-machine numbers: every digit is a reel (0–9 three times over) that spins down to its
// new value, the right-most reel landing first. Reels line up from the right, so 9.5R → 10.5R
// spins the units and adds a tens reel. `spin: false` moves only the digits that changed.
const DIGITS = "0123456789";
const REEL = [...DIGITS, ...DIGITS, ...DIGITS].map((d) => `<i>${d}</i>`).join("");
const reelAt = (index) => `translateY(${(-index * 100) / 30}%)`;

export function odometer(element, text, { spin = true, onStep = null } = {}) {
  const before = element.dataset.text;
  if (before === text) return;
  element.dataset.text = text;
  element.classList.add("odo");
  const still = reducedMotion() || before == null;
  const old = [...(before || "")].reverse();
  element.innerHTML = [...text].reverse().map((char, n) => {
    if (!DIGITS.includes(char)) return `<span class="odo-c">${char}</span>`;
    const from = DIGITS.includes(old[n]) ? Number(old[n]) : 0;
    const to = Number(char);
    const target = still ? to : spin || from !== to ? 20 + to : from;
    return `<span class="odo-d" data-target="${target}" data-n="${n}">` +
      `<span class="odo-s" style="transform:${reelAt(still ? to : from)}">${REEL}</span></span>`;
  }).reverse().join("");
  if (still) return;
  void element.offsetWidth;
  const reels = [...element.querySelectorAll(".odo-d")];
  for (const reel of reels) {
    const strip = reel.firstChild;
    const n = Number(reel.dataset.n);
    strip.style.transitionDelay = `${n * 90}ms`;
    strip.classList.add("rolling");
    strip.style.transform = reelAt(Number(reel.dataset.target));
    if (onStep) setTimeout(onStep, 520 + n * 90);
  }
}

// A small burst of sparks from the middle of `element`, for wins worth celebrating.
export function burst(element, { count = 14, color = "#f5c451" } = {}) {
  if (reducedMotion()) return;
  for (let n = 0; n < count; n++) {
    const spark = document.createElement("i");
    spark.className = "spark";
    spark.style.setProperty("--a", `${(360 / count) * n + Math.random() * 14}deg`);
    spark.style.setProperty("--d", `${26 + Math.random() * 22}px`);
    spark.style.setProperty("--c", color);
    element.appendChild(spark);
    spark.addEventListener("animationend", () => spark.remove());
  }
}
