"""Compatibility shim — the implementation lives in ``domain.policy``.

This is the pure policy for what the app does with a download it grabbed: when
to copy, when to wait, when to leave it alone, and how to recognise its own
grabs in the arr's history. Nothing here opens a socket, a file or a database —
it decides, and someone else acts.

That purity is not decoration: ``tests_auto_copy.py`` reads this module's source
and fails on ``aiohttp``/``os``/``state``/``history``/``config`` turning up. It
is what makes the rules testable without a Radarr. It moved to ``domain`` for
exactly that reason, and the purity test follows the implementation, not this
shim — a shim that re-exports would have passed that check while saying nothing.

Delete this module once nothing imports it.
"""

from __future__ import annotations

from domain.policy import (  # noqa: F401
    COPY,
    DEFAULT_GRAB_WINDOW_SECONDS,
    DEFAULT_GRACE_SECONDS,
    GRAB_CLOCK_SKEW_SECONDS,
    SKIP,
    UNIDENTIFIED,
    WAIT,
    auto_copy_key,
    decide_copy,
    find_own_grab,
    matches_own_grab,
)

__all__ = [
    "COPY",
    "DEFAULT_GRAB_WINDOW_SECONDS",
    "DEFAULT_GRACE_SECONDS",
    "GRAB_CLOCK_SKEW_SECONDS",
    "SKIP",
    "UNIDENTIFIED",
    "WAIT",
    "auto_copy_key",
    "decide_copy",
    "find_own_grab",
    "matches_own_grab",
]
