# Estructura de módulos: hexagonal estricto + feature folders

## Objetivo

Reubicar la política de negocio fuera de los controladores HTTP, dar estructura por features al frontend, tipar la frontera hexagonal del backend y sanear los flecos de estado abiertos.

## Problema / Por qué

Revisión estructural (sesión 2026-10-08, evidencia con path:line):

1. **Política de dominio en controladores**: `backend/interfaces/http/routes/files.py:272-480` contiene hardlink-first (`_link_or_copy`), rename atómico tmp→rename y batch move/delete; `routes/wanted.py:583` (`os.walk`) y `routes/calendar.py:627` (`shutil.disk_usage`) son probes de infra en rutas. Invisible para los tests de arquitectura y no testeable sin HTTP.
2. **Frontend plano**: `frontend/src/components/` es un pozo de ~50 archivos; `MediaPane.tsx` (58 KB) concentra queries+observer+debounce+modales; `CalendarModal.tsx:1-2` es un shim muerto (0 importadores) que re-exporta `ReleaseSearchModal.tsx:1153` con CSS heredado (`ReleaseSearchModal.tsx:22`); `SetupPage.tsx:5` importa `Field` de `./Settings`; `Peliculas.tsx:3-5` y `Series.tsx:3-5` duplican wiring.
3. **Hexagonal nominal**: `application/gateways.py:31` usa `__getattr__` + `ModuleType` (service locator): un binding mal hecho revienta en runtime, no en import. `routes/status.py` (verify_api_key) es importado por 7 rutas; `routes/calendar.py:43` importa el privado `_attach_grabbed_at` de `routes/wanted.py`.
4. **Deuda admitida**: `tests/contracts/tests_architecture.py:19-25,54` — `MAX_LEGACY_LOC = 2579`; módulos raíz cruzan capas (`traces.py:9,18`, `copy_engine.py:14` + 7 imports a función de `infrastructure.arr_client`, `config.py:4`).
5. **Flecos de estado**: F-03 con estado contradictorio (`BACKLOG.md:16` 🟡 vs `:340` "Entregado"); 10 `odd/tasks/*.md` con checkboxes sin cerrar (`b02-indexadores`, `archivos-tres-destinos`, `f05-amule-retention` figuran pendientes aunque BACKLOG los da entregados).

Verificado como NO-fleco (descartado con evidencia): ciclo de imports en vivo (es shim legacy), edges ambiguos del grafo (ruido de extracción), 434 nodos aislados (tooling: `.opencode/opencode.json`, `backend/run_local.sh`), bugs B-01..B-11 (todos cerrados, `BACKLOG.md:27-38`).

## Alcance autorizado

- `backend/domain/`, `backend/application/`, `backend/infrastructure/`, `backend/interfaces/http/`, `backend/app/`, `backend/tests/`
- `frontend/src/` (reorganización por features, splits, renombres de CSS)
- `odd/tasks/estructura-modulos.md` (este documento), `odd/tasks/*.md` (solo checkboxes de reconciliación T4), `BACKLOG.md` (solo estado F-03 en T4)
- Nuevos ficheros en `backend/**` y `frontend/src/**` dentro de las carpetas anteriores

Fuera de alcance: cambio de comportamiento visible de APIs o UI, nuevas dependencias mayores, features C-*, delivery/merge/push (decisión humana).

## Restricciones

- Los tests de arquitectura (`tests/contracts/tests_architecture.py`) y la suite deben quedar verdes en CADA commit; `MAX_LEGACY_LOC` solo puede bajar, nunca subir.
- Test-first donde exista runner determinista: RED → GREEN → REFACTOR observado. Excepción documentada en T4 (documentación/estado).
- Cada tarea cierra con un commit work-unit en la feature branch (rama nueva desde `main`, conventional commit, tests y docs junto al comportamiento).
- Artefactos técnicos en español (convención de `odd/tasks/`); código, identificadores y UI en inglés.
- Un solo writer a la vez; sin commits a `main`.

## Estrategia de delivery

- Forecast de authored lines (adiciones+borrados, excluye generados): **~3000** (T1 ~700, T2 ~1800, T3 ~400, T4 ~50)
- **Estrategia elegida: `stacked-to-main`** (decisión del usuario, 2026-10-08).
- Límites de slice (1 slice = 1 rama = 1 PR → `main`, apilado sobre el anterior hasta que se fusione):

| Slice | Tarea | Rama | PR |
|---|---|---|---|
| S1 | T1 política→dominio | `refactor/placement-domain` | → main |
| S2 | T2 frontend features | `refactor/frontend-feature-folders` | → main (base: S1) |
| S3 | T3 ports tipados | `refactor/typed-ports` | → main (base: S2) |
| S4 | T4 higiene flecos | `chore/estructura-flecos` | → main (base: S3) |

- Runner de verificación backend: `cd backend && ../.venv/bin/python -m pytest -q` (venv en la RAÍZ del repo, Python 3.12, espejo de CI `ci.yml:41-49`; NO poner el venv dentro de `backend/` — contamina los contratos de legacy LOC/pyflakes/vulture).

## Tareas

- [x] **T1 — Política de colocación de archivos → dominio** (ruta: DELEGADA — writer trigger: tocó 2+ ficheros no triviales; S1 = rama `refactor/placement-domain`)
  - Extraer hardlink-first `_link_or_copy`, rename atómico y batch ops de `routes/files.py` a `domain/policy/placement.py` + use case `application/use_cases/place_file.py`; rutas finas (655→486 líneas, 0 llamadas de placement en la ruta).
  - Nota: `domain/policy.py` → `domain/policy/__init__.py` (paquete, para no sombrear el import existente).
  - Aceptación: ✅ política testeable sin HTTP (37 tests nuevos); contratos verdes; suite verde.
  - Checks: `cd backend && ../.venv/bin/python -m pytest -q` → **981 passed, 0 failed** (baseline 941 passed + 37 nuevos); `... pytest tests/contracts -q` → **13 passed**; grep `os.rename|copytree|_link_or_copy` en la ruta → sin resultados; `MAX_LEGACY_LOC` = 2579 (sin aumento).
- [x] **T2 — Frontend: feature folders + MediaPane + shim** (ruta: DELEGADA ×2 — S2 = rama `refactor/frontend-feature-folders`)
  - Sub-pasos: (a) ✅ shim `CalendarModal.tsx` borrado + CSS renombrado (grep = 0); (b) ✅ `src/{app,pages,features,shared}` + 118 moves + tests espejo; (c) ✅ MediaPane **desmantelado**: 1441 → 223 líneas de composición + 11 módulos (max 379), contrato público intacto (3 importadores sin cambios), desviación deliberada documentada (ramas `render*` como funciones, no componentes, para no remontar filas con estado); (d) ✅ `api/calendar.ts` → `shared/api/{calendar,releases,grabs}.ts` (7 exports paritarios); (e) ✅ `Field` → `shared/ui/`.
  - Aceptación: sin imports pages→pages ✅; MediaPane original eliminado ✅; vitest+tsc+eslint verdes ✅ (54 files/419 tests, tsc 0, eslint 0 — baseline idéntico).
  - Verificación: T2a writer (5 checks) + verificador independiente (0 bloqueantes, auth.ts SHA idéntico) + spot-check padre; T2b assess **medium** → writer self-verification + spot-check padre (419/419, `wc -l` 223).
  - Checks: `./node_modules/.bin/{vitest run, tsc -b --noEmit, eslint src/}` en `frontend/` (NUNCA `npm` — alias a pnpm en esta shell).
- [x] **T3 — Ports tipados (adiós service locator)** (ruta: DELEGADA ×2 — S3 = rama `refactor/typed-ports`; superficie añadida `backend/app.py` aprobada por el usuario tras mi error de ruta `backend/app/`)
  - `ports.py`: 4 Protocols presence-level (`ArrClient`, `SettingsStore`, `HistoryStore`, `CredentialsStore`) + `SystemProbe`/`ScanWalk` con firmas reales; `gateways.bind()` valida `isinstance` → binding erróneo revienta en import (`TypeError`), `__getattr__`/`ModuleType` eliminados.
  - `verify_api_key` → `interfaces/http/deps.py` (7 importadores + patch targets retargeteados); `_attach_grabbed_at` → `route_helpers.py` público.
  - Probes → `infrastructure/{system_probe,wanted_scan}.py` + use cases `disk_report`/`scan_wanted` con callables inyectados; rutas parse→call→map; `app.py` net −1 línea.
  - Aceptación: ✅ sin `__getattr__` en gateways; ✅ contratos 17 (4 puertas nuevas); ✅ greps de aceptación vacíos; `MAX_LEGACY_LOC` = **2578 ≤ 2579**; suite **1001 passed, 0 failed** (+20 tests, RED observado: 5 failing gates).
  - Checks: `cd backend && ../.venv/bin/python -m pytest -q` · `... tests/contracts -q` · mypy omitido (no configurado — documentado).
  - Pendiente T4: entrada obsoleta en `vulture_whitelist.py` (fuera de superficies).
- [ ] **T4 — Higiene de flecos** (ruta: INLINE — documentación, mecánico)
  - Reconciliar F-03 (verdad única en BACKLOG), cerrar/reabrir con motivo los checkboxes drift en `odd/tasks/*.md` (10 ficheros), `MAX_LEGACY_LOC` actualizado al valor real tras T1/T3.
  - Aceptación: sin estados contradictorios entre BACKLOG y odd/tasks.
  - Checks: revisión estructural (sin runner).

## Progreso

- [x] Revisión estructural y propuesta (2026-10-08, evidencia en sesión)
- [x] Feature document creada (2026-10-08)
- [x] T1 (S1, `refactor/placement-domain`) — commit **ddf7f0c**
- [x] T2 (S2, `refactor/frontend-feature-folders`) — commits **b8b7980** + T2b
- [x] T3 (S3, `refactor/typed-ports`) — pendiente de commit con este doc
- [ ] T4

Siguiente paso: commit S3 → T4 higiene de flecos.

Estado RDD: **desactivado por el usuario (global) el 2026-10-09** → S1 entregado sin review nativo (`disabled/unmanaged`). Verificación de S1: writer + spot-check del padre (981/0, contratos 13).

Siguiente paso: T2 — paso estructural completado (ver evidencia), falta (e) desmantelar MediaPane.

## Evidencia de verificación

- **T1 (2026-10-08)**: RED observado (ImportErrors + gate de ruta delgada), GREEN 37 tests nuevos, suite final `981 passed, 0 failed`, contratos `13 passed`, grep de placement en `routes/files.py` sin resultados, `MAX_LEGACY_LOC` = 2579 sin aumento. Venv relocado de `backend/.venv` a `.venv/` raíz (contaminaba 3 contratos; local ≡ CI).
