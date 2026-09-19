# Exploration: Calendar Flow Bugs

## Current State

### Data Flow: Frontend → Backend → Radarr/Sonarr

1. **Calendar Page** (`Calendar.tsx`) fetches `/api/calendar?start=...&end=...` to get calendar items
2. User clicks a card with `has_file: false` → opens `CalendarModal.tsx`
3. **Indexer fetch**: Modal mounts → fetches `GET /api/calendar/indexers?source={source}` → backend calls `arr_indexers()` → `GET /api/v3/indexer` on Radarr/Sonarr → returns list of configured indexers
4. **Release search**: User clicks "Buscar Releases" → `fetchCalendarReleases(source, type, id)` → `POST /api/calendar/releases` → `arr_fetch_releases()` → `GET /api/v3/release?movieId={id}` (or `episodeId`) on Radarr/Sonarr → returns releases from ALL indexers
5. **Grab**: User clicks a release → `grabCalendarRelease(source, guid)` → `POST /api/calendar/grab` → `arr_grab_release()` → `POST /api/v3/release/pick`

### Key Observation

The Radarr/Sonarr `GET /api/v3/release` endpoint does **NOT** accept an `indexerId` filter parameter. Releases are fetched from all configured indexers simultaneously. The indexer selector in the UI is currently cosmetic — `selectedIndexer` state exists but is never passed to any API call.

---

## Bugs Found

### Bug 1: Indexer Selector Empty

**File**: `backend/clients.py:622-652` (`arr_indexers`)
**File**: `backend/app.py:498-506` (`calendar_indexers`)

**Current behavior**: The code appears correct — `arr_indexers` returns ALL indexers without filtering by `enableSearch`. The endpoint returns `{"indexers": [...]}`.

**Root cause**: The user reports `/api/calendar/indexers?source=radarr` returns `[]` despite Radarr working via direct curl. Possible causes:
1. **Service lookup failure** — `SERVICES` config might not have the correct `key` or `kind` for the Radarr instance
2. **API key mismatch** — `RADARR_API_KEY` in config may be empty or wrong
3. **URL mismatch** — `RADARR_URL` may not point to the correct Radarr instance
4. **Error swallowing** — `arr_indexers` catches `asyncio.TimeoutError` and `aiohttp.ClientError` and returns `[]` silently

**Evidence**: The debug endpoint `/api/debug/indexers` (line 1260) was likely added to diagnose this exact issue. The `arr_indexers` function has extensive logging (`log.warning`) suggesting prior debugging effort.

**Status**: Need to verify the actual Radarr configuration values and test the debug endpoint to confirm the root cause.

---

### Bug 2: 25s Timeout on Release Search

**File**: `backend/clients.py:1018-1071` (`arr_fetch_releases`)
**File**: `frontend/src/api/calendar.ts:54-82` (`fetchCalendarReleases`)

**Current behavior**:
- Backend timeout: `REQUEST_TIMEOUT * 5 = 5 * 5 = 25s` (line 1028)
- Frontend timeout: `30s` via AbortController (line 60)
- On timeout, backend returns `{"releases": [], "detail": "Timeout: Radarr/Sonarr no respondió en 25s..."}`
- Frontend receives this and displays error

**Root cause**: Radarr/Sonarr `GET /api/v3/release` queries ALL configured indexers. If any indexer is slow, unreachable, or has many results, the total response time exceeds 25s. This is a known behavior of the Radarr/Sonarr release search — it fans out to all indexers in parallel but waits for all to respond.

**Contributing factors**:
1. No indexer filtering (bug 3) means all indexers are always queried
2. Default `REQUEST_TIMEOUT` is only 5s, making the multiplier (5x) still insufficient for release searches
3. No progressive loading or streaming — the endpoint waits for the slowest indexer

**Impact**: Users see a timeout error with no ability to retry or narrow the search.

---

### Bug 3: Indexer Selector Is Cosmetic

**File**: `frontend/src/components/CalendarModal.tsx:45,88,191`
**File**: `frontend/src/api/calendar.ts:54-82`
**File**: `backend/app.py:461-479`
**File**: `backend/clients.py:1018-1071`

**Current behavior**:
- `selectedIndexer` state exists (line 45) and dropdown renders (lines 186-202)
- `handleSearch()` builds a message mentioning the selected indexer (line 88) but calls `fetchCalendarReleases(item.source, item.type, item.id)` WITHOUT passing the indexer
- `fetchCalendarReleases()` doesn't accept an indexer parameter
- Backend endpoint doesn't accept an indexer parameter
- `arr_fetch_releases()` doesn't pass indexer filter to Radarr API

**Root cause**: The indexer selector was added as UI scaffolding during the initial `calendar-search-download` feature, but the plumbing to actually use it was never implemented.

**What Radarr/Sonarr API supports**: The `GET /api/v3/release` endpoint does NOT support `indexerId` filtering. However, the Radarr v4+ API has `POST /api/v3/release/search` which takes `movieIds` and returns releases — but also doesn't filter by indexer.

---

## Affected Areas

| File | Lines | Why Affected |
|------|-------|-------------|
| `backend/clients.py` | 622-652 | `arr_indexers()` — may need better error reporting or config validation |
| `backend/clients.py` | 1018-1071 | `arr_fetch_releases()` — timeout too short, no indexer filtering possible at API level |
| `backend/app.py` | 461-479 | `calendar_releases()` — missing indexer parameter passthrough |
| `backend/app.py` | 498-506 | `calendar_indexers()` — needs validation/logging for debugging |
| `frontend/src/api/calendar.ts` | 54-82 | `fetchCalendarReleases()` — needs indexer parameter |
| `frontend/src/components/CalendarModal.tsx` | 45,88-90,186-202 | `selectedIndexer` state exists but unused in search |

---

## Approaches

### Approach A: Client-Side Indexer Filtering

After fetching all releases from Radarr/Sonarr, filter them client-side by the selected indexer name.

**Pros**:
- Simplest change — no backend API changes needed
- Works with existing Radarr/Sonarr API
- Immediate UX improvement
- Can increase backend timeout to 60s without affecting UX (filtering happens after)

**Cons**:
- Still queries ALL indexers (timeout risk remains)
- User sees "searching..." for same duration even if they only want one indexer
- Not a true "search through indexer" — it's "search all, show one"

**Effort**: Low

---

### Approach B: Increase Timeout + Client-Side Filtering + Loading UX

1. Increase backend timeout from 25s to 60s
2. Add client-side indexer filtering (like Approach A)
3. Add elapsed timer and cancel button to modal
4. Show which indexers are being queried

**Pros**:
- Better UX with progress feedback
- More realistic timeout for slow indexers
- Users can cancel long-running searches
- Filtering reduces noise in results

**Cons**:
- Still queries all indexers
- 60s is still a hard limit — some indexers may be slower

**Effort**: Low-Medium

---

### Approach C: Sequential Indexer Search (Parallel Backend Calls)

When user selects a specific indexer:
1. Frontend sends `indexerId` (or indexer name) to backend
2. Backend queries Radarr/Sonarr with all indexers but returns only matching ones
3. If user wants "all", query as usual; if specific indexer, query all but filter server-side

**Pros**:
- Server-side filtering reduces payload
- Can return partial results if some indexers fail
- Better error handling per-indexer

**Cons**:
- Radarr API doesn't support indexer filtering, so this is still server-side filtering of the same response
- Slightly more complex but no real performance gain over Approach A

**Effort**: Medium

---

### Approach D: Use Radarr Command API for Targeted Search

The `arr_search_movie()` function triggers `MoviesSearch` command which searches ALL indexers. There's no Radarr API to trigger search on a specific indexer. However, we could:
1. Temporarily disable indexers via `PUT /api/v3/indexer/{id}` (set `enableSearch: false`)
2. Trigger search
3. Re-enable indexers

**Pros**:
- True single-indexer search
- Reduces timeout risk

**Cons**:
- DANGEROUS — modifying Radarr config from the app
- Race conditions if user uses Radarr UI simultaneously
- Complex error recovery if something fails mid-way
- Over-engineered for the use case

**Effort**: High (not recommended)

---

## Recommendation

**Implement Approach B (Increase Timeout + Client-Side Filtering + Loading UX)** as the primary fix:

1. **Increase backend timeout** from `REQUEST_TIMEOUT * 5` (25s) to `REQUEST_TIMEOUT * 12` (60s) in `arr_fetch_releases()`
2. **Pass indexer selection** through the full chain: frontend → backend → filter response (server-side is cleaner than client-side)
3. **Add elapsed timer** already exists in the modal — make it more prominent
4. **Add cancel button** during search
5. **Improve error messages** — distinguish between "no indexers configured" vs "timeout" vs "connection error"

This addresses all three bugs:
- Bug 1: Debug the actual config issue (verify with `/api/debug/indexers`)
- Bug 2: Longer timeout + cancel button = better UX
- Bug 3: Indexer selection actually filters results

---

## Risks

- **Radarr/Sonarr may have many indexers** — even with 60s timeout, some configurations may still timeout. Consider adding a "per-indexer" timeout or circuit breaker.
- **Indexer filtering is post-hoc** — we still fetch from all indexers. If the goal is truly to search ONLY one indexer, we need Radarr API support (which doesn't exist).
- **Config verification** — Bug 1 may be a configuration issue, not a code bug. Need to verify the actual Radarr URL and API key in the running instance.

---

## Key Questions Before Proposal

1. **What does `/api/debug/indexers?source=radarr` return?** This will confirm whether the issue is config or code.
2. **How many indexers are configured in Radarr?** If only 1-2, the timeout issue may be elsewhere (network, Radarr load).
3. **What is the expected behavior when "Buscar Releases" times out?** Should it auto-retry, show a cancel button, or just show the error?
4. **Is client-side filtering sufficient, or does the user truly want to search through ONLY one indexer?** (Radarr API limitation)
5. **Should we increase the global `REQUEST_TIMEOUT` or just for release searches?** (Other endpoints may be affected)

---

## Ready for Proposal

**Yes** — the exploration is complete. The orchestrator should:
1. Run `/api/debug/indexers?source=radarr` to confirm Bug 1 root cause
2. Ask the user whether client-side filtering (Approach A/B) is sufficient or if they need true single-indexer search (which requires Radarr API changes)
3. Proceed to SDD proposal with the selected approach
