# Feature: buscador-tabla (buscador de releases como tabla unificada + panel de detalle V1)

ODD feature doc. Replaces the per-indexer stacked results with ONE unified,
sortable table, renames the library destination «Biblioteca» → «1080», and
restyles the movie detail panel to the approved V1 — without losing a single
existing function.

## Specs

- **S1 — Una sola tabla, todo mezclado.** «salen los resultados uno detras de
  otro por buscados, yo quiero que se vean en un wrapper todos mezclados como
  con una tabla». The results are no longer grouped in one block per indexer:
  a single table lists every release, whatever its indexer.
- **S2 — Columnas y destino.** «deberia salir una tabla modernizada nombre,
  size, language, seed, y luego en otra columna donde descargarlo
  biblioteca(esto deberiamos cambiarlo a 1080)/4k/3d/Carpeta». Columns, in
  this order: **Nombre**, **Tamaño**, **Idioma**, **Seeders**, **Destino**.
  The destination cell offers the same four actions as today (**1080** — the
  arr library, **4K**, **3D**, **Carpeta**), and the label «Biblioteca» is
  replaced by **«1080»** everywhere it names that destination. A configured
  destination the release already resolves to stays highlighted (`suggest`),
  and an unconfigured 4K/3D folder stays disabled — both rules survive.
- **S3 — Ordenable.** «esta tabla deberia poderse ordenar por nombre, por
  seed, por language y size». Every one of those four columns sorts: a click
  sorts ascending, a second click descending, and the header shows the active
  column and direction (`aria-sort`). The sort is **stable** and ties fall
  back to the title, so the order is deterministic for the operator and for
  tests.
- **S4 — Indexador visible sin volver a apilar.** The chosen answer to «¿qué
  hacemos con el indexador?»: a small badge **under the name**. The row keeps
  telling where it came from (aMule rows carry their source), but the table
  is not grouped by it.
- **S5 — Panel de detalle V1, sin perder funcionalidad.** «yo me referia a la
  parte de sec-detail … Los diseños que sean claros, y no debemos de perder
  ninguna funcionalidad (esto es muy importante)». The detail panel gets V1's
  shape (sticky header with poster, title, monitored badge, `año • duración`;
  metadata block with **Año, Clase, Calidad, Ruta, Descarga**; IMDb and Radarr
  ID chips; **segmented tabs**) and every existing element stays reachable:
  tab contents, honest empty states, the panel footnote, and the release
  search inside its tab.
- **S7 — Listado de películas L2.** «L2 · Filas con póster»: the left list
  becomes poster rows (72px) — poster, title + quality, path underneath,
  class badge and routed-destination chips on the right — keeping every
  behaviour it has today: click/keyboard selection into the detail panel,
  the filter chips with counts, the empty state and the selected-row mark.
- **S6 — Nada más cambia.** Filters (language, quality, min seeders), the 3D
  mark and its routing effect, the grab action and its processing lock, the
  folder picker, polling, error/done steps and the Series view keep behaving
  exactly as they do today.

## Tasks

- T1 — Pure sort model: `frontend/src/shared/utils/releaseTable.ts` with the
  sort keys (`name`, `size`, `language`, `seeders`), comparators (stable,
  title tiebreak, missing facts last) and the asc/desc toggle. Tests: each
  key, both directions, stability, missing values. Route: frontend.
- T2 — `ReleaseResultsTable`: the unified table (header cells with `aria-sort`
  and click-to-sort, name cell with the indexer badge underneath, size,
  language chips, seeders, destination buttons, 3D toggle) replacing the
  `groupByIndexer` blocks in `ReleaseSearchModal`. Tests: one table for many
  indexers, badge present, every destination action still fires the same
  handler, 3D toggle intact, disabled states. Route: frontend.
- T3 — Destination wording: «Biblioteca» → «1080» in the button label and
  title (the `library` action key is unchanged). Tests pinned on the new copy.
  Route: frontend.
- T4 — Detail panel V1: sticky header, metadata block including `Clase`,
  chips row, segmented tabs (`sec-detail` CSS/markup only; no behaviour
  change). Tests: every metadata row present, tabs still switch, empty state.
  Route: frontend.
- T5 — CSS for the table (dense rows, monospace numbers, hairline borders,
  seeder colour scale) and the V1 panel. Route: frontend.
- T6 — Docs: ROADMAP note, slice tally, PR body.
- T7 — Movie list L2 «Filas con póster»: each row 72px with a small poster,
  title + quality on one line, path underneath, class badge and destination
  chips on the right, selection accent. Keeps click/keyboard selection, the
  filter chips with counts and the honest empty state. Tests: row content,
  selection, filter. Route: frontend.

## Log

- L1 — User request verbatim (2026-11-02):
  «Cuando hago una busqueda de un archivo el diseño de ahora salen los
  resultados uno detras de otro por buscados, yo quiero que se vean en un
  wrapper todos mezclados como con una tabla, podrias crearme varios diseños
  con stitch? deberia salir una tabla modernizada nombre, size, language,
  seed, y luego en otra columna donde descargarlo biblioteca(esto deberiamos
  cambiarlo a 1080)/4k/3d/Carpeta, esta tabla deberia poderse ordenar por
  nombre, por seed, por language y size.»
- L2 — Scope correction from the user, same thread: «ok, me gusta el 14 para
  una seccion de busqueda, pero yo me referia a la parte de sec-detail. Creo
  que deberiamos hacer un rediseño tal vez de la parte de las peliculas.
  podrias proponer 3 diseños diferentes teniendo en cuenta lo que tenemos?
  Los diseños que sean claros, y no debemos de perder ninguna funcionalidad
  (esto es muy importante).» Then, on the three detail-panel variants:
  «V1 · Cabecera rica + pestañas». Then, on implementation: «Todo ahora
  (tabla + panel)».
- L3 — Indexer decision: «Badge pequeño bajo el nombre».
- L4 — Design references (Stitch project `4305330220058954866`, design system
  «FlowController»): results table «14» `fe9f10ae`-family, detail panel V1
  `fe9f10ae2bb543458b3d99656db2f3ed`, companion with the Archivos tab active
  `2f0554135bd04b4bbfe9b124ae50a0eb`. Known Stitch gaps that this feature
  fixes in code (not copied from the mock): the row «Clase» was dropped in
  the generated mocks and «Biblioteca» survived the wording change.
- L5 — Slice disclosure (recorded before T2's commit, harness ~400-line
  rule): after T1 + the prototype export the branch is **768 authored lines
  / 2 commits** (`9b43a9b` sort model + `bce2eef` prototypes HTML/README).
  Delivery strategy = **single PR with disclosures**, same as the previous
  three features; T6 keeps the tally current and the PR body carries the
  table.
- L6 — Prototype export fidelity: Stitch's download endpoint needs OAuth
  (`curl` → 401), so `prototypes/buscador-tabla/` holds **render-condensed**
  copies pulled through the MCP reader (markup/classes/copy intact, the
  generated Tailwind palette block trimmed). Documented in that folder's
  README so nobody treats them as byte-exact exports.
- L7 — Scope closure, user verbatim: «all in» → T2, T3, T4, T5, T6 and T7
  (the chosen list variant L2) ship as ONE branch and ONE PR. No separate
  delivery for the list.
- L8 — Delivery state (2026-11-02): T1-T5 and T7 delivered on `feat/buscador-tabla`.
  T4's V1 shape turned out to be mostly already present (the panel already had
  the sticky-capable header, the `Año/Clase/Calidad/Ruta` meta and the three
  tabs), so T4 landed as the CSS half: sticky header and the segmented tab
  treatment, with no behaviour change. T6's ROADMAP note is deliberately
  skipped: this redesign was never a roadmap item, it came from the design
  request — recorded here instead of inventing an entry.
  Gates at close: frontend **120 files / 936 tests**, tsc/eslint/build 0.
  Test migrations (all justified by S1/S2/S4/S7, none deleted): the release
  tests moved from per-indexer groups to the single table (`/Biblioteca/` →
  `'→ 1080'`, `.calendar-*` → `.release-table*`, exact names for the four
  destinations because `/3D/` also matched the routing toggle); the quality
  views keep a `rowOf` helper that reads L2 rows for Películas and falls back
  to the table for Series, which this feature does not touch.
