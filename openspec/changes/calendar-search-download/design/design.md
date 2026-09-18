# Technical Design: Calendar Search & Download Modal

## Architecture Overview

```
Calendar.tsx
  ├── CalendarModal.tsx (new component)
  │     ├── Item details display
  │     ├── "Search" / "Add & Search" button
  │     └── Status feedback
  ├── api/calendar.ts (new)
  │     ├── searchCalendarItem()
  │     └── addCalendarItem()
  └── Click handler on cards with has_file=false

Backend:
  POST /api/calendar/search
    → arr_search_movie() or arr_search_episode()
    → returns { ok, detail }

  POST /api/calendar/add
    → POST /api/v3/movie or /api/v3/series to Radarr/Sonarr
    → then triggers search
    → returns { ok, id, detail }
```

## Component Design

### CalendarModal.tsx

**Props**:
```typescript
interface CalendarModalProps {
  item: CalendarItem
  onClose: () => void
}
```

**State**:
- `status: 'idle' | 'searching' | 'adding' | 'done' | 'error'`
- `message: string` (status/error message)

**Behavior**:
1. On mount, check if item is in Radarr/Sonarr library
2. Show "Search" if in library, "Add & Search" if not
3. On button click:
   - If "Search": call `searchCalendarItem()`
   - If "Add & Search": call `addCalendarItem()` → then `searchCalendarItem()`
4. Update status/message based on result
5. Close modal on success (or after 2s delay for user to see result)

**UI Pattern**: Reuse scan-modal-backdrop + scan-modal styles from MissingContent.tsx

### api/calendar.ts

```typescript
export async function searchCalendarItem(
  source: 'radarr' | 'sonarr',
  type: 'movie' | 'episode',
  id: number,
): Promise<{ ok: boolean; detail: string }>

export async function addCalendarItem(
  source: 'radarr' | 'sonarr',
  type: 'movie' | 'episode',
  metadata: { title: string; year?: number },
): Promise<{ ok: boolean; id?: number; detail: string }>
```

### Backend Endpoints

**POST /api/calendar/search**
```python
@app.post("/api/calendar/search")
async def calendar_search(req: CalendarSearchRequest):
    # req: { source: str, type: str, id: int }
    service = find_service(req.source)
    if req.type == "movie":
        result = await arr_search_movie(session, service, req.id)
    else:
        result = await arr_search_episode(session, service, req.id)
    return {"ok": result.get("ok", False), "detail": result.get("detail", "")}
```

**POST /api/calendar/add**
```python
@app.post("/api/calendar/add")
async def calendar_add(req: CalendarAddRequest):
    # req: { source: str, type: str, title: str, year?: int }
    service = find_service(req.source)
    if req.type == "movie":
        # Add to Radarr
        movie_data = build_movie_payload(req)
        result = await arr_add_movie(session, service, movie_data)
    else:
        # Add series to Sonarr
        series_data = build_series_payload(req)
        result = await arr_add_series(session, service, series_data)
    return {"ok": result.get("ok", False), "id": result.get("id"), "detail": ...}
```

## Data Flow

### Happy Path: Search for existing item

```
1. User clicks card (has_file=false)
2. Modal opens, shows item details
3. System checks: is item in Radarr/Sonarr? → YES
4. Modal shows "Search" button
5. User clicks "Search"
6. Modal status: "Buscando..."
7. Backend: arr_search_movie/episode(id)
8. Radarr/Sonarr searches indexers
9. If found → download starts automatically
10. Backend returns { ok: true }
11. Modal shows "Búsqueda completada"
12. QueueSidebar detects new queue item
13. After download completes → auto-import
14. Card updates to has_file=true
```

### Happy Path: Add & Search for new item

```
1. User clicks card (has_file=false)
2. Modal opens, shows item details
3. System checks: is item in Radarr/Sonarr? → NO
4. Modal shows "Add & Search" button
5. User clicks "Add & Search"
6. Modal status: "Agregando a biblioteca..."
7. Backend: POST /api/v3/movie or /api/v3/series
8. Backend: arr_search_movie/episode(new_id)
9. Backend returns { ok: true, id: new_id }
10. Modal shows "Agregado y buscando..."
11. Download starts → import → card updates
```

## Edge Cases

1. **Radarr/Sonarr unavailable**: Return error, show in modal
2. **No indexers configured**: Search returns empty, show "No se encontraron resultados"
3. **Item already downloading**: Search returns queue status, show "Ya en cola"
4. **Metadata incomplete**: Use best-available data (title + year); Radarr/Sonarr fuzzy-matches

## Files to Create/Modify

| File | Action | Description |
|------|--------|-------------|
| `frontend/src/components/CalendarModal.tsx` | Create | Modal component |
| `frontend/src/api/calendar.ts` | Create | API functions |
| `frontend/src/components/Calendar.tsx` | Modify | Add click handler + modal state |
| `frontend/src/types.ts` | Modify | Add CalendarSearchRequest, CalendarAddRequest |
| `frontend/src/styles.css` | Modify | Modal styles (reuse scan-modal) |
| `backend/app.py` | Modify | Add 2 endpoints |
| `backend/clients.py` | Modify | Add arr_add_movie, arr_add_series |
| `backend/tests.py` | Modify | Add tests for new endpoints |
