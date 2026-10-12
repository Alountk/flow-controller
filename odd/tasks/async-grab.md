# Grab asíncrono (fase 2 del plan cola/push)

## Objetivo
`POST /api/calendar/grab` pasa a fire-and-forget: valida síncrono, devuelve
`task_id` al instante, y el worker (resolve ED2K 30-60s + add + arr grab +
registro) corre en background. Elimina la clase de timeouts de borde (nginx
corta a ~60s; el ×12 de #193 solo es un vendaje).

Patrón: clonar C-10 (`application/use_cases/release_search.py` —
`TaskManager(ttl=600)` propio, `start_*` + worker que jamás lanza y siempre
cierra la tarea).

## Alcance
- [x] T1 (backend): `application/use_cases/grab_release.py` —
      `grab_tasks = TaskManager(ttl=600)`, `start_grab(...)` (validación
      síncrona barata en la ruta: service, `path_is_allowed`, título exigido
      en foreign) y `run_grab` worker (session, roots/foreign, resolve, add,
      arr grab, `_resolve_series_id`, `record_own_grab`) → settle con el body
      de hoy (`ok/detail/direct`).
- [x] T2 (backend): `POST /api/calendar/grab` → `{ok, task_id, status:
      "running", detail}` cuando arranca; refusal sincrona SIN task_id =
      shape actual intacto. Nuevo `GET /api/calendar/grab/{task_id}` con la
      forma de `calendar.py:269-281`.
- [x] T3 (frontend): `grabCalendarRelease` acepta el start-shape; `handleGrab`
      (ReleaseSearchModal) pagina con `useQuery` 1500ms (clon de
      `releaseJobQuery`/`fetchReleaseSearchStatus`) hasta terminal y aplica
      `ok/detail` EXACTO de hoy (toast/notice/error-step). Nuevo helper
      `fetchGrabStatus` en `shared/api/grabs.ts`.
- [x] T4 (tests): backend — C-10-clone contract (start, status, worker done
      arr/foreign), y reajuste de los suites que pinneaban el sync
      (TestCalendarGrab, tests_calendar_direct, TestGrabOwnRegistry,
      TestGrabWritesSeriesId). Frontend — grabFeedback, grabErrorFeedback,
      panelGrabStaysOnResults, ReleaseSearchModal payloads, sectionsPanel.

## FUERA de alcance (decisión, documentada)
- `grab-batch`: SIN caller en el frontend (verificado) → se queda síncrono.
- Cancel de grab: TaskManager lo tiene; la UI no lo ofrece (step 'grabbing'
  ya bloquea re-click → anti doble-resolve).
- SSE/fase 3: aparte.
- `direct` no se lee en ningún frontend — viaja dentro del task payload.

## Riesgos aceptados
- `record_own_grab` pasa a settle-asíncrono: auto-copy verá la fila hasta ~60s
  después (registro best-effort, ya documentado como tal).
- Refusals síncronas conservan el shape → sus tests no cambian.

## Checks
- `backend/`: `../.venv/bin/python -m pytest` (baseline 1070)
- `frontend/`: `./node_modules/.bin/vitest run`, `tsc -b --noEmit`,
  `eslint src/` (baseline 499)
- e2e de CI es GATE

## Estrategia de delivery
- ask-on-risk; forecast >400 líneas → **single PR por preferencia establecida
  del usuario** (respondido en rondas anteriores).

## Progress
- 2026-10-11: doc creada, rama `feat/async-grab` desde main (46be4cf).
  Exploración: mapeo TaskManager + call sites hecha (evidencia en sesión).

## Progress (padre)
- 2026-10-11: T1–T4 [x] commit local (worker+route+polling+tests).
  Checks: backend pytest 1082 (+12), frontend vitest 503 (+4), tsc 0,
  eslint 0; RED observado (ModuleNotFoundError + 16 frontend failed).
  Riesgo registrado: record_own_grab asíncrono (~60s) aceptado en doc.
