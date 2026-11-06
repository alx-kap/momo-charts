"""The script editor, for tools/ui_check.py --steps tools/script_editor_steps.py.

Needs the service redeployed first. /api/scripts is answered here from memory, so nothing reaches
the real database; ui_check.py intercepts every other write. Screenshots go to
/tmp/momo-script-editor/.
"""

import json
import re
from pathlib import Path

page = globals()["page"]
log = globals()["log"]
out = Path("/tmp/momo-script-editor")
out.mkdir(exist_ok=True)

GOOD = '#momo 1\nindicator("Edit me", overlay=true)\nplot(ta.sma(close, 20), "Average")\n'
scripts = {}
errors = []
page.on("pageerror", lambda e: errors.append(str(e)))


def body(script):
    return {
        "id": script["id"], "name": script["name"], "head": len(script["versions"]),
        "source": script["versions"][-1]["source"], "draft": script["draft"], "errors": [],
        "favourite": script["favourite"], "has_draft": script["draft"] is not None,
        "in_trash": script["trash"], "updated_at": "2026-11-06T12:00:00+00:00",
    }


def add_version(script, source, note=""):
    script["versions"].append({
        "version": len(script["versions"]) + 1, "source": source, "note": note,
        "created_at": "2026-11-06T12:00:00+00:00", "size": len(source),
    })
    script["draft"] = None


def respond(route, value, status=200):
    route.fulfill(status=status, content_type="application/json", body=json.dumps(value))


def api(route):
    request = route.request
    path = re.sub(r"\?.*$", "", request.url.split("/api/scripts", 1)[1])
    method = request.method
    data = request.post_data_json if request.post_data else {}
    if path == "":
        if method == "GET":
            return respond(route, {"scripts": [
                {k: v for k, v in body(s).items() if k not in ("source", "draft")}
                | {"errors": 0} for s in scripts.values()
            ]})
        script = {"id": len(scripts) + 1, "name": data["name"], "versions": [], "draft": None,
                  "favourite": False, "trash": False}
        add_version(script, data["source"], data.get("note", ""))
        scripts[script["id"]] = script
        return respond(route, body(script))
    parts = path.strip("/").split("/")
    script = scripts.get(int(parts[0]))
    if script is None:
        return respond(route, {"detail": "No such script"}, 404)
    if len(parts) == 1:
        if method == "PATCH":
            changed = {k: v for k, v in data.items() if v is not None}
            script.update({k: v for k, v in changed.items() if k in ("name", "favourite")})
        if method == "DELETE":
            script["trash"] = True
        return respond(route, body(script))
    if parts[1] == "draft":
        head = script["versions"][-1]["source"]
        script["draft"] = None if data["source"] == head else data["source"]
        return respond(route, {"saved": True})
    if parts[1] == "versions" and len(parts) == 3:
        return respond(route, script["versions"][int(parts[2]) - 1])
    if parts[1] == "versions" and method == "GET":
        return respond(route, {"versions": [
            {k: v for k, v in version.items() if k != "source"}
            for version in reversed(script["versions"])
        ]})
    if parts[1] == "versions":
        add_version(script, data["source"], data.get("note", ""))
        return respond(route, {**body(script), "saved": True})
    if parts[1] == "restore":
        version = script["versions"][data["version"] - 1]
        add_version(script, version["source"], f"Restored v{data['version']}")
        return respond(route, {**body(script), "saved": True})
    return respond(route, {"detail": "?"}, 400)


page.route(re.compile(r"/api/scripts(/|\?|$)"), api)
page.evaluate(
    "localStorage.setItem('momo.scriptOpen', 'null');"
    "localStorage.setItem('momo.scriptDock', 'false')"
)
page.reload()
page.wait_for_selector("#script-button")
page.wait_for_timeout(1500)

scripts[1] = {
    "id": 1, "name": "Edit me", "versions": [], "draft": None, "favourite": False, "trash": False,
}
add_version(scripts[1], GOOD, "first")

INPUT = "#sd-editor textarea"


def wait(ms=500):
    page.wait_for_timeout(ms)


def code_text():
    return page.locator("#sd-editor .ed-code").inner_text()


def legend():
    return page.evaluate("[...document.querySelectorAll('.lg-row .label')].map(l => l.textContent)")


# Open it from the dock's menu.
page.locator("#script-button").click()
wait()
assert page.locator("#script-dock").is_visible()
page.locator("#sd-open").click()
page.locator("#sd-menu button", has_text="Edit me").click()
wait()
assert "Edit me" in page.locator("#sd-name").inner_text()
assert page.locator("#sd-status").inner_text() == "v1"
assert page.locator("#sd-editor .t-fn").count() >= 1, "highlighting"
log("opened; highlight spans: " + str(page.locator("#sd-editor .ed-code span").count()))

# 5.3 Add to chart, and it draws.
page.locator("#sd-add").click()
wait(1200)
assert any("Edit me" in label for label in legend()), legend()
assert page.locator("#sd-add").is_disabled()

# 5.1 Typing: the highlight follows, Enter indents, pairs close, ⌘/ comments.
page.locator(INPUT).click()
page.keyboard.press("Control+End")
page.keyboard.type("if close > open:")
page.keyboard.press("Escape")
page.keyboard.press("Enter")
page.keyboard.type("x = (1")
value = page.locator(INPUT).input_value()
assert value.endswith("if close > open:\n    x = (1)"), repr(value[-40:])
wait(100)
assert "if close > open:" in code_text()
page.keyboard.press("Control+/")
value = page.locator(INPUT).input_value()
assert "    # x = (1)" in value, repr(value[-40:])
page.keyboard.press("Control+z")
page.keyboard.press("Control+z")
page.keyboard.press("Control+z")
log("after undo: " + repr(page.locator(INPUT).input_value()[-30:]))

# Back to clean text.
page.locator(INPUT).fill(GOOD)
wait(400)
assert page.locator("#sd-status").inner_text() == "v1"

# 5.2 A typo: E-code under the right word, the chart keeps drawing; fixing it shows the draft.
page.locator(INPUT).fill(GOOD.replace("close, 20", "clsoe, 20"))
wait(500)
problem = page.locator("#sd-problems .sd-problem").first.inner_text()
assert "E201" in problem, problem
assert page.locator("#sd-editor .ed-marks u").inner_text() == "clsoe"
assert page.locator("#sd-editor .ed-gutter .bad").inner_text() == "3"
assert page.locator("#sd-tab-problems").inner_text() == "Problems (1)"
page.locator("#sd-problems .sd-problem").first.click()
page.locator(INPUT).fill(GOOD.replace("close, 20", "close, 30"))
wait(900)
assert page.locator("#sd-problems .sd-problem").count() == 0
assert any("Draft" in label for label in legend()), legend()
assert page.locator("#sd-status").inner_text() == "v1 · Draft"

# The draft reaches the server.
wait(2300)
assert scripts[1]["draft"] and "close, 30" in scripts[1]["draft"], scripts[1]["draft"]
log("draft saved")

# 5.3 ⌘S saves v2 and the chart leaves the draft.
page.locator(INPUT).click()
page.keyboard.press("Control+s")
wait(900)
assert len(scripts[1]["versions"]) == 2
assert page.locator("#sd-status").inner_text() == "v2"
assert not any("Draft" in label for label in legend()), legend()
assert scripts[1]["draft"] is None

# A reload brings back the draft.
page.locator(INPUT).fill(GOOD.replace("close, 20", "close, 40"))
wait(2500)
page.reload()
page.wait_for_selector("#script-button")
wait(1800)
assert page.locator("#script-dock").is_visible(), "the dock stays open"
assert "close, 40" in page.locator(INPUT).input_value()
assert page.locator("#sd-status").inner_text() == "v2 · Draft"
log("draft survived a reload")

# 5.4 History: diff, ghost, restore over a draft asks first.
page.locator("#sd-history").click()
wait()
assert page.locator(".sd-version").count() == 2
CHART = {"x": 40, "y": 60, "width": 1000, "height": 400}
before_ghost = page.screenshot(clip=CHART)
page.locator('.sd-version[data-version="1"]').click()
wait(1000)
assert page.screenshot(clip=CHART) != before_ghost, "the old version is dashed on the chart"
assert page.locator("#sd-diff .sd-line.del").count() >= 1
assert page.locator("#sd-diff .sd-line.add").count() >= 1
page.screenshot(path=str(out / "history.png"))
page.locator(".sd-restore").click()
wait(200)
assert page.locator(".dlg-back .dlg").is_visible(), "asks before dropping the draft"
page.locator(".dlg-ok").click()
wait(1000)
assert len(scripts[1]["versions"]) == 3 and scripts[1]["versions"][-1]["source"] == GOOD
assert page.locator(INPUT).input_value() == GOOD
assert page.locator("#sd-status").inner_text() == "v3"
assert page.locator("#sd-side").is_hidden()
log("restored v1 as v3")

# 5.6 Autocomplete and hover docs.
page.locator(INPUT).click()
page.keyboard.press("Control+End")
page.keyboard.type("y = ta.s")
wait(150)
offers = page.locator(".ed-offer b").all_inner_texts()
assert {"ta.sma", "ta.stdev", "ta.sum"} <= set(offers), offers
page.screenshot(path=str(out / "autocomplete.png"))
page.keyboard.press("Enter")
typed = page.locator(INPUT).input_value()
assert typed.endswith("y = ta.sma()"), typed[-20:]
page.keyboard.press("Control+a")
page.keyboard.press("Delete")
page.locator(INPUT).fill(GOOD + 'log("hello", close)\n')
wait(600)
box = page.locator(INPUT).bounding_box()
page.mouse.move(box["x"] + 8 + 7.8 * 7, box["y"] + 8 + 20 * 2 + 10)
wait(600)
hover = page.locator(".ed-hover")
log("hover: " + (hover.inner_text() if hover.is_visible() else "(not shown)"))
assert hover.is_visible() and "plot" in hover.inner_text() or "ta.sma" in hover.inner_text()

# 5.7 Console and Test.
page.locator("#sd-tab-console").click()
assert "hello" in page.locator("#sd-console").inner_text(), page.locator("#sd-console").inner_text()
page.locator("#sd-test").click()
page.wait_for_selector("#sd-test-out .sd-summary", timeout=30000)
summary = page.locator("#sd-test-out .sd-summary").inner_text()
log("test: " + summary)
assert summary.startswith("1 symbol · 0 failed"), summary
page.screenshot(path=str(out / "test.png"))

# 5.5 The picker: my scripts, a star, the search.
page.locator(INPUT).fill(GOOD)
wait(400)
page.locator("#indicators-button").click()
wait(800)
assert page.locator('[data-stored="1"]').count() == 1
page.locator('[data-fav="script:1"]').first.click()
wait(500)
assert scripts[1]["favourite"]
assert page.locator('.cs-h', has_text="Favorites").is_visible()
page.locator('[data-fav="library:bb"]').first.click()
wait(200)
assert page.locator('.cs-star.on').count() >= 2
page.locator('[data-fav="library:bb"]').first.click()
wait(200)
page.locator("#cs-ind-q").fill("boll")
wait(100)
assert page.locator(".cs-pick:visible").count() >= 1
assert page.locator('[data-stored="1"]:visible').count() == 0
page.screenshot(path=str(out / "picker.png"))
page.locator("#cs-ind-q").fill("")
page.keyboard.press("Escape")  # leaves the search box
page.keyboard.press("Escape")  # closes the dialog
wait(300)

# Closing the dock leaves the chart on the head; the right size for the chart comes back.
page.locator("#sd-close").click()
wait(400)
assert page.locator("#script-dock").is_hidden()

if errors:
    raise AssertionError(errors)
log("script editor checks passed")
