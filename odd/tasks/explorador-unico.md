# Un solo explorador de archivos en toda la app

Hoy hay **un** componente compartido (`FileNavigator`, 449 líneas) que dibuja
**cinco** exploradores distintos según 25 props, y mientras tanto cada pantalla
se ha inventado su propia barra de ruta cuando le hacía falta una. El resultado
es el que se ve: `.scan-*` y `.fm-*` repartidos por seis hojas de estilo, y el
mismo gesto (elegir una carpeta) con tres barras de ruta diferentes.

## Specs

- **S1 — Dos presentaciones, un chrome.** Todo explorador se dibuja con el mismo
  componente y las mismas cinco zonas: **ruta** (selector de raíz + migas +
  `Subir` + `Refrescar`), **herramientas** (filtro por nombre + `Seleccionar
  todo` + acciones), **cabecera de tabla** (`NOMBRE`/`TIPO`/`TAMAÑO`/
  `MODIFICADO`/`ACCIONES`), **filas** y **pie** (`N seleccionados · tamaño` y
  paginación). La presentación sólo elige el marco: `page` (dentro de la página,
  como Archivos) o `dialog` (modal con velo, como los selectores).
- **S2 — Nada de banderas para esconder partes.** No hay `showIcons`,
  `showSizes`, `showDates`, `showFilter`, `showRefresh`, `layout` ni
  `rootPicker`. Si un sitio necesita menos chrome, es que no debe ser un
  explorador. Un solo tipo de fila: densa, con icono, tamaño, fecha y acciones.
- **S3 — Lo que cambia entre sitios son las capacidades, no el aspecto.**
  `accept: 'folders' | 'files' | 'both'`, `multiple: boolean`, `title`,
  `confirmLabel` y dos slots: `toolbarActions` y `rowActions`. Un selector no
  recibe acciones; Archivos recibe `Renombrar`, `Mover a…`, `Copiar a…`,
  `Borrar`.
- **S4 — Selección múltiple de verdad.** Casilla por fila, casilla de cabecera
  con estado indeterminado, y en el pie `N seleccionados · 100,0 GB`. El clic
  normal sobre una carpeta sigue navegando; la casilla no navega.
- **S5 — La barra de ruta es su propio componente** (`PathBar`), porque también
  la necesita la barra de alcance de Duplicados: misma raíz desplegable, mismas
  migas, mismos botones `Subir`/`Raíz`.
- **S6 — Un solo pie de confirmación**: `Elegir esta carpeta`, `Elegir este
  fichero` o `Elegir N ficheros` según `accept`/`multiple`. Cancelar siempre en
  el mismo sitio.
- **S7 — No se pierde nada de lo que cada sitio ya sabe hacer**: navegación,
  filtro por nombre, sólo vídeo (Media Mixer), semilla de última ruta
  (búsqueda de releases), metadatos por fila (episodio en Escanear, procedencia
  en Archivos) y acciones por fila.
- **S8 — Nada se recorre al montar.** El listado llega por navegación; el
  selector siembra la última ruta que usó su consumidor, como hoy.

## Inventario: dónde se usa hoy

| Sitio | Hoy | Props que lo hacen distinto | Qué conserva |
|---|---|---|---|
| `features/file-manager/FileManager.tsx` (Archivos) | `region` + `rows` | `showDates`, `showIcons`, `showSizes`, `filter`, 4 slots, selección por clic | procedencia, antigüedad y acciones por fila |
| `features/media-pane/components/ScanModal.tsx` | `region` + `select` | `root, showRefresh`, `showIcons`, `showSizes`, `renderFileMeta` | el episodio que sugiere la coincidencia |
| `features/release-search/ReleaseSearchModal.tsx` | `dialog` | `mode: folder`, `initialPath` recordada | última ruta elegida |
| `pages/MediaMixer.tsx` (origen) | `region` + `split` | `showFilter`, `selection: file`, `onlyVideo` | sólo vídeo |
| `pages/MediaMixer.tsx` (destino) | `region` + `split` | `rootPicker: select`, `mode: folder` | carpeta destino |
| `pages/Duplicados.tsx` (alcance) | **inventada a mano** | — | raíz + migas + `Subir`/`Raíz` |
| `shared/ui/PanelFiles.tsx` (sólo lectura) | `useBrowse` a mano | — | lista por clase |
| `pages/Peliculas.tsx` / `pages/Series.tsx` (pestaña Archivos) | `browsePath` a mano | — | ruta de la selección |

CSS implicado: `FileNavigator.css` (667), `FileManager.css` (607),
`MissingContent.css` (395), `ReleaseSearchModal.css` (783), `MediaMixer.css`
(1014), `Duplicados.css` (309) — seis hojas para el mismo objeto.

## Diseño

Proyecto Stitch `4305330220058954866` («FlowController — Diseños»), misma familia
visual (claro, Inter, índigo `#4f46e5`, tablas densas, emoji):

- **Explorador** — `34d8471804144a87aff4d00d381dd367` — pantalla completa de
  Archivos: barra de ruta, herramientas con acciones de selección, tabla con
  casillas y acciones por fila, pie con `2 seleccionados · 100,0 GB`.
- **Selector** — `c254bb82272b4ec2bab9ff59d83a0710` — el mismo chrome dentro de un
  modal, con los tres modos anotados: carpeta (botón `Elegir esta carpeta`), un
  fichero (radios), varios (casillas).

Del diseño **no** se implementa: la tira del pool de disco ni las tarjetas de
punto de montaje/indexador/acceso de red (son de otra pantalla), y no hay
pósters: un explorador es una tabla.

## Tasks

| ID | Specs | Ruta | Commit |
|----|-------|------|--------|
| T1 | S1, S2, S3, S6 | `shared/ui/FileExplorer.tsx` (`PathBar` + `FileExplorer`) con el chrome único y las dos presentaciones; un solo CSS | `5e730dd` |
| T2 | S7 | migrar Archivos, Escanear, Búsqueda de releases y Media Mixer (×2); borrar `.scan-*`/`.fm-*` duplicados | `5e730dd` |
| T3 | S4 | selección múltiple en Archivos + acciones en lote (borrar/mover varios) | **no hizo falta**: ya existía |
| T4 | S5 | Duplicados usa `PathBar` y deja de tener barra propia | `5e730dd` |
| T5 | S2 | reforzar `pickerChrome.contract.test.ts`: ninguna clase de explorador fuera del componente | `5e730dd` |

Frontera real: T1+T2+T4+T5 van en **un solo commit**. No es descuido: el
componente y sus cinco consumidores comparten el mismo contrato de clases, y
partirlo dejaría la app con dos exploradores a medio migrar entre commits.
T3 (lote) **no hace falta**: Archivos ya tenía selección múltiple y borrado en
lote (`fm-batch-bar`, casilla por fila, `Seleccionar todo`); lo que faltaba era
el aspecto, y ahora viaja en el chrome compartido.

## Log

### L1 — petición del usuario (verbatim)

> ahora me gustaria abstraer el explorador de windows para que se vea igual en
> todas partes y no que cada uno sea de un padre y de una madre diferentes,
> puedes hablar con stitch para que sea lo más completo posible? recuerda que
> hay muchas partes que se utilizan para seleccionar archivos, o seleccionar
> varios, para renombrar archivos, para borrarlos, para trasladarlos de un lado
> a otro, etc... mira todos los casos donde lo utilizamos y estudia cual puede
> ser la mejor solucion (al final si tienen que ser dos diseños, no pasa nada,
> pero que al menos sean solo dos y coincidan los mismos en cada sitio y no
> tener 5 diferentes)

### L2 — diagnóstico

Cinco apariencias reales (no cinco sospechas): Archivos, Escanear, búsqueda de
releases, Media Mixer origen y Media Mixer destino, cada una con su combinación
de props, más una sexta barra de ruta inventada a mano en Duplicados. El
componente compartido no es el problema; el problema es que **admite** cinco
formas. La abstracción correcta no es otro componente, es **quitar opciones**.

### L3 — lo que el trabajo se llevó por delante

- `FileNavigator.tsx` (449) y `FileNavigator.css` (667) **desaparecen**;
  `FileManager.css` pierde 182 líneas de chrome duplicado (`.fm-path`,
  `.fm-crumb-*`, `.fm-filter`, `.fm-list`, `.fm-item`, `.fm-head-row`…).
- Los tests que fijaban el vocabulario viejo se reescribieron con el nuevo, no
  se borraron: la cabecera de tres columnas pasa a cinco, «Sin resultados» pasa
  a «Sin coincidencias», y el selector de Archivos deja de tener ids duplicados
  entre paneles (`fm-select-all-0`).
- La etiqueta de la raíz deja de **envolver** el selector: `htmlFor` enlaza, y
  `Subir`/`Refrescar` quedan fuera de la etiqueta.
- El nombre de la fila es un `<button>` sólo cuando el consumidor no pone slot:
  el teclado necesita una ruta, y Archivos ya tiene la suya (renombrado en
  línea). Un `<button>` es `fit-content`: sin `width: 100%` el nombre se
  quedaba en «a…».
- La celda de la casilla se dibuja siempre, aunque el consumidor no ponga slot:
  una rejilla que se desplaza una columna a la izquierda estrangula el nombre.

### L4 — verificación real (2026-11-04)

Backend contra `/private/tmp` (una raíz), `npm run build` y navegador:

- Archivos: **1** explorador, 279 filas, cabecera `NOMBRE / TIPO / TAMAÑO /
  MODIFICADO / ACCIONES`, migas `/private/tmp`, pie `/private/tmp · Mostrando 279`.
- Selector del Media Mixer: mismo chrome dentro del modal, `Volumen: tmp`,
  pie `Mostrando 15`; nombres completos tras las dos correcciones de rejilla.
- Duplicados: **1** barra de ruta compartida (`.explorer-bar`) y ninguna barra
  propia.
