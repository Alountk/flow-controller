# "En carpeta": listar el contenido real y no quedarse con una foto vieja

## Objective

Que la navegación de "📁 En carpeta" muestre lo que de verdad hay en la carpeta —archivos
incluidos— con la información completa del episodio cuando sea de una serie, y que el listado
no se quede congelado.

## Problem

1. **El listado solo enseña carpetas.** `MissingContent.tsx:187` y `:196` filtran
   `items.filter(i => i.is_dir)`. Un archivo de vídeo **nunca** aparece en la navegación: hay
   que lanzar el escaneo para descubrirlo. Consecuencia real: mientras Radarr/Sonarr no hayan
   organizado la descarga en su carpeta, lo descargado vive como **archivo** en la carpeta de
   descargas y desde el modal es literalmente invisible — "no se ven".
2. **El listado es una foto fija.** `ScanModal` monta
   `useQuery({ queryKey: ['scan-browse', currentPath] })` (`MissingContent.tsx:48-52`) heredando
   los defaults de `QueryProvider.tsx`: `staleTime: 30_000`, `refetchOnWindowFocus: false`, sin
   `refetchInterval`, y **sin botón de refresco** (el `FilePane` sí lo tiene, `FileManager.tsx:208-210`).
   Descartado el backend: `file_browse` (`routes/files.py:66-77`) hace `iterdir` en cada llamada,
   sin caché. El único sitio de la app que puede sostener un listado viejo es esa query.
3. **El escaneo de una serie pierde la identidad del episodio.** `handleScanForSeries(ep.series_title, ep.series_id)`
   (`MissingContent.tsx:398-401`) descarta temporada, episodio, título y fecha, y el header pinta
   solo `<strong>{item.title}</strong>` (`:154`). Los resultados del escaneo tampoco lo dicen:
   muestran `file_name`, `file_path` y `score` (`:262-268`).

## Why

"En carpeta" existe justo para localizar a mano lo que el import automático no resolvió. Si el
listado va por detrás del disco, la herramienta falla en su único trabajo; y si no enseña qué
episodio es cada archivo, se elige a ciegas.

Petición del usuario, textual: "en buscar carpeta se pudiera ver toda la informacion si es un
episodio de una serie (s03e07 Of Ice Men 2006-11-27)".

## Scope

Dentro:

- Listar **archivos además de carpetas** en la navegación del modal (icono, tamaño, fecha).
- Refrescar de verdad: `staleTime: 0` + `refetchOnMount: 'always'` en `scan-browse`, y evaluar lo
  mismo en `browse` (`FileManager.tsx:58`).
- Botón ↻ en el modal, con paridad con el explorador.
- Enriquecer los episodios con **una sola llamada por serie** (mapa `S##E## → título + airDate`),
  resolviendo el `S##E##` del nombre del archivo en local.
- Pasar `season_number`, `episode_number`, `title`, `air_date` de `MissingContent` al `ScanModal`
  y mostrarlos en el header.

Fuera:

- Watcher del sistema de archivos / SSE.
- Mostrar archivos en el Explorador de Archivos (ya los muestra).
- Enriquecer películas: basta tamaño y fecha.

## Constraints

- El modal no tiene contrato que romper: la navegación no está paginada.
- La lista de resultados del escaneo llega completa en una sola respuesta y su filtro en cliente
  es honesto; **no se toca**.
- "Seleccionar todo" del escaneo debe seguir operando sobre lo **visible** (`utils/selection.ts`).
- Un enriquecido por archivo contra Sonarr serían N llamadas: por eso **una llamada por serie** y
  lookup local por `S##E##`.
- `BrowseResponse`/`FileItem` (`types.ts:313-328`) ya traen nombre, tamaño y fecha; no hace falta
  contrato nuevo para la navegación.

## Tasks

- [x] **T1** Frontend: `scan-browse` con `staleTime: 0` y `refetchOnMount: 'always'`, más botón ↻
- [x] **T2** Frontend: listar archivos (además de carpetas) en la navegación del modal
- [x] **T3** Backend: traer los episodios de una serie en **una** llamada (Sonarr
      `/api/v3/episode?seriesId=`; verificar la forma real de la respuesta antes de fiarse)
- [x] **T4** Frontend: resolver `S##E##` del nombre del archivo y pintar `s03e07 Título fecha`
- [x] **T5** Frontend: header del modal con temporada, episodio, título y fecha
- [ ] **T6** Tests: refetch al navegar, archivos visibles, episodio resuelto por `S##E##`
- [ ] **T7** Verificación en vivo: una carpeta/archivo recién creado aparece sin recargar

## Acceptance criteria

- Una carpeta o archivo nuevo en disco aparece al navegar, sin esperar ni recargar.
- La navegación muestra archivos, no solo carpetas.
- Un archivo de episodio se muestra como `s03e07 Of Ice Men 2006-11-27`.
- El header del modal identifica el episodio, no solo la serie.
- Backend y frontend en verde; `pyflakes` y `vulture` limpios.

## Applicable checks

- Backend: `cd backend && python -m pytest -q`, `python -m pyflakes *.py routes/*.py`, `python -m vulture`
- Frontend: `cd frontend && npm test && npm run build && npm run typecheck`

## TDD

Desactivado (`strict_tdd: false`, origen `sdd-init/flow-controller`). Checks funcionales por tarea.

## Progress

- [x] T1+T2 hechos en la rama `feat/en-carpeta-navegacion-y-refresco`: el listado del modal
      refresca de verdad (petición sin caché + botón ↻) y muestra archivos además de carpetas,
      con icono, nombre y tamaño.
- Contexto del bug (descrito por el usuario y acotado por preguntas): retraso percibido
  10-30 min, sitio "al navegar carpetas en el modal".

## Verification evidence

- Commit T1: `d160c29` — `fix(wanted): refresh the "En carpeta" folder listing on every navigation`
- Commit T2: `bbd5022` — `feat(wanted): list files alongside folders in the "En carpeta" navigator`

Comandos ejecutados en `frontend/`:

- `npm test` → `Test Files 23 passed (23)`, `Tests 172 passed (172)`, exit 0.
- `npm run build` → `tsc -b && vite build` en verde: 129 módulos transformados, `✓ built`.

El test de refresco se comprobó en negativo: con el handler del botón ↻ sustituido por un
no-op, `src/__tests__/scanFolderNav.test.tsx` falla (el nombre nuevo no aparece y no hay
segunda petición a `/api/files/browse`).

### Slice T3-T5 (rama `feat/en-carpeta-enriquecido-episodios`, base `feat/en-carpeta-navegacion-y-refresco`)

- Commit T3: `ef098c8` — `feat(wanted): fetch a series' episodes for the "En carpeta" navigator`
- Commit T4: `91e508c` — `feat(wanted): resolve and show the episode of each file in the navigator`
- Commit T5: `5a36c2e` — `feat(wanted): identify the scanned episode in the "En carpeta" header`

Comandos y resultados literales:

- `cd backend && python -m pytest -q` → el binario `python` no existe en este checkout
  (`zsh: command not found: python`). Se ejecutó con el intérprete disponible:
  `python3 -m pytest -q` → `324 passed, 2 warnings in 13.85s`, exit 0.
- `cd backend && python -m pyflakes *.py routes/*.py` → mismo problema de binario; con
  `python3 -m pyflakes *.py routes/*.py` → sin salida, exit 0.
- `cd backend && python -m vulture` → mismo problema de binario; con `python3 -m vulture` →
  sin salida, exit 0.
- `cd frontend && npm test` → `Test Files 24 passed (24)`, `Tests 182 passed (182)`, exit 0.
- `cd frontend && npm run build` → `tsc -b && vite build` en verde: 130 módulos
  transformados, `✓ built in 1.88s`, exit 0.

Tamaño del slice: `git diff --shortstat feat/en-carpeta-navegacion-y-refresco...HEAD` →
`11 files changed, 458 insertions(+), 26 deletions(-)` = **484 líneas cambiadas**, por
encima del presupuesto blando de ~400. **No se recortaron tests, comentarios ni
documentación para encajar**: el presupuesto corta trabajo, no encoge código. Se reporta el
número real y queda a criterio del padre decidir si este slice se abre como un solo PR o se
parte.

### Verificación en vivo: NO posible desde este checkout

No se pudo verificar contra el Sonarr real. `backend/.env` es una copia de `.env.example`
con una dirección de relleno (`111.111.111.111`) y claves ficticias, y la configuración real
vive en el host de despliegue. No se hizo ninguna llamada de red a un servicio real.

Por qué los nombres de campo **no** son una suposición: `/api/v3/episode` devuelve el mismo
`EpisodeResource` que `fetch_wanted_episodes` ya consume en producción
(`seasonNumber`, `episodeNumber`, `title`, `airDateUtc`), y por eso las filas de episodios de
Faltantes ya pintan `S##E##` correctamente hoy. El mapeo del fetcher nuevo reutiliza
exactamente esos campos.

Suposición residual única sin probar: que `/api/v3/episode?seriesId=` **sin** `seasonNumber`
devuelve todas las temporadas. El call site existente (`clients.py:571`) nunca lo demostró
porque siempre pasó `seasonNumber`. Si Sonarr devolviera solo una temporada, el enriquecido
mostraría etiquetas parciales —los archivos de otras temporadas se quedarían sin segunda
línea— y **nunca** etiquetas incorrectas: un tag sin coincidencia no pinta nada.

## Review (RDD)

RDD activo (global). Evaluado el slice con
`gentle-ai review assess --cwd . --base-ref main --committed-only --json`:

- `risk: medium`, motivo `executable_change`, 4 ficheros, 376 líneas.

Por contrato, **medium se difiere al slice**: no se abre transacción de review por este work
unit; el preflight se lanzará al cerrar el slice. La declaración de no rastreados que exige la
herramienta se resolvió con `--untracked-scope=exclude` (el `.md` de la otra feature queda fuera
del candidato a propósito).

## Entrega

Estrategia elegida por el usuario: **PRs encadenados**, cadena **`stacked-to-main`**.

Al medir el slice completo salieron **404 líneas** (392+, 12−), por encima del presupuesto fijo de
400 por PR. En vez de pedir `size:exception` por 4 líneas, se hizo **un corte honesto** por unidad
de trabajo, que es lo que prescriben `chained-pr` y `work-unit-commits` (una unidad entregable por
PR). No hizo falta reescribir historia: `d160c29` cuelga directamente de `main`, así que basta una
rama apuntándolo.

| PR | Contenido | Base | Líneas | Commits |
| --- | --- | --- | --- | --- |
| [#27](https://github.com/Alountk/flow-controller/pull/27) | T1 — refresco del listado | `main` | 146 (145+, 1−) | `d160c29` |
| [#28](https://github.com/Alountk/flow-controller/pull/28) | T2 — archivos en el navegador + registro | `fix/en-carpeta-refresh` | 264 (250+, 14−) | `bbd5022`, `4797038`, `3071f92`, `2a76bff` |
| (futuro) | T3-T5 — enriquecido `S##E##` | rama de #28 | — | — |

Patrón `stacked-to-main` real: cada PR apunta a `main`, pero el hijo se abre con la base del padre
para que su diff no arrastre el trabajo anterior; al mergear el padre, GitHub reapunta el hijo.
Consecuencia práctica a recordar: **la CI solo se dispara en PRs con base `main`**, así que #28 no
tendrá checks hasta ese reapuntado.

Push, creación de PR y merge: autorizados por el usuario para este slice.

## Hipótesis pendiente de confirmar

El backend no cachea el listado, así que un F5 debería mostrar una carpeta nueva al instante. Si
el usuario ve que ni con F5 aparece, el contenido todavía no está en disco con la forma
esperada (descarga o import en curso, o payload como **archivo** y no como carpeta). Eso
reforzaría que el síntoma principal es el punto 1: lo que no se ve son los **archivos**.

## Next step

Seguir con **T6** (tests de refetch al navegar, archivos visibles y episodio resuelto por
`S##E##`) y **T7** (verificación en vivo: una carpeta o archivo recién creado aparece sin
recargar). T7 es justamente la que no puede cerrarse desde este checkout, por lo dicho en la
sección de honestidad de arriba.

El tercer PR de la cadena (T3-T5, rama `feat/en-carpeta-enriquecido-episodios`) **todavía no
está abierto**: lo abre el padre. T1-T2 ya están cerrados.
