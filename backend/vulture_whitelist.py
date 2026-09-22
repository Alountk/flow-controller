"""Vulture whitelist.

Referenced names are treated as used, so vulture stops reporting them. Keep this
file as small as possible and always explain WHY an entry exists: an unexplained
whitelist entry is just dead code with paperwork.

Written as valid Python — the imports are collected in ``__all__`` so pyflakes
sees them as used and a plain ``python -m pyflakes *.py`` stays clean. A bare
list of names (vulture's generated style) reports as undefined names to every
other tool.
"""

from auto_copy import auto_copy_key, decide_copy, matches_own_grab
from clients import arr_has_file
from history import is_auto_copy_handled, mark_auto_copy
from media_mixer import select_best_video
from state import queue_consumer_task

# ── Intentional: write-only reference held for garbage-collection safety ──────
#
# `asyncio.create_task()` docs: keep a reference to the task or it may be
# garbage-collected mid-execution. `queue_consumer_task` is assigned and never
# read, so static analysis sees it as unused — that is the point of it.
# See routes/files.py queue_add().
#
# ── Pending product decision: do NOT treat as permanent ──────────────────────
#
# `select_best_video` picks the video track to keep when muxing. It is fully
# implemented and covered by 7 tests, but NOTHING in production calls it: the UI
# requires explicit track selection (`selectedVideoA` / `canMux` in
# MediaMixer.tsx), so the automatic path never runs.
#
# Kept rather than deleted because it is tested, working code and may be
# intended for a future "auto-select" mode. Decide one of:
#   - wire it into the mux flow, or
#   - delete the function and its tests.
# Until then it is whitelisted so it cannot hide alongside real findings.
#
# ── Not yet wired: the auto-copy policy and marker await their driver ────────
#
# T4/T6 debt, declared so it stays visible instead of quietly settling. The
# auto-copy path is built bottom-up: T3 the pure decision, T4 the identity key
# and the durable marker, T6 the driver that wires them together. Until T6
# lands nothing in production calls any of these, and vulture does not scan
# tests, so they read as unused:
#
#   - `decide_copy`          T3 pure policy (trace -> copy/wait/skip).
#   - `auto_copy_key`        T4 stable identity for a candidate download.
#   - `mark_auto_copy`       T4 writes the idempotency marker.
#   - `is_auto_copy_handled` T4 reads it back.
#   - `matches_own_grab`     T5 pure matcher: is this trace one of our grabs?
#                            Its only caller is the T6 driver.
#
# `arr_has_file` (T4, clients.py) has no production caller either, but vulture
# does NOT report it: `decide_copy` has a parameter of the same name, so the
# name already reads as "referenced". That is a coincidence, not a caller. It is
# whitelisted explicitly so a future rename of that parameter cannot turn this
# real debt into a surprise finding.
#
# T6 MUST remove every auto-copy entry from this list once the driver calls
# them. They are debt, not permanent exceptions.
__all__ = [
    "arr_has_file",
    "auto_copy_key",
    "decide_copy",
    "is_auto_copy_handled",
    "mark_auto_copy",
    "matches_own_grab",
    "queue_consumer_task",
    "select_best_video",
]
