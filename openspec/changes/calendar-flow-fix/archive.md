# Archive: Calendar Flow Fix

## Change Summary

| Field | Value |
|-------|-------|
| Change Name | calendar-flow-fix |
| Status | ✅ Completed |
| Commit | `2aa0b61` |
| Tests | 59/59 passing |
| Changed Lines | ~10 |
| Files Modified | 3 |

## Problem

Three bugs broke the calendar release search flow:

1. **Indexer selector empty** — `arr_indexers()` returned `[]` due to `enableSearch` filter (fixed in earlier commit `983272f`)
2. **25s timeout on release search** — Backend timeout too short when Radarr fans out to all indexers in parallel
3. **Indexer selector was cosmetic** — `selectedIndexer` state existed but was never passed to any API call

## Solution

**Client-side filter approach** — fetch all releases from Radarr, filter locally by selected indexer.

### Changes Made

| File | Line | Change |
|------|------|--------|
| `backend/clients.py` | 1028 | `REQUEST_TIMEOUT * 5` → `REQUEST_TIMEOUT * 12` (60s) |
| `frontend/src/api/calendar.ts` | 60 | Timeout 30000 → 65000 (65s) |
| `frontend/src/api/calendar.ts` | 78 | Updated error message with timeout duration |
| `frontend/src/components/CalendarModal.tsx` | 90-93 | Added client-side filter: `releases.filter(r => r.indexer === selectedIndexer)` |

### Architecture

```
CalendarModal ──POST /api/calendar/releases──► FastAPI ──GET /api/v3/release──► Radarr/Sonarr
                                                       │
                                                       └─ return ALL releases (60s timeout)
       │
       └─ filter locally by selectedIndexer
       └─ display filtered results
```

## SDD Artifacts

| Artifact | Location |
|----------|----------|
| Exploration | `openspec/changes/calendar-flow-fix/exploration.md` |
| Proposal | `openspec/changes/calendar-flow-fix/proposal.md` |
| Spec (timeout) | `openspec/changes/calendar-flow-fix/specs/calendar-release-timeout/spec.md` |
| Spec (filter) | `openspec/changes/calendar-flow-fix/specs/calendar-indexer-filter/spec.md` |
| Design | `openspec/changes/calendar-flow-fix/design.md` |
| Tasks | `openspec/changes/calendar-flow-fix/tasks.md` |
| Archive | `openspec/changes/calendar-flow-fix/archive.md` |

## Key Learnings

1. Radarr/Sonarr release API has no `indexerId` filter — fetch-all-then-filter is the only option
2. Backend timeout error message uses `int(timeout.total)` dynamically — no separate message change needed
3. Client-side filter is simpler than server-side (no model/handler changes, instant filtering)

## Verification

- [x] All 59 backend tests pass
- [x] Backend timeout now 60s (was 25s)
- [x] Frontend timeout now 65s (was 30s)
- [x] Indexer filter works client-side in CalendarModal
- [ ] Manual test: open modal → select indexer → search → verify filtered results (deployment needed)
