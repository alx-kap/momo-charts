import { store } from "./util.js";

// Practice-mode sound, synthesized with Web Audio (no files to ship). Soft plucks and bells
// through a little reverb rather than chiptune beeps. During a replay each bar is a note on a
// pentatonic scale pitched by the trade's R, so a runner climbs and a failure sinks.
let ctx = null;
let dry = null;
let wet = null;
let muted = store.get("muted", false);
let forced = false; // an alert sound plays through Practice's mute
let out = null; // where voices go: { dry, wet }, an alert's own volume, or the normal buses

function impulse(c, seconds = 2.4, decay = 3.2) {
  const length = Math.floor(c.sampleRate * seconds);
  const buffer = c.createBuffer(2, length, c.sampleRate);
  for (let channel = 0; channel < 2; channel++) {
    const data = buffer.getChannelData(channel);
    for (let i = 0; i < length; i++) data[i] = (Math.random() * 2 - 1) * (1 - i / length) ** decay;
  }
  return buffer;
}

function audio() {
  if (muted && !forced) return null;
  if (!ctx) {
    const Context = window.AudioContext || window.webkitAudioContext;
    if (!Context) return null;
    ctx = new Context();
    const compressor = ctx.createDynamicsCompressor();
    compressor.threshold.value = -18;
    compressor.ratio.value = 4;
    const master = ctx.createGain();
    master.gain.value = 0.5;
    compressor.connect(master).connect(ctx.destination);
    dry = ctx.createGain();
    dry.connect(compressor);
    const reverb = ctx.createConvolver();
    reverb.buffer = impulse(ctx);
    wet = ctx.createGain();
    wet.gain.value = 0.22;
    wet.connect(reverb).connect(compressor);
  }
  if (ctx.state === "suspended") ctx.resume();
  return ctx;
}

// One enveloped oscillator through a lowpass, split to the dry bus and the reverb.
function voice(freq, {
  at = 0, attack = 0.004, decay = 0.4, gain = 0.2, type = "sine", cutoff = 4000, slide = null, space = 1,
} = {}) {
  const c = audio();
  if (!c) return;
  const t = c.currentTime + at;
  const osc = c.createOscillator();
  const filter = c.createBiquadFilter();
  const amp = c.createGain();
  osc.type = type;
  osc.frequency.setValueAtTime(freq, t);
  if (slide) osc.frequency.exponentialRampToValueAtTime(slide, t + decay);
  filter.type = "lowpass";
  filter.frequency.value = cutoff;
  amp.gain.setValueAtTime(0.0001, t);
  amp.gain.exponentialRampToValueAtTime(gain, t + attack);
  amp.gain.exponentialRampToValueAtTime(0.0001, t + attack + decay);
  osc.connect(filter).connect(amp);
  amp.connect(out ? out.dry : dry);
  if (space) {
    const send = c.createGain();
    send.gain.value = space;
    amp.connect(send).connect(out ? out.wet : wet);
  }
  osc.start(t);
  osc.stop(t + attack + decay + 0.05);
}

function noise({ at = 0, dur = 0.03, gain = 0.15, type = "highpass", freq = 2500, to = null, space = 0 } = {}) {
  const c = audio();
  if (!c) return;
  const t = c.currentTime + at;
  const buffer = c.createBuffer(1, Math.max(1, Math.floor(c.sampleRate * dur)), c.sampleRate);
  const data = buffer.getChannelData(0);
  for (let i = 0; i < data.length; i++) data[i] = Math.random() * 2 - 1;
  const source = c.createBufferSource();
  source.buffer = buffer;
  const filter = c.createBiquadFilter();
  filter.type = type;
  filter.frequency.setValueAtTime(freq, t);
  if (to) filter.frequency.exponentialRampToValueAtTime(to, t + dur);
  const amp = c.createGain();
  amp.gain.setValueAtTime(gain, t);
  amp.gain.exponentialRampToValueAtTime(0.0001, t + dur);
  source.connect(filter).connect(amp).connect(out ? out.dry : dry);
  if (space) {
    const send = c.createGain();
    send.gain.value = space;
    amp.connect(send).connect(out ? out.wet : wet);
  }
  source.start(t);
}

const pluck = (freq, at = 0, gain = 0.16, cutoff = 3200) => {
  voice(freq, { at, gain, decay: 0.5, cutoff, type: "triangle", space: 0.8 });
  voice(freq * 2, { at, gain: gain * 0.25, decay: 0.18, cutoff, space: 0.4 });
};
const bell = (freq, at = 0, gain = 0.12) => {
  voice(freq, { at, gain, decay: 1.4, space: 1 });
  voice(freq * 2.76, { at, gain: gain * 0.22, decay: 0.5, space: 1 });
  voice(freq * 5.4, { at, gain: gain * 0.06, decay: 0.2, space: 1 });
};
const pad = (freqs, at = 0, gain = 0.06, decay = 1.8) => {
  for (const f of freqs) {
    voice(f * 0.998, { at, gain, attack: 0.05, decay, cutoff: 2400, space: 1.2 });
    voice(f * 1.002, { at, gain, attack: 0.05, decay, cutoff: 2400, type: "triangle", space: 1.2 });
  }
};
const thud = (at = 0, gain = 0.5) => {
  voice(150, { at, gain, decay: 0.22, slide: 42, space: 0.2 });
  noise({ at, dur: 0.05, gain: 0.12, type: "lowpass", freq: 900 });
};

// A major pentatonic from A2 up; R maps to steps around the middle of it.
const PENTATONIC = [0, 2, 4, 7, 9];
const SCALE = Array.from({ length: 30 }, (_, n) =>
  110 * 2 ** ((Math.floor(n / 5) * 12 + PENTATONIC[n % 5]) / 12));
const CENTER = 13;
const pitchFor = (r) => SCALE[Math.max(0, Math.min(SCALE.length - 1, CENTER + Math.round(r * 2.5)))];

let lastTally = 0;

export const sfx = {
  enter() {
    pad([110, 164.8], 0, 0.05, 1.6);
    [CENTER - 2, CENTER, CENTER + 3, CENTER + 5].forEach((n, i) => pluck(SCALE[n], 0.12 + i * 0.07, 0.1));
  },
  exit() {
    [CENTER + 3, CENTER].forEach((n, i) => pluck(SCALE[n], i * 0.08, 0.08, 1800));
  },
  round() {
    noise({ dur: 0.35, gain: 0.05, type: "bandpass", freq: 600, to: 3200, space: 0.6 });
  },
  // Order ticket submitted: a key-click with weight for a real position, lighter for a pass.
  call(verdict) {
    noise({ dur: 0.012, gain: 0.25, freq: 3000 });
    if (verdict === "pass") voice(330, { gain: 0.08, decay: 0.12, space: 0.2 });
    else thud(0.005, verdict === "like" ? 0.45 : 0.3);
  },
  fill() {
    bell(SCALE[CENTER + 5], 0, 0.1);
    noise({ dur: 0.02, gain: 0.1, freq: 5000 });
  },
  bar(r, live) {
    if (live) pluck(pitchFor(r), 0, 0.14);
    else voice(pitchFor(r) / 2, { gain: 0.05, decay: 0.15, cutoff: 900, space: 0.3 });
  },
  // A quiet session on watch: the setup is still coiled, decide again.
  watch() {
    bell(SCALE[CENTER + 4], 0, 0.08);
    bell(SCALE[CENTER + 7], 0.13, 0.09);
  },
  // Half banked at day 3: a bright double chime.
  partial() {
    bell(SCALE[CENTER + 7], 0, 0.1);
    bell(SCALE[CENTER + 9], 0.1, 0.08);
  },
  // Trailing bars: a soft tick that climbs with the open R.
  trail(r) {
    voice(pitchFor(r), { gain: 0.06, decay: 0.12, cutoff: 2600, type: "triangle", space: 0.4 });
  },
  stop() {
    thud(0, 0.6);
    voice(pitchFor(-1), { gain: 0.1, decay: 0.7, slide: pitchFor(-3), cutoff: 900, type: "sawtooth", space: 0.6 });
  },
  close(r) {
    const top = pitchFor(Math.max(r, 0.5));
    bell(top, 0, 0.11);
    if (r >= 2) bell(top * 1.5, 0.09, 0.07);
  },
  good(big) {
    // Major-nine bloom; bigger wins get a higher voicing.
    const root = big ? 261.6 : 220;
    pad([root, root * 1.26, root * 1.5, root * 1.89, root * 2.24], 0, 0.045, 2.2);
    pluck(root * 3, 0.06, 0.08);
  },
  miss() {
    pad([98, 103.8], 0, 0.06, 0.9);
    thud(0, 0.3);
  },
  neutral() {
    bell(SCALE[CENTER], 0, 0.07);
  },
  streak(n) {
    const steps = Math.min(n, 10);
    for (let i = 0; i < 3; i++) bell(SCALE[CENTER + steps + i * 2], i * 0.08, 0.06);
  },
  tally() {
    const now = performance.now();
    if (now - lastTally < 45) return;
    lastTally = now;
    noise({ dur: 0.008, gain: 0.08, freq: 6000 });
  },
  runEnd(grade) {
    const lift = { S: 7, A: 5, B: 3, C: 1, D: -2 }[grade] ?? 0;
    const notes = grade === "D" ? [CENTER, CENTER - 2, CENTER - 4] : [0, 2, 4, 5, 7].map((n) => CENTER - 2 + n + lift - 3);
    notes.forEach((n, i) => pluck(SCALE[Math.max(0, n)], i * 0.11, 0.12));
    if (grade === "S" || grade === "A") pad([220, 277.2, 329.6, 440], 0.5, 0.05, 2.6);
  },
};

export function toggleMute() {
  muted = !muted;
  store.set("muted", muted);
  return muted;
}

export const isMuted = () => muted;

// ---------- price alerts ----------
// Alerts pick their own sound in Settings → Alerts, so Practice's mute doesn't silence them.

const ALERT_SOUNDS = {
  chime: { label: "Chime", play() {
    bell(SCALE[CENTER + 7], 0, 0.12);
    bell(SCALE[CENTER + 9], 0.15, 0.1);
    bell(SCALE[CENTER + 12], 0.3, 0.09);
  } },
  bell: { label: "Desk bell", play() {
    bell(SCALE[CENTER + 10], 0, 0.16);
    bell(SCALE[CENTER + 10], 0.32, 0.12);
  } },
  ping: { label: "Ping", play() {
    for (const at of [0, 0.13]) voice(1760, { at, gain: 0.12, decay: 0.22, space: 0.3 });
  } },
  pulse: { label: "Pulse", play() {
    for (const at of [0, 0.12, 0.24]) voice(880, { at, gain: 0.1, decay: 0.08, type: "triangle", cutoff: 2600, space: 0.1 });
  } },
  none: { label: "None", play() {} },
};

export const alertSounds = () => Object.entries(ALERT_SOUNDS).map(([key, sound]) => [key, sound.label]);

// `volume` 0-100, on a curve the ear hears as even steps; 70 is the sounds' natural level.
export function playAlertSound(name, volume = 70) {
  forced = true;
  try {
    const c = audio();
    if (!c || !(volume > 0)) return;
    const level = (volume / 70) ** 2;
    out = { dry: c.createGain(), wet: c.createGain() };
    out.dry.gain.value = out.wet.gain.value = level;
    out.dry.connect(dry);
    out.wet.connect(wet);
    (ALERT_SOUNDS[name] || ALERT_SOUNDS.chime).play();
  } finally {
    forced = false;
    out = null;
  }
}

