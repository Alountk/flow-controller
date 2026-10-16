# Stitch bloque 🟡 — Árbol de Series + estados de episodio con cola

> Feature del bloque 🟡 (HANDOFF.md:67-68). Árbol serie→temporada→episodio en la
> lista izquierda de Series, con estados de episodio cruzados contra la cola.
> Specs S1-S5 = decisiones verbatim del usuario (L2); S4 = vocabulario del diseño.

## Specs

- **S1** (alcance): el usuario eligió **"Árbol Series + cola episodios"** —
  *"Estados de episodio con cola en el árbol izquierdo. Toca backend (Sonarr +
  nuestra cola) y frontend."*
- **S2** (reemplazo de la lista): **"Reemplazo total (árbol gana)"** — *"La
  lista izquierda de Series pasa a ser el árbol. Las tarjetas rediseñadas en PR
  #200 desaparecen de esta vista."* (Solo la vista Series; Películas y el resto
  de secciones no se tocan.)
- **S3** (namings, decisión cerrada): **"No cambiar ninguno (recomendado)"** —
  *"Cerramos los 3 puntos como decisión registrada en el doc de feature y no se
  toca código."* → los 3 namings del bloque 🟡 quedan registrados aquí y **no se
  modifica código por ellos**: (a) la pestaña **"Archivos"** se queda "Archivos"
  (no "Ficheros"; tests lo afirman), (b) los **chips de procedencia F-07**
  siguen backend-owned (tests de retención), (c) los **8 dots de Setup**
  siguen siendo contrato (decisión deliberada setup-02).
- **S4** (vocabulario de estados del diseño, verbatim de
  `prototypes/series-01-arbol.html:532-533` y leyenda `:1189-1193`): los
  estados de episodio son **"En biblioteca"** (ok/verde), **"Falta"** /
  *"Falta (sin archivo)"* (bad/rojo), **"Descargando"** (warn/ámbar) y
  **"Colocado"** / *"Colocado, pendiente de renombrar"* (neutral/gris). Visto en
  diseño: `"En biblioteca" · "Falta" · "Descargando" · "Colocado"`.
- **S5** (honestidad de datos, contrato del repo): la app **no muestra
  estados/datos que no conoce** (HANDOFF.md:36; pinned por tests
  `seriesEpisodes.test.tsx:248` "states only what the payload states" y
  `tests_wanted_scan.py:216` "honestly null rather than invented"). Un episodio
  solo muestra "Descargando"/"Colocado" si la cola REAL lo dice para ese
  `episode_id`; sin datos de cola → el estado se deriva solo de `has_file`.
  Extensión honesta permitida: si la cola reporta `importBlocked`/`failed` para
  el episodio, el pill refleja el bloqueo (dato real, no inventado).

Fuera de alcance (del diseño, no pedido): checkboxes/acciones en lote
("Buscar releases (3)", "Marcar visto (3)"), chips de toolbar
("Todas / Con faltantes / En emisión / Emitidas"), botón "Ver cola" del
episodio, sidebar/nav.

## Tasks

- [x] **T1 [S1,S5]** — backend: `series_id`/`episode_id` opcionales en
  `_build_download` (`backend/application/use_cases/downloads_cache.py:76`)
  desde los records crudos de Sonarr (traen `seriesId`/`episodeId`); omisión
  (no null) cuando no vengan. Tests RED→GREEN en
  `backend/tests/` (downloads). Ruta: backend + tests backend.
  Commit `d80a7fc` — RED `KeyError: series_id` → GREEN, foco 29/29,
  suite backend completa 1130/1130.
- [x] **T2 [S1]** — frontend types: `series_id`/`episode_id` opcionales en el
  tipo de download (`frontend/src/shared/types.ts`). Ruta: tsc (`tsc -b
  --noEmit` exit 0 — tipos se borran en runtime, sin RED posible).
- [x] **T3 [S1,S2,S4,S5]** — componente árbol serie→temporada→episodio que
  **reemplaza** el grid de tarjetas de la lista izquierda de Series
  (`CatalogListings.renderCatalogSeries` → nuevo `SeriesTree` en
  `frontend/src/features/media-pane/`): pills de estado S4, resumen por
  temporada (conteos derivados de los episodios cargados), episodios cargados
  bajo demanda al expandir serie con el endpoint EXISTENTE
  `GET /api/wanted/series/{id}/episodes`; fila de serie colapsada usa
  `season_count`/`episode_count`/`episode_file_count` ya disponibles en
  `AllSeries`. Selección de serie mantiene el panel derecho (master-detail
  intacto, split 40/60 de `Sections.css:74` sin tocar).
  GREEN (2026-10-15): `SeriesTree.tsx` nuevo + wiring en `MediaPane.tsx:215`;
  seriesSummary → `rowData.ts`, errorMessage → `text.ts`, helpers de episodio
  → `episodeView.ts`, queryKey unificado `series-episodes`; test del árbol
  5/5, suite frontend 575/575, `tsc -b` y `eslint` exit 0.
- [x] **T4 [S1,S5]** — wiring de cola por episodio: cruce
  `downloads (query ['downloads']) × episode_id` → pills "Descargando" /
  "Colocado" / bloqueo (S5); invalidación SSE `downloads` existente ya refresca
  el cruce (cero backend nuevo de eventos).
  GREEN (2026-10-15): query lazy `['downloads']` dentro de `SeriesEpisodes`,
  `queueEpisodeState()` en `episodeView.ts`, `fetchDownloads()` nuevo en
  `shared/api/downloads.ts`, `.sec-pill-neutral` en CSS; árbol 11/11,
  suite frontend **581/581**, `tsc -b` y `eslint` exit 0.
- [x] **T5 [S1-S5]** — tests: RED→GREEN del árbol y del cruce; ajustar los
  tests que pinnean hoy la lista de tarjetas de Series
  (`seriesSummary`, `sectionCounter`, `sectionsDelta` split — el split NO
  cambia); regla honesta del árbol (estado solo si el payload lo dice).
  GREEN (2026-10-15): RED del nodo compacto S2 (5 failed: DOM en
  `seriesTree`, `secRowPoster`, contrato CSS en `sectionCards`) → nodo
  compacto (`hidePoster`, sin `path`), CSS aplanado `.sec-master .st-tree …`
  con marco de selección compensado, card-fallback y `renderCatalogSeries` +
  CSS huérfano eliminados; suite frontend **580/580**, `tsc -b` y `eslint`
  exit 0.

## Progress

- 2026-10-15: rama `feat/stitch-series-tree` desde `main` = `870ceec`.
- 2026-10-15: **T1 [x]** RED `KeyError: series_id` → GREEN; foco downloads
  29/29, suite backend **1130/1130**.
- 2026-10-15: **T2 [x]** tipos opcionales en `DownloadEntry`; `tsc -b` exit 0
  (sin runtime = sin RED aplicable).
- 2026-10-15: **T3 [x]** — RED `seriesTree.test.tsx` 5/5 failed (falta el
  disclosure) → GREEN tras crear `SeriesTree.tsx` + wiring `MediaPane.tsx:215`:
  árbol 5/5, suite frontend **575/575**, `tsc -b --noEmit` exit 0, `eslint src/`
  exit 0. Refactor de vocabulario compartido: `seriesSummary` → `rowData.ts`,
  `errorMessage` → `text.ts`, helpers de episodio → `episodeView.ts`, queryKey
  unificado `series-episodes` (antes `panel-series-episodes` solo en el panel).
  Evidencia explore previa: diseño `series-01-arbol.html` (estados
  `:532-533`), backend episodios ya sirve (`arr_client.py:1715`), hueco =
  `downloads_cache.py:76` descarta `seriesId`/`episodeId` (cerrado en T1).
  Desviación resuelta (L6): path del episodio como texto plano.
- 2026-10-15: **T4 [x]** — RED del cruce cola (6 tests nuevos: 6 failed / 5
  passed) → GREEN: query lazy `['downloads']` en `SeriesEpisodes`,
  `queueEpisodeState()` en `episodeView.ts`, `shared/api/downloads.ts` nuevo,
  `.sec-pill-neutral` nuevo; árbol **11/11**, suite **581/581**, `tsc -b` y
  `eslint` exit 0. Colá solo habla donde la cola tiene palabra (S5): id ajeno
  → nada, lectura fallida → `has_file`, `paused` (fuera de S4) → null→
  `has_file`, bloqueo reflejado incluso sobre "En biblioteca"; conteos de
  temporada intactos (cuentan archivos, no cola).
- 2026-10-15: **T5 [x]** — RED del nodo compacto S2 (5 failed: `seriesTree`
  DOM, `secRowPoster`, 3 contract CSS) → GREEN: `hidePoster` en SectionRow,
  nodo sin `path`, CSS aplanado `.sec-master .st-tree …` (base→hover→selected
  con padding compensado) + `.st-tree .sec-row-name` 13.5px; card-fallback y
  `renderCatalogSeries` + CSS huérfano (`.wanted-ep-count`/`.wanted-complete`)
  eliminados; `seriesSummary.test` queda solo con el describe SectionRow
  (8/8). Suite **580/580**, `tsc -b` y `eslint` exit 0.

## Log

- **L1 (2026-10-15, usuario)**: "sigamos por el 1" → punto 1 de los pendientes
  = **Bloque 🟡 de diseño** (decisión de usuario antes de tocar).
- **L2 (2026-10-15, usuario, ask 1)**: eligió **"Árbol Series + cola
  episodios"** → S1. (Otras opciones descartadas: secciones Calidad/Avisos,
  tabla densa Archivos, redesign del Mixer — siguen pendientes del bloque 🟡.)
- **L3 (2026-10-15, usuario, ask 2)**: eligió **"No cambiar ninguno
  (recomendado)"** para los 3 namings → S3.
- **L4 (2026-10-15, usuario, ask 3)**: eligió **"Reemplazo total (árbol
  gana)"** → S2.
- **L5 (2026-10-15, evidencia)**: explore handoff — diseño en
  `prototypes/series-01-arbol.html` (estados en `:532-533`, leyenda
  `:1189-1193`); backend ya sirve episodios vía `arr_client.py:1715`
  (`arr_series_episodes`, join episode+episodefile con nulos honestos);
  `downloads_cache.py:76` `_build_download` descarta hoy `seriesId`/`episodeId`
  de los records de cola (`arr_client.py:790`). No existe `/api/queue`: la
  query `['queue']` de `Seguimiento.tsx:181` es nuestra cola de ficheros
  (`/api/files/queue/status`), y la cola de arr activa se expone en
  `/api/downloads` (la que sirve `_build_download`).
- **L6 (2026-10-15, decisión del parent sobre desviación del worker)**: el
  primer GREEN dibujaba el path del episodio con CSS `content: attr(data-path)`
  para evitar que `getByText(/Season 01/)` del test collidiera con el path del
  fixture (`/series/Some Show/Season 01/`). Decisión: path como **texto plano**
  (consistente con el panel Episodios) + **una línea autorizada en el test**:
  regex sobre-broad `/Season 01/` → string exacto `'Season 01'` (mismo valor
  de aserción, único match). Truco CSS eliminado. Verificado 5/5 + 575/575.
- **L7 (2026-10-15, usuario, decisión S2)**: pregunta del parent sobre la
  tensión de S2 («las tarjetas de PR #200 desaparecen de esta vista» vs la
  fila-card que el árbol dibujaba con caret). Eligió **"Nodo compacto al
  estilo del prototipo (S2 literal)"**: serie esbelta sin card ni poster en
  la lista, manteniendo selección, conteos, acciones y las clases
  `.sec-row`/`.wanted-card` para no romper contratos; solo se ajustan los
  tests que pineaban la card. Implementado en T5.
- **L8 (2026-10-15, evidencia)**: RED de T5 observado — 5 failed (nodo
  compacto en `seriesTree.test.tsx`, ausencia de poster en
  `secRowPoster.test.tsx`, y los 3 asserts de CSS del aplanado en
  `sectionCards.css.contract.test.ts`); card-fallback describe de
  `seriesSummary.test.tsx` eliminado junto con `renderCatalogSeries` (código
  muerto: MediaPane ya no lo importa). GREEN: suite 580/580 + tsc + eslint.
- **L9 (2026-10-15, cierre)**: checks de cierre verdes — backend pytest
  **1130/1130**; frontend `vitest` **580/580**, `tsc -b --noEmit` exit 0,
  `eslint src/` exit 0. Commits work-unit en `feat/stitch-series-tree`:
  `ae60533` feat(backend) T1 (29 líneas) y `59cdff4` feat(media-pane) T2–T5
  (1544 líneas). Frontera de slice registrada aquí por encima de ~400:
  la entrega sigue la decisión explícita de HANDOFF.md:56 — **single PR
  aunque >400 líneas**, merge al estar CI verde sin preguntar.
