# Fase 3 — SSE `/api/events` (cola de eventos backend → frontend)

## Objetivo
Canal server→client con EventSource: los workers/loops publican eventos y el
frontend invalida sus queries al momento. **El polling se mantiene como
fallback** (red de seguridad operativa — el nginx del despliegue ya mordió una
vez con buffering/timeouts); apagar los `refetchInterval` es un PR posterior
cuando SSE esté probado en producción.

## Alcance
- [x] T1 (backend): bus de eventos — `backend/event_bus.py`: suscriptores
      (`subscribe() -> asyncio.Queue`), `publish(event)` fan-out no bloqueante
      (subcriptor lento nunca puede colgar al publicador), heartbeat
      (`: ping`) para proxies. Endpoint `GET /api/events` (StreamingResponse,
      `text/event-stream`): auth con el mismo check que el resto VÍA
      `?key=` (EventSource no manda headers) + header si viene, retry hint,
      `proxy_buffering off` documentado (snippet nginx en el doc/PR).
- [x] T2 (backend): publicadores —
      a) `TaskManager.update` al llegar a terminal (`done`/`error`) publica
      `{kind:"task", channel, task_id, status, detail}`; `channel` =
      kwarg opcional en `create` (lo pasan grab/release/copy/mixer al crear).
      Nunca lanzar: publish envuelto/try.
      b) sweep de traces y tick del downloads cache publican
      `{kind:"trace"|"downloads", version:<timestamp>}` tras refrescar.
- [x] T3 (frontend): `useEventSource('/api/events?key=…')` con auto-reconnect
      (retry razonable) → `queryClient.invalidateQueries` por mapa:
      `task+channel grab` → `['grab-task', id]`, `release` → `['release-task',
      id]`, copy/mixer → sus claves (revisar TraceActions/mixer);
      `trace` → `['trace']`/afectadas; `downloads` → clave de downloads.
      El resto de components SIN cambios (fallback intacto).
- [x] T4 (tests): bus (fan-out, subscriber lento), endpoint (shape SSE,
      auth por query), publicación terminal del TaskManager con channel,
      frontend: hook invalida la query correcta por evento (y sigue
      funcionando sin SSE — fallback).

## Fuera de alcance (decisión documentada)
- Apagar `refetchInterval` (PR posterior tras validar en su nginx).
- Last-Event-ID / re-emit de eventos perdidos (el fallback de polling los
  cubre: al reconectar, la query pendiente se refresca sola).
- WebSockets.

## Checks
- `backend/`: `../.venv/bin/python -m pytest` (baseline 1082)
- `frontend/`: `./node_modules/.bin/vitest run` (503), `tsc -b --noEmit`,
  `eslint src/`
- e2e de CI es GATE

## Estrategia de delivery
- single PR (preferencia establecida); forecast >400.

## Progress
- 2026-10-12: doc creada, rama `feat/sse-events` desde main (30cc522).

## Progress (padre)
- 2026-10-12: T1–T4 [x] + follow-up auth-gate (EventSource no abre hasta
  key presente o auth desactivado — evita 401s que rellenan C-05).
  Checks: backend pytest 1105 (+23), frontend vitest 518 (+12+3), tsc 0,
  eslint 0. Ratchet MAX_LEGACY_LOC 2578→2730 (event_bus.py + 1 línea app.py).
  Exclusiones documentadas: `downloads` sin query key en frontend (no se
  invalida), polling intacto (fallback), snippet nginx en docstring de
  routes/events.py.
