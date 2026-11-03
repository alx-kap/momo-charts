"""Runs scripts in worker processes with a time limit, so a script can't hold the server up.

A `Pool` keeps worker processes. Each job sends the script text and the bars over a pipe; the
worker compiles the text itself (and caches it), runs it with the evaluator and sends the result
back, so no code or closure ever crosses a process boundary. A job that takes longer than its
limit gets its worker killed and replaced, and its result is the R401 error; the other workers
carry on. A screen spreads symbols over the workers and gives each its own limit.

    with Pool() as pool:
        pool.run(source, bars)                         # one run, the whole result
        pool.run_many(source, [(key, bars, extra)])    # many symbols, the last bar of each
"""

from __future__ import annotations

import hashlib
import json
import multiprocessing
import os
import time
from collections import OrderedDict, deque
from multiprocessing import connection

from .compile import check_source
from .evaluator import run_script

RUN_SECONDS = 5.0           # one run's limit; the chart's 250 ms is the browser's, for Python
MEMORY_BYTES = 2 * 1024 ** 3
CACHE = 32                  # compiled scripts a worker or the parent keeps
RESULTS = 20000             # screen results kept until their symbol's next bar


def _error(code, message):
    return {"ok": False, "error": {"code": code, "message": message, "line": 1, "col": 1,
                                   "i": -1}}


def timed_out(seconds):
    return _error("R401", f"Stopped: the script took longer than {seconds:g} seconds.")


def source_key(source):
    return hashlib.sha256(source.encode("utf-8", "surrogatepass")).hexdigest()


class CompileCache:
    """check_source results by source text (the last few)."""

    def __init__(self, size=CACHE):
        self.size = size
        self.items = OrderedDict()

    def get(self, source):
        key = source_key(source)
        if key in self.items:
            self.items.move_to_end(key)
            return self.items[key]
        result = check_source(source)
        self.items[key] = result
        if len(self.items) > self.size:
            self.items.popitem(last=False)
        return result


def last_bar(meta, out, n):
    """What a screen wants from a run: each plot's and signal's last value, the stats and levels
    (already last-bar), and the markers on the last bar."""
    kinds = {s["name"]: s["kind"] for s in meta["signals"]}
    last = {
        "plots": {k: p["values"][-1] for k, p in out["plots"].items() if p["values"]},
        "signals": {k: bool(v[-1]) if kinds.get(k) == "bool" else v[-1]
                    for k, v in out["signals"].items() if len(v)},
        "stats": out["stats"], "levels": out["levels"],
        "markers": [m for m in out["markers"] if m["i"] == n - 1],
    }
    return {"ok": True, "ms": out["ms"], "bars": n, "last": last}


def execute(cache, source, bars, inputs, extra, last_only):
    """One job, in whichever process is running it: compile (cached), run, shape the result."""
    compiled = cache.get(source)
    if not compiled["ok"]:
        return {"ok": False, "errors": compiled["errors"]}
    out = run_script(compiled["ir"], bars, inputs, extra)
    if not out["ok"]:
        return out
    n = len(bars["close"])
    return last_bar(compiled["meta"], out, n) if last_only else {**out, "meta": compiled["meta"]}


# ---- the worker process ---------------------------------------------------------------------


def worker_main(conn):
    try:
        import resource

        resource.setrlimit(resource.RLIMIT_AS, (MEMORY_BYTES, MEMORY_BYTES))
    except (ImportError, ValueError, OSError):
        pass
    cache = CompileCache()
    conn.send(("ready", 0, None))
    while True:
        try:
            message = conn.recv()
        except (EOFError, OSError):
            return
        if message is None:
            return
        _, job, source, bars, inputs, extra, last_only = message
        try:
            result = execute(cache, source, bars, inputs, extra, last_only)
        except MemoryError:
            result = _error("R405", "The script used too much memory.")
        except Exception as e:  # a bug in momo, not in the script: report it, keep the worker
            result = _error("R500", f"Internal error: {type(e).__name__}: {e}")
        conn.send(("done", job, result))


class _Worker:
    def __init__(self, context):
        self.parent, child = context.Pipe()
        self.process = context.Process(target=worker_main, args=(child,), daemon=True)
        self.process.start()
        child.close()
        self.ready = False
        self.job = None
        self.deadline = 0.0

    def kill(self):
        try:
            self.process.kill()
            self.process.join(2)
        except (OSError, ValueError):
            pass
        self.parent.close()


class Pool:
    def __init__(self, size=None, seconds=RUN_SECONDS):
        self.size = max(1, size or min(os.cpu_count() or 1, 8))
        self.seconds = seconds
        self.context = multiprocessing.get_context("spawn")
        self.workers = [_Worker(self.context) for _ in range(self.size)]
        self.compiled = CompileCache()
        self.results = OrderedDict()

    def __enter__(self):
        return self

    def __exit__(self, *exc):
        self.close()

    def close(self):
        for worker in self.workers:
            try:
                worker.parent.send(None)
            except (OSError, ValueError):
                pass
        for worker in self.workers:
            worker.process.join(0.5)
            if worker.process.is_alive():
                worker.kill()
        self.workers = []

    # ---- jobs -------------------------------------------------------------------------------

    def run(self, source, bars, inputs=None, extra=None, seconds=None, last_only=False):
        """One run: the whole result (or its last bar with `last_only`), or {ok: False, ...}."""
        return self.run_many(source, [(None, bars, extra or {})], inputs, seconds, last_only)[0]

    def run_many(self, source, items, inputs=None, seconds=None, last_only=True):
        """Runs the script over many symbols at once. `items` is [(key, bars, extra)]; the
        results come back in the same order, each with its own time limit."""
        seconds = self.seconds if seconds is None else seconds
        compiled = self.compiled.get(source)
        if not compiled["ok"]:
            failure = {"ok": False, "errors": compiled["errors"]}
            return [failure for _ in items]
        inputs = inputs or {}
        results = [None] * len(items)
        pending = deque(enumerate(items))
        for worker in self.workers:
            if not worker.process.is_alive():
                self.replace(worker)
        while pending or any(w.job is not None for w in self.workers):
            for worker in self.workers:
                if worker.ready and worker.job is None and pending:
                    index, (_, bars, extra) = pending.popleft()
                    worker.job = index
                    worker.deadline = time.monotonic() + seconds
                    try:
                        worker.parent.send(("run", index, source, bars, inputs, extra,
                                            last_only))
                    except (OSError, ValueError):
                        results[index] = _error("R500", "The script worker stopped.")
                        self.replace(worker)
            waiting = [w for w in self.workers if w.job is not None or not w.ready]
            now = time.monotonic()
            deadlines = [w.deadline for w in waiting if w.job is not None]
            wait = 1.0 if not deadlines else max(0.0, min(deadlines) - now)
            ready = connection.wait([w.parent for w in waiting], timeout=min(wait, 1.0))
            by_connection = {w.parent: w for w in waiting}
            for conn in ready:
                worker = by_connection[conn]
                try:
                    tag, job, payload = conn.recv()
                except (EOFError, OSError):
                    if worker.job is not None:
                        results[worker.job] = _error("R500", "The script worker stopped.")
                    self.replace(worker)
                    continue
                if tag == "ready":
                    worker.ready = True
                else:
                    results[job] = payload
                    worker.job = None
            now = time.monotonic()
            for worker in self.workers:
                if worker.job is not None and now >= worker.deadline:
                    results[worker.job] = timed_out(seconds)
                    self.replace(worker)
        return results

    def screen(self, source, universe, inputs=None, seconds=None):
        """The last bar of the script for every symbol in `universe` ({symbol: (bars, extra)}).
        Results are cached by script, inputs, symbol and last bar, so asking again before the
        next bar costs nothing; a script that times out isn't cached."""
        inputs = inputs or {}
        tag = f"{source_key(source)}:{json.dumps(inputs, sort_keys=True, default=str)}"
        keys = {symbol: (tag, symbol, bars["time"][-1] if bars["time"] else None, len(bars["time"]))
                for symbol, (bars, _) in universe.items()}
        out = {}
        todo = []
        for symbol, key in keys.items():
            if key in self.results:
                self.results.move_to_end(key)
                out[symbol] = self.results[key]
            else:
                todo.append(symbol)
        if todo:
            items = [(symbol, *universe[symbol]) for symbol in todo]
            for symbol, result in zip(todo, self.run_many(source, items, inputs, seconds),
                                      strict=True):
                out[symbol] = result
                failed = not result["ok"] and result.get("error", {}).get("code") in (
                    "R401", "R500", "R405")
                if not failed:
                    self.results[keys[symbol]] = result
            while len(self.results) > RESULTS:
                self.results.popitem(last=False)
        return out

    def replace(self, worker):
        worker.kill()
        self.workers[self.workers.index(worker)] = _Worker(self.context)


__all__ = ["Pool", "RUN_SECONDS", "execute", "timed_out"]
