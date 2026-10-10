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
- [x] **T2 — C-09: UI de confirmación con recuento** (DELEGADA, S/M) — ✅ nuevo `BulkSearchFlow` (probe `confirm=false` → diálogo de recuento → `confirm=true` solo tras aceptar → paso launched con cancel por `command_id`); trigger restaurado (había sido borrado en `4fcb976`, casualty de layout, no respuesta al incidente); guard desactivado con filtro de texto activo (el total sería filtrado). Checks: vitest **55/424** (RED observado: trigger inexistente), tsc 0, eslint 0, greps de `confirm=true` solo vía diálogo. ⚠️ **e2e de CI roto y arreglado** (2026-10-09): el trigger `🔍 Buscar todas las faltantes` colisiona por substring con `getByRole(name:'🔍 Buscar')` en `flow-faltantes:62` y `flow-release-search:59` → `exact: true` en ambos (fix `5fc8040`, propagado a F3/F4; e2e **verde** en #180/#181/#182). Lección: el e2e de CI es gate — incluirlo en la verificación de cambios de flujo frontend.
- [x] **T3 — C-10: releases asíncronos** (DELEGADA, M) — ✅ POST arranca job (`application/use_cases/release_search.py`, `TaskManager` propio ttl 600) y devuelve `{ok, task_id, status}`; nuevo `GET /api/calendar/releases/{task_id}` con la forma exacta de `GET /api/tasks/{id}`; frontend poll con el patrón TraceActions (1500 ms); `arr_fetch_releases` solo en el worker; validación síncrona intacta. Checks: pytest **1008** (+7, RED 7 failed→9 passed), contratos 17/MAX 2578, vitest **56/429** (RED 3→5), tsc 0, eslint 0, greps limpios.
- [x] **T4 — F-07+f05 T9: procedencia de ficheros** (DELEGADA, M) — ✅ seam `application/use_cases/file_provenance.py` (precedencia own > queue > history, matching exacto tras `clean_title`, degradación honesta), caché de traces movida de `routes/status.py` a `application/use_cases/trace_cache.py` (tests retargeteados), chip display-only en FileManager. Checks: pytest **1028** (+20, RED observado), contratos 17/MAX 2578, vitest **56/430**, tsc 0, eslint 0, greps limpios; T9 de `f05-amule-retention.md` cerrado por el padre.
- [x] **T5 — C-02: gestor de import bloqueado** (DELEGADA, M) — ✅ mapa previo: **reintentar ya existía** (`TraceActions.tsx:58` → `/api/actions/retry_import`, cubierto con test de click nuevo); gap real = **limpiar** → ack por incidente (`POST /api/trace/blocked/ack`, use case `blocked_acks` con clave `auto_copy_key+queue_id`, tabla sqlite v10, filtro en `GET /api/trace` tras caché → columna y contador Stuck bajan juntos). Etiqueta `Descartar bloqueo` (0 colisiones substring — lección C-09). Checks: pytest **1036** (+8, RED 8 failed), contratos 17/MAX 2578, vitest **57/435** (RED 3→5), tsc 0, eslint 0, read-only respetado (traces/copy_engine/e2e sin diffs).
- [x] **T6 — C-05: rate limiting + Request ID** (DELEGADA, M) — ✅ middleware único `RequestGuards` (fixed window 60s: general 300/`ip|sha256(key)`, fallos auth 10/60s por IP), 429 con `Retry-After` + body `detail/retry_after`, `X-Request-Id` (inbound echo acotado `[A-Za-z0-9._-]{1,64}` o uuid4, logging en errores), `deps.key_matches` compartido edge↔dependency, `app.py` **net 0** (145→145), sin dependencias nuevas. Issues #13/#14 del BACKLOG = PRs (no existen issues — diseñado desde la fila BACKLOG). Cubierto y NO cubierto documentado: sin websockets (no hay), streaming cuenta 1 request, 500 de crash sin header (test-pinado). Checks: pytest **1047** (+11, RED 10 failed), contratos 17/MAX 2578, frontend intacto (0 tests rotos).
- [x] **T7 — F-06(e): caché TTL de downloads** (DELEGADA, M) — ✅ `application/use_cases/downloads_cache.py` (TTL **3.0** del estudio, stale-last en fallo, poller único en lifespan `app.py` junto a `background_checker`, cancelado en shutdown), ruta `downloads.py` 127→22 sin fetch por request, golden byte-idéntico, `app.py` net −1 (legacy **2577**). (b) sigue aparcaada por GPL. Checks: pytest **1060** (+13, RED 10 failed→13 passed), contratos 17/MAX ≤2578, greps: 1 create_task, 0 fetch en handler. NOTA: doc reference `e2e/fake-arr/fixtures/README.md:17` obsoleto (lo refresca el padre en este commit).
- [x] **T8 — C-06: responsive + dark mode** (DELEGADA, L) — ✅ paleta por tokens en `global.css` (light `:root` + dark bajo `prefers-color-scheme: dark`, mismo set de propiedades; SOLO preferencia de sistema, toggle = follow-up); 17 ficheros convertidos: hex 30→**0** fuera del token file, rgba 98→8 (whitelist: shadows/backdrops/poster); **13 tokens referenciados en ningún sitio resueltos** (modal de scan transparente incluido); breakpoints 7→4 `{640,768,900,1280}` con las reglas e2e-pinned de Seguimiento **byte-idénticas**; fixes de wrap a 360px (SetupPage, FileManager). Checks: vitest **57/435** (baseline idéntico), tsc 0, eslint 0, postcss parse 20/20, audit greps. **⚠️ requiere ojos humanos** (lista en el PR: paletas dark/light, scrollbars nativos, 360px, Sections apila a 1280). Dashboard grid 4 col a 360px = follow-up reportado (fuera de alcance).
- [ ] **T9 — F-09 fase 2 detalle** (DESPBloQUEADO — **decisión del usuario 2026-10-09: PANEL LATERAL** dentro de `/seguimiento`, sin ruta nueva; convive con el tail de operaciones 30%; coherente con maestro–detalle de Películas/Series). Slice **F9**, rama `feat/f09-detail-panel`. Tamaño M.
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
