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
