# seguimiento-unificado — Vista única con filtros, salto tras «Mezclar» y completado manual

Specs S1–S3 (verbatim de L33–L36 de `odd/tasks/mixer-redesign.md`, feedback sobre PR #212)
· Tasks T1–T3 · Log L1–L4 · Creado: 2026-10-18

## Specs

- **S1 — trazabilidad tras «Mezclar»** (verbatim L33): «una vez le doy al mezclar pierdo
  la tarea, no se donde visualizarla». Al pulsar «Mezclar» con destino válido y envío
  aceptado: navegación automática a **Seguimiento** con la mezcla recién enviada
  **resaltada (borde de acento) arriba del todo** de la vista activa.
  Decisión L35 (verbatim): «Saltar a Seguimiento» + preview elegido:
  «Al pulsar Mezclar → /seguimiento con «mezcla X» destacada en la lista (borde de acento)».
- **S2 — vista única de tareas** (verbatim L33): «el nuevo diseño del seguimiento es muy
  malo, crea mucho ruido y no puedo ver nada, tendriamos que darle una vuelta».
  Decisión L34 (verbatim): «Vista única con filtros» + preview elegido:
  «Una sola lista de tareas (trazas + copias + mezclas) con filtros por estado (activas /
  completadas / error) y un contador global. Menos paneles, una sola lectura.» con la UI
  exacta: pestañas «Activas (n)» (por defecto) / «Completadas» / «Errores», filas con
  progreso y controles (cancelar/pausar), completadas y fallidas **ocultas** bajo sus
  pestañas, «(completadas ocultas bajo su pestaña)». El estado bloqueante actual
  «Operaciones de la derecha» deja de vivir apilado: se integra en la misma lista.
- **S3 — completado manual** (verbatim L33): «habria que permitir marcar como completadas
  de manera manual algunas tareas (estas por detras se han hecho pero se quedan
  bloqueadas)». Decisión L33 (verbatim): «Operaciones de la derecha» (filas de
  copia/importación que quedan en «en cola/en curso» sin avanzar). Acción «Marcar como
  completada» visible en las filas de operaciones con estado activo; el clic la marca como
  **hecha** (estado de la UI y del origen de verdad de la operación) sin tocar datos.

## Tasks

- [x] **T1 [S3]** — backend + frontend: acción «Marcar como completada» sobre operaciones
  activas bloqueadas (endpoint o llamada al estado de origen según explore; button en la
  fila de operación; estado pasa a hecha y sobrevive al refetch). RED primero; área de
  edición: `backend/interfaces/http/**`, `backend/**/task*`, `frontend/src/pages/Seguimiento*`,
  tests de ambos lados.
  - Evidencia (2026-10-18): RED observado **6 failed** (tras arreglar fixtures: `state.queue_lock`
    es `asyncio.Lock` → los tests mutan `file_queue` directo, precedente `tests_history`;
    fixture `db` autouse para que el serializer «prefiere durable» sea determinista) →
    GREEN **6/6** en `tests_files_queue.py`; frontend RED **2 observado** (el 3º, de ausencia,
    pasa trivial pre-impl) → 33/33 en el fichero. Padre verificó: backend **1288/1288**,
    frontend **639/639**, `tsc -b` 0, `eslint` 0. Descubrimientos: `gateways.history` se cablea
    en `app.py:40`; `/status` reemplaza `completed` por `recent_operations(10)` sin filtro de
    estado (raíz del «bloqueada» que el usuario veía). Commit: **C2 `f1a90c4`** (`Risk: none`).
- [x] **T2 [S2]** — frontend: rediseño de Seguimiento a **vista única con filtros**
  «Activas (n)» / «Completadas» / «Errores» + contador global; fusionar trazas + copias +
  mezclas en una sola lista con progreso y controles; actualizar el contrato e2e/CSS de
  `.sg` que hoy fija [sg-board, sg-ops] 70/30. RED primero; área de edición:
  `frontend/src/pages/Seguimiento*`, `frontend/src/__tests__/**`, e2e/contratos afectados.
  - Evidencia (2026-10-18): worker `gentle-ai-worker` (task `mve4w7yg-l-f30c`) — RED observado
    **15 failed** (24 preservados en verde) → GREEN **645/80**, `tsc -b` 0, `eslint` 0.
    Contratos reescritos al comportamiento decidido (L35): pin DOM `[sg-board, sg-ops]`, test
    de 4 columnas, 70/30 del e2e `kanban-fit`; query keys/polls intactos (`ssePollGate`).
    e2e **observado en local** con shim nuevo `e2e/docker-compose.local.yml` (disclosed):
    `kanban-fit` **4/4** × varias pasadas + `flow-faltantes` ✓; disclosures: `flow-release-search`
    flakó 1× (preexistente/env), rate-limit de API key en re-ejecuciones rápidas, 1 flake
    unitario no reproducido (×4 verde después). Padre: spot-check aprobado (mappings pinneados
    por test) + suites **645/645 + tsc 0 + eslint 0**; contenedores/scratch e2e limpiados.
    Commit: **C3 `83ce7c3`** (`Risk: none`).
- [x] **T3 [S1]** — frontend: al enviar una mezcla, navegar a `/seguimiento` con la fila
  resaltada (borde de acento) y pestaña «Activas» por defecto. RED primero; área de
  edición: `frontend/src/pages/MediaMixer.tsx`, `frontend/src/pages/Seguimiento.tsx`,
  router/highlight, tests de ambos.
  - Evidencia (2026-10-18): worker `gentle-ai-worker` (task `mved6ta3-m-bd4j`) — RED observado
    **5 failed** → GREEN focused **54/54**, full **653/81**, `tsc -b` 0, `eslint` 0. Mecanismo:
    `onSubmitted(task_id)` → App `setPage` **primero** (su pushState borra el hash) →
    `#/seguimiento?highlight=<id>` → `hoistHighlight` puro (solo con target) + `sg-row-highlight`
    con acento inline (CSS fuera de surfaces T3; hook documentado para tema). Lifetime one-shot
    por visita pinneado (primer cambio de tab consume latch+param; back/forward tragados);
    nuevo `seguimientoJump.test.tsx` end-to-end por el App real. Padre: spot-check aprobado +
    suites **653/653 + tsc 0 + eslint 0**. Commit: **C4 `d8dd3fe`** (`Risk: none`).

> **Delivery / slices**: PR único **#213** (>400 líneas por slice: estrategia de PR único del
> proyecto, disclosure en el cuerpo). C1 `f6a2d43` (doc + L33–L36) · C2 `f1a90c4` (T1) ·
> C3 `83ce7c3` (T2) · C4 `d8dd3fe` (T3) · C5 (docs de cierre). Specs al cierre: **1288 backend /
> 653 frontend** (base 1288/645 pre-T3).

## Log

- **L1** (2026-10-18, verbatim del usuario, request original de esta feature): «una vez le
  doy al mezclar pierdo la tarea, no se donde visualizarla, además creo que el nuevo
  diseño del seguimiento es muy malo, crea mucho ruido y no puedo ver nada, tendriamos que
  darle una vuelta. Y habria que permitir marcar como completadas de manera manual algunas
  tareas (estas por detras se han hecho pero se quedan bloqueadas).»
- **L2** (decisión): «¿en qué sección ves las tareas que se quedan bloqueadas?» →
  **«Operaciones de la derecha»**.
- **L3** (decisión): «¿Qué dirección prefieres?» → **«Vista única con filtros»** (preview
  elegido: «Activas (3)  Completadas  Errores / ─── / ● Dune Parte Dos 67% [cancelar] /
  ● mezcla X en cola [pausar] / ● copia Y en curso / (completadas ocultas bajo su pestaña)»).
- **L4** (decisión): «¿Cómo la recuperas en el mixer?» → **«Saltar a Seguimiento»**
  (preview elegido: «Al pulsar Mezclar → /seguimiento con «mezcla X» destacada en la lista
  (borde de acento)»).
