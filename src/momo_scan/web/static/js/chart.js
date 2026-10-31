import { $, api, escapeHtml, fmtBig, fmtPct, fmtPrice, narrow, store, ticker } from "./util.js";
import { state, throughDate } from "./state.js";
import { chartProfile, openChartSettings, removeIndicator, toggleIndicator, useChartProfile } from "./chartsettings.js";
import { INDICATORS, ema, shownOn, sma } from "./indicators.js";
import { formatColor, parseColor } from "./colorpicker.js";
import { CHART_BARS, DECK_BARS, fetchBars, inRegular, isIntraday, prefetchNeighbors, series, showLive } from "./feed.js";
import { extendedQuote, marketSession, onLiveQuotes, onSessionChange, watchBuzz } from "./live.js";
import { createEarnings, dayOf, previousSession, sessionsBetween, todayET } from "./earnings.js";
import * as LC from "./engine/index.js";

// Styling and indicators come from the chart settings (⚙ → Chart settings, or ƒx).
const BENCHMARK = "AMEX:SPY"; // for the relative strength line
const visibleBars = () => narrow() ? 90 : 190;
// The zoom you set by hand (bar spacing, per timeframe) carries to every chart in Chart and Daily
// review mode. Practice ignores it and always starts from the default view.
const savedZoom = (interval) => store.get("zoom", {})[interval] || null;
const saveZoom = (interval, spacing) => store.set("zoom", { ...store.get("zoom", {}), [interval]: spacing });
const forgetZoom = (interval) => {
  const { [interval]: _, ...rest } = store.get("zoom", {});
  store.set("zoom", rest);
};
const LEVEL_STYLES = {
  trigger: { lineWidth: 2, lineStyle: LC.LineStyle.Solid },
  early: { lineWidth: 1, lineStyle: LC.LineStyle.Dashed },
  overhead: { lineWidth: 1, lineStyle: LC.LineStyle.Dotted },
};
const OWN_PANE_MARGINS = { top: 0.1, bottom: 0.1 };
// The weekday after a "YYYY-MM-DD" day (holidays aside): where the ghost candle goes.
function nextWeekday(day) {
  const date = new Date(`${day}T12:00:00Z`);
  do date.setUTCDate(date.getUTCDate() + 1); while (date.getUTCDay() === 0 || date.getUTCDay() === 6);
  return date.toISOString().slice(0, 10);
}
const SESSION_SHADE = "rgba(120, 123, 134, 0.10)"; // behind pre- and post-market bars

// Bar Replay: the last bar on or before the replay day (a day's bar, the week or month it falls
// in, or that day's last intraday bar).
const cutIndex = (bars, day) => bars.findLastIndex((bar) => dayOf(bar.time) <= day);
// History loads through a while past the replay day, so stepping needs no request; the chart
// loads again as it nears the end. Intraday charts load what the store has.
const REPLAY_AHEAD_DAYS = { D: 370, W: 3 * 365, M: 10 * 365 };
export function replayThrough(day, interval) {
  const ahead = REPLAY_AHEAD_DAYS[interval.slice(-1)];
  if (!ahead) return null;
  const until = new Date(Date.parse(`${day}T12:00:00Z`) + ahead * 86400000).toISOString().slice(0, 10);
  return until >= todayET() ? null : until;
}

// Hooks for the rest of the app, run for whichever chart redraws or loads.
const renderHooks = []; // run on every redraw (scroll, zoom, resize, new bars)
const crosshairHooks = []; // fn(pane, { time, price } or null) as the pointer moves over a chart
const loadHooks = []; // run when a chart loads
const fundamentalsHooks = []; // fundamentals can arrive after bars paint
export const onChartRender = (fn) => renderHooks.push(fn);
export const onChartLoad = (fn) => loadHooks.push(fn);
export const onFundamentalsLoad = (fn) => fundamentalsHooks.push(fn);
export const onCrosshair = (fn) => crosshairHooks.push(fn);

// One chart: its series, indicators, legends, handles and callouts, inside `root` (a chart area
// whose parts carry data-part attributes). `owner` names its live symbol to the feed; `settings`
// is its own settings profile; `info` shows the info table (the left chart only, in split view).
function createPane(root, { side, owner, settings, info = true }) {
  const el = Object.fromEntries([...root.querySelectorAll("[data-part]")].map((node) => [node.dataset.part, node]));
  const S = settings.S; // replaced in place, never swapped, so this stays current
  let loadToken = 0;
  let pane = null; // this chart's handle, given to hooks

  const chart = LC.createChart(el["chart"], {
    autoSize: true,
    layout: { attributionLogo: false, panes: { enableResize: true } },
    crosshair: { mode: LC.CrosshairMode.Normal },
    rightPriceScale: { borderVisible: false },
    timeScale: { borderVisible: false, minBarSpacing: 1, rightBarStaysOnScroll: true }, // zoom anchors the latest bar, like TradingView
  });

  // Intraday with extended hours: pre- and post-market bars sit on a faint band. A full-height
  // histogram on its own hidden scale, added first so it stays behind everything.
  const sessions = chart.addSeries(LC.HistogramSeries, {
    priceScaleId: "sessions", priceLineVisible: false, lastValueVisible: false, crosshairMarkerVisible: false,
    columnWidth: 1, // a solid band, no gaps between bars
  }, 0);
  sessions.priceScale().applyOptions({ visible: false, scaleMargins: { top: 0, bottom: 0 } });
  const shade = (bar) => ({ time: bar.time, value: 1, color: inRegular(bar.time) ? "rgba(0, 0, 0, 0)" : SESSION_SHADE });
  let candles = chart.addSeries(S.candles.style === "bars" ? LC.BarSeries : LC.CandlestickSeries, {
    priceLineStyle: LC.LineStyle.Dotted, priceLineVisible: state.lines.lastPrice,
  }, 0);
  // The ghost candle: today's pre- or post-market so far, in the slot after the last daily bar.
  const ghost = chart.addSeries(LC.CandlestickSeries, {
    priceLineVisible: false, lastValueVisible: false, borderVisible: true,
  }, 0);
  const watermark = LC.createTextWatermark(chart.panes()[0], {
    horzAlign: "center", vertAlign: "center", lines: [{ text: "", color: "transparent", fontSize: 110 }],
  });
  let volume = null;
  let volumeAverage = null;
  let plots = []; // one per drawn line: { series, ind, def, plot, values }
  let levelSets = []; // one per "levels" indicator: { ind, def, result, series }
  let paneKeys = ["price"]; // what each pane holds: "price", "volume" or an indicator id
  let priceLines = [];
  let fullBars = []; // every bar loaded for the chart
  let currentBars = []; // the bars shown so far (fewer during a replay)
  let realBars = []; // the bars as loaded; Bar Replay may swap the last one shown for a part-period
  let lastData = null; // the loaded series' payload
  let replayInfo = null; // Bar Replay: the daily series through the replay day (ADR, $ volume)
  let volumeAvg = [];
  let benchmark = { key: null, bars: [] };
  let chartInfo = {};
  let lastCard = null;
  let currentThrough = null; // the date the chart's bars run through
  let currentRequest = { interval: "1D", count: 520 };
  let view = {}; // per-call options: { through, anonymous, lines, markers }
  let unsubscribe = null; // from the live series on screen
  const earnings = createEarnings(root, chart, () => ({
    ...chartContext(),
    allowed: state.mode === "chart" && !view.anonymous && (!view.replayFrom || view.replay),
    enabled: S.indicators.some((ind) => ind.type === "earnings" && drawn(ind)),
  }));

  // Pre- and post-market: the last extended-hours trade, as a tag on the price scale, a line
  // and a chip in the legend (each optional, in Chart settings → Symbol). Only on live charts
  // whose candles stop at the regular session (daily and up, or intraday with extended hours
  // off); an extended intraday chart has it as a candle.
  let extTicker = null;
  let extDaily = false; // the ghost candle is for daily charts
  let extQuote = null;
  let extLine = null;
  let ghostBar = null; // the session so far from the server: { open, high, low, close }
  let ghostTimer = 0;
  let ghostFade = 1; // 0 to 1 as the candle fades in
  let ghostFrame = 0;
  let ghostShown = false;
  const extNow = () => {
    const ext = extTicker ? extendedQuote(extQuote) : null;
    if (!ext) return null;
    const session = marketSession() === "pre" ? "pre" : "post";
    return { ...ext, session, color: S.extended[session], title: session === "pre" ? "Pre" : "Post" };
  };
  const extChip = (ext) => (ext && S.extended.chip
    ? `<i class="dot" style="background:${ext.color}"></i>${ext.title} ${fmtPrice(ext.price)} ` +
      `<span class="${ext.pct >= 0 ? "up" : "down"}">${fmtPct(ext.pct)}</span>` : "");
  function drawExtended() {
    const ext = extNow();
    const chip = el["legend-title"].querySelector(".ext-chip");
    if (chip) {
      chip.innerHTML = extChip(ext);
      chip.style.borderColor = ext ? ext.color : "";
      chip.hidden = !chip.innerHTML;
    }
    drawGhost(ext);
    const E = S.extended;
    if (!ext || (!E.tag && !E.line)) {
      if (extLine) candles.removePriceLine(extLine);
      extLine = null;
      return;
    }
    const line = {
      price: ext.price, color: ext.color, lineVisible: E.line, lineStyle: Number(E.lineStyle),
      lineWidth: Number(E.lineWidth), axisLabelVisible: E.tag, title: E.tag ? ext.title : "",
    };
    if (extLine) extLine.applyOptions(line);
    else extLine = candles.createPriceLine(line);
  }
  // Ghost candle: from the regular session's last price (the body's far end) to the latest
  // extended-hours trade, its wicks at the session's high and low. Hollow and faint, so it never
  // passes for a real bar.
  function drawGhost(ext) {
    const last = currentBars[currentBars.length - 1];
    if (!ext || !extDaily || !S.extended.ghost || !last || !extQuote) {
      cancelAnimationFrame(ghostFrame);
      ghostShown = false;
      return ghost.setData([]);
    }
    const open = extQuote.last;
    const close = ext.price;
    const stored = ghostBar && ghostBar.session === ext.session ? ghostBar : null;
    const high = Math.max(open, close, stored ? stored.high : close);
    const low = Math.min(open, close, stored ? stored.low : close);
    if (stored) Object.assign(stored, { high: Math.max(stored.high, close), low: Math.min(stored.low, close) });
    if (!ghostShown) { // it appears after the chart has loaded: fade it in rather than pop
      ghostShown = true;
      ghostFade = 0;
      fadeGhost(performance.now());
    }
    paintGhost();
    ghost.setData([{ time: nextWeekday(last.time), open, high, low, close }]);
  }
  function paintGhost() {
    const { hex, alpha } = parseColor(S.extended.ghostColor);
    const line = formatColor(hex, alpha * ghostFade);
    const fill = formatColor(hex, alpha * 0.18 * ghostFade);
    ghost.applyOptions({ upColor: fill, downColor: fill, borderUpColor: line, borderDownColor: line, wickUpColor: line, wickDownColor: line });
  }
  function fadeGhost(start) {
    cancelAnimationFrame(ghostFrame);
    ghostFrame = requestAnimationFrame((now) => {
      ghostFade = Math.min(1, (now - start) / 450);
      paintGhost();
      if (ghostFade < 1) fadeGhost(start);
    });
  }
  async function loadGhost() {
    clearTimeout(ghostTimer);
    if (!extTicker || !extDaily || !S.extended.ghost || !marketSession() || marketSession() === "regular") return;
    const symbol = extTicker;
    try {
      const { bar } = await api(`/api/extended?symbol=${encodeURIComponent(symbol)}`);
      if (symbol !== extTicker) return;
      ghostBar = bar;
      drawGhost(extNow());
    } catch {}
    ghostTimer = setTimeout(loadGhost, 60_000); // the stream keeps the store current: no requests
  }
  function watchExtended(ticker, daily = false) {
    extTicker = ticker;
    extDaily = daily;
    extQuote = null;
    ghostBar = null;
    // The ghost's high and low come from the symbol's minute bars, streamed into the store.
    watchBuzz(`ghost-${owner}`, ticker && daily && S.extended.ghost ? [ticker] : []);
    drawExtended();
    loadGhost();
  }
  onLiveQuotes((quotes) => {
    if (!extTicker || !quotes.has(extTicker)) return;
    extQuote = quotes.get(extTicker);
    drawExtended();
  });
  onSessionChange(() => {
    ghostBar = null;
    drawExtended();
    loadGhost();
  });

  const up = () => S.candles.up;
  const down = () => S.candles.down;

  function rgba(color, opacity) {
    const { hex, alpha } = parseColor(color);
    return formatColor(hex, alpha * opacity);
  }

  // ---------- style ----------

  function applyStyle() {
    const area = root;
    area.classList.toggle("ind-no-titles", !S.status.titles);
    area.classList.toggle("ind-no-values", !S.status.values);
    area.classList.toggle("ind-collapsed", S.status.collapsed);
    const c = S.canvas;
    const k = S.candles;
    const hollow = k.style === "hollow";
    chart.applyOptions({
      layout: {
        background: c.background === "gradient"
          ? { type: LC.ColorType.VerticalGradient, topColor: c.color, bottomColor: c.color2 }
          : { type: LC.ColorType.Solid, color: c.color },
        textColor: c.text, fontSize: c.fontSize,
        panes: { separatorColor: c.separator, separatorHoverColor: c.separator },
      },
      grid: {
        vertLines: { visible: c.gridV, color: c.gridColor },
        horzLines: { visible: c.gridH, color: c.gridColor },
      },
      crosshair: {
        mode: c.magnet ? LC.CrosshairMode.Magnet : LC.CrosshairMode.Normal,
        vertLine: { color: c.crosshair, style: c.crosshairStyle, labelBackgroundColor: "#2a2e39" },
        horzLine: { color: c.crosshair, style: c.crosshairStyle, labelBackgroundColor: "#2a2e39" },
      },
      timeScale: { rightOffset: S.scale.rightOffset },
    });
    candles.applyOptions(k.style === "bars" ? {
      upColor: k.up, downColor: k.down, openVisible: true, thinBars: true,
    } : {
      upColor: hollow ? "rgba(0, 0, 0, 0)" : k.up, downColor: k.down,
      borderVisible: hollow || k.borders,
      borderUpColor: k.borders ? k.borderUp : k.up, borderDownColor: k.borders ? k.borderDown : k.down,
      wickUpColor: k.wickUp, wickDownColor: k.wickDown,
    });
    candles.priceScale().applyOptions({
      mode: S.scale.log ? LC.PriceScaleMode.Logarithmic : LC.PriceScaleMode.Normal,
      invertScale: S.scale.invert,
    });
    root.style.setProperty("--chart-text", c.text);
    root.style.setProperty("--chart-bg", c.color);
    setWatermark();
    applyMargins();
    applyLevels(lastCard);
    if (volume) volume.setData(currentBars.map(volumeBar));
    renderLegend(null);
    scheduleCallouts();
  }

  function setWatermark() {
    const c = S.canvas;
    const text = view.anonymous || !c.watermark ? "" : chartInfo.ticker || "";
    watermark.applyOptions({ lines: [{ text, color: rgba(c.watermarkColor, c.watermarkOpacity / 100), fontSize: 110 }] });
  }

  const marginsFor = (key) => S.margins[key] || OWN_PANE_MARGINS;

  // The series whose price scale holds each pane's margins.
  function paneSeries(n) {
    const key = paneKeys[n];
    if (key === "price") return candles;
    if (key === "volume") return volume;
    const plot = plots.find((item) => item.ind.id === key);
    return plot && plot.series;
  }

  function applyMargins() {
    paneKeys.forEach((key, n) => {
      const series = paneSeries(n);
      if (series) series.priceScale().applyOptions({ scaleMargins: { ...marginsFor(key) } });
    });
  }

  // ---------- series ----------

  // Dollar volume (shares × close) by default, like TC2000; plain share volume in settings.
  const vol = (b) => (S.volume.dollar ? b.volume * b.close : b.volume);
  const fmtVol = (v) => fmtBig(v, S.volume.dollar ? "$" : "");
  const volumeFormat = () => (S.volume.dollar
    ? { type: "custom", minMove: 1, formatter: (v) => fmtVol(v).replace(/\.00(?=[KMBT]?$)/, "") }
    : { type: "volume" });
  const volumeBar = (b) => ({ time: b.time, value: vol(b), color: b.close >= b.open ? S.volume.up : S.volume.down });
  const candle = ({ time, open, high, low, close }) => ({ time, open, high, low, close });

  function point(item, i) {
    const value = item.values[i];
    const time = fullBars[i].time;
    if (value == null) return { time };
    if (item.plot.type === "histogram") {
      const style = item.ind.style[item.plot.key];
      return { time, value, color: value >= 0 ? style.color : style.color2 };
    }
    return { time, value };
  }

  const volumeAvgPoint = (i) => volumeAvg[i] == null ? { time: fullBars[i].time } : { time: fullBars[i].time, value: volumeAvg[i] };
  // An indicator is drawn when it's on and not turned off for this timeframe. One turned off
  // for it isn't computed or drawn at all.
  const drawn = (ind, interval = currentRequest.interval) => ind.visible && shownOn(ind, interval) &&
    (!INDICATORS[ind.type].chartOnly || (state.mode === "chart" && !view.anonymous));
  const drawnKey = (interval) => S.indicators.filter((ind) => drawn(ind, interval)).map((ind) => ind.id).join();
  let builtKey = null; // which indicators the series were built for
  const needsBenchmark = (interval = currentRequest.interval) =>
    S.indicators.some((item) => drawn(item, interval) && INDICATORS[item.type].benchmark);

  // Tear down and re-add volume and every indicator, in settings order.
  function rebuildSeries() {
    // Keep the shared price-series handle current for live bars, drawings and price lines.
    const type = S.candles.style === "bars" ? "Bar" : "Candlestick";
    if (candles.seriesType() !== type) {
      const previous = candles;
      const { priceLineVisible, priceLineStyle } = previous.options();
      const order = previous.seriesOrder();
      candles = chart.addSeries(type === "Bar" ? LC.BarSeries : LC.CandlestickSeries, {
        priceLineVisible, priceLineStyle,
      }, 0);
      // Populate first so removing the old series cannot change the chart's time points.
      candles.setData(currentBars.map(candle));
      chart.removeSeries(previous);
      candles.setSeriesOrder(order);
      priceLines = [];
      alertLines = [];
      extLine = null;
      drawAlertLines();
    }
    builtKey = drawnKey(currentRequest.interval);
    for (const item of plots) chart.removeSeries(item.series);
    for (const set of levelSets) for (const series of set.series) chart.removeSeries(series);
    if (volume) chart.removeSeries(volume);
    if (volumeAverage) chart.removeSeries(volumeAverage);
    volume = volumeAverage = null;
    plots = [];
    levelSets = [];
    paneKeys = ["price"];
    while (chart.panes().length > 1) chart.removePane(chart.panes().length - 1);

    if (S.volume.visible) {
      volume = chart.addSeries(LC.HistogramSeries, { priceFormat: volumeFormat(), priceLineVisible: false }, 1);
      volumeAverage = chart.addSeries(LC.LineSeries, {
        color: S.volume.averageColor, lineWidth: 1, priceLineVisible: false, lastValueVisible: false,
        crosshairMarkerVisible: false, priceFormat: volumeFormat(), visible: S.volume.average,
      }, 1);
      paneKeys.push("volume");
    }
    for (const ind of S.indicators) {
      if (!drawn(ind)) continue;
      const def = INDICATORS[ind.type];
      if (def.kind === "events") continue;
      if (def.kind === "levels") { levelSets.push({ ind, def, result: null, series: [] }); continue; }
      const own = def.pane === "own";
      const pane = own ? paneKeys.length : 0;
      const first = plots.length;
      for (const plot of def.plots) {
        const style = ind.style[plot.key];
        const common = {
          priceLineVisible: false, lastValueVisible: own, priceFormat: { type: "price", precision: 2, minMove: 0.01 },
          // Overlays on the price pane (SMAs etc.) don't stretch the scale: the price bars set the margins.
          ...(own ? {} : { autoscaleInfoProvider: () => null }),
        };
        const series = plot.type === "histogram"
          ? chart.addSeries(LC.HistogramSeries, common, pane)
          : chart.addSeries(LC.LineSeries, {
            ...common, color: style.color, lineWidth: style.width, crosshairMarkerVisible: false,
          }, pane);
        plots.push({ series, ind, def, plot, values: [] });
      }
      if (own) {
        for (const level of def.levels || []) {
          plots[first].series.createPriceLine({
            price: level, color: "#787b86", lineWidth: 1, lineStyle: LC.LineStyle.Dashed, axisLabelVisible: false,
          });
        }
        paneKeys.push(ind.id);
      }
    }
    chart.panes().forEach((pane, n) => pane.setStretchFactor(n === 0 ? 5 : paneKeys[n] === "volume" ? 1 : 1.3));
    computeSeries();
    fillSeries();
    applyMargins();
    buildLegend();
    layoutOverlays();
    earnings.render();
  }

  function computeSeries() {
    if (!fullBars.length) return;
    const ctx = { benchmark: benchmark.bars };
    const results = new Map();
    for (const item of plots) {
      if (!results.has(item.ind.id)) results.set(item.ind.id, item.def.compute(fullBars, item.ind.params, ctx));
      item.values = results.get(item.ind.id)[item.plot.key];
    }
    for (const set of levelSets) set.result = set.def.compute(fullBars, set.ind.params, ctx);
    volumeAvg = (S.volume.ema ? ema : sma)(fullBars.map(vol), S.volume.period);
  }

  // Show everything up to the bars currently on the chart.
  function fillSeries() {
    const n = currentBars.length;
    const range = [...Array(n).keys()];
    for (const item of plots) item.series.setData(range.map((i) => point(item, i)));
    drawLevels(n);
    if (volume) {
      volume.setData(currentBars.map(volumeBar));
      volumeAverage.setData(range.map(volumeAvgPoint));
    }
  }

  // Horizontal levels (HVC) run from their bar to the last bar shown. Which levels show depends on
  // the last close, so they are picked again for every bar a replay adds.
  function drawLevels(n) {
    for (const set of levelSets) {
      for (const series of set.series) chart.removeSeries(series);
      set.series = [];
      if (!set.result || !n) continue;
      const end = fullBars[n - 1].time;
      for (const level of set.def.lines(fullBars, set.result, set.ind.params, n)) {
        const style = set.ind.style[level.major ? "major" : "minor"];
        const series = chart.addSeries(LC.LineSeries, {
          color: style.color, lineWidth: level.major ? style.width : 1,
          lineStyle: level.major ? LC.LineStyle.Solid : LC.LineStyle.LargeDashed,
          priceLineVisible: false, lastValueVisible: level.major, crosshairMarkerVisible: false,
          priceFormat: { type: "price", precision: 2, minMove: 0.01 }, autoscaleInfoProvider: () => null,
        }, 0);
        const start = fullBars[level.i].time;
        series.setData([{ time: start, value: level.price }, ...(start === end ? [] : [{ time: end, value: level.price }])]);
        set.series.push(series);
      }
    }
  }

  async function loadBenchmark(through, interval, count) {
    if (!needsBenchmark(interval)) return;
    const key = `${through}|${interval}|${count}`;
    if (benchmark.key === key && benchmark.bars.length) return;
    try {
      const data = await fetchBars(BENCHMARK, through, interval, count);
      benchmark = { key, bars: data.bars };
    } catch {
      benchmark = { key, bars: [] };
    }
  }

  settings.on(async (what) => {
    let range;
    if (what === "series") {
      if (needsBenchmark()) {
        const token = loadToken;
        await loadBenchmark(currentThrough, currentRequest.interval, currentRequest.count);
        if (token !== loadToken) return;
      }
      range = chart.timeScale().getVisibleLogicalRange();
      rebuildSeries();
    }
    range ||= chart.timeScale().getVisibleLogicalRange();
    applyStyle();
    renderLegend(null);
    earnings.render();
    if (extTicker) watchExtended(extTicker, extDaily); // the ghost may have been switched
    if (S.scale.rightOffset !== shownOffset && currentBars.length) {
      shownOffset = S.scale.rightOffset;
      setRightOffset(shownOffset);
    } else if (range) {
      chart.timeScale().setVisibleLogicalRange(range);
    }
  });
  let shownOffset = S.scale.rightOffset;

  // ---------- legends ----------
  // The price legend lists the overlays; each own pane (and volume) gets a legend at its top.
  // Rows carry TradingView-style buttons: hide, settings, remove.

  const tools = (id, removable = true) =>
    `<span class="lg-tools"><button data-lg="toggle" data-id="${id}" title="Hide">◉</button>` +
    `<button data-lg="edit" data-id="${id}" title="Settings">⚙</button>` +
    (removable ? `<button data-lg="remove" data-id="${id}" title="Remove">×</button>` : "") + `</span>`;

  function legendRow(ind) {
    const def = INDICATORS[ind.type];
    const shown = def.kind === "levels" ? [{ key: def.value, color: ind.style[def.plots[0].key].color }]
      : def.plots.map((plot) => ({ key: plot.key, color: ind.style[plot.key].color }));
    const values = ind.visible
      ? shown.map((plot) => `<span class="v" data-ind="${ind.id}" data-plot="${plot.key}" style="color:${plot.color}"></span>`).join("")
      : "";
    return `<div class="lg-row ${ind.visible ? "" : "off"}${def.chartOnly ? " chart-only" : ""}"><span class="label">${escapeHtml(def.label(ind.params))}</span>${values}${tools(ind.id)}</div>`;
  }

  // TradingView's arrow under the price legend: hide the indicator rows, or show how many there are.
  const CHEVRON = '<svg viewBox="0 0 12 12" width="12" height="12" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M3 7.5L6 4.5l3 3"/></svg>';

  function buildLegend() {
    // Indicators turned off for this timeframe leave the legend too, as on TradingView.
    const rows = S.indicators.filter((ind) => shownOn(ind, currentRequest.interval) &&
      (!INDICATORS[ind.type].chartOnly || (state.mode === "chart" && !view.anonymous)) &&
      (INDICATORS[ind.type].pane === "price" || !ind.visible));
    el["legend-ma"].innerHTML = rows.length
      ? `<div class="lg-rows">${rows.map(legendRow).join("")}</div>` +
        `<button class="lg-collapse" data-lg="collapse" title="Hide or show the indicator legend">` +
        `${CHEVRON}<span>${rows.length}</span></button>`
      : "";
    el["pane-legends"].innerHTML = paneKeys.slice(1).map((key) => {
      if (key === "volume") {
        return `<div class="pane-legend" data-pane="volume"><div class="lg-row"><span class="vol-values"></span>${tools("volume", false)}</div></div>`;
      }
      const ind = S.indicators.find((item) => item.id === key);
      return `<div class="pane-legend" data-pane="${key}">${legendRow(ind)}</div>`;
    }).join("");
    renderLegend(null);
  }

  function formatValue(def, value) {
    if (value == null) return "—";
    return def.format ? def.format(value) : def.pane === "price" ? fmtPrice(value) : value.toFixed(2);
  }

  function renderLegend(index) {
    const bars = currentBars;
    if (!bars.length) return;
    const i = index == null || index < 0 || index >= bars.length ? bars.length - 1 : index;
    const bar = bars[i];
    const prev = i > 0 ? bars[i - 1].close : bar.open;
    const change = bar.close - prev;
    const color = change >= 0 ? up() : down();
    const ohlc = [
      `<span class="ohlc" style="color:${color}">`,
      `<b>O</b>${fmtPrice(bar.open)} <b>H</b>${fmtPrice(bar.high)} <b>L</b>${fmtPrice(bar.low)} <b>C</b>${fmtPrice(bar.close)} `,
      `${change >= 0 ? "+" : ""}${fmtPrice(change)} (${fmtPct((change / prev) * 100)})</span>`,
    ];
    const ext = extNow();
    const chip = extChip(ext);
    ohlc.push(`<span class="ext-chip"${ext ? ` style="border-color:${ext.color}"` : ""}${chip ? "" : " hidden"}>${chip}</span>`);
    ohlc.push(earnings.pill());
    const parts = view.anonymous ? [`<span class="sym">Practice setup</span>`, ...ohlc] : [
      `<span class="sym">${chartInfo.ticker}</span>`,
      chartInfo.company ? `<span class="co"> · ${escapeHtml(chartInfo.company)}</span>` : "",
      ` · ${currentRequest.interval} · ${chartInfo.exchange || ""}`,
      ...ohlc,
    ];
    el["legend-title"].innerHTML = parts.join("");
    for (const node of root.querySelectorAll('[data-part="legend"] .v, [data-part="pane-legends"] .v')) {
      const item = plots.find((p) => p.ind.id === node.dataset.ind && p.plot.key === node.dataset.plot);
      const set = !item && levelSets.find((s) => s.ind.id === node.dataset.ind);
      node.textContent = item ? formatValue(item.def, item.values[i])
        : set && set.result ? formatValue(set.def, set.result[node.dataset.plot][i]) : "";
    }
    const volLegend = el["pane-legends"].querySelector(".vol-values");
    if (volLegend) {
      const avg = volumeAvg[i];
      volLegend.innerHTML =
        `${S.volume.dollar ? "$ Vol" : "Vol"} <span style="color:${bar.close >= bar.open ? S.volume.up : S.volume.down}">${fmtVol(vol(bar))}</span>` +
        (S.volume.average ? ` <span class="muted">· ${S.volume.ema ? "EMA" : "SMA"} ${S.volume.period}</span> ${fmtVol(avg)}` +
          (avg ? ` <span class="muted">· RVOL</span> ${(vol(bar) / avg).toFixed(2)}x` : "") : "");
    }
  }

  let echoing = false; // showing another chart's crosshair: don't send it back
  // The chart re-reports its crosshair on every live tick. One the pointer isn't over is showing
  // the other chart's crosshair (snapped to its own bars); sending that back would pull the
  // pointer's chart to its last bar whenever the mouse rests past it.
  let pointerOver = false;
  root.addEventListener("pointerenter", () => { pointerOver = true; });
  root.addEventListener("pointerleave", () => { pointerOver = false; });
  chart.subscribeCrosshairMove((param) => {
    if (echoing || (param.point && !pointerOver)) return;
    const hovering = param && param.logical != null && currentBars.length;
    renderLegend(hovering ? Math.round(param.logical) : null);
    const bar = hovering ? currentBars[Math.max(0, Math.min(currentBars.length - 1, Math.round(param.logical)))] : null;
    const price = bar && param.point ? candles.coordinateToPrice(param.point.y) : null;
    for (const fn of crosshairHooks) fn(pane, bar ? { time: bar.time, price, symbol: lastShown.symbol } : null);
  });

  // Another chart's crosshair, at the bar here that holds its moment: a daily bar shows on an
  // intraday chart at that day's last bar, an intraday time on a daily chart at its day.
  function echoCrosshair(at) {
    if (!at || !currentBars.length) {
      chart.clearCrosshairPosition();
      return renderLegend(null);
    }
    const intraday = typeof currentBars[0].time === "number";
    const time = intraday
      ? (typeof at.time === "number" ? at.time : Date.parse(`${at.time}T16:00:00Z`) / 1000 - 1)
      : (typeof at.time === "number" ? new Date(at.time * 1000).toISOString().slice(0, 10) : at.time);
    if (time < currentBars[0].time) return chart.clearCrosshairPosition();
    let lo = 0;
    let hi = currentBars.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (currentBars[mid].time <= time) lo = mid;
      else hi = mid - 1;
    }
    const bar = currentBars[lo];
    echoing = true;
    // The same price only means something on the same stock; otherwise this bar's close.
    const price = at.symbol === lastShown.symbol && at.price != null ? at.price : bar.close;
    chart.setCrosshairPosition(price, bar.time, candles);
    echoing = false;
    renderLegend(lo);
  }

  function onLegendClick(event) {
    const button = event.target.closest("button[data-lg]");
    if (!button) return;
    event.stopPropagation();
    const { lg, id } = button.dataset;
    activate(side); // the indicator commands and dialog act on the active chart
    if (lg === "collapse") return settings.change((s) => { s.status.collapsed = !s.status.collapsed; }, "series");
    if (id === "volume") {
      if (lg === "toggle") settings.change((s) => { s.volume.visible = false; }, "series");
      else openChartSettings("symbol");
      return;
    }
    if (lg === "toggle") toggleIndicator(id);
    else if (lg === "remove") removeIndicator(id);
    else openChartSettings("indicators", id);
  }
  el["legend"].addEventListener("click", onLegendClick);
  el["pane-legends"].addEventListener("click", onLegendClick);

  // ---------- pane overlays: legends and margin handles ----------
  // TC2000-style margin handles: two small triangles on each pane's price axis mark where the
  // highest and lowest bars sit. Drag them to give the chart more or less room above and below.

  function paneBoxes() {
    const area = root.getBoundingClientRect();
    let top = 0;
    return chart.panes().map((pane) => {
      const el = pane.getHTMLElement && pane.getHTMLElement();
      if (el) {
        const rect = el.getBoundingClientRect();
        return { top: rect.top - area.top, height: rect.height };
      }
      const box = { top, height: pane.getHeight() };
      top += box.height + 1;
      return box;
    });
  }

  function layoutOverlays() {
    const boxes = paneBoxes();
    for (const node of el["pane-legends"].children) {
      const n = paneKeys.indexOf(node.dataset.pane);
      if (n < 1 || !boxes[n]) { node.hidden = true; continue; }
      node.hidden = false;
      node.style.top = `${boxes[n].top + 4}px`;
    }
    const layer = el["margin-handles"];
    if (!S.scale.handles || !currentBars.length) { layer.innerHTML = ""; return; }
    const axis = chart.priceScale("right").width();
    const left = root.clientWidth - axis;
    if (layer.childElementCount !== paneKeys.length * 2 + 1) {
      layer.innerHTML = paneKeys.map((key, n) =>
        `<div class="mh top" data-n="${n}" data-edge="top"></div><div class="mh bottom" data-n="${n}" data-edge="bottom"></div>`).join("") +
        `<div class="rh"></div>`;
    }
    placeRightHandle(layer.lastElementChild, boxes, left);
    for (const node of layer.querySelectorAll(".mh")) {
      const n = Number(node.dataset.n);
      const box = boxes[n];
      if (!box) continue;
      const margins = marginsFor(paneKeys[n]);
      // Keep each handle inside its pane so a margin dragged to zero can still be grabbed.
      const y = node.dataset.edge === "top"
        ? Math.max(box.top + 12, box.top + margins.top * box.height)
        : Math.min(box.top + box.height - 12, box.top + (1 - margins.bottom) * box.height);
      node.style.left = `${left}px`;
      node.style.top = `${y}px`;
      node.title = `${node.dataset.edge === "top" ? "Top" : "Bottom"} margin ${Math.round(margins[node.dataset.edge] * 100)}% · drag to adjust`;
    }
  }

  // The right-margin handle sits on the time axis under the last bar. Drag it sideways to set the
  // empty space between the last bar and the price axis.
  function placeRightHandle(node, boxes, plotWidth) {
    const last = boxes[boxes.length - 1];
    const x = chart.timeScale().logicalToCoordinate(currentBars.length - 1);
    node.hidden = x == null || x < 0 || x > plotWidth;
    if (node.hidden) return;
    node.style.left = `${x}px`;
    node.style.top = `${last.top + last.height + 1}px`;
    node.title = `Right margin ${S.scale.rightOffset} bars · drag to adjust`;
  }

  function setRightOffset(offset) {
    const range = chart.timeScale().getVisibleLogicalRange();
    if (!range) return;
    const to = currentBars.length - 1 + offset;
    chart.timeScale().setVisibleLogicalRange({ from: to - (range.to - range.from), to });
  }

  function rightOffsetNow() {
    const range = chart.timeScale().getVisibleLogicalRange();
    return Math.max(0, Math.round((range?.to ?? currentBars.length - 1) - (currentBars.length - 1)));
  }

  function dragRightHandle(event, handle) {
    handle.setPointerCapture(event.pointerId);
    handle.classList.add("drag");
    root.classList.add("offset-drag");
    const move = (e) => {
      const plotWidth = root.clientWidth - chart.priceScale("right").width();
      const x = e.clientX - root.getBoundingClientRect().left;
      const offset = Math.max(0, Math.min(500, (plotWidth - x) / chart.timeScale().options().barSpacing));
      setRightOffset(offset);
      scheduleCallouts();
    };
    const done = () => {
      handle.removeEventListener("pointermove", move);
      handle.classList.remove("drag");
      root.classList.remove("offset-drag");
      shownOffset = rightOffsetNow();
      settings.change((s) => { s.scale.rightOffset = shownOffset; });
    };
    handle.addEventListener("pointermove", move);
    handle.addEventListener("pointerup", done, { once: true });
    handle.addEventListener("pointercancel", done, { once: true });
  }

  el["margin-handles"].addEventListener("pointerdown", (event) => {
    const right = event.target.closest(".rh");
    if (right) {
      event.preventDefault();
      event.stopPropagation();
      return dragRightHandle(event, right);
    }
    const handle = event.target.closest(".mh");
    if (!handle) return;
    event.preventDefault();
    event.stopPropagation();
    const n = Number(handle.dataset.n);
    const key = paneKeys[n];
    const edge = handle.dataset.edge;
    const series = paneSeries(n);
    if (!series) return;
    const margins = { ...marginsFor(key) };
    handle.setPointerCapture(event.pointerId);
    handle.classList.add("drag");
    root.classList.add("margin-drag");
    const move = (e) => {
      const box = paneBoxes()[n];
      const at = Math.max(0, Math.min(1, (e.clientY - root.getBoundingClientRect().top - box.top) / box.height));
      if (edge === "top") margins.top = Math.min(at, 0.9 - margins.bottom);
      else margins.bottom = Math.min(1 - at, 0.9 - margins.top);
      margins[edge] = Math.max(0, Math.round(margins[edge] * 1000) / 1000);
      S.margins[key] = { ...margins };
      series.priceScale().applyOptions({ autoScale: true, scaleMargins: { ...margins } });
      layoutOverlays();
      scheduleCallouts();
    };
    const done = () => {
      handle.removeEventListener("pointermove", move);
      handle.classList.remove("drag");
      root.classList.remove("margin-drag");
      settings.change((s) => { s.margins[key] = { ...margins }; });
    };
    handle.addEventListener("pointermove", move);
    handle.addEventListener("pointerup", done, { once: true });
    handle.addEventListener("pointercancel", done, { once: true });
  });

  // Double-clicking a price axis turns its auto-scaling back on, so the margins apply again.
  el["chart"].addEventListener("dblclick", (event) => {
    const rect = el["chart"].getBoundingClientRect();
    if (event.clientX < rect.right - chart.priceScale("right").width()) return;
    for (let n = 0; n < paneKeys.length; n++) {
      const series = paneSeries(n);
      if (series) series.priceScale().applyOptions({ autoScale: true });
    }
  });
  window.addEventListener("resize", () => scheduleCallouts());

  function renderInfoTable(data, card) {
    el["info-table"].hidden = !info;
    if (!info) return;
    const daily = view.replay ? replayInfo : data; // a replay knows the replay day's figures
    const adr = card ? card.adr20 : daily?.adr20;
    const adv = card ? card.adv20 : daily?.adv20;
    const industry = (card && card.industry) || data.industry || "—";
    el["info-table"].innerHTML = [
      "<span>Market Cap</span><span>ADR %</span><span>Avg Daily $ Vol</span><span>Ind. Grp</span>",
      `<span>${view.anonymous ? "hidden" : fmtBig(data.market_cap)}</span><span>${adr == null ? "—" : adr.toFixed(2) + "%"}</span>`,
      `<span>${fmtBig(adv, "$")}</span><span>${escapeHtml(industry)}</span>`,
    ].join("");
  }

  function applyLevels(card) {
    lastCard = card;
    priceLines.forEach((line) => candles.removePriceLine(line));
    priceLines = [];
    for (const line of view.lines || []) {
      priceLines.push(candles.createPriceLine({ lineWidth: 1, axisLabelVisible: true, ...line }));
    }
    if (view.lines || !card || !state.showLevels) return;
    for (const level of card.levels) {
      if (!state.lines[level.kind]) continue;
      const kind = LEVEL_STYLES[level.kind] ? level.kind : "overhead";
      priceLines.push(candles.createPriceLine({
        price: level.price, ...LEVEL_STYLES[kind], color: S.levels[kind], axisLabelVisible: true, title: level.label,
      }));
    }
  }

  // Price alerts on this chart's symbol (alerts.js draws and drags them): { price, color, width,
  // style, onLine }. An alert on a drawn line shows only its price tag; the line is already there.
  let alertSpec = [];
  let alertLines = [];
  function setAlertLines(spec) {
    alertSpec = spec;
    drawAlertLines();
  }
  function drawAlertLines() {
    alertLines.forEach((line) => candles.removePriceLine(line));
    alertLines = alertSpec.map(({ price, color, width, style, onLine }) => candles.createPriceLine({
      price, color, lineWidth: width, lineStyle: style, lineVisible: !onLine, axisLabelVisible: true, title: "",
    }));
  }

  function setLastPriceLine(visible) {
    candles.applyOptions({ priceLineVisible: visible });
  }

  // ---------- callouts ----------
  // Event labels (scan, fill, exit, …) drawn as HTML pills joined to their candles by stems,
  // instead of chart markers whose text sits on top of the bars. Labels whose candles are close
  // together are spaced out in time order left to right, each as close to its own candle as the
  // order allows, and each sits just above the candles beneath it (below them if there's no room
  // above), so it never covers a bar. `badge: true` draws a small dot (or numbered dot) under the bar
  // instead. Labels only appear once their bar is on the chart, so they arrive with the bar
  // during a replay.
  const calloutLayer = el["callouts"];
  const SVG = "http://www.w3.org/2000/svg";
  let callouts = [];
  let calloutFrame = 0;
  const CLEARANCE = 16; // px between a row and the candles it spans
  const PILL_GAP = 6; // px between pills in a row
  const CLUSTER_GAP = 40; // px: pills further apart than this get rows of their own

  function scheduleCallouts() {
    if (!calloutFrame) calloutFrame = requestAnimationFrame(() => {
      calloutFrame = 0;
      renderCallouts();
      earnings.render();
      layoutOverlays();
      for (const fn of renderHooks) fn(pane);
    });
  }

  // Highest high and lowest low (as y coordinates) of the candles between two x positions.
  function candleExtent(left, right) {
    const scale = chart.timeScale();
    const half = Math.max(scale.options().barSpacing / 2, 2);
    let top = Infinity;
    let bottom = -Infinity;
    for (let i = 0; i < currentBars.length; i++) {
      const x = scale.logicalToCoordinate(i);
      if (x == null || x + half < left || x - half > right) continue;
      const high = candles.priceToCoordinate(currentBars[i].high);
      const low = candles.priceToCoordinate(currentBars[i].low);
      if (high != null) top = Math.min(top, high);
      if (low != null) bottom = Math.max(bottom, low);
    }
    return { top, bottom };
  }

  // Centres for pills of widths `widths` wanting to sit at `targets` (sorted), without overlaps,
  // in order, as close to their targets as possible, and inside [0, width].
  function layoutRow(targets, widths, width) {
    const centres = [...targets];
    for (let n = 1; n < centres.length; n++) {
      centres[n] = Math.max(centres[n], centres[n - 1] + (widths[n - 1] + widths[n]) / 2 + PILL_GAP);
    }
    // Pushing right drags the row off its candles; slide it back by the average drift.
    const drift = centres.reduce((total, c, n) => total + c - targets[n], 0) / centres.length;
    let shift = -drift;
    const left = centres[0] - widths[0] / 2 + shift;
    const right = centres[centres.length - 1] + widths[widths.length - 1] / 2 + shift;
    if (left < 0) shift -= left;
    else if (right > width) shift -= right - width;
    return centres.map((c) => c + shift);
  }

  function renderCallouts() {
    const shown = new Map(currentBars.map((bar) => [bar.time, bar]));
    const width = calloutLayer.clientWidth - chart.priceScale("right").width();
    const paneHeight = chart.panes()[0].getHeight();
    const items = callouts
      .filter((item) => shown.has(item.time))
      .map((item, order) => {
        const bar = shown.get(item.time);
        return {
          ...item, order, x: chart.timeScale().timeToCoordinate(item.time),
          high: candles.priceToCoordinate(bar.high), low: candles.priceToCoordinate(bar.low),
        };
      })
      .filter((item) => item.x != null && item.high != null && item.x >= 0 && item.x <= width)
      .sort((a, b) => a.x - b.x || a.order - b.order);

    calloutLayer.innerHTML = "";
    const svg = document.createElementNS(SVG, "svg");
    svg.setAttribute("class", "co-stems");
    calloutLayer.appendChild(svg);
    const stems = [];
    const pills = [];
    for (const item of items) {
      const node = document.createElement("div");
      node.className = item.badge ? "co-badge" : "co-label";
      node.textContent = item.text || "";
      node.style.setProperty("--c", item.color);
      calloutLayer.appendChild(node);
      if (item.badge) {
        node.style.left = `${item.x - node.offsetWidth / 2}px`;
        node.style.top = `${item.low + 6}px`;
      } else {
        pills.push({ ...item, node, w: node.offsetWidth, h: node.offsetHeight });
      }
    }

    // Group pills whose natural spots would crowd each other into rows.
    const rows = [];
    for (const pill of pills) {
      const row = rows[rows.length - 1];
      const previous = row && row[row.length - 1];
      if (previous && pill.x - pill.w / 2 - (previous.x + previous.w / 2) < CLUSTER_GAP) row.push(pill);
      else rows.push([pill]);
    }

    for (const row of rows) {
      // The row fixes the left-to-right order and spacing; each pill then drops to its own height,
      // just clear of the candles beneath it and between it and its candle.
      const centres = layoutRow(row.map((pill) => pill.x), row.map((pill) => pill.w), width);
      row.forEach((pill, n) => {
        const cx = centres[n];
        const extent = candleExtent(Math.min(pill.x, cx - pill.w / 2) - 4, Math.max(pill.x, cx + pill.w / 2) + 4);
        const above = extent.top - CLEARANCE - pill.h;
        const below = extent.bottom + CLEARANCE;
        const fitsAbove = above >= 2;
        const fitsBelow = below + pill.h <= paneHeight - 2;
        const up = pill.position === "belowBar" ? !fitsBelow && fitsAbove : fitsAbove || !fitsBelow;
        const top = up ? Math.max(2, above) : Math.min(paneHeight - pill.h - 2, below);
        pill.node.style.left = `${cx - pill.w / 2}px`;
        pill.node.style.top = `${top}px`;
        // The stem runs from the candle's high (or low) to the nearest point on the pill's edge.
        const anchorY = up ? pill.high - 3 : pill.low + 3;
        const endY = up ? top + pill.h : top;
        const endX = Math.max(cx - pill.w / 2 + 8, Math.min(cx + pill.w / 2 - 8, pill.x));
        stems.push(`<line x1="${pill.x.toFixed(1)}" y1="${anchorY.toFixed(1)}" x2="${endX.toFixed(1)}" y2="${endY.toFixed(1)}" stroke="${pill.color}"/>` +
          `<circle cx="${pill.x.toFixed(1)}" cy="${anchorY.toFixed(1)}" r="2.5" fill="${pill.color}"/>`);
      });
    }
    svg.innerHTML = stems.join("");
  }

  chart.timeScale().subscribeVisibleLogicalRangeChange(scheduleCallouts);
  chart.timeScale().subscribeSizeChange(scheduleCallouts);
  // Remember a zoom you made yourself: the range also changes when a chart loads or resizes, so
  // only count changes right after a wheel, drag or touch.
  let lastInput = 0;
  const touched = () => { lastInput = Date.now(); };
  for (const type of ["wheel", "pointerdown", "touchmove"]) el["chart"].addEventListener(type, touched, { passive: true });
  el["chart"].addEventListener("pointermove", (event) => { if (event.buttons) touched(); }, { passive: true });
  chart.timeScale().subscribeVisibleLogicalRangeChange(() => {
    if (Date.now() - lastInput > 400 || lastShown.anonymous || !lastShown.interval || replaying) return;
    const spacing = chart.timeScale().options().barSpacing;
    if (spacing !== savedZoom(lastShown.interval)) saveZoom(lastShown.interval, spacing);
  });
  // Price-scale drags and wheel zooms have no event of their own.
  for (const type of ["wheel", "pointermove", "pointerup"]) {
    el["chart"].addEventListener(type, scheduleCallouts, { passive: true });
  }

  function applyMarkers() {
    if (view.markers) callouts = view.markers;
    else if (state.mode === "review" && state.followThrough && state.deck && !state.adhoc) {
      callouts = [{ time: state.deck.as_of, position: "aboveBar", color: "#5b9cff", text: "scan" }];
    } else callouts = [];
    scheduleCallouts();
  }

  async function showChart(symbol, card, options = {}) {
    cancelPick();
    stopReplay();
    replayControls.hidden = true;
    clearTimeout(replayRefresh);
    replayInfo = null;
    const token = ++loadToken;
    earnings.clear();
    if (unsubscribe) unsubscribe();
    unsubscribe = null;
    watchExtended(null);
    view = options;
    if (callouts.length) { callouts = []; scheduleCallouts(); } // the last call's pills don't wait for the new bars
    const through = "through" in options ? options.through : state.adhoc ? null : throughDate();
    const interval = options.interval || "1D";
    const count = options.count || DECK_BARS;
    const intraday = isIntraday(interval);
    const shown = series(symbol, { through: intraday ? null : through, interval, count, extended: state.extended });
    let data;
    try {
      [data] = await Promise.all([shown.load(), loadBenchmark(through, interval, count)]);
    } catch (error) {
      if (token !== loadToken) return;
      return chartMessage(`No chart for ${view.anonymous ? "this setup" : ticker(symbol)}: ${error.message}`);
    }
    if (token !== loadToken) return;
    chartMessage(null);
    currentThrough = through;
    currentRequest = { interval, count, extended: intraday && state.extended };
    const bars = data.bars;
    // Bar Replay stops at its day; a Playbook example or practice replay starts at the scan date.
    const replay = Boolean(options.replay);
    let cut = bars.length - 1;
    if (replay) cut = cutIndex(bars, options.replayFrom);
    else if (options.replayFrom) cut = bars.reduce((last, bar, i) => (bar.time <= options.replayFrom ? i : last), bars.length - 1);
    realBars = bars;
    fullBars = replay && cut >= 0 ? await partPeriod(bars, cut, options.replayFrom, interval, data) : bars;
    if (token !== loadToken) return;
    lastData = data;
    lastShown = { symbol: data.symbol, interval, anonymous: Boolean(view.anonymous) };
    if (cut < 0) {
      realBars = fullBars = currentBars = [];
      blank();
      return chartMessage(`No ${intraday ? "intraday " : ""}bars for ${ticker(data.symbol)} by ${options.replayFrom}`);
    }
    chartInfo = {
      ticker: ticker(data.symbol),
      exchange: data.symbol.includes(":") ? data.symbol.split(":")[0] : "",
      company: (card && card.company) || data.company,
    };

    // A replay starts at the scan date and animates later bars in one at a time.
    const initial = fullBars.slice(0, cut + 1);
    currentBars = initial;
    const asof = replay ? options.replayFrom
      : intraday ? dayOf(initial.at(-1)?.time) : data.last_day || initial.at(-1)?.time;
    // A new timeframe can turn indicators on or off: rebuild the series when the set changes.
    if (drawnKey(interval) !== builtKey) rebuildSeries();
    computeSeries();
    candles.setData(initial.map(candle));
    fillSeries();
    setWatermark();
    sessions.setData(intraday && state.extended ? initial.map(shade) : []);
    // Practice hides the date axis until the call so the setup can't be recognised by its date.
    chart.applyOptions({
      timeScale: { visible: !view.anonymous, timeVisible: intraday, secondsVisible: false },
      crosshair: { vertLine: { labelVisible: !view.anonymous } },
    });
    applyLevels(card);
    applyMarkers();
    earnings.render();
    const span = visibleBars();
    const offset = S.scale.rightOffset;
    shownOffset = offset; // settings may have synced before the first bars loaded
    const animate = options.replayFrom && !options.manualReplay && !replay; // practice reveals
    const right = animate
      ? Math.max(offset, bars.length - initial.length + 4) : offset;
    const zoom = view.anonymous || (options.replayFrom && !replay) ? null : savedZoom(interval);
    replaying = Boolean(options.replayFrom) && !replay;
    if (zoom) {
      chart.timeScale().applyOptions({ barSpacing: zoom });
      setRightOffset(right);
    } else chart.timeScale().setVisibleLogicalRange({ from: initial.length - span, to: initial.length - 1 + right });
    renderLegend(null);
    renderInfoTable(data, card);
    for (const fn of loadHooks) fn({ pane, symbol: data.symbol, anonymous: Boolean(view.anonymous), data });
    // Bars paint first. A slow fundamentals read must never delay switching charts.
    const nextAsOf = !through && !options.replayFrom ? todayET() : asof;
    if (replay) refreshReplay(data.symbol, asof, 0);
    else earnings.load(data.symbol, asof, state.mode === "chart" && !view.anonymous && !options.replayFrom, nextAsOf).then(() => {
      if (token !== loadToken) return;
      earnings.render();
      renderLegend(null);
      for (const fn of fundamentalsHooks) fn({ pane, symbol: data.symbol, anonymous: Boolean(view.anonymous), data });
    });
    // Live prices only where the chart runs to today: never in practice, replays or past scans.
    unsubscribe = showLive(owner, view.anonymous || options.replayFrom ? null : shown, onLiveBar);
    const live = !view.anonymous && !options.replayFrom && shown.liveable;
    watchExtended(live && !(intraday && state.extended) ? shown.ticker : null, interval === "1D");

    if (options.manualReplay && options.replayFrom) {
      replayControls.hidden = false;
      updateReplayControls();
      return true;
    }
    if (animate) {
      for (let i = cut + 1; i < bars.length; i++) {
        const delay = typeof options.replayMs === "function" ? options.replayMs(i - cut, bars[i]) : options.replayMs;
        await new Promise((resolve) => setTimeout(resolve, delay || 320));
        if (token !== loadToken) return false;
        candles.update(candle(bars[i]));
        currentBars = bars.slice(0, i + 1);
        for (const item of plots) item.series.update(point(item, i));
        drawLevels(i + 1);
        if (volume) {
          volume.update(volumeBar(bars[i]));
          volumeAverage.update(volumeAvgPoint(i));
        }
        renderLegend(null);
        scheduleCallouts();
        if (options.onBar) options.onBar(bars[i], i - cut, bars[i - 1]);
      }
      return true;
    }
    if (!view.anonymous && "through" in options) return true;
    prefetchNeighbors();
    return true;
  }

  // ---------- Bar Replay ----------
  // The chart cut at a replay day, moved by the replay bar (replay.js) one bar at a time. Both
  // charts in split view follow one day; only what was known by that day shows.

  function blank() {
    candles.setData([]);
    for (const item of plots) item.series.setData([]);
    drawLevels(0);
    if (volume) { volume.setData([]); volumeAverage.setData([]); }
    earnings.clear();
  }

  // A week or month the replay day falls inside has sessions still to come: its bar is swapped
  // for the period so far, as the server builds it through that day.
  async function partPeriod(bars, cut, day, interval, data) {
    if (!/[WM]$/.test(interval)) return bars;
    const next = bars[cut + 1];
    const unfinished = next ? sessionsBetween(day, next.time) > 1 : sessionsBetween(day, data.last_day) > 0;
    if (!unfinished) return bars;
    try {
      const part = (await series(data.symbol, { through: day, interval, count: 20 }).load()).bars.at(-1);
      return part && part.time === bars[cut].time ? bars.map((bar, i) => (i === cut ? part : bar)) : bars;
    } catch {
      return bars;
    }
  }

  // The day a bar closes: an intraday bar's day; otherwise the session before the next bar
  // starts, or the last day loaded.
  function closeDay(i) {
    const bar = realBars[i];
    if (typeof bar.time === "number") return dayOf(bar.time);
    const next = realBars[i + 1];
    return next ? previousSession(next.time) : lastData.last_day;
  }
  const replayDayOf = (time) => {
    const i = realBars.findIndex((bar) => bar.time === time);
    return i < 0 ? null : closeDay(i);
  };

  // The next replay day: when the next bar closes, or the rest of a week or month in progress.
  // Null at the newest bar.
  function replayNext() {
    const cut = currentBars.length - 1;
    if (cut < 0) return null;
    const i = fullBars[cut] !== realBars[cut] ? cut : cut + 1;
    return i < realBars.length ? closeDay(i) : null;
  }

  async function replayTo(day) {
    if (!view.replay || !lastShown.symbol) return false;
    view.replayFrom = day;
    const interval = currentRequest.interval;
    const cut = cutIndex(realBars, day);
    // Load again around the day when it is outside what's loaded or near either end of it.
    const early = cut < 300 && realBars.length >= currentRequest.count;
    if (cut < 0 || early || (currentThrough && realBars.length - 1 - cut < 3)) {
      const range = chart.timeScale().getVisibleLogicalRange();
      const gap = range && currentBars.length ? range.to - (currentBars.length - 1) : null;
      const loaded = await showChart(lastShown.symbol, null, { ...view, replayFrom: day, through: replayThrough(day, interval) });
      if (loaded && gap != null) {
        const last = currentBars.length - 1;
        chart.timeScale().setVisibleLogicalRange({ from: last + gap - (range.to - range.from), to: last + gap });
      }
      return loaded;
    }
    const token = loadToken;
    const bars = await partPeriod(realBars, cut, day, interval, lastData);
    if (token !== loadToken) return false;
    const range = chart.timeScale().getVisibleLogicalRange();
    const following = range && range.to >= currentBars.length - 1; // the newest bar is in view
    const recompute = bars !== fullBars;
    fullBars = bars;
    currentBars = bars.slice(0, cut + 1);
    if (recompute) computeSeries();
    candles.setData(currentBars.map(candle));
    fillSeries();
    if (currentRequest.extended) sessions.setData(currentBars.map(shade));
    earnings.render();
    // Like a live chart: the new bar keeps your right margin, unless you've scrolled back.
    if (following) setRightOffset(S.scale.rightOffset);
    renderLegend(null);
    scheduleCallouts();
    refreshReplay(lastShown.symbol, day);
    return true;
  }

  // Earnings, ADR and $ volume as of the replay day, fetched once the day stops moving.
  let replayRefresh = null;
  let replaySeq = 0;
  function refreshReplay(symbol, day, delay = 300) {
    clearTimeout(replayRefresh);
    const token = loadToken;
    replayRefresh = setTimeout(async () => {
      const request = ++replaySeq;
      const [daily] = await Promise.all([
        series(symbol, { through: day, interval: "1D", count: CHART_BARS.D }).load().catch(() => null),
        earnings.load(symbol, day, state.mode === "chart", day, true),
      ]);
      if (token !== loadToken || request !== replaySeq) return;
      replayInfo = daily;
      renderInfoTable(lastData, lastCard);
      earnings.render();
      renderLegend(null);
      for (const fn of fundamentalsHooks) fn({ pane, symbol, anonymous: false, data: lastData });
    }, delay);
  }

  // Examples use the same sliced series as practice, but advance on demand.
  const replayControls = Object.assign(root.appendChild(document.createElement("div")), {
    className: "example-replay", hidden: true,
  });
  replayControls.innerHTML = '<span></span><button class="mini" data-play>Play</button>' +
    '<button class="mini" data-next>Next bar <kbd>→</kbd></button>' +
    '<button class="mini" data-exit>Exit replay <kbd>Esc</kbd></button>';
  let replayTimer = null;
  function updateReplayControls() {
    const done = currentBars.length >= fullBars.length;
    if (done) stopReplay();
    replayControls.querySelector("span").textContent = `Example · ${dayOf(currentBars.at(-1)?.time) || "No bars"}`;
    replayControls.querySelector("[data-next]").disabled = done;
    replayControls.querySelector("[data-play]").disabled = done;
    replayControls.querySelector("[data-play]").textContent = replayTimer ? "Pause" : "Play";
  }
  function stopReplay() {
    clearInterval(replayTimer);
    replayTimer = null;
  }
  function playReplay() {
    if (replayTimer) stopReplay();
    else replayTimer = setInterval(nextReplayBar, 250);
    updateReplayControls();
  }
  function nextReplayBar() {
    if (replayControls.hidden || currentBars.length >= fullBars.length) return;
    const range = chart.timeScale().getVisibleLogicalRange();
    const bar = fullBars[currentBars.length];
    currentBars = fullBars.slice(0, currentBars.length + 1);
    candles.update(candle(bar));
    fillSeries();
    if (currentRequest.extended) sessions.update(shade(bar));
    if (range) chart.timeScale().setVisibleLogicalRange({ from: range.from + 1, to: range.to + 1 });
    renderLegend(null);
    scheduleCallouts();
    updateReplayControls();
  }
  function exitReplay() {
    stopReplay();
    replayControls.hidden = true;
    if (view.onReplayExit) view.onReplayExit();
    else showChart(lastShown.symbol, null, { interval: currentRequest.interval, through: null });
  }
  replayControls.querySelector("[data-play]").addEventListener("click", playReplay);
  replayControls.querySelector("[data-next]").addEventListener("click", () => { stopReplay(); nextReplayBar(); });
  replayControls.querySelector("[data-exit]").addEventListener("click", exitReplay);

  let cancelPick = () => {};
  function pickBar(prompt = "Click the last candle to show in this example") {
    cancelPick();
    return new Promise((resolve) => {
      const picker = Object.assign(root.appendChild(document.createElement("div")), { className: "example-pick" });
      picker.innerHTML = `<div class="example-replay"><span>${prompt}</span>` +
        '<button class="mini">Cancel <kbd>Esc</kbd></button></div>' +
        '<div class="pick-shade" hidden></div><div class="pick-line" hidden><span></span></div>';
      // The bar under the pointer: a line through it, the bars after it shaded, its date.
      const line = picker.querySelector(".pick-line"), shadeEl = picker.querySelector(".pick-shade");
      const barAt = (event) => {
        const rect = root.getBoundingClientRect(), { box, plotWidth } = chartContext();
        const x = event.clientX - rect.left, y = event.clientY - rect.top;
        if (x < 0 || x >= plotWidth || y < box.top || y >= box.top + box.height) return null;
        const logical = chart.timeScale().coordinateToLogical(x);
        const i = logical == null ? -1 : Math.min(currentBars.length - 1, Math.round(logical));
        return i < 0 ? null : { i, bar: currentBars[i], plotWidth };
      };
      picker.addEventListener("pointermove", (event) => {
        const hit = !event.target.closest(".example-replay") && barAt(event);
        line.hidden = shadeEl.hidden = !hit;
        if (!hit) return;
        const x = chart.timeScale().logicalToCoordinate(hit.i);
        const half = chart.timeScale().options().barSpacing / 2;
        const bottom = `${chart.timeScale().height()}px`;
        Object.assign(line.style, { left: `${Math.round(x)}px`, bottom });
        Object.assign(shadeEl.style, { left: `${Math.round(x + half)}px`, width: `${Math.max(0, hit.plotWidth - x - half)}px`, bottom });
        const time = hit.bar.time;
        line.querySelector("span").textContent = typeof time === "number"
          ? new Date(time * 1000).toLocaleString("en-US", { timeZone: "UTC", month: "short", day: "numeric", hour: "2-digit", minute: "2-digit", hour12: false })
          : new Date(`${time}T12:00:00Z`).toLocaleDateString("en-US", { timeZone: "UTC", weekday: "short", month: "short", day: "numeric", year: "numeric" });
      });
      picker.addEventListener("pointerleave", () => { line.hidden = shadeEl.hidden = true; });
      const finish = (time = null) => {
        picker.remove();
        cancelPick = () => {};
        resolve(time);
      };
      cancelPick = () => finish();
      picker.querySelector("button").addEventListener("click", () => finish());
      picker.addEventListener("click", (event) => {
        if (event.target.closest(".example-replay")) return;
        const hit = barAt(event);
        if (hit) finish(hit.bar.time);
      });
    });
  }
  document.addEventListener("keydown", (event) => {
    if (state.mode !== "chart" || root.hidden || root.closest("[hidden]")) return;
    const picking = root.querySelector(".example-pick");
    if (event.key === "Escape" && picking) {
      event.preventDefault();
      event.stopImmediatePropagation();
      cancelPick();
    } else if (!replayControls.hidden && pane === activePane() &&
      !event.target.closest("input, textarea, select, [contenteditable]")) {
      if (event.key !== "Escape" && event.key !== "ArrowRight") return;
      event.preventDefault();
      event.stopImmediatePropagation();
      if (event.key === "Escape") exitReplay();
      else { stopReplay(); nextReplayBar(); }
    }
  }, true);

  // A live update to the series on screen: redraw its newest bar (the feed has merged it). An
  // intraday bar's late last minute can change the bar before the newest: redraw them all then.
  function onLiveBar({ bar, added, index = fullBars.length - 1 }) {
    currentBars = fullBars;
    const i = fullBars.length - 1;
    if (index < i) {
      candles.setData(fullBars.map(candle));
      computeSeries();
      fillSeries();
      if (currentRequest.extended) sessions.setData(fullBars.map(shade));
      renderLegend(null);
      for (const fn of renderHooks) fn(pane);
      return;
    }
    if (currentRequest.extended) sessions.update(shade(bar));
    candles.update(candle(bar));
    computeSeries();
    for (const item of plots) item.series.update(point(item, i));
    if (volume) {
      volume.update(volumeBar(bar));
      volumeAverage.update(volumeAvgPoint(i));
    }
    if (added) drawLevels(fullBars.length);
    if (added && state.mode === "chart" && dayOf(bar.time) !== earnings.record()?.asof) {
      const token = loadToken;
      earnings.load(lastShown.symbol, dayOf(bar.time), true, todayET()).then(() => {
        if (token !== loadToken) return;
        earnings.render();
        renderLegend(null);
        for (const fn of fundamentalsHooks) fn({ pane, symbol: lastShown.symbol, anonymous: false, data: { bars: fullBars } });
      });
    }
    renderLegend(null);
    for (const fn of renderHooks) fn(pane);
  }

  function chartMessage(text) {
    el["chart-message"].hidden = !text;
    el["chart-message"].textContent = text || "";
  }

  rebuildSeries();
  applyStyle();

  // What the drawing layer needs to map between dates/prices and pixels.
  function chartContext() {
    const box = paneBoxes()[0] || { top: 0, height: 0 };
    return {
      chart, candles, bars: currentBars, box,
      plotWidth: root.clientWidth - chart.priceScale("right").width(),
      interval: currentRequest.interval,
    };
  }

  const currentInterval = () => currentRequest.interval;

  // A date window (ISO days) fitted to the chart with a little room each side: a Playbook
  // example. No end: about three months from the start.
  function showRange(from, to) {
    if (!currentBars.length || typeof currentBars[0].time !== "string") return;
    const last = currentBars.length - 1;
    let a = currentBars.findIndex((bar) => bar.time >= from);
    if (a < 0) a = last;
    let b = to ? currentBars.findLastIndex((bar) => bar.time <= to) : a + 63;
    if (b < a) b = a;
    const pad = Math.max(5, Math.round((b - a) * 0.12));
    for (let n = 0; n < paneKeys.length; n++) {
      const series = paneSeries(n);
      if (series) series.priceScale().applyOptions({ autoScale: true });
    }
    chart.timeScale().setVisibleLogicalRange({ from: a - pad, to: Math.min(b + pad, last + S.scale.rightOffset) });
  }

  // The first and last day in view, for saving the window as an example.
  function visibleDates() {
    const range = chart.timeScale().getVisibleLogicalRange();
    if (!range || !currentBars.length) return null;
    const last = currentBars.length - 1;
    const at = (i) => currentBars[Math.max(0, Math.min(last, Math.round(i)))].time;
    const [from, to] = [at(Math.ceil(range.from)), at(Math.floor(range.to))];
    const day = (t) => (typeof t === "number" ? new Date(t * 1000).toISOString().slice(0, 10) : t);
    return { from: day(from), to: day(to) };
  }

  // ⌥R in TradingView: back to the default view, auto-scaled.
  function resetView() {
    if (lastShown.interval && !lastShown.anonymous) forgetZoom(lastShown.interval);
    for (let n = 0; n < paneKeys.length; n++) {
      const series = paneSeries(n);
      if (series) series.priceScale().applyOptions({ autoScale: true });
    }
    const shown = visibleBars();
    earnings.render();
    chart.timeScale().setVisibleLogicalRange({
      from: currentBars.length - shown, to: currentBars.length - 1 + S.scale.rightOffset,
    });
  }

  // The text laid over the chart (legend, info table, pane legends), painted onto the picture
  // where it sits on screen: each visible text run in its own font, colour and opacity.
  function paintOverlays(ctx, scale) {
    const origin = el["chart"].getBoundingClientRect();
    const roots = [el["legend"], el["info-table"], el["pane-legends"]];
    ctx.textBaseline = "middle";
    for (const root of roots) {
      const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
      for (let node = walker.nextNode(); node; node = walker.nextNode()) {
        const text = node.textContent.trim();
        const owner = node.parentElement;
        if (!text || !owner) continue;
        const style = getComputedStyle(owner);
        if (style.visibility !== "visible") continue;
        let alpha = 1;
        for (let el = owner; el && el !== root; el = el.parentElement) alpha *= Number(getComputedStyle(el).opacity);
        if (alpha < 0.05) continue;
        // The box of the text itself, without the spaces around it.
        const lead = node.textContent.length - node.textContent.trimStart().length;
        const range = document.createRange();
        range.setStart(node, lead);
        range.setEnd(node, lead + text.length);
        const box = [...range.getClientRects()].find((rect) => rect.width > 0);
        if (!box) continue;
        ctx.globalAlpha = alpha;
        ctx.fillStyle = style.color;
        ctx.font = `${style.fontStyle} ${style.fontWeight} ${parseFloat(style.fontSize) * scale}px ${style.fontFamily}`;
        // Canvas text can come out wider than the page's (another font, tabular digits); the
        // width cap squeezes it back into its box so neighbours never overlap.
        const x = (box.left - origin.left) * scale;
        ctx.fillText(text, x, (box.top + box.height / 2 - origin.top) * scale, box.width * scale + 1);
      }
    }
    ctx.globalAlpha = 1;
  }

  // The chart as on screen: canvas, drawings and the text over it.
  async function chartImage(svg) {
    const shot = chart.takeScreenshot();
    const scale = shot.width / el["chart"].clientWidth || 1;
    const canvas = document.createElement("canvas");
    [canvas.width, canvas.height] = [shot.width, shot.height];
    const ctx = canvas.getContext("2d");
    // The chart's colours can be see-through; on screen they sit on the page's background.
    ctx.fillStyle = getComputedStyle(document.body).backgroundColor || "#000";
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    ctx.drawImage(shot, 0, 0);
    // Images placed on the chart (a GIF as its current frame), clipped to the plot as on screen.
    const base = el["chart"].getBoundingClientRect();
    for (const holder of root.querySelectorAll(".draw-images")) {
      const clip = holder.getBoundingClientRect();
      ctx.save();
      ctx.beginPath();
      ctx.rect((clip.left - base.left) * scale, (clip.top - base.top) * scale, clip.width * scale, clip.height * scale);
      ctx.clip();
      for (const img of holder.querySelectorAll("img")) {
        // A picture from another site would make the canvas unreadable, so it's left out.
        if (!img.complete || !img.naturalWidth || new URL(img.src).origin !== location.origin) continue;
        const at = img.getBoundingClientRect();
        ctx.drawImage(img, (at.left - base.left) * scale, (at.top - base.top) * scale, at.width * scale, at.height * scale);
      }
      ctx.restore();
    }
    if (svg && svg.childElementCount) {
      const markup = new XMLSerializer().serializeToString(svg);
      const image = new Image();
      image.src = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(markup)}`;
      await image.decode().catch(() => {});
      ctx.drawImage(image, 0, 0, canvas.width, canvas.height);
    }
    paintOverlays(ctx, scale);
    return canvas;
  }

  const pngOf = (canvas) => new Promise((resolve, reject) =>
    canvas.toBlob((blob) => (blob ? resolve(blob) : reject(new Error("no image"))), "image/png"));

  // ⇧⌥S: save the chart image as a PNG file.
  async function snapshot(svg) {
    const canvas = await chartImage(svg);
    const link = document.createElement("a");
    const day = currentBars.length ? currentBars[currentBars.length - 1].time : "";
    link.download = `${view.anonymous ? "practice" : chartInfo.ticker || "chart"}_${currentRequest.interval}_${day}.png`;
    link.href = canvas.toDataURL("image/png");
    link.click();
  }

  // ⌥S and the camera button: copy the chart image to the clipboard. The ClipboardItem gets a
  // promise so Safari still counts it as part of the click or key press. False if not allowed.
  async function copySnapshot(svg) {
    if (!navigator.clipboard?.write || !window.ClipboardItem) return false;
    try {
      await navigator.clipboard.write([new ClipboardItem({ "image/png": chartImage(svg).then(pngOf) })]);
      return true;
    } catch {
      return false;
    }
  }

  let replaying = false;
  let lastShown = { symbol: null, interval: null, anonymous: false };
  pane = {
    side, root, settings, show: showChart, applyLevels, setLastPriceLine, scheduleCallouts, context: chartContext,
    interval: currentInterval, resetView, showRange, visibleDates, pickBar, message: chartMessage, snapshot, copySnapshot,
    replayTo, replayNext, replayDayOf, replayDay: () => (view.replay ? view.replayFrom : null), setAlertLines,
    shown: () => lastShown, setInfo(on) { info = on; el["info-table"].hidden = !on; }, echoCrosshair,
    fundamentals: () => earnings.record(), clearEarnings: () => earnings.clear(),
    // Leaving split view: stop its live symbols and clear it.
    clear() {
      cancelPick();
      stopReplay();
      clearTimeout(replayRefresh);
      replayControls.hidden = true;
      if (unsubscribe) unsubscribe();
      unsubscribe = null;
      loadToken++;
      earnings.clear();
      showLive(owner, null);
      watchExtended(null);
      lastShown = { symbol: null, interval: null, anonymous: false };
    },
  };
  // A click anywhere in the chart makes it the active one.
  root.addEventListener("pointerdown", () => activate(side), { capture: true });
  return pane;
}

// ---------- the charts ----------
// The left chart always exists; the right one is made the first time split view opens. The
// rest of the app acts on the active chart: the exports below, the watchlist, search, hotkeys.

const panes = {
  left: createPane($("chart-area"), { side: "left", owner: "chart", settings: chartProfile("chart") }),
};
let active = panes.left;
const activateHooks = [];
export const onChartActivate = (fn) => activateHooks.push(fn);
export const activePane = () => active;
export const chartPane = (side) => panes[side];

export function rightPane() {
  if (!panes.right) {
    panes.right = createPane($("chart-right"), {
      side: "right", owner: "chart:right", settings: chartProfile("chart_right"), info: false,
    });
  }
  return panes.right;
}

function activate(side) {
  const next = panes[side];
  if (!next || next === active) return;
  active = next;
  useChartProfile(next.settings);
  for (const pane of Object.values(panes)) pane.root.classList.toggle("active-pane", pane === active);
  for (const fn of activateHooks) fn(next);
}
export const activateChart = activate;

// Crosshair sync (the layout menu): the other chart shows the hovered moment.
let syncCrosshair = false;
export const setCrosshairSync = (on) => { syncCrosshair = on; };
crosshairHooks.push((source, at) => {
  if (!syncCrosshair) return;
  for (const pane of Object.values(panes)) {
    if (pane !== source && !pane.root.hidden && pane.shown().symbol) pane.echoCrosshair(at);
  }
});

export const showChart = (...args) => active.show(...args);
export const applyLevels = (card) => active.applyLevels(card);
export const setLastPriceLine = (visible) => active.setLastPriceLine(visible);
export const scheduleCallouts = () => active.scheduleCallouts();
export const chartContext = () => active.context();
export const currentInterval = () => active.interval();
export const resetView = () => active.resetView();
export const chartMessage = (text) => active.message(text);
export const snapshot = (svg) => active.snapshot(svg);
export const copySnapshot = (svg) => active.copySnapshot(svg);
