# Flecos de producto — cierre del backlog abierto

## Objetivo
Cerrar los flecos de producto abiertos tras la reestructuración: C-items, procedencia aMule, caché de downloads, y (tras decisión del usuario) F-09 fase 2, avisos y upgrades.

## Evidencia de partida (mapeo 2026-10-09, path:line)
- **C-07** ya implementado: campo `intervals.import_timeout` en `frontend/src/features/settings/Settings.tsx:295`, backend lee vía `config.py:207` (rebuild en save; fuera de `RESTART_REQUIRED_FIELDS`). BACKLOG.md:883 está desactualizado.
- **C-09**: backend ✅ (`routes/wanted.py:320-363`, `confirm=true` obligatorio); falta SOLO la UI — `searchWanted(confirm=false)` en `shared/api/wanted.ts:81-87` sin ningún caller.
- **C-10**: búsqueda de releases síncrona de 91,6 s con proxy que corta a ~60 s (504 tapado a mano, `routes/calendar.py:219-246`); `task_manager` ya existe (`copy_engine.py:27`, `media_mixer.py:10`).
- **F-07 + f05 T9**: el mismo trabajo (mover caché de `build_traces` desde `routes/status.py:96-110` + chip de procedencia en `FileManager.tsx`); decisión ya tomada: "mostrar y no bloquear" (BACKLOG:588-590).
- **F-06(e)** listo (caché con TTL ~3 s reutilizando `background_checker`/`status_cache`; propuesta `f06-amule-local.md:50-56,103`); **F-06(b)** aparcaada (licencia GPL exacta sin verificar, `:104`).
- **C-01** avisos: sin código (0 hits telegram/webhook/smtp); canal por decidir (menor).
- **C-02** gestor de import bloqueado: sin código (0 hits retry de `import_blocked`).
- **C-04** upgrades 1080p→4K: sin código; requiere política (umbral, cuándo).
- **C-05** rate limiting + Request ID: sin código.
- **C-06** responsive + dark mode: 11 `@media` dispersos, 0 dark mode.
- **F-09 fase 2** "Ver detalles": fork exacto panel lateral vs vista aparte (`BACKLOG.md:727`, `prototypes/manifest.json:92`); Películas/Series ya eligieron maestro–detalle con panel (`manifest.json:32-36`); `Seguimiento.tsx` sin detalle (:26-27).

## Alcance autorizado
- `frontend/src/`, `backend/{application,domain,infrastructure,interfaces,app,tests}/`, `BACKLOG.md` (solo estado de los C/F que cierren), `odd/tasks/*.md` (solo cierre de T9 en f05).
- Nuevos ficheros dentro de esas carpetas.
- Fuera de alcance: F-06(b), licencias, delivery (push/PR = usuario), cambios de comportamiento no pedidos.

## Restricciones
- Suites verdes en cada commit: backend `cd backend && ../.venv/bin/python -m pytest -q` (hoy **1001**), contratos `17`; frontend `./node_modules/.bin/{vitest run,tsc -b --noEmit,eslint src/}` desde `frontend/` (hoy **419/0/0**). NUNCA `npm` (alias pnpm).
- TDD donde exista runner (RED→GREEN→REFACTOR observado); excepción documentada solo para moves mecánicos.
- Un commit work-unit por tarea en rama feature desde `main`; conventional commits; un writer a la vez.
- `MAX_LEGACY_LOC` (2578) solo puede bajar.

## Estrategia de delivery
- Forecast: **~2000–2500** authored lines (T1 S · T2 S/M · T3 M · T4 M · T5 M · T6 M · T7 M · T8 L · T9-T11 bloqueados).
- **Estrategia elegida: `stacked-to-main`** (decisión del usuario, 2026-10-09; misma que estructura-modulos).
- Límites de slice (1 slice = 1 rama = 1 PR → `main`, apilado sobre el anterior hasta merge):

| Slice | Tarea | Rama | PR |
|---|---|---|---|
| F1 | T1 cerrar C-07 | `docs/close-c07-timeout` | pendiente |
| F2 | T2 C-09 UI confirm | `feat/c09-confirm-ui` | pendiente |
| F3 | T3 C-10 releases async | `feat/c10-async-releases` | pendiente |
| F4 | T4 F-07+T9 procedencia | `feat/f07-provenance` | pendiente |
| F5 | T5 C-02 import manager | `feat/c02-import-manager` | pendiente |
| F6 | T6 C-05 rate limit | `feat/c05-rate-limit` | pendiente |
| F7 | T7 F-06(e) downloads cache | `feat/f06-downloads-cache` | pendiente |
| F8 | T8 C-06 dark mode | `feat/c06-dark-mode` | pendiente |
| — | T9-T11 | (tras decisión del usuario) | — |

- Runner backend: `cd backend && ../.venv/bin/python -m pytest -q`; frontend: `./node_modules/.bin/...` desde `frontend/` (nunca `npm`).

## Tareas
- [x] **T1 — C-07: cerrar en BACKLOG** (INLINE, S) — ✅ `BACKLOG.md:883` marcado con evidencia (`Settings.tsx:295` + `config.py:207` + rebuild en save); verificación estructural (grep del campo y del backend).
- [ ] **T2 — C-09: UI de confirmación con recuento** (DELEGADA, S/M): caller de `searchWanted(confirm=false)` en la búsqueda masiva de wanted — diálogo con recuento antes de confirmar, usa `confirm=true` + endpoint de cancel. Checks: vitest/tsc/eslint.
- [ ] **T3 — C-10: releases asíncronos** (DELEGADA, M): job con `task_manager` + polling en `POST /api/calendar/releases` (fin del 504). Checks: pytest + vitest/tsc.
- [ ] **T4 — F-07+f05 T9: procedencia de ficheros** (DELEGADA, M): caché de traces a application, chip `cola·importando/histórico/nosotros` en FileManager; marcar T9 en `f05-amule-retention.md`. Checks: pytest + vitest/tsc.
- [ ] **T5 — C-02: gestor de import bloqueado** (DELEGADA, M): reintentar/limpiar `import_blocked`. Checks: pytest + vitest/tsc.
- [ ] **T6 — C-05: rate limiting + Request ID** (DELEGADA, M): middleware FastAPI, headers. Checks: pytest + contratos.
- [ ] **T7 — F-06(e): caché TTL de downloads** (DELEGADA, M): sondeo background + caché TTL ~3 s en `/api/downloads` según `f06-amule-local.md`. Checks: pytest + vitest/tsc.
- [ ] **T8 — C-06: responsive + dark mode** (DELEGADA, L): por último. Checks: vitest/tsc/eslint + revisión visual manual (documentar).
- [ ] **T9 — F-09 fase 2 detalle** (BLOCKADO decisión): panel lateral vs vista aparte → pregunta abierta.
- [ ] **T10 — C-01 avisos** (BLOCKADO decisión menor): canal — Telegram vs webhook genérico/ntfy.
- [ ] **T11 — C-04 upgrades programados** (BLOCKADO decisión): política de umbral/cuándo (L).

## Progreso
- [x] Mapeo de flecos (2026-10-09)
- [x] Feature document creada
- [x] T1 (F1, `docs/close-c07-timeout`) — BACKLOG C-07 cerrado con evidencia
- [ ] T2..T11

Siguiente paso: commit F1 + PR → T2 (C-09 UI de confirmación, delegada).

## Evidencia de verificación
- **T1 (2026-10-09)**: edición documental pasiva — lectura estructural: `grep import_timeout Settings.tsx:295` presente, `config.py:207` presente; BACKLOG:883 ahora ✅ consistente con el código.
