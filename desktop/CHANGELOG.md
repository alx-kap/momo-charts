# momo desktop: what changed

Newest first. Changes are added under **Unreleased** as they land. A release renames that
section to its version, and the section becomes the release's notes on GitHub.

Changes to momo itself (charts, lists, keys) reach the app from its server without a new
version; this file is for the app around it.

## Unreleased

### What's new
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
