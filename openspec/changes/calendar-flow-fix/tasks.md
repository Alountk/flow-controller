# Tasks: Calendar Flow Fix

## Review Workload Forecast

| Field | Value |
|-------|-------|
| Estimated changed lines | 5–10 |
| 400-line budget risk | Low |
| Chained PRs recommended | No |
| Suggested split | Single PR |
| Delivery strategy | ask-on-risk |
| Chain strategy | pending |

Decision needed before apply: No
Chained PRs recommended: No
Chain strategy: pending
400-line budget risk: Low

### Suggested Work Units

| Unit | Goal | Likely PR | Focused test command | Runtime harness | Rollback boundary |
|------|------|-----------|----------------------|-----------------|-------------------|
| 1 | All changes (timeout + filter) | PR 1 | `cd backend && python -m pytest tests/test_calendar.py -v` | Manual: open CalendarModal, select indexer, search → verify filtered results | Single revert removes all 3 line changes |

## Phase 1: Backend Timeout Increase

- [ ] 1.1 In `backend/clients.py` line 1028, change `REQUEST_TIMEOUT * 5` → `REQUEST_TIMEOUT * 12` in the `arr_fetch_releases()` function. The timeout error message on line 1068 already uses `int(timeout.total)` dynamically, so it will automatically reflect the new 60s value with no further changes.

## Phase 2: Frontend Timeout Alignment

- [ ] 2.1 In `frontend/src/api/calendar.ts` line 60, change the `AbortController` timeout from `30000` (30s) to `65000` (65s). Update the comment to `// 65s timeout (backend is 60s)`.
- [ ] 2.2 In `frontend/src/api/calendar.ts` line 78, update the timeout error detail string from `'Timeout: Radarr/Sonarr no respondió. Verifica que el servicio esté activo.'` to `'Timeout: Radarr/Sonarr no respondió en 65s. Verifica que el servicio esté activo y los indexadores respondan.'`

## Phase 3: Client-Side Indexer Filter

- [ ] 3.1 In `frontend/src/components/CalendarModal.tsx` inside `handleSearch()` (line 90), after the `fetchCalendarReleases` call and before the `result.releases.length > 0` check, add a client-side filter:
  ```typescript
  const filtered = selectedIndexer === 'all'
    ? result.releases
    : result.releases.filter(r => r.indexer === selectedIndexer)
  ```
  Then replace `result.releases` with `filtered` in the `setReleases` call and the `length` check.

## Phase 4: Verification

- [ ] 4.1 Run backend tests: `cd backend && python -m pytest tests/test_calendar.py -v` — confirm existing `TestCalendarReleases` tests pass (they mock `arr_fetch_releases`, so the timeout change is transparent).
- [ ] 4.2 Manual verification: open CalendarModal → select a specific indexer → search → confirm only matching releases appear. Select "All indexers" → search → confirm all releases appear.
