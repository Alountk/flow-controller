# Stitch port 03 — Películas (frontend + mapper)

## Objetivo
Acerar la vista Películas al diseño Stitch "03 Películas — FlowController" en lo
visible y honesto: topbar (subtítulo + chips en todas las páginas), fila de
contadores, cabecera del inspector (Monitoreada, minutos, IMDb, Radarr ID),
tarjeta con director y tamaño, y el mapper backend que habilita esos datos.
Un solo PR.

## Fuente de diseño
- **HTML** de `projects/4305330220058954866/screens/d9a2212af2ac4d649bc7dddedfa41c57`
  ("03 Películas — FlowController", vía `get_screen`; el HTML es la fuente, no
  la captura). Copia de diseño relevante: subtítulo
  `Catálogo cinematográfico y gestión de indexación`; contador
  `148 películas catalogadas • 4 pendientes`; cabecera `2024 • 166 min`,
  pill `Monitoreada`, chips `tt15239678` y `Radarr ID: #4812`; tarjeta
  `Dir: Denis Villeneuve` y tamaño mono `48.2 GB`.
- Recuperación de ids: `list_screens` devuelve `{}` para este proyecto
  (PROJECT_DESIGN); el inventario completo vive en el historial de OpenCode
  (opencode.db) — ids 01–09 anotados al final de este doc.

## Decisiones del usuario (2026-10-13, verbatim)
- Alcance: **"Frontend + mapper (recomendado)"** — topbar, contadores, pill
  Monitoreada, mapper backend (imdb, runtime, sizeOnDisk, directors) con tests.
- **"Mantener 'Archivos'"** — la pestaña NO se renombra a "Ficheros".
- **"No añadir selects"** — los 3 selects de filtro del diseño quedan fuera
  (chocan con las sub-vistas aprobadas en F-08).

## Specs
- **S1** — Topbar: subtítulo `Catálogo cinematográfico y gestión de indexación`
  en Películas (el subtítulo del Dashboard ya existe) y chips de servicios en
  **todas** las páginas (hoy solo dashboard). Páginas sin subtítulo de diseño
  no llevan subtítulo.
- **S2** — Fila de contadores en las secciones (donde hoy no hay): exact copy
  `N películas catalogadas • M pendientes` (series: `N series catalogadas…`),
  con `allTotal`/`wantedTotal` reales; solo cuando la vista ya recibe esos
  totales; no duplica los contadores de los botones en la página Faltantes.
- **S3** — Mapper backend (`fetch_all_movies_detailed`, arr_client.py:1503)
  serializa opcionalmente `imdb_id`, `runtime`, `size_on_disk`, `directors`
  (precedente `season_count`: **clave omitida** si Radarr no la manda; tipos
  frontend opcionales ⇒ cero stubs rotos). Tests nuevos del mapper.
- **S4** — Tarjeta de lista: línea `Dir: <director>` (solo si `directors`
  presente) y tamaño mono a la derecha del pie (solo si `size_on_disk`
  presente y `has_file`); pill Monitoreada de la lista ya existe (#190) — no
  se toca.
- **S5** — Cabecera del inspector: pill `Monitoreada` con dot (dato
  `monitored` ya en `AllMovie`), línea `2024 • 166 min` cuando `runtime`
  exista, chip mono `tt…` cuando `imdb_id` exista, y `Radarr ID: #<id>`.
  Sin dato → sin elemento (regla de honestidad).
- **S6** — Honesty pinned: el placeholder NO adopta la copy del diseño
  (`Buscar película por título, IMDb ID o año...`) porque la búsqueda real
  filtra solo `title/series_title/overview/altTitles` (wanted.py:57-63) — no
  promete IMDb ni año. Sin footer de "último sondeo de indexador" (no hay
  campo honesto de último sondeo).

## Fuera de alcance (documentado)
- Los 3 selects de filtro; botones "Actualizar metadatos" y
  "Monitorear seleccionadas" (sin backend/multiselect); acciones de release
  del diseño (Descartar/Vincular manual/Forzar/Descargar vía aMule);
  renombrar pestaña; pills de estados de pipeline (Atascada (Conflicto
  permisos)/Buscando release/En cola) — requieren join traza↔película;
  footer indexador; tabla "Actividad reciente" (ya diferida del port 01).

## Tasks
- [ ] T1 (backend, RED→GREEN): serializar `imdb_id`/`runtime`/`size_on_disk`/
      `directors` en `fetch_all_movies_detailed` + test nuevo
      `backend/tests/infrastructure/tests_movie_enrichment.py`.
- [ ] T2 (frontend, RED→GREEN): tipos opcionales en `AllMovie`; `SectionRow`:
      prop `director` → línea `Dir: …`, tamaño mono en el pie de tarjeta
      (CatalogListings movies); estilo de fila seleccionada con borde accent
      (verificar existente `Sections.css:539-543`).
- [ ] T3 (frontend, RED→GREEN): `PAGE_SUBTITLES` (dashboard + Películas) +
      chips en todas las páginas; e2e `flow-faltantes` añade aserción de chips
      (paridad en Películas).
- [ ] T4 (frontend, RED→GREEN): cabecera del inspector (pill Monitoreada,
      `Año • runtime min`, chip IMDb, `Radarr ID: #id`) en
      rowData/Peliculas.
- [ ] T5 (frontend, RED→GREEN): fila de contadores en `FilterBar` solo en
      secciones (`showFilterButtons === false`).

## Checks
- backend: `../.venv/bin/python -m pytest` desde `backend/`.
- frontend: desde `frontend/`: `./node_modules/.bin/vitest run`,
  `./node_modules/.bin/tsc -b --noEmit`, `./node_modules/.bin/eslint src/`.
- e2e de CI es GATE (nunca `npm`).

## Estrategia de delivery
- Rama `feat/stitch-peliculas-03` desde main; 1 work-unit commit por tarea;
  1 PR (preferencia establecida); merge con CI verde sin preguntar.
- Ruta: inline en el padre (subagentes no disponibles — provider sin API key).

## Progress
- 2026-10-13: doc creada antes de la primera escritura; decisiones registradas;
  id de pantalla 03 recuperado del historial de OpenCode.
- 2026-10-13: **T1 [x]** commit `a0026e7` — `_movie_enrichment` en
  `fetch_all_movies_detailed` (imdb_id/runtime/size_on_disk/directors, claves
  omitidas si faltan, precedente season_count). RED→GREEN: 6 tests nuevos.
  Suite backend **1119/1119**, tsc/eslint n/a (backend).
- 2026-10-13: **T2 [x]** commit `9490d44` — SectionRow con props `director`/`size`
  (línea `Dir: …` + tamaño mono a la derecha del pie), wiring en
  `renderCatalogMovies` (`directors[0]`, `formatBytes` con `has_file`), CSS
  `.sec-row-dir/.sec-row-size`. La fila seleccionada YA existía
  (`aria-current` + `Sections.css:550`) — sin cambio. Checks: vitest 538/538,
  tsc 0, eslint 0.
- 2026-10-13: **T3 [x]** commit `5a5799a` — `PAGE_SUBTITLES` (dashboard +
  Películas, solo pantallas con HTML leído), chips en todas las páginas
  (antes solo dashboard), e2e `flow-faltantes` + aserción `.service-chips`.
  Checks: vitest 541/541, tsc 0, eslint 0.
- 2026-10-13: **T4 [x]** commit `90801fc` — cabecera del inspector: pill
  `Monitoreada`/`Sin monitorear` con dot, línea `2024 • 166 min` (solo con
  runtime), chip IMDb mono + `Radarr ID: #<id>`; `MediaDetail` gana campos
  opcionales rellenados por `catalogMovieDetail`. Los tests seleccionan la
  fila (la selección por defecto no rellena la cabecera). Checks: vitest
  547/547, tsc 0, eslint 0.
- 2026-10-13: **T5 [x]** commit `342f9b0` — decisión del usuario: **el contador
  reemplaza los N de los botones**. Fila `.wanted-counter-row` (border-top,
  BulkSearchFlow a la derecha) con `N películas|series catalogadas • M
  pendientes`; botones `Faltantes`/`Todas` sin número; **ambas queries del
  kind activo habilitadas** (el total de pendientes era 0 estructural en
  Biblioteca: `enabled: filter === 'missing'`); 21 matchers unit + 2 e2e
  actualizados; chips `Todas (8)` de la vista Calidad intactos. Checks:
  vitest 550/550, tsc 0, eslint 0.
- 2026-10-13: **Cierre** — PR **#199** (6 commits: T1..T5 + docs `ad7888d`).
  Checks finales: backend **1119/1119** · frontend **550/550** · tsc 0 ·
  eslint 0. Assess nativo: riesgo **medium** (`slice_budget_reached`, 1124
  líneas, 32 paths). START de la revisión → `consent-declined-this-candidate`
  (`lineage_created=false`, sin linaje): revisión **declinada para este
  candidato**; verificador independiente no disponible (routing de modelos:
  `subagents.json`→openrouter sin provider) — decisión establecida del
  usuario: entregar y retomar al arreglar el config. CI **VERDE** (e2e 2m24s
  + backend + frontend-build + docker-verify + GitGuardian). Merge
  `--merge --delete-branch` → main **`1b17f35`**; ramas local y remota
  borradas.

## Log
- L1 (2026-10-13, usuario): "ya puedo ver el dashboard, no es 1:1 porque me
  imagino que hay funcionalidades no compatibles, que tal vez deberiamos
  implementar más adelante. Podemos seguir con peliculas?"
- L2 (2026-10-13, usuario, decisiones): alcance "Frontend + mapper
  (recomendado)" · "Mantener \"Archivos\"" · "No añadir selects".

## Anexo — inventario de pantallas (recuperado de opencode.db)
| # | Título | id |
|---|---|---|
| 01 | 01 Dashboard — FlowController | `2d435715b5324f809d4be6fd5a29a2ab` |
| 02 | 02 Dashboard Modo Oscuro — FlowController | `73b9a7c6ac42475397da034c3343de89` |
| 03 | 03 Películas — FlowController | `d9a2212af2ac4d649bc7dddedfa41c57` |
| 05 | 05 Seguimiento — FlowController | `9c704db13fc244c3abd8d55799ab72dd` |
(04/06/07/08/09: ids no confirmados en el historial; obtener con `get_screen`
cuando toque cada port.)
