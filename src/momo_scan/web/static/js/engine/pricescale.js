// A price scale: the price range one pane shows for the series attached to it, and the mapping
// between prices and pixels. Auto-scaled to the bars in view unless you drag it.

export const Mode = { Normal: 0, Logarithmic: 1, Percentage: 2, IndexedTo100: 3 };

export function priceFormatter(format = {}) {
  if (format.type === "custom" && format.formatter) return { format: format.formatter };
  if (format.type === "volume") return { format: formatVolume };
  const precision = format.precision ?? 2;
  const tiny = 0.5 / 10 ** precision;
  return { format: (value) => (Math.abs(value) < tiny ? 0 : value).toFixed(precision) };
}

function formatVolume(value) {
  const sign = value < 0 ? "-" : "";
  const v = Math.abs(value);
  const short = (n) => String(Math.round(n * 100) / 100);
  if (v < 995) return sign + short(v);
  if (v < 999995) return `${sign}${short(v / 1e3)}K`;
  if (v < 999999995) return `${sign}${short(v / 1e6)}M`;
  return `${sign}${short(v / 1e9)}B`;
}

// A round step near `step`: 1, 2, 2.5 or 5 times a power of ten.
function niceStep(step) {
  const magnitude = 10 ** Math.floor(Math.log10(step));
  const r = step / magnitude;
  return magnitude * (r <= 1 ? 1 : r <= 2 ? 2 : r <= 2.5 ? 2.5 : r <= 5 ? 5 : 10);
}

export class PriceScale {
  constructor(id, options = {}) {
    this.id = id;
    this.options = {
      visible: id === "right", autoScale: true, mode: Mode.Normal, invertScale: false,
      scaleMargins: { top: 0.2, bottom: 0.1 }, ...options,
    };
    this.range = null; // { min, max } in scale units (log10 of price in log mode)
    this.height = 0;
    this.series = [];
  }

  get log() { return this.options.mode === Mode.Logarithmic; }
  toUnits(price) { return this.log ? Math.log10(Math.max(price, 1e-12)) : price; }
  fromUnits(units) { return this.log ? 10 ** units : units; }

  applyOptions(options) {
    if (options.mode != null && options.mode !== this.options.mode) this.options.autoScale = true;
    this.options = { ...this.options, ...options, scaleMargins: { ...this.options.scaleMargins, ...options.scaleMargins } };
  }

  // The scale's own labels use its first series' price format.
  formatter() {
    const first = this.series[0];
    return first ? first.formatter() : priceFormatter();
  }

  // Fit the bars between logical indexes `from` and `to`. A range dragged by hand holds until
  // the bars leave it entirely (another symbol loaded), then auto-scaling comes back.
  fit(from, to) {
    let min = Infinity, max = -Infinity;
    for (const series of this.series) {
      const extent = series.extent(from, to);
      if (!extent) continue;
      min = Math.min(min, this.toUnits(extent.min));
      max = Math.max(max, this.toUnits(extent.max));
    }
    if (!this.options.autoScale && this.range) {
      if (min > max || (max >= this.range.min && min <= this.range.max)) return;
      this.options.autoScale = true;
    }
    if (min > max) { this.range = null; return; }
    if (min === max) {
      const pad = Math.abs(min) * 0.005 || 0.5;
      min -= pad;
      max += pad;
    }
    this.range = { min, max };
  }

  // Pixels from the pane's top for a price, and back. Null until the scale has a range.
  coordinate(price) {
    if (!this.range || !this.height) return null;
    const { top, bottom } = this.options.scaleMargins;
    const inner = this.height * (1 - top - bottom);
    let f = (this.toUnits(price) - this.range.min) / (this.range.max - this.range.min);
    if (this.options.invertScale) f = 1 - f;
    return this.height * top + (1 - f) * inner;
  }

  price(y) {
    if (!this.range || !this.height) return null;
    const { top, bottom } = this.options.scaleMargins;
    const inner = this.height * (1 - top - bottom) || 1;
    let f = 1 - (y - this.height * top) / inner;
    if (this.options.invertScale) f = 1 - f;
    return this.fromUnits(this.range.min + f * (this.range.max - this.range.min));
  }

  // Scale units per pixel, for dragging.
  unitsPerPixel() {
    const { top, bottom } = this.options.scaleMargins;
    const inner = this.height * (1 - top - bottom) || 1;
    return this.range ? (this.range.max - this.range.min) / inner : 0;
  }

  // Prices for grid lines and labels at least `gap` px apart, top to bottom.
  ticks(gap) {
    if (!this.range || this.height < gap) return [];
    const a = this.price(0), b = this.price(this.height);
    const [low, high] = a < b ? [a, b] : [b, a];
    const count = this.height / gap;
    const out = [];
    if (!this.log) {
      const step = niceStep((high - low) / count);
      for (let p = Math.ceil(low / step) * step; p <= high; p += step) out.push(Math.round(p / step) * step);
    } else {
      const l = this.toUnits(low), h = this.toUnits(high);
      const step = (h - l) / count;
      let last = null;
      for (let u = Math.ceil(l / step) * step; u <= h; u += step) {
        const price = 10 ** u;
        const round = niceStep(price / 20);
        const value = Math.round(price / round) * round;
        if (value !== last && value > 0) out.push(value);
        last = value;
      }
    }
    return out;
  }
}
