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
- T7 — V2: la fila **selecciona**, solo la flecha abre el detalle (S3). El
  detalle se abre con un estado propio (`detailOpen`) para que selección y
  navegación dejen de ser el mismo gesto. Tests: clic de fila no navega y
  marca `aria-current`; flecha abre; ✕ vuelve dejando la selección.
- T8 — V2: cabecera del diseño L2 — título con recuento, buscador por nombre
  con atajo `Ctrl+K`, botón «Actualizar» y menú «Acciones rápidas» que actúa
  sobre la fila seleccionada (abrir detalle, buscar releases, escanear).
  Deshabilitado sin selección: sin selección no hay sobre qué actuar.
- T9 — CSS: cabecera L2, buscador con la píldora `Ctrl+K`, menú de acciones
  rápidas, fila seleccionada del diseño (barra izquierda + título acento).
- T10 — Docs: Log L7/L8, espejo Engram y PR.

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

- L4 — **Plan cambiado (decisión del usuario, 2026-11-02)**: la reescritura en
  sitio se descarta. «podriamos meter estos cambios en una seccion nueva?
  Peliculas V2 / Series V2, asi podriamos implementar esto y poco a poco ir
  trasladando si hemos perdido alguna funcionalidad». Por qué: la primera
  tentativa sustituyó la lista por la de Calidad y con ella desapareció
  `MediaPane` (buscador, Faltantes/Todas, bulk search, navegación de escaneo)
  — 83 tests en rojo lo señalaban. La V2 convive con la V1 como red de
  seguridad y el traslado es incremental.
- L5 — Entrega de la V2 v0: `Peliculas` acepta `layout?: 'split' | 'page'`
  (`split` es la V1 de siempre, sin un solo cambio de comportamiento);
  `page` es la V2: sin pestañas de sub-vista, lista a ancho completo, el
  detalle **sustituye** la vista y se cierra con ✕, y cada fila lleva su
  flecha. Ruta `/peliculas-v2` + entrada «Películas V2» en el sidebar.
  Gates: frontend **121 ficheros / 940 tests**, tsc/eslint/build 0.
- L6 — Pendiente consciente (no es un olvido): lo que sigue viviendo solo en
  la V1 debe **trasladarse** a la V2 antes de retirar aquella — buscador por
  nombre, chips Faltantes/Todas, bulk search y navegación de escaneo de
  `MediaPane`; y Series V2 replicando el mismo `layout`.

## Extraído del diseño L2 (fuente de verdad para el 1:1)

Pantalla Stitch `3df91e1aaee3452f80c627b386df7712` (proyecto
`4305330220058954866`, design system «FlowController»).

- **Iconos (material symbols)**: `tune` (logo), `dashboard`, `movie`, `tv`,
  `notifications`, `folder`, `settings`, `sync`, `description`, `restart_alt`,
  `logout`, `dns`, `cloud_done`, `warning`, `search`, `bolt`.
- **Logo/brand anchor**: cuadrado `w-8 h-8 rounded bg-primary-container` con el
  icono `tune` a `FILL 1`; junto a «FlowController» (headline-md bold) y el
  subtítulo «Gestor Multimedia». Ese cuadrado es el icono a subir como favicon.
- **Cabecera (header, `h-14`, sticky, `border-b`)**: breadcrumb a la izquierda
  (`FlowController / Películas / <vista>`) y a la derecha un clúster de estado
  con píldoras por servicio (Radarr / Sonarr / aMule con punto de color y texto
  «Conectado» / «Alerta») más tres botones de icono `dns`, `cloud_done`,
  `warning`.
- **Chips de filtro de clase**: `rounded-full px-3 py-1`, fondo `#141622`,
  borde `#1e202e`, y el contador en una píldora interior
  (`text-xs text-[#777587] bg-[#10111a] px-1.5 rounded-full`). Orden del
  diseño: Todas · 4K · 3D · 1080 · Otros.
- **Badge de clase por fila**: `px-2 py-0.5 rounded text-xs border
  font-semibold` con color por clase — 4K: `bg-blue-500/20 text-blue-400
  border-blue-500/30`.
- **Skeleton**: el diseño **no** trae skeleton de fila (el único
  `animate-pulse` es el punto de alerta de aMule) ⇒ hay que pedírselo a Stitch
  como pantalla nueva antes de implementar el estado de carga.

## Corrección pendiente (reportada por el usuario, 2026-11-02) — **HECHA** (T7)

«cuando le damos a la row entra directamente a lo que son los detalles, esto
no debería ser así porque si no el Acciones rápidas no tiene sentido, se
selecciona la row y en la flecha que hay a la derecha del todo se puede
acceder a los detalles».

- **Regla correcta (V2)**: clic en la **fila** ⇒ solo **selecciona** (la fila
  queda marcada y las «Acciones rápidas» se activan). Abrir el detalle es
  **exclusivo de la flecha `›`** del extremo derecho.
- **Estado actual (incorrecto)**: en V2 la fila entera hace `choose()` y abre
  el detalle, dejando las «Acciones rápidas» sin sentido. Lo mantuve a
  propósito para no romper tests de la V1; es un error de criterio, no un
  olvido: S3 pide que **solo la flecha** navegue.
- **Al arreglarlo**: `onClick`/`onKeyDown` de la fila pasan a `setSelected`
  (selección, sin cambiar de vista), la flecha conserva `choose()`, y hay que
  revisar los tests que hoy asumen que pulsar la fila abre el panel
  (`peliculasV2.test.tsx` y los de `calidadView`) — migrándolos a pulsar la
  flecha, no borrándolos.

- L7 — Corrección del usuario (2026-11-02), verbatim: «cuando le damos a la
  row entra directamente a lo que son los detalles, esto no debería ser así
  porque si no el Acciones rápidas no tiene sentido, se selecciona la row y en
  la flecha que hay a la derecha del todo se puede acceder a los detalles».
  Se ejecuta en T7: la selección deja de navegar.
- L8 — Continuación pedida por el usuario (2026-11-02), verbatim: «sigue con la
  tarea 26». La «tarea 26» es el pendiente que dejó la entrega de Estrenos:
  completar la V2 con el diseño (buscador `[Ctrl+K]`, botón «Actualizar»,
  «Acciones rápidas» activo con película seleccionada) reutilizando lo que ya
  existe en la V1. Se ejecuta en T8/T9; el contenido del menú de acciones
  rápidas se decide con lo que la app **ya** sabe hacer por película (abrir
  detalle, buscar releases, escanear carpeta) — no se inventa ninguna acción
  nueva. Queda fuera de este alcance la renumeración de los chips de clase
  (`1080`/`Otros` en el diseño) porque redefine las clases de la vista Calidad
  de la V1: se decide después, con la V1 ya retirada.
- L9 — Decisión de implementación de T7: la V1 no cambia de comportamiento con
  el arreglo. En la V1 `onSelect` rellena el panel lateral, que ya está en
  pantalla, así que «seleccionar» y «abrir» son el mismo gesto; el cambio solo
  añade un segundo gesto (la flecha) que la V1 también admite. La navegación
  exclusiva de la flecha vive en la V2, con su propio `detailOpen`.
- L10 — T7/T8/T9 entregados en `2c3c292` (489 líneas autoradas, un solo
  commit: la selección y la cabecera que la sirve son un mismo cambio, y el
  corte se divulga aquí y en el PR). Qué quedó:
  - **T7**: `CalidadMovies` gana `onOpen?`; la fila hace `onSelect` y solo la
    flecha `›` hace `onOpen ?? onSelect`. La V2 separa `selected` de
    `detailOpen`: la fila selecciona, la flecha abre, la ✕ cierra sin
    deseleccionar (`showDetail = !pageMode || (selected && detailOpen)`).
  - **T8**: cabecera L2 dentro de `CalidadMovies` con `l2` — título con
    recuento («2 películas · 1 sin archivo»), buscador por nombre con `Ctrl+K`
    (filtro local: el catálogo llega entero con `page_size=0`, sin petición
    nueva), «Actualizar» con estado «Actualizando…» deshabilitado, y menú
    «Acciones rápidas» que actúa sobre la selección (Ver detalle, Buscar
    releases, Escanear carpeta) y queda deshabilitado sin ella. En modo página
    se retira `.sec-master-head`: el diseño dibuja su propio `h1`.
  - **T9**: `.sec-l2-*` en `Sections.css` (cabecera, buscador con la píldora
    `Ctrl+K`, botones, menú anclado, título acentuado de la fila seleccionada).
  - Gates del padre: frontend **949 tests**, tsc/eslint/build rc=0.
  - Fuera del alcance (L8): renombrar los chips de clase a `1080`/`Otros` como
    en el diseño, porque redefine las clases de la vista Calidad de la V1.
