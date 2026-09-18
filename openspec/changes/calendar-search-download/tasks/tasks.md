# Implementation Tasks: Calendar Search & Download Modal

## Task 1: Backend — arr_add_movie + arr_add_series in clients.py

**Priority**: High
**Estimated effort**: Small

Add two new functions to `backend/clients.py`:
- `arr_add_movie(session, service, movie_data)` — sends `POST /api/v3/movie` to Radarr
- `arr_add_series(session, service, series_data)` — sends `POST /api/v3/series` to Sonarr

Both follow the existing pattern of `arr_command()` but use POST with body.

**Acceptance criteria**:
- [ ] `arr_add_movie` sends correct payload to Radarr
- [ ] `arr_add_series` sends correct payload to Sonarr
- [ ] Both handle errors gracefully (timeout, HTTP errors)
- [ ] Both return `{"ok": bool, "id": int | None, "detail": str}`

---

## Task 2: Backend — POST /api/calendar/search + /api/calendar/add

**Priority**: High
**Estimated effort**: Small

Add two endpoints to `backend/app.py`:
- `POST /api/calendar/search` — delegates to `arr_search_movie` or `arr_search_episode`
- `POST /api/calendar/add` — calls `arr_add_movie`/`arr_add_series`, then triggers search

Add Pydantic models for request validation.

**Acceptance criteria**:
- [ ] `/api/calendar/search` accepts `{ source, type, id }` and returns `{ ok, detail }`
- [ ] `/api/calendar/add` accepts `{ source, type, title, year }` and returns `{ ok, id, detail }`
- [ ] Both endpoints require API key authentication
- [ ] Error handling: service unavailable, invalid data

---

## Task 3: Backend — Tests for new endpoints

**Priority**: Medium
**Estimated effort**: Small

Add tests to `backend/tests.py` for the new calendar endpoints.

**Acceptance criteria**:
- [ ] Test search endpoint with mocked Radarr/Sonarr
- [ ] Test add endpoint with mocked Radarr/Sonarr
- [ ] Test error cases (service down, invalid input)
- [ ] All existing tests still pass

---

## Task 4: Frontend — API functions in api/calendar.ts

**Priority**: High
**Estimated effort**: Small

Create `frontend/src/api/calendar.ts` with:
- `searchCalendarItem(source, type, id)` — calls POST /api/calendar/search
- `addCalendarItem(source, type, metadata)` — calls POST /api/calendar/add

**Acceptance criteria**:
- [ ] Functions use `authHeaders()` for authentication
- [ ] Functions return typed responses
- [ ] Error handling included

---

## Task 5: Frontend — CalendarModal.tsx component

**Priority**: High
**Estimated effort**: Medium

Create `frontend/src/components/CalendarModal.tsx`:
- Displays item details (poster, title, date, type badge)
- Shows "Search" or "Add & Search" button based on library membership
- Status feedback (idle/searching/adding/done/error)
- Close via X, Escape, or backdrop click
- Reuse scan-modal CSS patterns

**Acceptance criteria**:
- [ ] Modal opens with correct item details
- [ ] "Search" button triggers searchCalendarItem
- [ ] "Add & Search" triggers addCalendarItem then searchCalendarItem
- [ ] Status messages shown correctly
- [ ] Close via X, Escape, backdrop
- [ ] TypeScript clean

---

## Task 6: Frontend — Integrate modal into Calendar.tsx

**Priority**: High
**Estimated effort**: Small

Modify `frontend/src/components/Calendar.tsx`:
- Add `scanItem` state (CalendarItem | null)
- Add click handler on cards with `has_file: false`
- Render CalendarModal when scanItem is set

**Acceptance criteria**:
- [ ] Cards with has_file=false are clickable
- [ ] Click opens modal with correct item
- [ ] Cards with has_file=true are not clickable
- [ ] Modal closes properly

---

## Task 7: Frontend — Add types + styles

**Priority**: Medium
**Estimated effort**: Small

- Add `CalendarSearchRequest` and `CalendarAddRequest` to `types.ts`
- Add modal styles to `styles.css` (reuse scan-modal patterns)

**Acceptance criteria**:
- [ ] Types are correct
- [ ] Modal matches existing design language
- [ ] Responsive on mobile

---

## Task 8: Integration test + final verification

**Priority**: Medium
**Estimated effort**: Small

- Run `npx tsc --noEmit` — must be clean
- Run `python3 -m pytest backend/tests.py` — must pass
- Manual test: click calendar card → modal opens → search works

**Acceptance criteria**:
- [ ] TypeScript clean
- [ ] All 39+ backend tests pass
- [ ] ESLint clean
- [ ] Manual flow works end-to-end
