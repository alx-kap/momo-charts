"""Today's candle arrives with the chart, for tools/ui_check.py --steps <this file>.

Needs the market open and live quotes. A quote that reaches the page before its bars must be in
those bars when they load, so a chart never paints without today's candle. Writes nothing.
"""

page = globals()["page"]
log = globals()["log"]

result = page.evaluate(
    """async () => {
      const feed = await import('/static/js/feed.js');
      const live = await import('/static/js/live.js');
      const symbol = 'NASDAQ:INTC';
      live.watchLive('check', [symbol]);
      await new Promise((resolve) => setTimeout(resolve, 2500));
      const data = await feed.fetchBars(symbol, null, '1D', 1300);
      const last = data.bars.at(-1);
      live.watchLive('check', []);
      return { time: last.time, live: Boolean(last.live), last_day: data.last_day };
    }"""
)
log(str(result))
today = page.evaluate(
    "new Intl.DateTimeFormat('en-CA', { timeZone: 'America/New_York' }).format(new Date())"
)
assert result["time"] == today, (result, today)
log("today's candle was in the bars at load")
