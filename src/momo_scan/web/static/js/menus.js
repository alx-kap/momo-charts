import { fmtPrice, toast, ticker } from "./util.js";
import { actions, state } from "./state.js";
import { openMenu, svgIcon, wantsMenu } from "./contextmenu.js";
import { chartPane } from "./chart.js";
import { chartSettings, changeSettings, openChartSettings } from "./chartsettings.js";
import { drawingsAt } from "./drawings.js";
import { confirmDialog } from "./dialog.js";
import {
  FLAG_SVG, activeListId, activeListName, addSectionBefore, addToWatchlist, inActiveList, isFlagged, moveSymbol, removeSymbol,
  toggleFlag, watchlistChoices,
} from "./watchlists.js";

// What a right-click opens, by where it lands. The menu itself lives in contextmenu.js.

const ICONS = {
  chart: svgIcon("M3 17l5-6 4 3 4-7 5 5"),
  list: svgIcon("M4 6h12M4 12h8M4 18h8M18 14v6M15 17h6"),
  remove: svgIcon("M4 6h12M4 12h8M4 18h8M15 17h6"),
  copy: svgIcon("M9 9h10v11H9z", "M5 15V4h10"),
  line: svgIcon("M3 12h18"),
  lock: svgIcon("M6 11h12v9H6z", "M8 11V8a4 4 0 0 1 8 0v3"),
  unlock: svgIcon("M6 11h12v9H6z", "M8 11V8a4 4 0 0 1 7.5-2"),
  section: svgIcon("M4 6h16M4 12h8M4 18h16"),
  move: svgIcon("M4 12h14M13 7l5 5-5 5"),
  trash: svgIcon("M5 7h14M10 7V4h4v3M7 7l1 13h8l1-13"),
  edit: svgIcon("M4 20h4L19 9l-4-4L4 16z"),
  reset: svgIcon("M4 12a8 8 0 1 0 3-6.2M4 4v5h5"),
  image: svgIcon("M4 5h16v14H4z", "M4 16l5-5 4 4 3-3 4 4"),
  gear: svgIcon("M12 9a3 3 0 1 0 0 6 3 3 0 0 0 0-6z", "M19 12l2-1-1-3-2 .5-1.5-1.5.5-2-3-1-1 2h-2l-1-2-3 1 .5 2L6 8.5 4 8l-1 3 2 1v2l-2 1 1 3 2-.5L7.5 19l-.5 2 3 1 1-2h2l1 2 3-1-.5-2 1.5-1.5 2 .5 1-3-2-1z"),
};

// A symbol shown in a list: watchlist, scan list, screener, theme and result chips.
const ROWS = ".hw-row[data-symbol], .wl-row[data-symbol], .sc-line[data-symbol], .rc-chip[data-symbol]";

// Flag and watchlist commands, shared by list rows and the chart.
function symbolCommands(symbol) {
  return [
    { label: isFlagged(symbol) ? "Unflag" : "Flag", icon: FLAG_SVG, hint: "⇧F", run: () => toggleFlag(symbol) },
    {
      label: "Add to watchlist", icon: ICONS.list,
      items: watchlistChoices(symbol).map((list) => ({ label: list.name, checked: list.has, disabled: list.has, run: () => addToWatchlist(symbol, list.id) })),
    },
  ];
}

function symbolItems(symbol, row) {
  const here = row.matches(".hw-row") && inActiveList(symbol);
  return [
    { heading: ticker(symbol) },
    state.mode !== "chart" && { label: "Open chart", icon: ICONS.chart, run: () => actions.openSymbol(symbol) },
    ...symbolCommands(symbol),
    here && { label: "Add section here…", icon: ICONS.section, run: () => addSectionBefore(row.dataset.symbol) },
    here && {
      label: "Move to", icon: ICONS.move,
      items: watchlistChoices(symbol).filter((list) => list.id !== activeListId()).map((list) => ({ label: list.name, run: () => moveSymbol(row.dataset.symbol, list.id) })),
    },
    here && { label: `Remove from ${activeListName()}`, icon: ICONS.remove, danger: true, run: () => removeSymbol(row.dataset.symbol) },
    "-",
    { label: "Copy ticker", icon: ICONS.copy, run: () => copy(ticker(symbol)) },
  ];
}


function chartItems(event, pane) {
  const drawings = drawingsAt(pane, event);
  const symbol = state.mode === "practice" ? null : pane.shown().symbol;
  const { scale } = chartSettings;
  const drawing = drawings.item;
  return [
    drawing ? { heading: drawing.name } : symbol && { heading: ticker(symbol) },
    drawing && drawing.text && !drawing.locked && { label: "Edit text", icon: ICONS.edit, run: drawing.edit },
    drawing && !drawing.locked && { label: "Edit position…", icon: ICONS.edit, run: drawing.position },
    drawing && { label: "Duplicate", icon: ICONS.copy, run: drawing.duplicate },
    drawing && { label: drawing.locked ? "Unlock" : "Lock", icon: drawing.locked ? ICONS.unlock : ICONS.lock, run: drawing.lock },
    drawing && { label: "Delete", icon: ICONS.trash, danger: true, hint: "Del", disabled: drawing.locked, run: drawing.remove },
    drawing && "-",
    ...(symbol ? [...symbolCommands(symbol), { label: "Copy ticker", icon: ICONS.copy, run: () => copy(ticker(symbol)) }, "-"] : []),
    drawings.price != null && { label: `Draw horizontal line at ${fmtPrice(drawings.price)}`, icon: ICONS.line, run: drawings.addLine },
    drawings.count > 0 && {
      label: `Clear drawings (${drawings.count})`, icon: ICONS.trash, danger: true,
      run: async () => {
        const sure = await confirmDialog({
          title: `Clear ${drawings.count} drawing${drawings.count === 1 ? "" : "s"}?`, message: "Ctrl+Z brings them back.", ok: "Clear drawings", danger: true,
        });
        if (sure) actions.removeAllDrawings();
      },
    },
    "-",
    { label: "Reset chart view", icon: ICONS.reset, hint: "⌥R", run: () => pane.resetView() },
    { label: "Log scale", checked: scale.log, keep: true, hint: "⌥L", run: () => changeSettings((s) => { s.scale.log = !s.scale.log; }) },
    { label: "Invert scale", checked: scale.invert, keep: true, hint: "⌥I", run: () => changeSettings((s) => { s.scale.invert = !s.scale.invert; }) },
    "-",
    { label: "Copy chart image", icon: ICONS.image, hint: "⌥S", run: () => actions.copyChart() },
    { label: "Save chart image", icon: ICONS.image, hint: "⇧⌥S", run: () => actions.saveChart() },
    "-",
    { label: "Settings…", icon: ICONS.gear, run: () => openChartSettings() },
  ];
}

function copy(text) {
  navigator.clipboard.writeText(text).then(() => toast(`Copied ${text}`), () => toast("Couldn't copy"));
}

export function bindMenus() {
  document.addEventListener("contextmenu", (event) => {
    if (!wantsMenu(event) || event.defaultPrevented) return;
    const row = event.target.closest(ROWS);
    if (row) return openMenu(event, symbolItems(row.dataset.symbol, row));
    const pane = ["left", "right"].map(chartPane).find((each) => each && !each.root.hidden && each.root.contains(event.target));
    if (pane) openMenu(event, chartItems(event, pane));
  });
}
