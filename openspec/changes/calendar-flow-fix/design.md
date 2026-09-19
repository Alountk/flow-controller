# Design: Calendar Flow Fix

## Technical Approach

Two independent capabilities that together restore the calendar release search flow:

1. **calendar-release-timeout**: Increase `arr_fetch_releases()` timeout from `REQUEST_TIMEOUT * 5` (25s) to `REQUEST_TIMEOUT * 12` (60s), and align the frontend `AbortController` from 30s to 65s (5s buffer above backend).

2. **calendar-indexer-filter**: Client-side filter in the frontend after fetching all releases. The frontend fetches ALL releases (no indexer param sent to backend), then filters locally by `selectedIndexer`.

This is a **fetch-all-then-filter** approach because the Radarr/Sonarr API does not expose an `indexerId` filter parameter. The filter is trivial (O(n) where n < 100 releases).

## Architecture Decisions

### Decision: Backend timeout multiplier

**Choice**: `REQUEST_TIMEOUT * 12` (60s)
**Alternatives considered**: `* 10` (50s), `* 15` (75s), hardcoded 60s
**Rationale**: Radarr fans out to all configured indexers in parallel; with 2-5 indexers, 25s was insufficient when one indexer was slow. 60s gives a 4x headroom without being excessive. Using the multiplier keeps consistency with the existing pattern across `clients.py` (all other timeouts use `REQUEST_TIMEOUT * N`).

### Decision: Frontend timeout alignment

**Choice**: 65s AbortController timeout
**Alternatives considered**: Match backend at 60s, 70s, or remove frontend timeout
**Rationale**: Frontend must stay slightly above backend to avoid premature client-side cancellation while the server is still processing. 5s buffer is the minimum safe margin. Removing the timeout is unsafe (browser could hang indefinitely).

### Decision: Client-side indexer filter

**Choice**: Filter in frontend after fetching all releases
**Alternatives considered**: Server-side post-fetch filter, Radarr API `indexerId` parameter, sequential per-indexer search
**Rationale**: Simpler backend (no model/handler changes), instant filtering with no network round-trip, easier to debug (filter logic visible in frontend code). The Radarr/Sonarr release API has no indexer filter parameter anyway, so server-side would also be post-fetch. Client-side avoids touching backend models, handlers, and API contracts.

### Decision: Filter by name (exact match)

**Choice**: Exact string match on `release.indexer === selectedIndexer`
**Alternatives considered**: Case-insensitive match, partial match, index ID match
**Rationale**: Radarr returns indexer names as-is; exact match is deterministic and predictable. Case-insensitive adds complexity with no user benefit (indexer names are configured by the user and consistent).

## Data Flow

```
CalendarModal                     FastAPI                         Radarr/Sonarr
─────────────                     ───────                         ─────────────
handleSearch()
  │
  ├─ selectedIndexer = "SomeIndexer" (or "all")
  │
  └─ fetchCalendarReleases(source, type, id)
       │
       ├─ POST /api/calendar/releases
       │  body: { source, type, id }        ← NO indexer param
       │
       └─────────────────────────► calendar_releases(req)
                                     │
                                     ├─ Validate service
                                     │
                                     └─ arr_fetch_releases(session, service, movie_id)
                                          │
                                          ├─ GET /api/v3/release?movieId=42
                                          │  timeout: 60s
                                          │
                                          ├─ Parse releases from JSON
                                          │
                                          └─ Return { releases: [...], detail: "..." }
       │
       ◄───────────────────────────── { releases: [...], detail: "..." }
       │
       ├─ Client-side filter:
       │  const filtered = releases.filter(r =>
       │    selectedIndexer === 'all' || r.indexer === selectedIndexer
       │  )
       │
       └─ Display filtered results in modal
```

## File Changes

| File | Action | Description |
|------|--------|-------------|
| `backend/clients.py` (line 1028) | Modify | Change `REQUEST_TIMEOUT * 5` → `REQUEST_TIMEOUT * 12` |
| `frontend/src/api/calendar.ts` (line 54-60) | Modify | Change timeout from `30000` → `65000` |
| `frontend/src/components/CalendarModal.tsx` (line 90) | Modify | Add client-side filter after fetch, before display |

## Detailed Changes

### 1. `backend/clients.py` — `arr_fetch_releases()`

**Timeout change** (line 1028):
```python
# Before:
timeout = aiohttp.ClientTimeout(total=REQUEST_TIMEOUT * 5)

# After:
timeout = aiohttp.ClientTimeout(total=REQUEST_TIMEOUT * 12)
```

No signature changes. No filter logic added to backend.

### 2. `frontend/src/api/calendar.ts` — `fetchCalendarReleases()`

**Timeout** (lines 54-65):
```typescript
// Before:
const timeout = setTimeout(() => controller.abort(), 30000) // 30s timeout

// After:
const timeout = setTimeout(() => controller.abort(), 65000) // 65s timeout (backend is 60s)
```

No `indexer` parameter added. Body remains `{ source, type, id }`.

**Timeout message** (line 78):
```typescript
// Before:
return { releases: [], detail: 'Timeout: Radarr/Sonarr no respondió. Verifica que el servicio esté activo.' }

// After:
return { releases: [], detail: 'Timeout: Radarr/Sonarr no respondió en 65s. Verifica que el servicio esté activo y los indexadores respondan.' }
```

### 3. `frontend/src/components/CalendarModal.tsx` — `handleSearch()`

**Add client-side filter** (after line 90, before display):
```typescript
// Before:
const result = await fetchCalendarReleases(item.source, item.type, item.id)
// ... display result.releases

// After:
const result = await fetchCalendarReleases(item.source, item.type, item.id)
const filtered = selectedIndexer === 'all'
  ? result.releases
  : result.releases.filter(r => r.indexer === selectedIndexer)
// ... display filtered (instead of result.releases)
```

## Interfaces / Contracts

No backend contract changes. The API request/response shapes remain identical.

### `fetchCalendarReleases()` signature

```typescript
function fetchCalendarReleases(
  source: string,
  type: string,
  id: number,
): Promise<{ releases: Release[]; detail: string }>
```

### `arr_fetch_releases()` signature

```python
async def arr_fetch_releases(
    session: aiohttp.ClientSession,
    service: dict,
    movie_id: int = 0,
    episode_id: int = 0,
) -> dict
```

## Testing Strategy

| Layer | What to Test | Approach |
|-------|-------------|----------|
| Unit | `arr_fetch_releases` timeout is 60s | Verify `aiohttp.ClientTimeout(total=60)` is set (inspect timeout.total) |
| Unit | Frontend filter: `selectedIndexer='all'` returns all releases | Mock fetch result with mixed indexers; apply filter; assert all returned |
| Unit | Frontend filter: specific indexer returns only matching | Mock fetch result with mixed indexers; apply filter with `selectedIndexer='Torznab'`; assert only Torznab |
| Unit | Frontend filter: no match returns empty | Mock fetch result; apply filter with non-existent indexer; assert empty array |
| Frontend | `fetchCalendarReleases` sends correct body (no indexer) | Mock fetch; call; verify body has no `indexer` key |
| E2E | Full flow: select indexer → search → filtered results | Manual or Cypress: open modal, select specific indexer, verify results filtered |

### Existing Test Updates

Backend tests in `TestCalendarReleases` (lines 632-667) continue to pass unchanged — the mock replaces `arr_fetch_releases` entirely, and the API contract is unchanged. No backend test modifications needed.

## Threat Matrix

N/A — no routing, shell, subprocess, VCS/PR automation, executable-file classification, or process-integration boundary.

## Migration / Rollout

No migration required. This is a pure code change with no database schema, config, or environment variable changes.

**Deployment order**: Backend first (timeout change is backward-compatible), then frontend. Frontend applies client-side filtering independently.

**Rollback**: Revert commits. No data to migrate back.

## Open Questions

None — all technical decisions are resolved. The client-side approach is simpler with fewer moving parts.
