# Golden cases

One case is two files: `NAME.momo` (the script) and `NAME.json`. Both implementations of momo
script run every case: JavaScript in `tests/js/script/golden.test.mjs`, Python in
`tests/test_script_python.py`. A case passes when both give what the JSON expects, so the two
can't drift.

```json
{
  "about": "One line on what the case pins down.",
  "bars": "ramp",
  "inputs": { "length": 5 },
  "extra": { "chart": { "interval": "5m", "ticker": "NVDA" } },
  "expect": { ... }
}
```

- `bars` names a file in `bars/` (`bars-NAME.json`, columns `time open high low close volume`).
  Regenerate with `node tests/js/script/make-fixtures.mjs`.
- `inputs` and `extra` are optional and passed to `run()` as they are.
- Numbers match to 1e-9 (relative above 1). `null` in an expected series means `na`.

`expect` holds one of:

- `errors`: a list of `{ code, line, col }`, exactly the compile errors, in order.
- `runError`: a subset of the run error (`code`, `i`, `line`, `col`).
- any of `plots` (full series by key), `plotsAt` (`{ key: { index: value } }`), `plotColors`,
  `signals`, `signalsAt`, `barColors`, `bgColors`, and `markers`, `levels`, `stats`, `logs`
  and `meta` (each a subset of what the run returns, objects by key, arrays element by element).
