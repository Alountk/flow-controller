# Feature: detalle-pantalla (el detalle sustituye la vista, no la acompaña)

ODD feature doc. Corrects a scope mistake of `buscador-tabla`: the approved
detail design was implemented as a **side column** when it was meant to
**replace** the page. The sub-view tabs disappear, the list takes the full
width, and a row's arrow opens the detail — an X comes back.

## Specs

- **S1 — Fuera el panel lateral.** «primero deberiamos perder la parte lateral
  de details de las vistas». There is no side column any more: the list uses
  the whole width and the detail is a different screen of the same page.
- **S2 — Fuera las pestañas de sub-vista.** «y las pestañas de biblioteca /
  estrenos / calidad, se pierden». The Películas and Series pages have no
  Biblioteca/Estrenos/Calidad tab strip. The class filtering does NOT vanish
  with them: it stays as the chip row of the approved list design (the L2 mock
  carries `Todas (128) · 4K (12) · …`), so removing the tabs costs no filter.
  The Estrenos calendar keeps its entry point: it moves to the app sidebar as
  its own page instead of dying with the tabs.
- **S3 — La flecha abre el detalle.** «cuando selecciono una de las peliculas
  y le das a la flecha de la derecha del row deberia salir el diseño de panel
  de detalle sustituyendo la vista actual». Each row carries a trailing arrow
  that opens the detail for that row, replacing the list in the same page.
  Clicking the row body never navigates; only the arrow does.
- **S4 — La X vuelve a la lista.** «y si le damos a la x en esta vista
  volveriamos a la anterior». The detail carries a close control (X) that
  returns to the list with the previous state intact: same filter chips, same
  scroll position, no re-fetch.
- **S5 — Las filas son las del diseño.** «Los rows de la supuesta tabla tambien
  son diferentes». The L2 rows of the approved mock: poster, title,
  «año · calidad», path underneath, class badge, destination chips and the
  trailing arrow.
- **S6 — Series igual.** «Sí, Series también»: Series loses its side panel and
  its sub-view tabs the same way, and its detail (Episodios/Releases/
  Archivos/Historial) becomes the full-page view reached by the row's arrow.
- **S7 — Nada más se pierde.** Detail contents, tab contents, the release
  table, the file sections, the history tab, honest empty states and every
  existing action stay reachable from the full-page detail.

## Tasks

- T1 — Películas: remove `SUB_VIEWS`/`sec-subtabs`/`sec-split`, list full
  width, arrow per row, full-page detail with X. Tests: no tablist, no side
  panel, arrow opens, X returns and keeps the chips.
- T2 — Chips row: the class filter survives as the list's chip row, with
  counts; the «Faltantes/Todas» choice becomes a chip too, so no filter is
  lost with the tabs.
- T3 — Series: same structure (list full width, arrow, full-page detail, X).
- T4 — Estrenos: the calendar becomes its own sidebar page (route + nav entry)
  so removing the tabs does not delete the feature.
- T5 — CSS: `.sec-detail-page` (full width, sticky header, close button),
  row arrow, chips row.
- T6 — Docs: ROADMAP note if needed, slice tally, PR body.

## Log

- L1 — User correction verbatim (2026-11-02): «el diseño no se parece un huevo
  a una castaña, has implementado 1:1 el diseño, primero deberiamos perder la
  parte lateral de details de las vistas y las pestañas de biblioteca /
  estrenos / calidad, se pierden. Los rows de la supuesta tabla tambien son
  diferentes y cuando seleccono una de las peliculas y le das a la flecha de
  la derecha del row deberia salir el diseño de panel de detalle sustituyendo
  la vista actual y si le damos a la x en esta vista volveriamos a la anterior».
- L2 — Decisions taken in the same thread: sub-view tabs **removed** («se
  pierde funcionalidad» accepted), **Series too**, list rows = **L2 «filas con
  póster»**.
- L3 — Parent's standing correction on the destructive part: the tabs go away
  but the Estrenos calendar moves to the sidebar instead of being deleted
  (T4), and the class filter survives as the chip row (T2). Both keep the
  feature set whole while honouring «se pierden [las pestañas]».
