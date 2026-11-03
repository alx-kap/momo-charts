"""The `ta` steppers (the port of runtime.js's steppers): one object per call site, O(1) work per
bar.

`TA["sma"](at, length)` builds one (`at` is [line, col] for errors; the other arguments are the
call's fixed arguments in the catalogue's order); `step(...)` takes this bar's values and stores
the result in `.v` (NaN for na; `.o0`, `.o1`, `.o2` for several outputs). A window that holds an
na gives na. ema, rma and rsi skip an na and keep their state. The arithmetic is the
JavaScript's, operation for operation, so both give the same values.
"""

from __future__ import annotations

import math

from .jsnum import NAN, js_floor, js_max, js_sqrt, js_str
from .limits import LIMITS, RunError

INF = float("inf")
REFRESH = 1024
NEARLY_FLAT = 1e-8


def whole(at, name, v, minimum=1):
    if not v >= minimum or v != math.floor(v) or v > LIMITS["length"]:
        raise RunError("R404", f"{name} must be a whole number from {minimum} to "
                       f"{LIMITS['length']}, not {js_str(float(v))}.", at)
    return int(v)


def fmax(a, b):
    """Math.max of two: NaN if either is."""
    if a != a or b != b:
        return NAN
    return a if a > b else b


def fmin(a, b):
    if a != a or b != b:
        return NAN
    return a if a < b else b


def pow2(n):
    c = 2
    while c < n:
        c *= 2
    return c


class Ring:
    """The last n values. `quiet` counts the values since the last na, so a window is clean when
    quiet >= n. The buffer holds a power of two, so positions wrap with a mask."""

    __slots__ = ("n", "mask", "buf", "i", "quiet")

    def __init__(self, n):
        self.n = n
        self.mask = pow2(n + 1) - 1
        self.buf = [0.0] * (self.mask + 1)
        self.i = 0
        self.quiet = 0

    def push(self, x):
        """Adds x; returns the value that fell out of the window (NaN while it was filling)."""
        i = self.i
        old = self.buf[(i - self.n) & self.mask] if i >= self.n else NAN
        self.buf[i & self.mask] = x
        self.quiet = self.quiet + 1 if x == x else 0
        self.i = i + 1
        return old

    @property
    def ready(self):
        return self.quiet >= self.n

    def at(self, k):
        """Value k bars ago (0 is the newest)."""
        return self.buf[(self.i - 1 - k) & self.mask]


class SumWindow(Ring):
    """Running sum of a full, clean window, updated in O(1). `fresh` counts updates since the sum
    was last built from the ring (-1: not valid yet), so it is rebuilt every REFRESH bars and
    after an na leaves the window. `push` returns whether the window is full and clean."""

    __slots__ = ("inv", "sum", "fresh")

    def __init__(self, n):
        super().__init__(n)
        self.inv = 1 / n
        self.sum = 0.0
        self.fresh = -1

    def push(self, x):
        n = self.n
        i = self.i
        buf = self.buf
        old = buf[(i - n) & self.mask]
        buf[i & self.mask] = x
        self.i = i + 1
        if x != x:
            self.quiet = 0
            self.fresh = -1
            return False
        quiet = self.quiet + 1
        self.quiet = quiet
        if quiet < n:
            return False
        fresh = self.fresh
        if 0 <= fresh < REFRESH:
            self.fresh = fresh + 1
            self.sum += x - old
        else:
            self.rebuild()
        return True

    def rebuild(self):
        first = self.i - self.n
        total = 0.0
        buf = self.buf
        mask = self.mask
        for k in range(self.n):
            total += buf[(first + k) & mask]
        self.sum = total
        self.fresh = 0


class M2Window(SumWindow):
    """Also the sum of squared deviations from the mean, by Welford's running update."""

    __slots__ = ("m2",)

    def __init__(self, n):
        super().__init__(n)
        self.m2 = 0.0

    def push(self, x):
        n = self.n
        i = self.i
        buf = self.buf
        old = buf[(i - n) & self.mask]
        buf[i & self.mask] = x
        self.i = i + 1
        if x != x:
            self.quiet = 0
            self.fresh = -1
            return False
        quiet = self.quiet + 1
        self.quiet = quiet
        if quiet < n:
            return False
        fresh = self.fresh
        if 0 <= fresh < REFRESH:
            self.fresh = fresh + 1
            inv = self.inv
            prev_mean = self.sum * inv
            total = self.sum + x - old
            self.sum = total
            mean = total * inv
            m2 = self.m2 + (x - old) * (x - mean + old - prev_mean)
            self.m2 = m2
            # The running update loses precision when the window is nearly flat (its stdev
            # under 0.01% of its mean); work it out from scratch then, as a two-pass sum would.
            if m2 < NEARLY_FLAT * total * mean:
                self.rebuild()
        else:
            self.rebuild()
        return True

    def rebuild(self):
        super().rebuild()
        first = self.i - self.n
        mean = self.sum * self.inv
        m2 = 0.0
        buf = self.buf
        mask = self.mask
        for k in range(self.n):
            d = buf[(first + k) & mask] - mean
            m2 += d * d
        self.m2 = m2


class WeightedWindow(SumWindow):
    """Also the weighted sum (the oldest value counts 1, the newest n)."""

    __slots__ = ("wsum",)

    def __init__(self, n):
        super().__init__(n)
        self.wsum = 0.0

    def push(self, x):
        n = self.n
        i = self.i
        buf = self.buf
        old = buf[(i - n) & self.mask]
        buf[i & self.mask] = x
        self.i = i + 1
        if x != x:
            self.quiet = 0
            self.fresh = -1
            return False
        quiet = self.quiet + 1
        self.quiet = quiet
        if quiet < n:
            return False
        fresh = self.fresh
        if 0 <= fresh < REFRESH:
            self.fresh = fresh + 1
            self.wsum = self.wsum - self.sum + n * x
            self.sum += x - old
        else:
            self.rebuild()
        return True

    def rebuild(self):
        super().rebuild()
        first = self.i - self.n
        wsum = 0.0
        buf = self.buf
        mask = self.mask
        for k in range(self.n):
            wsum += (k + 1) * buf[(first + k) & mask]
        self.wsum = wsum


class Extreme:
    """Highest (sign 1) or lowest (sign -1) over the last n values, with a monotonic deque of the
    candidates (indices into the stream) kept in a power-of-two ring."""

    __slots__ = ("n", "sign", "mask", "vals", "idx", "head", "tail", "i", "quiet")

    def __init__(self, n, sign):
        self.n = n
        self.sign = sign
        self.mask = pow2(n) - 1
        self.vals = [0.0] * (self.mask + 1)
        self.idx = [0] * (self.mask + 1)
        self.head = 0
        self.tail = 0
        self.i = 0
        self.quiet = 0

    def push(self, x):
        i = self.i
        self.i = i + 1
        if x != x:
            self.quiet = 0
            return False
        self.quiet += 1
        quiet = self.quiet
        mask = self.mask
        vals = self.vals
        idx = self.idx
        sign = self.sign
        oldest = i - self.n
        head = self.head
        tail = self.tail
        while head < tail and idx[head & mask] <= oldest:
            head += 1
        while tail > head and sign * vals[(tail - 1) & mask] <= sign * x:
            tail -= 1
        vals[tail & mask] = x
        idx[tail & mask] = i
        self.head = head
        self.tail = tail + 1
        return quiet >= self.n

    @property
    def value(self):
        return self.vals[self.head & self.mask]

    @property
    def offset(self):
        """0 for this bar, -k for k bars ago."""
        return float(self.idx[self.head & self.mask] - (self.i - 1))


class Sma:
    __slots__ = ("m", "v")

    def __init__(self, at, n):
        self.m = SumWindow(whole(at, "length", n))
        self.v = NAN

    def step(self, x):
        m = self.m
        self.v = m.sum * m.inv if m.push(x) else NAN


class Sum:
    __slots__ = ("m", "v")

    def __init__(self, at, n):
        self.m = SumWindow(whole(at, "length", n))
        self.v = NAN

    def step(self, x):
        self.v = self.m.sum if self.m.push(x) else NAN


class Ema:
    """Exponential and Wilder moving averages. Both seed with the simple average of the first n
    values, then smooth; an na is skipped (the state is kept)."""

    __slots__ = ("n", "k", "k1", "prev", "seeded", "seed", "count", "v")

    def __init__(self, at, n):
        self.n = whole(at, "length", n)
        self.k = 2 / (n + 1)
        self.k1 = 1 - self.k
        self.prev = NAN
        self.seeded = False
        self.seed = 0.0
        self.count = 0
        self.v = NAN

    def step(self, x):
        if self.seeded:
            if x != x:
                self.v = NAN
                return
            self.prev = x * self.k + self.prev * self.k1
            self.v = self.prev
            return
        self.start(x)

    def start(self, x):
        self.v = NAN
        if x != x:
            return
        self.seed += x
        self.count += 1
        if self.count < self.n:
            return
        self.seeded = True
        self.prev = self.seed / self.n
        self.v = self.prev


class Rma:
    __slots__ = ("n", "nm1", "inv", "prev", "seeded", "seed", "count", "v")

    def __init__(self, at, n):
        self.n = whole(at, "length", n)
        self.nm1 = n - 1
        self.inv = 1 / n
        self.prev = NAN
        self.seeded = False
        self.seed = 0.0
        self.count = 0
        self.v = NAN

    def step(self, x):
        if self.seeded:
            if x != x:
                self.v = NAN
                return
            self.prev = (self.prev * self.nm1 + x) * self.inv
            self.v = self.prev
            return
        self.start(x)

    def start(self, x):
        self.v = NAN
        if x != x:
            return
        self.seed += x
        self.count += 1
        if self.count < self.n:
            return
        self.seeded = True
        self.prev = self.seed / self.n
        self.v = self.prev


class Wma:
    __slots__ = ("m", "div", "v")

    def __init__(self, at, n):
        self.m = WeightedWindow(whole(at, "length", n))
        self.div = (n * (n + 1)) / 2
        self.v = NAN

    def step(self, x):
        self.v = self.m.wsum / self.div if self.m.push(x) else NAN


class Hma:
    __slots__ = ("half", "full", "out", "v")

    def __init__(self, at, n):
        whole(at, "length", n)
        self.half = Wma(at, max(1, math.floor(n / 2)))
        self.full = Wma(at, n)
        self.out = Wma(at, max(1, math.floor(js_sqrt(n))))
        self.v = NAN

    def step(self, x):
        self.half.step(x)
        self.full.step(x)
        self.out.step(2 * self.half.v - self.full.v)
        self.v = self.out.v


class Vwma:
    __slots__ = ("pv", "vol", "v")

    def __init__(self, at, n):
        self.pv = SumWindow(whole(at, "length", n))
        self.vol = SumWindow(self.pv.n)
        self.v = NAN

    def step(self, x, volume):
        a = self.pv.push(x * volume)
        b = self.vol.push(volume)
        self.v = self.pv.sum / self.vol.sum if a and b and self.vol.sum != 0 else NAN


class Variance:
    __slots__ = ("m", "root", "v")

    def __init__(self, at, n, root):
        self.m = M2Window(whole(at, "length", n))
        self.root = root
        self.v = NAN

    def step(self, x):
        m = self.m
        if not m.push(x):
            self.v = NAN
            return
        v = js_max(0.0, m.m2) * m.inv
        self.v = math.sqrt(v) if self.root else v


class BlockMax:
    """Highest over the last n values without a deque (van Herk / Gil-Werman): the window is the
    tail of the previous block of n values plus the head of the current one, so its extreme is
    the max of a running head and a stored tail. An na poisons the head and the tails that cover
    it, which is exactly "a window that holds an na gives na"."""

    __slots__ = ("n", "block", "tail", "j", "head", "count", "v")

    def __init__(self, n):
        self.n = n
        self.block = [0.0] * n
        self.tail = [-INF] * (n + 1)
        self.j = 0
        self.head = -INF
        self.count = 0
        self.v = NAN

    def step(self, x):
        j = self.j
        head = fmax(self.head, x)
        value = fmax(head, self.tail[j + 1])
        self.block[j] = x
        if j + 1 == self.n:
            block = self.block
            tail = self.tail
            t = -INF
            for k in range(self.n - 1, -1, -1):
                t = fmax(t, block[k])
                tail[k] = t
            self.j = 0
            self.head = -INF
        else:
            self.j = j + 1
            self.head = head
        self.count += 1
        self.v = value if self.count >= self.n else NAN


class BlockMin:
    __slots__ = ("n", "block", "tail", "j", "head", "count", "v")

    def __init__(self, n):
        self.n = n
        self.block = [0.0] * n
        self.tail = [INF] * (n + 1)
        self.j = 0
        self.head = INF
        self.count = 0
        self.v = NAN

    def step(self, x):
        j = self.j
        head = fmin(self.head, x)
        value = fmin(head, self.tail[j + 1])
        self.block[j] = x
        if j + 1 == self.n:
            block = self.block
            tail = self.tail
            t = INF
            for k in range(self.n - 1, -1, -1):
                t = fmin(t, block[k])
                tail[k] = t
            self.j = 0
            self.head = INF
        else:
            self.j = j + 1
            self.head = head
        self.count += 1
        self.v = value if self.count >= self.n else NAN


class HighestBars:
    __slots__ = ("e", "v")

    def __init__(self, at, n, sign):
        self.e = Extreme(whole(at, "length", n), sign)
        self.v = NAN

    def step(self, x):
        self.v = self.e.offset if self.e.push(x) else NAN


class Change:
    __slots__ = ("ring", "mode", "v")

    def __init__(self, at, n, mode):
        self.ring = Ring(whole(at, "length", n))
        self.mode = mode
        self.v = NAN

    def step(self, x):
        old = self.ring.push(x)
        if self.mode == 0:
            self.v = x - old
        else:
            self.v = NAN if old == 0 else ((x - old) / old) * 100


class Rsi:
    __slots__ = ("n", "nm1", "inv", "prev", "up", "down", "count", "seeded", "v")

    def __init__(self, at, n):
        self.n = whole(at, "length", n)
        self.nm1 = n - 1
        self.inv = 1 / n
        self.prev = NAN
        self.up = 0.0
        self.down = 0.0
        self.count = 0
        self.seeded = False
        self.v = NAN

    def step(self, x):
        """Wilder smoothing of the gains and the losses, seeded with their simple averages."""
        change = x - self.prev
        self.prev = x
        self.v = NAN
        if change != change:
            return
        gain = (change + abs(change)) * 0.5      # max(change, 0)
        loss = gain - change
        if self.seeded:
            self.up = (self.up * self.nm1 + gain) * self.inv
            self.down = (self.down * self.nm1 + loss) * self.inv
        else:
            self.up += gain
            self.down += loss
            self.count += 1
            if self.count < self.n:
                return
            self.up *= self.inv
            self.down *= self.inv
            self.seeded = True
        self.v = 100 if self.down == 0 else (100 * self.up) / (self.up + self.down)


class Tr:
    __slots__ = ("prev", "first", "v")

    def __init__(self):
        self.prev = NAN
        self.first = True
        self.v = NAN

    def step(self, high, low, close):
        rng = high - low
        if self.first:
            self.v = rng
            self.first = False
        else:
            self.v = js_max(rng, abs(high - self.prev), abs(low - self.prev))
        self.prev = close


class Atr:
    __slots__ = ("tr", "rma", "v")

    def __init__(self, at, n):
        self.tr = Tr()
        self.rma = Rma(at, n)
        self.v = NAN

    def step(self, high, low, close):
        self.tr.step(high, low, close)
        self.rma.step(self.tr.v)
        self.v = self.rma.v


class Adr:
    __slots__ = ("m", "v")

    def __init__(self, at, n):
        self.m = SumWindow(whole(at, "length", n))
        self.v = NAN

    def step(self, high, low):
        m = self.m
        self.v = m.sum * m.inv if m.push(NAN if low == 0 else (high / low - 1) * 100) else NAN


class Macd:
    __slots__ = ("fast", "slow", "signal", "v", "o0", "o1", "o2")

    def __init__(self, at, fast, slow, signal):
        self.fast = Ema(at, fast)
        self.slow = Ema(at, slow)
        self.signal = Ema(at, signal)
        self.v = self.o0 = self.o1 = self.o2 = NAN

    def step(self, x):
        self.fast.step(x)
        self.slow.step(x)
        line = self.fast.v - self.slow.v
        self.signal.step(line)
        self.o0 = self.v = line
        self.o1 = self.signal.v
        self.o2 = line - self.signal.v


class Bb:
    __slots__ = ("m", "v", "o0", "o1", "o2")

    def __init__(self, at, n):
        self.m = M2Window(whole(at, "length", n))
        self.v = self.o0 = self.o1 = self.o2 = NAN

    def step(self, x, mult):
        m = self.m
        if not m.push(x):
            self.v = self.o0 = self.o1 = self.o2 = NAN
            return
        basis = m.sum * m.inv
        dev = math.sqrt(js_max(0.0, m.m2) * m.inv)
        self.v = self.o0 = basis
        self.o1 = basis + mult * dev
        self.o2 = basis - mult * dev


class Kc:
    __slots__ = ("ema", "atr", "v", "o0", "o1", "o2")

    def __init__(self, at, n, atr_length):
        self.ema = Ema(at, n)
        self.atr = Atr(at, atr_length)
        self.v = self.o0 = self.o1 = self.o2 = NAN

    def step(self, x, mult, high, low, close):
        self.ema.step(x)
        self.atr.step(high, low, close)
        basis = self.ema.v
        atr = self.atr.v
        self.v = self.o0 = basis
        self.o1 = basis + mult * atr
        self.o2 = basis - mult * atr


class Stoch:
    __slots__ = ("hi", "lo", "k", "d", "v", "o0", "o1")

    def __init__(self, at, n, k_smooth, d_smooth):
        self.hi = BlockMax(whole(at, "length", n))
        self.lo = BlockMin(self.hi.n)
        self.k = Sma(at, k_smooth)
        self.d = Sma(at, d_smooth)
        self.v = self.o0 = self.o1 = NAN

    def step(self, high, low, close):
        self.hi.step(high)
        self.lo.step(low)
        rng = self.hi.v - self.lo.v
        self.k.step((100 * (close - self.lo.v)) / rng if rng > 0 else NAN)
        self.d.step(self.k.v)
        self.v = self.o0 = self.k.v
        self.o1 = self.d.v


class Cross:
    __slots__ = ("mode", "pa", "pb", "v")

    def __init__(self, mode):
        self.mode = mode
        self.pa = NAN
        self.pb = NAN
        self.v = False

    def step(self, a, b):
        over = a > b and self.pa <= self.pb
        under = a < b and self.pa >= self.pb
        self.pa = a
        self.pb = b
        self.v = over if self.mode == 0 else under if self.mode == 1 else (over or under)


class Run:
    __slots__ = ("n", "rising", "prev", "run", "v")

    def __init__(self, at, n, rising):
        self.n = whole(at, "length", n)
        self.rising = rising
        self.prev = NAN
        self.run = 0
        self.v = False

    def step(self, x):
        self.run = self.run + 1 if (x > self.prev if self.rising else x < self.prev) else 0
        self.prev = x
        self.v = self.run >= self.n


class BarsSince:
    __slots__ = ("v",)

    def __init__(self):
        self.v = NAN

    def step(self, cond):
        self.v = 0.0 if cond else self.v + 1


class ValueWhen:
    __slots__ = ("size", "buf", "count", "v")

    def __init__(self, at, nth):
        self.size = whole(at, "nth", nth, 0) + 1
        self.buf = [0.0] * self.size
        self.count = 0
        self.v = NAN

    def step(self, cond, x):
        if cond:
            self.buf[self.count % self.size] = x
            self.count += 1
        self.v = self.buf[(self.count - self.size) % self.size] if self.count >= self.size \
            else NAN


class Cum:
    __slots__ = ("total", "v")

    def __init__(self):
        self.total = 0.0
        self.v = NAN

    def step(self, x):
        if x != x:
            self.v = NAN
            return
        self.total += x
        self.v = self.total


class Median:
    __slots__ = ("r", "v")

    def __init__(self, at, n):
        self.r = Ring(whole(at, "length", n))
        self.v = NAN

    def step(self, x):
        r = self.r
        r.push(x)
        if not r.ready:
            self.v = NAN
            return
        n = r.n
        tmp = sorted(r.at(k) for k in range(n))
        self.v = tmp[(n - 1) // 2] if n % 2 else (tmp[n // 2 - 1] + tmp[n // 2]) / 2


class PercentRank:
    __slots__ = ("r", "v")

    def __init__(self, at, n):
        self.r = Ring(whole(at, "length", n) + 1)
        self.v = NAN

    def step(self, x):
        r = self.r
        r.push(x)
        if not r.ready:
            self.v = NAN
            return
        count = 0
        for k in range(1, r.n):
            if r.at(k) <= x:
                count += 1
        self.v = (count / (r.n - 1)) * 100


class Pivot:
    """A pivot is confirmed `right` bars after it. A high must beat the `left` bars before it
    and at least match the `right` bars after it (an equal run pivots on its first bar)."""

    __slots__ = ("left", "right", "r", "sign", "v")

    def __init__(self, at, left, right, sign):
        self.left = whole(at, "left", left)
        self.right = whole(at, "right", right)
        self.r = Ring(self.left + self.right + 1)
        self.sign = sign
        self.v = NAN

    def step(self, x):
        r = self.r
        r.push(x)
        self.v = NAN
        if not r.ready:
            return
        s = self.sign
        mid = r.at(self.right)
        for k in range(self.right):
            if s * r.at(k) > s * mid:
                return
        for k in range(self.right + 1, self.right + self.left + 1):
            if s * r.at(k) >= s * mid:
                return
        self.v = mid


class Vwap:
    __slots__ = ("day", "value", "volume", "v")

    def __init__(self):
        self.day = NAN
        self.value = 0.0
        self.volume = 0.0
        self.v = NAN

    def step(self, time, high, low, close, volume):
        day = js_floor(time / 86400)
        if day != self.day:
            self.day = day
            self.value = 0.0
            self.volume = 0.0
        typical = (high + low + close) / 3
        if typical != typical or volume != volume:
            self.v = NAN
            return
        self.value += typical * volume
        self.volume += volume
        self.v = self.value / self.volume if self.volume else typical


class Rvol:
    """Volume over its average across the bars before this one."""

    __slots__ = ("m", "prev", "v")

    def __init__(self, at, n):
        self.m = SumWindow(whole(at, "length", n))
        self.prev = NAN
        self.v = NAN

    def step(self, volume):
        prev = self.prev
        self.v = volume / prev if prev and prev == prev else NAN
        m = self.m
        self.prev = m.sum * m.inv if m.push(volume) else NAN


TA = {
    "sma": lambda at, n: Sma(at, n),
    "ema": lambda at, n: Ema(at, n),
    "rma": lambda at, n: Rma(at, n),
    "wma": lambda at, n: Wma(at, n),
    "vwma": lambda at, n: Vwma(at, n),
    "hma": lambda at, n: Hma(at, n),
    "stdev": lambda at, n: Variance(at, n, True),
    "variance": lambda at, n: Variance(at, n, False),
    "highest": lambda at, n: BlockMax(whole(at, "length", n)),
    "lowest": lambda at, n: BlockMin(whole(at, "length", n)),
    "highestbars": lambda at, n: HighestBars(at, n, 1),
    "lowestbars": lambda at, n: HighestBars(at, n, -1),
    "change": lambda at, n: Change(at, n, 0),
    "mom": lambda at, n: Change(at, n, 0),
    "roc": lambda at, n: Change(at, n, 1),
    "rsi": lambda at, n: Rsi(at, n),
    "atr": lambda at, n: Atr(at, n),
    "tr": lambda at: Tr(),
    "adr": lambda at, n: Adr(at, n),
    "macd": lambda at, fast, slow, signal: Macd(at, fast, slow, signal),
    "bb": lambda at, n: Bb(at, n),
    "kc": lambda at, n, atr_length: Kc(at, n, atr_length),
    "stoch": lambda at, n, k, d: Stoch(at, n, k, d),
    "crossover": lambda at: Cross(0),
    "crossunder": lambda at: Cross(1),
    "cross": lambda at: Cross(2),
    "rising": lambda at, n: Run(at, n, True),
    "falling": lambda at, n: Run(at, n, False),
    "barssince": lambda at: BarsSince(),
    "valuewhen": lambda at, nth: ValueWhen(at, nth),
    "cum": lambda at: Cum(),
    "sum": lambda at, n: Sum(at, n),
    "median": lambda at, n: Median(at, n),
    "percentrank": lambda at, n: PercentRank(at, n),
    "pivothigh": lambda at, left, right: Pivot(at, left, right, 1),
    "pivotlow": lambda at, left, right: Pivot(at, left, right, -1),
    "vwap": lambda at: Vwap(),
    "rvol": lambda at, n: Rvol(at, n),
}
