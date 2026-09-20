# Filtros en los resultados de los indexadores

## Objective

Poder acotar la lista de releases que devuelve la búsqueda en indexadores, en lugar de
hacer scroll entre varios cientos de entradas.

## Problem

La búsqueda en indexadores devuelve **todos** los resultados de una vez y los pinta agrupados
por indexador, sin ningún filtro. Medido contra la API real (película 411, "Everything
Everywhere All at Once"): **401 releases** en una sola búsqueda, con calidad e idioma muy
repartidos y una mediana de **1 seeder**.

| Campo | Distribución real |
| --- | --- |
| `languages` | English 223 · Italian+English 31 · Unknown 31 · Spanish 26 · Italian 16 · French 15 |
| `quality` | Bluray-1080p 59 · WEBDL-1080p 56 · WEBDL-720p 45 · Bluray-720p 41 · SDTV 28 |
| `indexer` | aMuTorrent 255 · TPB 75 · Knaben 66 · YTS 5 |
| `seeders` | 0 a 501, mediana **1** |

401 entradas con scroll no es una lista, es una aguja en un pajar.

## Why

A diferencia de los faltantes, aquí **sí hay datos fiables que filtrar**: Radarr/Sonarr
etiquetan cada release con `languages`, `quality` y `seeders`. Es además el idioma que se
quiso filtrar desde el principio y no se pudo, porque los `alternateTitles` de los faltantes
no llevan etiqueta de idioma — los releases sí.

## Scope

Dentro:

- Filtro por **texto libre** (cubre título del release).
- Filtro por **calidad** (multiselección).
- Filtro por **idioma** (multiselección; un release puede traer varios idiomas).
- Filtro por **seeders mínimos**.
- Contador `visibles de total` y botón de limpiar.
- "Seleccionar todo" y el agrupado por indexador respetan el filtro.

Fuera:

- **Filtro por indexador**: ya existe. El desplegable "Indexador:" del paso inicial filtra
  los resultados por nombre de indexador. No se duplica.
- Cambios de backend: la API ya devuelve todos los campos necesarios.

## Constraints

- La lista de releases llega **completa en una sola respuesta** (no está paginada), así que
  filtrar en cliente es honesto aquí.
- **"Seleccionar todo" solo puede afectar a lo visible.** Actuar sobre lo oculto descargaría
  releases que el usuario no ve. Es la misma regla que en el escaneo, así que debe haber
  **una sola implementación** de esa lógica, no dos copias.
- Los grupos por indexador que queden vacíos tras filtrar no deben renderizarse.
- Las opciones de calidad/idioma se calculan del conjunto **completo**, no del filtrado, para
  que no desaparezcan a medida que se filtra.

## Tasks

- [x] **T1** `utils/selection.ts`: helpers genéricos de selección por clave (`areAllSelected`, `toggleVisibleSelection`)
- [x] **T2** Refactorizar `utils/scanResults.ts` para delegar en ellos (sin romper sus tests)
- [x] **T3** `utils/releaseFilters.ts`: filtrado, recogida de opciones y estado de filtros
- [x] **T4** `ReleaseSearchModal.tsx`: barra de filtros (texto, calidad, idioma, seeders, limpiar, contador)
- [x] **T5** Conectar "seleccionar todo", agrupado por indexador y contador al conjunto filtrado
- [x] **T6** Tests: filtros de release, helpers de selección y regresión de selección sobre lo visible
- [x] **T7** Verificación en vivo con releases reales
- [x] **T8** README: actualizar el backlog

## Acceptance criteria

- La barra filtra por texto, calidad, idioma y seeders mínimos, combinables.
- El contador muestra `visibles de total`.
- "Seleccionar todo" solo marca lo visible.
- Los grupos de indexador vacíos no se pintan.
- Las opciones ofrecidas salen de los resultados completos, no de los filtrados.
- Limpiar filtros restaura la lista completa.

## Applicable checks

- Frontend: `cd frontend && npm test && npm run build`
- Sin cambios de backend, pero el barrido de endpoints debe seguir verde.

## TDD

Desactivado (`strict_tdd: false`, origen `sdd-init/flow-controller`). Checks funcionales por tarea.

## Progress

- Rama: `feat/filtros-busqueda-indexadores`
- **Todos los tasks hechos (T1-T8).**

## Verification evidence

- **Frontend: 95 passed** (antes 57). `npm run build` y `tsc -b --noEmit` limpios.
- **Guards validados revirtiendo los defectos:**
  - `textIncludes` sin normalizar la aguja -> **6 tests fallan** (los de texto de
    `releaseFilters` y `scanResults`). El bug real que los tests cazaron durante el
    desarrollo: se normalizaba el texto pero no la aguja, así que `"Todo"` no casaba
    con `"todo"`.
  - `toggleAll` usando `releases` en vez de `visibleReleases` -> **falla
    `select-all marks only the filtered releases`**. Esto es lo que guarda el cableado
    del componente, que la lógica pura no cubre.
- **Datos reales (búsqueda en vivo, película 411):** 403 releases.
  - `languages`: **0 releases con lista vacía** — todos traen al menos `["Unknown"]`
    (31 solo-Unknown). Por eso los chips de idioma cubren el 100% y el filtro **no
    oculta releases por falta de datos**.
  - 35 releases con `seeders = 0`, de ahí el filtro de seeders mínimos.
- Backend sin cambios: `pytest` 172 passed, `pyflakes` y `vulture` limpios.

## Next step

Ninguno: PR abierta.
