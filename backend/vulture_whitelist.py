"""Vulture whitelist.

Referenced names are treated as used, so vulture stops reporting them. Keep this
file as small as possible and always explain WHY an entry exists: an unexplained
whitelist entry is just dead code with paperwork.

Everything else in the backend is expected to be genuinely used — if vulture
flags something new, either delete it or justify it here.
"""

# ── Intentional: write-only reference held for garbage-collection safety ──────
#
# `asyncio.create_task()` docs: keep a reference to the task or it may be
# garbage-collected mid-execution. `queue_consumer_task` is assigned and never
# read, so static analysis sees it as unused — that is the point of it.
# See routes/files.py queue_add().
queue_consumer_task  # noqa: B018 - GC anchor, deliberately never read


# ── Pending product decision: do NOT treat as permanent ──────────────────────
#
# `select_best_video` picks the video track to keep when muxing. It is fully
# implemented and covered by 7 tests, but NOTHING in production calls it: the
# UI requires explicit track selection (`selectedVideoA` / `canMux` in
# MediaMixer.tsx), so the automatic path never runs.
#
# Kept rather than deleted because it is tested, working code and may be
# intended for a future "auto-select" mode. Decide one of:
#   - wire it into the mux flow, or
#   - delete the function and its tests.
# Until then it is whitelisted so it cannot hide alongside real findings.
select_best_video  # noqa: B018 - pending decision, see comment above
