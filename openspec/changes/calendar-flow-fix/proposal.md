# Proposal: Calendar Flow Bugs Fix

## Intent

Three bugs break the calendar release search flow in the flow-controller app:

1. **Indexer selector returns empty** — `arr_indexers()` returns `[]` due to config or error-swallowing issues (partially addressed in commit `983272f`)
2. **25-second timeout on release search** — `arr_fetch_releases()` uses `REQUEST_TIMEOUT * 5 = 25s`, which is too short when Radarr fans out to all configured indexers in parallel; a slow indexer kills the whole request
3. **Indexer selector is cosmetic** — `selectedIndexer` state exists in the modal but is never passed to any API call; the user picks an indexer and nothing happens

The net effect: users cannot reliably search for releases. The modal either times out or shows unfiltered results regardless of their indexer selection.

## Scope

### In Scope

- Increase backend timeout for release searches from 25s to 60s (`REQUEST_TIMEOUT * 12`)
- Plumb the indexer selection through the full stack: frontend → backend API → server-side filter
- Pass `indexer` (optional string) in `CalendarReleasesRequest` and `fetchCalendarReleases()`
- Filter releases server-side by indexer name in `arr_fetch_releases()` (Radarr API has no `indexerId` filter, so fetch-all-then-filter is the only option)
- Align frontend timeout to 65s (slightly above backend) to avoid premature AbortController cancellation
- Keep the existing UI structure (dropdown, search button, results list)

### Out of Scope

- Radarr/Sonarr API-level indexer filtering (doesn't exist in their API)
- Sequential per-indexer search (over-engineered for the current need)
- Modifying Radarr indexer config from the app (dangerous, race conditions)
- Bug 1 root-cause investigation beyond the code fix (config verification is a deployment concern, not a code change)
- Loading UX enhancements (elapsed timer, cancel button) — already partially present, can be a follow-up

## Capabilities

### New Capabilities

- `calendar-release-timeout`: Increase the backend release search timeout and align the frontend timeout to prevent premature cancellation
- `calendar-indexer-filter`: Plumb the indexer selection through the API chain and filter releases server-side by indexer name

### Modified Capabilities

None — the existing `calendar-radarr-sonarr-integration` spec describes add/search/grab flows which are unaffected by this change.

## Approach

**Approach 1: Timeout + Server-Side Filter** (user-selected)

1. **Backend timeout** (`clients.py:1028`): Change `REQUEST_TIMEOUT * 5` → `REQUEST_TIMEOUT * 12` (5s × 12 = 60s)
2. **Request model** (`app.py:179-182`): Add optional `indexer: str | None = None` field to `CalendarReleasesRequest`
3. **Backend handler** (`app.py:461-479`): Pass `req.indexer` to `arr_fetch_releases()`
4. **Backend fetch** (`clients.py:1018-1071`): Add `indexer: str | None = None` parameter; after parsing releases from Radarr, filter by `release["indexer"] == indexer` when `indexer` is provided and not `"all"`
5. **Frontend API** (`calendar.ts:54-82`): Add optional `indexer?: string` parameter to `fetchCalendarReleases()`; include it in the JSON body
6. **Frontend modal** (`CalendarModal.tsx:90`): Pass `selectedIndexer` to `fetchCalendarReleases()`
7. **Frontend timeout** (`calendar.ts:60`): Change 30s → 65s to stay above the new backend timeout

## Affected Areas

| Area | Impact | Description |
|------|--------|-------------|
| `backend/clients.py:1018-1071` | Modified | `arr_fetch_releases()` — new `indexer` param, timeout increase to 60s, post-fetch filter |
| `backend/app.py:179-182` | Modified | `CalendarReleasesRequest` — add `indexer` field |
| `backend/app.py:461-479` | Modified | `calendar_releases()` — pass `req.indexer` to `arr_fetch_releases()` |
| `frontend/src/api/calendar.ts:54-82` | Modified | `fetchCalendarReleases()` — add `indexer` param, increase timeout to 65s |
| `frontend/src/components/CalendarModal.tsx:90` | Modified | `handleSearch()` — pass `selectedIndexer` to `fetchCalendarReleases()` |

## Risks

| Risk | Likelihood | Mitigation |
|------|------------|------------|
| 60s timeout still insufficient for very slow indexers | Low | Filter is server-side — reduces payload size; user can retry with specific indexer to narrow scope |
| Frontend timeout out of sync with backend | Low | Set frontend to 65s (5s buffer above backend 60s); single source of truth is the backend timeout |
| Server-side filter adds trivial overhead | Negligible | Single pass over releases array; O(n) where n is typically <100 |
| Breaking change to API contract (`indexer` field) | Low | Field is optional with `None` default; existing callers unaffected |

## Rollback Plan

1. Revert the 5 commits (one per file) that touched the affected files
2. Alternatively, revert to the commit before `calendar-flow-fix` branch: `git revert <range>`
3. No database migrations or config changes involved — pure code revert
4. If only partial rollback needed: removing the `indexer` filter is safe (reverts to current "all indexers" behavior); timeout rollback is a one-line change

## Dependencies

- None — self-contained change within the existing backend/frontend codebase

## Success Criteria

- [ ] `POST /api/calendar/releases` with `indexer: "SomeIndexer"` returns only releases from that indexer
- [ ] `POST /api/calendar/releases` without `indexer` (or `indexer: "all"`) returns all releases (backward-compatible)
- [ ] Release search does not timeout within 60s for typical Radarr/Sonarr configurations (2-5 indexers)
- [ ] Frontend modal correctly passes the selected indexer to the API
- [ ] Existing tests pass (no regressions in add, grab, or search flows)
