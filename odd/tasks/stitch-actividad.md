# Stitch port 01 (2º PR) — Tabla "Actividad reciente" del Dashboard

## Objetivo
La sección 3 del diseño "01 Dashboard — FlowController": la tabla
`Actividad reciente de transferencias e indexación` bajo la banda de
incidencias, con su toolbar y su pie. Comprometida como segundo PR cuando el
usuario eligió "Diseño sin tabla primero" en el port 01.

## Fuente de diseño
- **HTML** de `projects/4305330220058954866/screens/2d435715b5324f809d4be6fd5a29a2ab`
  (sección 3): toolbar `Actividad reciente de transferencias e indexación` +
  botones `Filtrar`/`Actualizar`; columnas `Servicio` (punto+nombre) ·
  `Nombre del medio / Release` (mono) · `Destino / Ruta` (mono) · `Tamaño`
  (mono) · `Estado` (pill) · `Acción`; pie
  `Mostrando 5 transferencias recientes` + `Frecuencia de refresco: manual`.

## Decisiones del usuario (verbatim)
- L1 (2026-10-13): eligió **"Tabla Actividad reciente (recomendado)"** con el
  plan embebido: nuevo endpoint `GET /api/activity` que compone grabs
  recientes + operaciones de cola + auto-copy con timestamps reales.
- (Plan ajustado en exploración: la fuente operativa real son **operaciones
  `operations` (copy/move) + descargas activas**; `auto_copy_log` es un registro
  de decisiones, no de transferencias — queda fuera con esta nota.)

## Specs
- **S1 — Backend `GET /api/activity`**: compone (y ordena por `at` DESC, límite
  10):
  - operaciones de `recent_operations()` (sqlite: `type` copy/move, `name`,
    `dst`, `size_bytes`, `status`, `import_status`, `arr_source`,
    `created_at`/`finished_at`), y
  - descargas activas de `downloads_cache.get_downloads()` (cada fila usa el
    `updated_at` del snapshot como `at`; sin destino → `destination: null`).
  - Respuesta `{items: [...], updated_at}`; campos crudos honestos (estados en
    vocabulario backend, etiquetas en frontend). Degradación: si sqlite no
    está disponible, solo las descargas (nunca un error por eso).
- **S2 — Tabla en el Dashboard** (tras la banda): columnas del diseño;
  `Servicio` = `service` cuando existe (punto de color por servicio, `—` si no);
  `Nombre` y `Destino` en mono; `Tamaño` mono con `formatBytes` (sin dato → `—`);
  `Estado` = pill con vocabulario existente (`En cola`, `Copiando`, `Hecha`,
  `Fallida`, `Cancelada`, `Importando`, `Import fallido`, `Descargando`,
  `Import bloqueado`, `En pausa`; estados desconocidos se muestran **tal cual**
  el valor crudo, nunca inventados).
- **S3 — Toolbar**: `Filtrar` = filtro de texto **client-side** sobre las filas
  mostradas (placeholder `Filtrar por nombre…`); `Actualizar` = invalida
  `['activity']`. Ambos con tests.
- **S4 — Pie**: `Mostrando N transferencias recientes` (N real de la tabla) +
  `Actualizado <HH:MM:SS>` desde `updated_at`.
  **Desviación documentada**: el diseño dice `Frecuencia de refresco: manual`;
  la app refresca por SSE + poll → el dato honesto es la hora del último dato.
- **S5 — Acción**: por fila, `Ver en Seguimiento` (todas las filas viven allí:
  descargas → trazas, operaciones → banda) con `setPage('seguimiento')`.
  **Desviación documentada**: el diseño muestra acciones específicas
  (`Reintentar`, `Reanudar`…) — requieren backend por estado; fuera de este PR.
- **S6 — Query**: `['activity']`, dashboard-only (`enabled` en
  `page === 'dashboard'`), `refetchInterval` gated
  (`connected ? false : 10000`) como el resto; SSE invalida `['activity']` en
  los eventos `downloads` y `task` (las operaciones cambian con las tareas).

## Ruta y gates
- Ruta: **inline** (subagentes no disponibles — provider sin API key).
- TDD RED→GREEN por tarea. Checks por tarea: backend
  `../.venv/bin/python -m pytest` desde `backend/`; frontend desde
  `frontend/`: `./node_modules/.bin/{vitest run,tsc -b --noEmit,eslint src/}`.
- e2e de CI es GATE. Delivery: rama `feat/stitch-actividad` desde main,
  1 commit por tarea, 1 PR, merge con CI verde.

## Tasks
- [ ] T1 (backend, RED→GREEN): ruta `GET /api/activity` + composición +
      tests (`backend/tests/interfaces/routes/tests_activity.py`).
- [ ] T2 (frontend, RED→GREEN): `ActivityTable` (columnas/toolbar/pie) +
      tests.
- [ ] T3 (frontend, RED→GREEN): wiring en Dashboard (tras la banda) + query
      `['activity']` gated + invalidación SSE (downloads/task) + tests.

## Progress
- 2026-10-14: doc creada antes de la primera escritura; exploración de fuentes
  completada (operations schema sqlite_history.py:30-52, recent_operations:318,
  downloads_cache, queue/status como referencia de vocabulario).

## Log
- L1 (2026-10-14, usuario): "continua" → pregunta de siguiente hito → eligió
  **"Tabla Actividad reciente (recomendado)"** (plan: endpoint /api/activity +
  tabla del diseño en el Dashboard).
