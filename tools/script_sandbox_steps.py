"""momo script sandbox check, for tools/ui_check.py --steps tools/script_sandbox_steps.py.

Runs tools/script_sandbox_probe.js in the page (see there for what it does) and fails if any
check does not pass. Needs the service redeployed first, since static files come from the
installed package.
"""

import json
from pathlib import Path

page = globals()["page"]
log = globals()["log"]

probe = (Path(__file__).parent / "script_sandbox_probe.js").read_text()
host_url = page.evaluate("new URL('/static/js/script/host.js', location.href).href")
results = page.evaluate(probe, host_url)
failed = [r for r in results if not r["pass"]]
for r in results:
    detail = f" · {r['detail']}" if not r["pass"] and r["detail"] else ""
    log(("ok   " if r["pass"] else "FAIL ") + r["name"] + detail)
log(f"{len(results) - len(failed)}/{len(results)} sandbox checks passed")
if failed:
    raise SystemExit("sandbox check failed: " + json.dumps([r["name"] for r in failed]))
