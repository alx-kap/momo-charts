"""momo script indicators on a live chart, for tools/ui_check.py --url http://127.0.0.1:8791/
--steps tools/script_live_steps.py, against `momo serve --port 8791 --live sim`.

Checks that live ticks re-run the scripts, at most about 4 times a second for each, and that the
library BB keeps matching the built-in as the newest bar moves. Screenshots: /tmp/momo-script-live/.
"""

from pathlib import Path

page = globals()["page"]
log = globals()["log"]
out = Path("/tmp/momo-script-live")
out.mkdir(exist_ok=True)

page.locator("#symbol-button").click()
page.locator("#ss-input").fill("NVDA")
page.wait_for_timeout(500)
page.locator("#ss-input").press("Enter")
page.wait_for_timeout(1500)
page.evaluate(
    """async () => {
  const m = await import('/static/js/chartsettings.js');
  m.addIndicator('bb');
  await m.addLibrary('bb');
  await m.addLibrary('rsi');
  const host = (await import('/static/js/script/host.js')).sharedHost();
  const run = host.run.bind(host);
  window.__runs = 0;
  host.run = (...args) => { window.__runs++; return run(...args); };
}"""
)
page.wait_for_timeout(1000)
before = page.evaluate("window.__runs")
page.wait_for_timeout(5000)
runs = page.evaluate("window.__runs") - before
log(f"runs in 5 s with two scripts on a live chart: {runs}")
assert runs > 0, "live ticks never re-ran the scripts"
assert runs <= 2 * 4 * 5 + 4, runs  # two scripts, 4 a second
rows = page.evaluate(
    """() => [...document.querySelectorAll('.lg-row')].filter(r => r.querySelector('.label'))
    .map(r => [r.querySelector('.label').textContent,
      [...r.querySelectorAll('.v')].map(v => v.textContent).join(' ')])"""
)
bbs = [v for k, v in rows if k.startswith("BB 20")]
log(f"BB rows: {bbs}")
assert len(bbs) == 2 and bbs[0] == bbs[1], bbs
page.screenshot(path=str(out / "live.png"))
