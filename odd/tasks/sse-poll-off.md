# B1 — Apagar los polls de TAREAS cuando SSE está conectado

## Contexto (por qué B1 y no "apagarlo todo")
Inventario de `refetchInterval` (2026-10-12):
- **Tareas** (`ReleaseSearchModal` release+grab 1500, `TraceActions` copy,
  `MediaMixer` mixer): el worker publica `event: task` al cerrar → SSE cubre
  por completo → **apagar con fallback es ganancia pura**.
- **`status` 5s**: `background_checker` no publica evento → B2.
- **`trace` 15s + Seguimiento 2s/10s**: el refresh de `trace_cache` es
  lectura-driven (TTL perezoso, `trace_cache.py:51-57` publica tras refresh):
  sin lecturas no hay refresh → no hay eventos → **kanban congelado** → B2
  (refresher backend independiente + evento de frescura).
- `actions` 60s, `DiskSpace` 30s: sin cubrir → quedan.

Apagar sin B2 = riesgo de pantalla congelada; por eso el alcance es tasks-only.

## Alcance (B1)
- [x] T1: `useEventStream` expone el estado de conexión
      (`connected` vía `onopen`, `disconnected` vía `onerror`/cierre) a través
      de un React context exportado del propio módulo. **Default:
      `disconnected`** (sin provider → polls siguen como hoy — todos los
      tests existentes sin montar el provider conservan su semántica).
- [x] T2: `App.tsx` envuelve el árbol con el provider (el hook ya se monta
      ahí).
- [x] T3: consumidores: `ReleaseSearchModal` (×2), `TraceActions`,
      `MediaMixer` → `refetchInterval: connected ? false : <fn actual>`
      (mismo valor de función, sin tocar su lógica interna).
- [x] T4: tests — RED primero: (a) con provider `connected` los intervalos
      de tarea devuelven `false`; (b) con `disconnected` (o sin provider)
      conservan el valor actual; (c) `onerror` vuelve a `disconnected` y los
      polls resucitan (fallback real, no solo teórico).

## Fuera de alcance (documentado)
- B2: publisher de `status` + refresher backend de `trace` (cadencia
  adaptativa del kanban) → apagar `App` 5s/15s y `Seguimiento` 2s/10s.
- `actions`/`DiskSpace` (sin cubrir, baratos).

## Checks
- `frontend/`: `./node_modules/.bin/vitest run` (baseline 518),
  `tsc -b --noEmit`, `eslint src/`
- backend intocado; e2e CI = GATE

## Estrategia
- single PR (preferencia establecida); forecast <400 (frontend puro).

## Progress
- 2026-10-12: doc creada, rama `feat/sse-gate-task-polls` desde main.

## Progress (padre)
- 2026-10-12: B1 [x] — context EventStreamContext (default disconnected),
  App envuelve el árbol, 4 intervals gated (release/grab/copy/mixer),
  lifecycle test (onerror → polls resucitan). Checks: vitest 525 (+7),
  tsc 0, eslint 0. B2 (status publisher + trace refresher backend) queda
  documentado, sin empezar.

---

# B2 — Refrescadores backend + apagar los polls ambientales

Evidencia de la exploración (2026-10-12):
- `GET /api/status` sirve `status_cache` que solo cambia en el tick de
  `background_checker` (**15s**, `intervals.check`) → el poll de 5s del
  cliente solo relee datos sin cambiar; publicar al final de `check_all`
  (cubre tick Y `/api/status/refresh`) da frescura ≥ actual con 0 requests
  extra.
- `build_traces` = **9 llamadas HTTP + 1 lectura SQLite** por build;
  `TRACE_TTL = 10.0` (bajo el poll de 15s a propósito). Un refresher a 2s
  multiplicaría ×5 la carga — prohibido; la cadencia es 10s (TTL).
- `downloads_poller` (`downloads_cache.py:184-200`) = plantilla exacta:
  tick con try/except, publish solo en refresh real.
- `event_bus` no expone `subscriber_count()` → añadirlo (el SSE route
  subscribe antes del primer yield y unsubscribe en finally → el conteo es
  fiable).
- ⚠️ El poll adaptativo 2s/10s de Seguimiento es `['queue']` → `/api/queue`
  (**NO** es trace) y **queda como está** (SSE no lo cubre).
- Frontend: `['status']` 5s y `['trace']` 15s en `App.tsx` → los que se
  apagan. `['actions']` 60s y `DiskSpace` 30s siguen (sin cubrir).

## Alcance (B2)
- [x] B2.1 (backend): `event_bus.subscriber_count()`.
- [x] B2.2 (backend): publish `{"kind":"status","version"}` al final de
      `check_all` (status.py) — best-effort try igual que trace.
- [x] B2.3 (backend): `trace_refresher` en `trace_cache.py` (clon de
      downloads_poller): cada `TRACE_TTL` → `get_traces()` SOLO si
      `subscriber_count() >= 1`; registrado en el lifespan de `app.py`.
      Sin subs → 0 builds (nadie puede observar obsolescencia); con subs →
      1 build/10s compartido por todos los tabs (≤ carga de hoy).
- [x] B2.4 (frontend): listener `status` → invalidate `['status']`;
      gate `['status']` (5000) y `['trace']` (15000) con `connected ? false :`
      (mismo patrón que B1). `['queue']`, `['actions']`, `DiskSpace`: sin
      cambios.

## Checks
- backend `pytest` (baseline 1105), frontend `vitest` (525), tsc, eslint.
- e2e CI = GATE.

## Progress B2
- 2026-10-12: diseño cerrado por exploración; rama `feat/sse-b2-refreshers`.

- 2026-10-12: **B2 [x]** — subscriber_count, publish en check_all (finally,
  cubre tick+refresh+early-return), trace_refresher (0 subs → 0 builds;
  ≥1 → 1 build/10s), App gate status/trace, listener status. Checks:
  backend 1113 (+8), frontend 529 (+4), tsc/eslint 0. Ratchet
  MAX_LEGACY_LOC 2730→2750 (owned en PR). `['queue']`/`['actions']`/
  DiskSpace sin cambios (documentado).
