"""Fixed-window counters — the arithmetic behind the HTTP edge (C-05).

Why a fixed window and not a token bucket: ``Retry-After``. A window's reset
instant is known the moment the window opens, so the seconds left are exact;
a bucket would have to project a refill that depends on arrivals that have
not happened yet. The app is a single-process REST service polled by its own
frontend — the double burst a fixed window allows across its seam (up to 2×
the limit around a boundary) means nothing at these limits, and nothing here
has to agree with another process.

Time is injected (``clock`` defaults to ``time.monotonic``) so rollover is
testable without sleeping. The store is bounded because its keys are
attacker-influenced (client addresses): past ``MAX_KEYS`` live entries the
prune drops the whole table — availability over strictness, chosen over an
unbounded dict that a flood of distinct keys could grow without limit.
"""

from __future__ import annotations

import math
import time
from collections.abc import Callable

#: Distinct keys kept before the store is dropped wholesale. At ~100 bytes a
#: entry this caps the table in the hundreds of KB, whatever the traffic.
MAX_KEYS = 4096

Clock = Callable[[], float]


class FixedWindow:
    """``limit`` arrivals per ``window`` seconds, counted per key.

    Two questions, one counter: :meth:`hit` counts an arrival and says
    whether it fits (the general budget); :meth:`peek` says how long a key
    that has ALREADY been counted must still wait, without counting again
    (the auth-failure budget, which records only what the app actually
    rejected). Both answer "N allowed, N+1 refused".
    """

    def __init__(self, limit: int, window: float = 60.0, clock: Clock = time.monotonic):
        self.limit = limit
        self.window = window
        self._clock = clock
        #: key -> (window start, arrivals in that window)
        self._counts: dict[str, tuple[float, int]] = {}

    def hit(self, key: str) -> tuple[bool, int]:
        """Count one arrival; report ``(allowed, retry_after)``.

        ``retry_after`` is whole seconds until the window resets when the
        arrival is refused, and ``0`` when it is allowed — exact, because
        the window's end was fixed when it started.
        """
        now = self._clock()
        start, count = self._roll(key, now)
        count += 1
        self._counts[key] = (start, count)
        self._prune(now)
        if count > self.limit:
            return False, self._wait(start, now)
        return True, 0

    def peek(self, key: str) -> int | None:
        """Seconds ``key`` must still wait, or ``None`` if it may proceed.

        Reads without counting: the caller decides what an over-budget key
        means (the edge answers ``429`` before serving it).
        """
        now = self._clock()
        entry = self._counts.get(key)
        if entry is None:
            return None
        start, count = entry
        if now - start >= self.window:
            del self._counts[key]
            return None
        if count >= self.limit:
            return self._wait(start, now)
        return None

    def _roll(self, key: str, now: float) -> tuple[float, int]:
        """The live ``(start, count)`` for ``key`` — a stale window starts over."""
        start, count = self._counts.get(key, (now, 0))
        if now - start >= self.window:
            return now, 0
        return start, count

    def _wait(self, start: float, now: float) -> int:
        return max(1, math.ceil(self.window - (now - start)))

    def _prune(self, now: float) -> None:
        if len(self._counts) <= MAX_KEYS:
            return
        for key, (start, _) in list(self._counts.items()):
            if now - start >= self.window:
                self._counts.pop(key, None)
        if len(self._counts) > MAX_KEYS:
            # Still full of LIVE keys: a flood of distinct addresses. Drop
            # the table — a bounded cache that briefly forgets is the right
            # trade against a dict an attacker can grow at will.
            self._counts.clear()
