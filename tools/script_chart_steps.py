"""momo script indicators on the chart, for tools/ui_check.py --steps tools/script_chart_steps.py.

Needs the service redeployed first (static files come from the installed package). All API
writes are intercepted by ui_check.py. Screenshots go to /tmp/momo-script-chart/.
"""

from pathlib import Path

page = globals()["page"]
log = globals()["log"]
out = Path("/tmp/momo-script-chart")
out.mkdir(exist_ok=True)

MOD = "/static/js/chartsettings.js"


def open_symbol(symbol: str) -> None:
    page.locator("#symbol-button").click()
    page.locator("#ss-input").fill(symbol)
    page.wait_for_timeout(500)
    page.locator("#ss-input").press("Enter")
    page.wait_for_function(
        "s => document.querySelector('#symbol-label').textContent.includes(s)", arg=symbol,
    )
    page.wait_for_timeout(800)


def call(expr: str):
    return page.evaluate(f"async () => {{ const m = await import('{MOD}'); return {expr}; }}")


def legend() -> list[list[str]]:
    """Legend rows by label: the label text and the values shown."""
    return page.evaluate(
        """() => [...document.querySelectorAll('.lg-row')].filter(r => r.querySelector('.label'))
        .map(r => [r.querySelector('.label').textContent,
          [...r.querySelectorAll('.v, .lg-err')].map(v => v.textContent).join(' ')])"""
    )


def settle() -> None:
    page.wait_for_timeout(700)


errors = []
page.on("pageerror", lambda e: errors.append(str(e)))

open_symbol("NVDA")
# Fresh page: remove the default moving averages so the legend is easy to read.
call("m.addIndicator('bb')")
call("m.addLibrary('bb')")
settle()
rows = legend()
log(f"legend: {rows}")
# Both BB rows carry the same three values.
bbs = [v for k, v in rows if k.startswith("BB 20")]
log(f"BB rows: {bbs}")
assert len(bbs) == 2 and bbs[0] == bbs[1] and "—" not in bbs[0], bbs
page.screenshot(path=str(out / "bb-daily.png"))

call("m.addLibrary('rsi')")
call("m.addLibrary('macd')")
settle()
rows = legend()
log(f"legend: {rows}")
assert any(k.startswith("RSI") for k, _ in rows)
panes = page.locator(".pane-legend").count()
log(f"pane legends: {panes}")
page.screenshot(path=str(out / "rsi-macd-daily.png"))

# Editing an input in the settings dialog redraws the chart.
call("m.openChartSettings('indicators')")
page.wait_for_timeout(300)
box = page.locator('#cs input[data-kind="int"][data-param="length"]').first
assert box.count() == 1
# the first script row with a Length input is BB's (settings order: SMAs, built-in BB, script BB)
rows_in_dialog = page.locator("#cs .cs-ind").count()
script_bb = page.locator('#cs .cs-ind:has(input[data-kind="float"])').last
script_bb.locator('input[data-param="length"]').fill("30")
script_bb.locator('input[data-param="length"]').press("Tab")
settle()
rows = legend()
log(f"after edit: {[r for r in rows if r[0].startswith('BB')]}")
assert ["BB 30 2" in r[0] for r in rows].count(True) == 1
script_bb.locator('input[data-param="length"]').fill("20")
script_bb.locator('input[data-param="length"]').press("Tab")
settle()
# a colour input and a choice work too (MACD's histogram colours are inputs)
macd = page.locator('#cs .cs-ind:has(input[data-param="fast"])')
assert macd.locator(".swatch").count() == 4, macd.locator(".swatch").count()
page.screenshot(path=str(out / "dialog.png"))
call("m.closeChartSettings()")

# Broken scripts show one red row each and nothing else changes.
BROKEN = {
    "kc": '#momo 1\nindicator("Broken", overlay=true)\nplot(clos)\n',
    "atr": '#momo 1\nindicator("Slow")\nfor i in range(2000000):\n    pass\nplot(close)\n',
}
for name, source in BROKEN.items():
    page.route(f"**/static/scripts/{name}.momo", lambda route, _request, body=source: route.fulfill(
        status=200, content_type="text/plain", body=body))
call("(await m.addLibrary('kc'), await m.addLibrary('atr'))")
settle()
rows = legend()
log(f"errors: {[r for r in rows if r[1].startswith(('E', 'R', 'L'))]}")
errs = page.locator(".lg-err")
assert errs.count() == 2, errs.count()
texts = [errs.nth(i).inner_text() for i in range(2)]
log(f"error rows: {texts}")
assert texts[0].startswith("E201") and texts[1].startswith("R402"), texts
color = errs.first.evaluate("e => getComputedStyle(e).color")
assert color == "rgb(239, 83, 80)", color
bbs = [v for k, v in rows if k.startswith("BB")]
assert len(bbs) == 2 and all("—" not in v for v in bbs), bbs
page.screenshot(path=str(out / "errors.png"))

# Bar Replay: scripts re-run on the bars shown. A script that reads last_bar is 1 on whatever
# bar the replay has reached; the library BB still matches the built-in at every step.
page.unroute("**/static/scripts/kc.momo")
page.unroute("**/static/scripts/atr.momo")
LAST = (
    '#momo 1\nindicator("Last bar", overlay=false, short="LB")\nplot(1 if last_bar else 0, "x")\n'
)
page.route("**/static/scripts/sma.momo", lambda route, _request: route.fulfill(
    status=200, content_type="text/plain", body=LAST))
call("m.addLibrary('sma')")
settle()
assert dict(legend())["LB"].startswith("1")
page.mouse.move(600, 300)
page.keyboard.press("Shift+ArrowDown")
page.wait_for_timeout(300)
page.mouse.click(600, 300)
page.wait_for_timeout(2500)
page.screenshot(path=str(out / "replay-start.png"))


def replay_state() -> tuple[str, list[str]]:
    rows = legend()
    lb = [v for k, v in rows if k == "LB"]
    bbs = [v for k, v in rows if k.startswith("BB 20")]
    return lb[0], bbs


lb, bbs = replay_state()
log(f"replay start: LB={lb} BB={bbs}")
assert lb.startswith("1") and bbs[0] == bbs[1], (lb, bbs)
for step in range(3):
    day = page.locator('input[type="date"]').last.input_value()
    page.get_by_role("button", name="Forward").click()
    page.wait_for_timeout(800)
    lb, bbs = replay_state()
    after = page.locator('input[type="date"]').last.input_value()
    log(f"replay step {step + 1}: {day} -> {after} LB={lb} BB={bbs}")
    assert after != day and lb.startswith("1") and bbs[0] == bbs[1], (lb, bbs)
page.screenshot(path=str(out / "replay-steps.png"))
page.keyboard.press("Escape")
page.wait_for_timeout(1500)

# A 5-minute chart draws the same scripts (the library BB still matches the built-in).
page.locator('.iv-quick button[data-interval="5m"]').click()
page.wait_for_timeout(2500)
rows = legend()
log(f"5m legend: {[r for r in rows if r[0].startswith(('BB', 'RSI', 'MACD'))]}")
bbs = [v for k, v in rows if k.startswith("BB 20")]
assert len(bbs) == 2 and bbs[0] == bbs[1] and "—" not in bbs[0], bbs
assert any(k.startswith("RSI") and "—" not in v for k, v in rows)
page.screenshot(path=str(out / "bb-5m.png"))

# (The stand-ins for kc, atr and sma are cached in the page: reload for the real library.)
page.unroute("**/static/scripts/sma.momo")
page.reload()
page.wait_for_timeout(3000)
# Timing of a rebuild: every library script over the daily bars and the 5-minute bars, run with
# new inputs each time so the host's cache can't answer.
timing = page.evaluate("""async () => {
  const { runScript } = await import('/static/js/scripts.js');
  const { fetchBars } = await import('/static/js/feed.js');
  const { LIBRARY } = await import('/static/js/indicators.js');
  const out = {};
  for (const [interval, count] of [['1D', 520], ['5m', 4000]]) {
    const data = await fetchBars('NVDA', null, interval, count);
    let total = 0;
    for (const item of LIBRARY) {
      const params = { length: 17 + total % 3 };
      const ind = { type: 'script', library: item.key, params, style: {} };
      const t = performance.now();
      const run = await runScript(ind, data.bars, { interval, ticker: 'NVDA' });
      const ms = performance.now() - t;
      if (!run.ok) throw new Error(item.key + ' ' + run.error.message);
      total += ms;
    }
    // the same eight again, cold cache: bump an input
    out[interval] = { bars: data.bars.length, allEightMs: Math.round(total) };
  }
  return out;
}""")
log(f"timing: {timing}")

assert not errors, errors
log("script chart checks passed")
