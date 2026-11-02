# momo desktop: what changed

Newest first. Changes are added under **Unreleased** as they land. A release renames that
section to its version, and the section becomes the release's notes on GitHub.

Changes to momo itself (charts, lists, keys) reach the app from its server without a new
version; this file is for the app around it.

## Unreleased

## 0.1.3 · 2026-11-02

### What's new
- Tab syncing on the tab itself: click the slot at a tab's left edge to pick a colour, and
  tabs of one colour follow each other's symbol and, with their switches on, interval,
  scrolling and dates in view. A linked tab shows its colour in the slot and along its top
  edge. (Before this version, momo's chain button does the linking.)
- Right-click a tab for its menu: Duplicate tab (⌘U), Reload tab, Pin tab, Detach tab (into
  its own window), Customize tab title, Close, Close other tabs, Close tabs to the right.
- Tabs are named by their chart: symbol and timeframe, such as "NVDA 1D".
- Pinned tabs and custom titles come back with the rest of your tabs.
- Running from source (`npm run dev` in `desktop/`) pulls the latest code first, keeps its own
  tabs and settings so it opens beside an installed momo, and marks its tab strip "dev".

## 0.1.2 · 2026-11-02

### Fixed
- Chart keys are TradingView's again: ⌥T trend line, ⌥W add to watchlist and so on. On a Mac,
  ⌘T, ⌘W, ⌘N and ⌘1–9 are tabs and windows.
- The window buttons on a Mac sit centred on the tabs.

## 0.1.1 · 2026-11-02

Tried ⌘ for chart keys on a Mac; 0.1.2 went back to ⌥.

## 0.1.0 · 2026-11-02

### What's new
- momo in native tabs drawn in the title bar: switch, drag to reorder, middle-click to close,
  ⌘T / ⌘W / ⇧⌘T / ⌘1–9 / ⌃Tab (Ctrl on Windows), and ⌘N for another window.
- Windows and tabs come back where they were, each tab on its own chart.
- A connect page for the first launch, and a calm page that reconnects by itself when the
  server stops answering.
- Native menus: Settings (⌘,), Keyboard Shortcuts, Check for Updates.
- An "Update available" pill when a new version is out.
