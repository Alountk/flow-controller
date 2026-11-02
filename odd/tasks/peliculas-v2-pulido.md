# Feature: peliculas-v2-pulido (Películas V2 al diseño L2, con sus funciones)

ODD feature doc. Cierra la V2 de Películas: la deja 1:1 con la pantalla Stitch
«Películas — Variante L2 (Filas con Póster)» y le devuelve las funciones que
hoy solo viven en la V1 (filtro de faltantes, recuentos por clase, búsqueda por
nombre contra el servidor, paginación).

## Specs

- **S1 — Pedido.** «quiero que pulas del todo Peliculas V2, tanto el diseño
  como las funcionalidades».
- **S2 — Chips del mock + «Sin archivo».** La fila de chips usa el vocabulario
  del diseño —`Todas`, `4K`, `3D`, `1080`, `Otros`— con su recuento, y añade un
  sexto chip `Sin archivo` para las películas que Radarr no tiene con archivo
  (lo que la V1 llama «Faltantes»). Los chips son excluyentes y sus recuentos
  suman el total: una película sin archivo cuenta en `Sin archivo`, nunca
  además en su clase.
- **S3 — Paginador real.** «Paginador real contra el backend»: la lista deja de
  pedir `page_size=0` y pide páginas (`page`, `page_size`), con `‹ ›` y
  «Pág N de M» en el pie. Los recuentos de chips y del subtítulo se calculan
  sobre el catálogo entero, no sobre la página.
- **S4 — La fila solo selecciona.** «Solo el menú Acciones rápidas»: la fila no
  lleva acciones propias; selecciona (clic o `Espacio`) y el chevron `›` abre
  el detalle (`Enter` también, como dice la leyenda del pie). Releases y escaneo
  se piden desde el menú de la cabecera, sobre la fila seleccionada.
- **S5 — Cabecera del mock.** Título `Películas`; subtítulo
  «N películas · M sin archivo»; buscador con pista `Ctrl+K`; botón `Actualizar`
  (refresca catálogo y carpetas, con su estado en vuelo); botón
  `Acciones rápidas` (menú: Ver detalle, Buscar releases, Escanear carpeta),
  deshabilitado sin selección. `Ctrl+K` enfoca el buscador.
- **S6 — Fila del mock.** Póster 40×60, título 15 px, «año · calidad», ruta en
  mono 11 px, badge de clase con su color (4K azul, 3D morado, 1080 pizarra,
  Otros zinc, Sin archivo ámbar), chips de carpeta de destino, chevron. La fila
  seleccionada lleva barra izquierda, fondo propio, título en acento y la
  etiqueta `Seleccionado`.
- **S7 — Pie del mock.** «Mostrando N de M», leyenda de teclado
  (`↑↓` navegar, `Enter` detalle, `Espacio` selección) y paginador
  «Pág N de M» con `‹ ›` deshabilitados en los extremos.
- **S8 — Volver no pierde nada.** La ✕ devuelve a la lista con su chip, su
  búsqueda, su página y su scroll: la lista se queda montada y se oculta, no se
  desmonta.
- **S9 — La V1 no cambia.** `CalidadMovies` y la vista Calidad de la V1 quedan
  como están (clases `en biblioteca`/`desconocida`, `page_size=0`, sin chips
  nuevos); la V2 estrena componente propio.

## Tasks

- T1 — Backend: clase de biblioteca como función pura (`domain`), `class` por
  item + `counts` + filtro `class` en `/api/wanted/all`, default intacto.
  Pytest: default sin cambios, filtro, recuentos, `q` + `class` + página.
- T2 — Frontend: lista propia de la V2 (`PeliculasV2List`) con la query
  paginada, chips con recuento, buscador contra el servidor y paginador.
- T3 — Frontend: cabecera y pie del mock (S5, S7) y navegación por teclado.
- T4 — Frontend: fila del mock (S6) y lista montada y oculta al abrir el
  detalle (S8).
- T5 — CSS de la lista V2.
- T6 — Tests de la V2 reescritos sobre el componente nuevo.
- T7 — Gates, doc, Engram y PR.

Delivery: dos PRs encadenados — backend (T1) y frontend (T2–T7).

## Log

- L1 — «quiero que pulas del todo Peliculas V2, tanto el diseño como las
  funcionalidades».
- L2 — Decisión (chips), verbatim de la opción elegida: «Etiquetas del mock +
  chip «Sin archivo»».
- L3 — Decisión (pie), verbatim: «Paginador real contra el backend».
- L4 — Decisión (acciones por fila), verbatim: «Solo el menú Acciones rápidas».
- L5 — Consecuencia técnica de L3: con paginación real los recuentos por clase y
  el propio filtro por clase dejan de poder resolverse en el cliente, así que el
  backend pasa a clasificar cada película (`class`) y a devolver `counts`. La
  regla vive en `backend/domain` (función pura con su test); la V1 conserva la
  suya en el frontend porque sus etiquetas son otras (S9).
- L6 — Fuera de alcance consciente: el segmento «Raíz: /mnt/storage/movies» del
  subtítulo del mock. La raíz de la biblioteca es una carpeta raíz de Radarr y
  la app no la expone hoy (`/api/files/roots` son las raíces permitidas de esta
  app, no las del arr); inventarla desde las rutas de la página sería una
  mentira. Se pide aparte si se quiere.
- L7 — Entrega. T1 en `3f6caf9` (409 líneas autoradas: la regla pura, los
  recuentos, el filtro y sus tests); T2–T7 en `9a84425` (≈1476 líneas: el
  componente nuevo con su CSS y los tests reescritos — no se puede partir sin
  dejar una suite roja, así que se entrega como una unidad y se revisa por
  commit). Dos PRs encadenados: backend primero, frontend encima.
- L8 — Decisiones de esta entrega:
  - `CalidadMovies` vuelve a ser exactamente lo que era (S9): la V2 estrena
    `PeliculasV2List` en su propio archivo, y `.sec-l2-*` sale de `Sections.css`
    a `PeliculasV2.css`. La barra izquierda, el póster y la fila de 72 px se
    reutilizan de `.sec-movie-*` porque ya eran las del diseño.
  - `QualityBelowList` («umbral-calidad») se queda, pero **debajo** del pie: el
    mock no tiene sitio para él y empujar la cabecera del diseño hacia abajo
    habría roto el 1:1. Sigue en su sitio en la V1.
  - La lista se oculta con `hidden`, no se desmonta (S8), y el scroll de la
    ventana se guarda al abrir el detalle y se repone al volver — jsdom no
    puede probar el scroll, así que la prueba cubre chip y búsqueda.
  - Paginación de 50 por página (como la V1), no los 8 del mock: 8 filas por
    página sobre 128 títulos son 16 páginas de dos clics cada una.
- L9 — Gates del padre: pytest 1858, vitest 955, tsc/eslint/build rc=0,
  pyflakes y vulture limpios. El contrato `tests_dist_fresh` exige el build
  del frontend al día.
- L10 — Riesgo: se toca `/api/wanted/all`, que también alimenta la lista de
  Biblioteca de la V1 (vía MediaPane). Los campos añadidos son aditivos y el
  default no cambia de forma; el test `test_unfiltered_request_is_unchanged` y
  el e2e de Faltantes siguen verdes. El endpoint pasa a pedir siempre el
  catálogo completo al adaptador, que ya lo pedía así y rebanaba en memoria:
  no hay petición extra, pero sí un recorrido de clasificación por request.
- L11 — Ajustes de estilo pedidos después del merge (L1 verbo: «en el
  .sec-master, .sec-detail no tiene sentido en este nuevo diseño porque lo
  wrapean en una card»; «los chips del row donde dice la resolución en Todas
  deberían salir todas las resoluciones y las que están disponibles en azul»;
  «la paginación siempre se vea abajo [...] tiene que estar disponible siempre
  en la vista principal»; vocabulario de resoluciones, textual: «4K,3D,1080P,SD»).
  - S10: en modo página `.sec-master` y `.sec-detail-page` no dibujan card
    (sin fondo, borde, radio ni recorte) y el detalle pierde el `top: 72px` de
    la variante sticky, que lo pintaba 72 px por debajo de su sitio en el flujo
    y lo hacía solaparse con lo que viniera después.
  - S11: cada fila nombra siempre las cuatro resoluciones `4K · 3D · 1080p ·
    SD`; se encienden en azul las que la película tiene, según su clase y las
    carpetas de destino que contienen el archivo. Sin archivo: las cuatro
    apagadas y la píldora ámbar «Sin archivo».
  - S12: el pie (`Mostrando N de M`, leyenda y paginador) es `sticky` al borde
    inferior del área de scroll, y el `.content` pierde su padding inferior
    mientras la página V2 está montada, para que el pie quede pegado al borde
    y no flotando 48 px por encima.
  - S13: las «Notas de implementación» (checklist de PR 1–7) no se pintan en la
    V2: son para quien construye la pantalla, no para quien la usa. La V1 las
    conserva.
- L12 — Verificación de los ajustes: vitest 956 (18 en `peliculasV2.test.tsx`,
  el nuevo cubre S11), pytest 1858, tsc/eslint/build rc=0. Además, comprobación
  visual real con un arnés desechable (dist estático + API stubbeada en
  Playwright, fuera del repo): cabecera, filas, chips, pie pegado al borde tras
  desplazar 1200 px y detalle a página completa sin card ni solapes.
- L13 — Riesgo de L11: se toca `Sections.css` (compartido con Series y con la
  V1). Las reglas nuevas están acotadas a `.sec-page`, `.sec-detail-page` y
  `.content:has(.sec-page)`; la V1 no monta `.sec-page`, y sus 12 tests de
  `calidadView` siguen verdes.
