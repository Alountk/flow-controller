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

- [ ] **T1 [S3]** — backend + frontend: acción «Marcar como completada» sobre operaciones
  activas bloqueadas (endpoint o llamada al estado de origen según explore; button en la
  fila de operación; estado pasa a hecha y sobrevive al refetch). RED primero; área de
  edición: `backend/interfaces/http/**`, `backend/**/task*`, `frontend/src/pages/Seguimiento*`,
  tests de ambos lados.
- [ ] **T2 [S2]** — frontend: rediseño de Seguimiento a **vista única con filtros**
  «Activas (n)» / «Completadas» / «Errores» + contador global; fusionar trazas + copias +
  mezclas en una sola lista con progreso y controles; actualizar el contrato e2e/CSS de
  `.sg` que hoy fija [sg-board, sg-ops] 70/30. RED primero; área de edición:
  `frontend/src/pages/Seguimiento*`, `frontend/src/__tests__/**`, e2e/contratos afectados.
- [ ] **T3 [S1]** — frontend: al enviar una mezcla, navegar a `/seguimiento` con la fila
  resaltada (borde de acento) y pestaña «Activas» por defecto. RED primero; área de
  edición: `frontend/src/pages/MediaMixer.tsx`, `frontend/src/pages/Seguimiento.tsx`,
  router/highlight, tests de ambos.

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
