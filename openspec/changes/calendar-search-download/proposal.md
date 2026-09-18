# Proposal: Calendar Search & Download Modal

## Intent

The Calendar page shows upcoming movies and episodes, but items without files are dead ends. Users want to click a card, search for the content via Radarr/Sonarr indexers, and trigger a download — all without leaving the Calendar view. This turns the Calendar from a read-only schedule into an actionable content acquisition dashboard.

## Scope

### In Scope
- Click handler on Calendar cards with `has_file: false`
- Modal overlay showing item details + search/download actions
- Backend endpoint: trigger Radarr/Sonarr search for a specific movie/episode
- Backend endpoint: add item to Radarr/Sonarr library (for content not yet tracked)
- Visual feedback: queue status, download progress, import confirmation
- Consistent design with existing ScanModal pattern

### Out of Scope
- AmuTorrent direct search (AmuTorrent is a download client, not a search engine; search goes through Radarr/Sonarr indexers)
- Manual torrent file upload
- Indexer configuration UI
- History/log of past searches

## Capabilities

### New Capabilities
- `calendar-search-modal`: Modal overlay for searching and downloading content from Calendar cards
- `calendar-radarr-sonarr-integration`: Direct Radarr/Sonarr search + add-to-library from Calendar

### Modified Capabilities
- None — this is purely additive to the Calendar page

## Approach

**Key architectural insight**: AmuTorrent is a download client (like qBittorrent), NOT a search engine. The search must go through Radarr/Sonarr's configured indexers.

### Flow
1. User clicks a Calendar card with `has_file: false`
2. Modal opens showing: poster, title, date, type badge
3. If item is in Radarr/Sonarr library → "Search" button triggers `MoviesSearch`/`EpisodeSearch`
4. If item is NOT in library → "Add & Search" button first adds via `POST /api/v3/movie` or `POST /api/v3/series`, then searches
5. Modal shows search status (pending/completed/failed)
6. After successful search, item appears in queue → auto-refresh updates the card
7. Download completes → Radarr/Sonarr auto-imports (existing flow)

### Backend Changes
- `POST /api/calendar/search` — triggers search for a calendar item (delegates to `arr_search_movie` or `arr_search_episode`)
- `POST /api/calendar/add` — adds a movie/series to Radarr/Sonarr library if not already tracked

### Frontend Changes
- `CalendarModal.tsx` — new component (follows ScanModal pattern)
- `Calendar.tsx` — add click handler on cards, pass item to modal
- New API functions in `api/calendar.ts`

## Affected Areas

| Area | Impact | Description |
|------|--------|-------------|
| `frontend/src/components/Calendar.tsx` | Modified | Add click handler + modal state |
| `frontend/src/components/CalendarModal.tsx` | New | Search/download modal component |
| `frontend/src/api/calendar.ts` | New | API functions for search + add |
| `backend/app.py` | Modified | Two new endpoints |
| `backend/clients.py` | Modified | Wrapper for Radarr/Sonarr add |
| `frontend/src/styles.css` | Modified | Modal styles (reuse scan-modal patterns) |

## Risks

| Risk | Likelihood | Mitigation |
|------|------------|------------|
| Radarr/Sonarr add requires full metadata (year, title, TMDB ID) | High | Use data from calendar response; Radarr/Sonarr can fuzzy-match |
| Search may return no results (indexers not configured) | Medium | Show clear "no results" state; suggest checking indexer config |
| Race condition: item added but search hasn't started yet | Low | Sequential: add → wait for confirmation → search |
| User confusion: search triggers download automatically | Medium | Show confirmation before download; explain what will happen |

## Rollback Plan

- Remove new endpoints from `app.py`
- Remove `CalendarModal.tsx` and `api/calendar.ts`
- Revert `Calendar.tsx` click handlers
- No data migration needed — purely additive feature

## Dependencies

- Radarr/Sonarr must be configured with indexers for search to work
- Existing `arr_search_movie` / `arr_search_episode` functions already handle the search flow
- Existing queue system handles download monitoring

## Success Criteria

- [ ] Clicking a Calendar card with no file opens a modal
- [ ] Modal shows item details (poster, title, date, type)
- [ ] "Search" button triggers Radarr/Sonarr search
- [ ] "Add & Search" works for items not in library
- [ ] Search status is shown (pending/completed/failed)
- [ ] After download, card updates to show "has file"
- [ ] No TypeScript errors, all existing tests pass
