"""Vulture whitelist.

Referenced names are treated as used, so vulture stops reporting them. Keep this
file as small as possible and always explain WHY an entry exists: an unexplained
whitelist entry is just dead code with paperwork.

Written as valid Python — the imports are collected in ``__all__`` so pyflakes
sees them as used and a plain ``python -m pyflakes *.py`` stays clean. A bare
list of names (vulture's generated style) reports as undefined names to every
other tool.
"""

from auto_copy import decide_copy
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
# ── Not yet wired: the pure decision answers before its driver exists ────────
#
# `decide_copy` is the T3 pure policy: it reads a trace and returns
# copy/wait/skip. Nothing in production calls it yet — the driver that feeds it
# real traces is T6, still to be written. The tests cover it exhaustively, but
# vulture does not scan tests, so it reads as unused until that driver lands.
__all__ = ["decide_copy", "queue_consumer_task", "select_best_video"]
