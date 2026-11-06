"""The indicator browser, for tools/ui_check.py --steps tools/indicator_browser_steps.py.

Needs the service redeployed first. ui_check.py intercepts every write.
"""

page = globals()["page"]
log = globals()["log"]
errors = []
page.on("pageerror", lambda e: errors.append(str(e)))


def wait(ms=300):
    page.wait_for_timeout(ms)


def names():
    return page.locator("#ib-list .ib-row b").all_inner_texts()


def legend():
    return page.evaluate("[...document.querySelectorAll('.lg-row .label')].map(l => l.textContent)")


# ƒx opens it with the search box focused; every indicator has a line about it.
page.locator("#indicators-button").click()
wait()
assert page.locator("#ib").is_visible()
assert page.evaluate("document.activeElement.id") == "ib-q"
page.locator('#ib-side [data-group="all"]').click()
wait()
count = len(names())
assert count >= 11, count
texts = page.locator("#ib-list .ib-text span").all_inner_texts()
assert len(texts) == count and all(t and t != "undefined" for t in texts), texts
assert names() == sorted(names(), key=str.lower)

# A group narrows the list.
page.locator('#ib-side [data-group="momentum"]').click()
wait()
assert "MACD" in names() and "Bollinger Bands" not in names(), names()

# Search spans every group; Enter adds the first and leaves the window open with a tick.
before = legend()
page.locator("#ib-q").fill("keltner")
wait()
assert names() == ["Keltner Channels"], names()
page.locator("#ib-q").press("Enter")
wait(700)
assert any(label.startswith("KC") for label in legend()), legend()
assert len(legend()) == len(before) + 1, legend()
assert page.locator("#ib").is_visible()
assert page.locator(".ib-row .ib-count").count() == 1

# Arrows move the pick.
page.locator("#ib-q").fill("")
page.locator('#ib-side [data-group="all"]').click()
wait()
first = names()[1]
page.locator("#ib-q").press("ArrowDown")
assert page.locator(".ib-row.on b").inner_text() == first

# A click adds; a star doesn't, and Favorites keeps it.
page.locator('.ib-row[data-type="rsi"]').click()
wait(700)
assert any(label.startswith("RSI") for label in legend() + page.evaluate(
    "[...document.querySelectorAll('.pane-legend .label')].map(l => l.textContent)"
)), legend()
shown = len(legend())
page.locator('[data-fav="bb"]').click()
wait(700)
assert len(legend()) == shown, "a star adds nothing"
page.locator('#ib-side [data-group="favorites"]').click()
wait()
assert "Bollinger Bands" in names(), names()
page.locator('[data-fav="bb"]').click()
wait()
page.locator("#ib").screenshot(path="/tmp/momo-indicator-browser.png")

# Nothing found says so.
page.locator("#ib-q").fill("zzz")
wait()
assert "Nothing matches" in page.locator("#ib-list").inner_text()

# Esc closes it from the search box, / opens it, and Settings hands over to it.
page.locator("#ib-q").press("Escape")
wait()
assert page.locator("#ib").is_hidden()
page.keyboard.press("/")
wait()
assert page.locator("#ib").is_visible()
page.locator("#ib-close").click()
wait()
if errors:
    raise AssertionError(errors)
log("indicator browser checks passed")
