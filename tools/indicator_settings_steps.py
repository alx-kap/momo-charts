"""An indicator's settings popover, for tools/ui_check.py --steps <this file>.

Needs the service redeployed first. ui_check.py intercepts every write.
"""

page = globals()["page"]
log = globals()["log"]
errors = []
page.on("pageerror", lambda e: errors.append(str(e)))
BOX = "#ip"


def wait(ms=300):
    page.wait_for_timeout(ms)


def labels():
    return page.evaluate("[...document.querySelectorAll('.lg-row .label')].map(l => l.textContent)")


def open_from_legend(prefix):
    row = page.locator(".lg-row", has=page.locator(".label", has_text=prefix)).first
    row.hover()
    row.locator('[data-lg="edit"]').click()
    wait()
    assert page.locator(BOX).is_visible()


# The legend gear opens it beside the row, and the chart stays in view.
assert "Indicators" not in page.evaluate("document.querySelector('#cs-tabs')?.textContent || ''")
page.locator("#indicators-button").click()
wait()
page.locator("#ib-q").fill("bollinger")
wait()
page.locator("#ib-q").press("Enter")
wait(600)
page.locator("#ib-close").click()
wait()
open_from_legend("BB")
assert "BB" in page.locator(f"{BOX} b").inner_text()
assert page.locator(f"{BOX} input[type=number]").count() >= 1

# A new length applies as it's typed; an invalid one is ignored and put back.
first = page.locator(f"{BOX} input[type=number]").first
first.fill("33")
wait(500)
assert any("33" in label for label in labels()), labels()
assert "33" in page.locator(f"{BOX} b").inner_text()
first.fill("0")
wait()
first.blur()
wait()
assert first.input_value() == "33"
assert any("33" in label for label in labels()), labels()

# Colour: the picker opens over it and leaves it open.
page.locator(f"{BOX} .swatch").first.click()
wait()
assert page.locator("#color-picker").is_visible()
page.locator("#color-picker [data-color], #color-picker button").nth(14).click()
wait()
assert page.locator(BOX).is_visible()
page.keyboard.press("Escape")
wait()
assert page.locator("#color-picker").is_hidden() and page.locator(BOX).is_visible()

# Line width, a timeframe chip and the eye.
page.locator(f"{BOX} select").select_option("3")
wait()
chip = page.locator(f'{BOX} [data-tf="1m"]')
assert "on" in chip.get_attribute("class")
chip.click()
wait()
assert "on" not in (page.locator(f'{BOX} [data-tf="1m"]').get_attribute("class") or "")
page.locator(f"{BOX} [data-eye]").click()
wait()
assert page.locator(f"{BOX} [data-eye]").inner_text() == "○"
page.locator(f"{BOX} [data-eye]").click()
wait()
page.screenshot(path="/tmp/momo-indicator-settings.png")

# The value beside the name can be hidden for this indicator alone.
values = "[...document.querySelectorAll('.lg-row')].filter(r => r.textContent.includes('BB'))"
assert page.evaluate(f"{values}[0].querySelectorAll('.v').length") == 3
page.locator(f"{BOX} [data-value]").uncheck()
wait(500)
assert page.evaluate(f"{values}[0].querySelectorAll('.v').length") == 0
page.locator(f"{BOX} [data-value]").check()
wait(500)
assert page.evaluate(f"{values}[0].querySelectorAll('.v').length") == 3

# Esc closes it, and so does a click elsewhere.
page.keyboard.press("Escape")
wait()
assert page.locator(BOX).is_hidden()
open_from_legend("BB")
page.mouse.click(600, 300)
wait()
assert page.locator(BOX).is_hidden()

# A double-click on the line opens it; away from any line it doesn't.
found = False
for y in range(100, 460, 3):
    page.mouse.dblclick(500, y)
    page.wait_for_timeout(30)
    if page.locator(BOX).is_visible():
        found = True
        break
assert found, "no line found at x=500"
log("double-click opened: " + page.locator(f"{BOX} b").inner_text())
page.keyboard.press("Escape")
wait()

# The browser's On the chart list opens it too, for a row with no legend.
page.locator("#indicators-button").click()
wait()
page.locator('#ib-side [data-group="chart"]').click()
wait()
assert page.locator("#ib-list .ib-row").count() >= 1
page.locator("#ib-list .ib-row").first.click()
wait()
assert page.locator(BOX).is_visible() and page.locator("#ib").is_visible()
page.keyboard.press("Escape")
wait()
assert page.locator(BOX).is_hidden() and page.locator("#ib").is_visible()
page.locator("#ib-close").click()
wait()

# Remove.
open_from_legend("BB")
page.locator(f"{BOX} [data-remove]").click()
wait(500)
assert page.locator(BOX).is_hidden()
assert not any(label.startswith("BB") for label in labels()), labels()

# Ctrl+Z brings it back, Ctrl+Shift+Z removes it again, and typing a length is one step.
page.mouse.click(600, 300)
page.keyboard.press("Control+z")
wait(500)
assert any(label.startswith("BB") for label in labels()), labels()
page.keyboard.press("Control+Shift+z")
wait(500)
assert not any(label.startswith("BB") for label in labels()), labels()
page.keyboard.press("Control+z")
wait(500)
open_from_legend("BB")
first = page.locator(f"{BOX} input[type=number]").first
first.fill("4")
first.fill("44")
wait(500)
assert any("44" in label for label in labels()), labels()
page.mouse.click(600, 300)
wait()
page.keyboard.press("Control+z")
wait(500)
assert any("33" in label for label in labels()) and not any("44" in x for x in labels()), labels()

# A drawing and an indicator undo in the order they happened.
open_from_legend("BB")
page.locator(f"{BOX} [data-remove]").click()
wait(400)
shapes = page.locator("#drawings > *").count()
page.keyboard.press("Alt+h")
wait(100)
page.mouse.click(600, 300)
wait(400)
page.keyboard.press("Escape")
assert page.locator("#drawings > *").count() > shapes, "the line was drawn"
page.keyboard.press("Control+z")
wait(500)
assert page.locator("#drawings > *").count() == shapes, "the drawing goes first"
assert not any(label.startswith("BB") for label in labels()), labels()
page.keyboard.press("Control+z")
wait(500)
assert any(label.startswith("BB") for label in labels()), "then the indicator"

if errors:
    raise AssertionError(errors)
log("indicator settings checks passed")
