"""Headless check of the live momo UI: load a mode, report JS errors, save a screenshot.

Every PUT/POST/DELETE to /api is intercepted and answered with {}, so a check can click,
draw and call freely without touching Alex's real reviews, practice history or settings.

    uvx --from playwright==1.55.0 python -I tools/ui_check.py --mode review
    uvx --from playwright==1.55.0 python -I tools/ui_check.py --steps my_steps.py

A steps file is plain Python run with `page` (a Playwright page) and `log` in scope.
"""

from __future__ import annotations

import argparse
import runpy
from pathlib import Path

from playwright.sync_api import sync_playwright

CHROME = Path.home() / ".cache/ms-playwright/chromium-1243/chrome-linux64/chrome"
URL = "http://127.0.0.1:8790/"


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("--mode", choices=["chart", "review"], default="chart")
    parser.add_argument("--steps", type=Path, help="Python file to run against the page")
    parser.add_argument("--shot", type=Path, default=Path("/tmp/momo-ui-check.png"))
    parser.add_argument("--url", default=URL, help="momo to check (another port for a test server)")
    parser.add_argument("--size", default="1500x900", help="Viewport, WIDTHxHEIGHT")
    args = parser.parse_args()
    width, height = (int(n) for n in args.size.split("x"))

    errors: list[str] = []
    writes: list[str] = []

    def guard(route) -> None:  # type: ignore[no-untyped-def]
        request = route.request
        if request.method == "GET":
            return route.continue_()
        writes.append(f"{request.method} {request.url.split('/api/', 1)[1]}")
        return route.fulfill(status=200, content_type="application/json", body="{}")

    with sync_playwright() as playwright:
        browser = playwright.chromium.launch(executable_path=str(CHROME))
        page = browser.new_page(viewport={"width": width, "height": height})
        page.on("pageerror", lambda error: errors.append(str(error)))
        page.on("console", lambda msg: msg.type == "error" and errors.append(msg.text))
        page.route("**/api/**", guard)
        page.add_init_script(f"localStorage.setItem('momo.mode', JSON.stringify('{args.mode}'))")
        page.goto(args.url)
        page.wait_for_timeout(2500)
        if args.steps:
            runpy.run_path(str(args.steps), init_globals={"page": page, "log": print})
        page.screenshot(path=str(args.shot))
        browser.close()

    print(f"screenshot: {args.shot}")
    print(f"intercepted writes: {', '.join(sorted(set(writes))) or 'none'}")
    print(f"errors: {len(errors)}")
    for error in errors:
        print(f"  {error}")
    raise SystemExit(1 if errors else 0)


if __name__ == "__main__":
    main()
