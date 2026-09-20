# Faltantes: títulos alternativos + filtro de resultados del escaneo

## Objective

Que el escaneo de "📁 En carpeta" encuentre archivos desubicados **cuyo nombre esté en
cualquier idioma**, y que el usuario pueda **filtrar a mano** la lista de coincidencias.

## Problem

1. **El matching por títulos alternativos está muerto.** `clients.py` lee `altTitles` de
   la API de Radarr, pero Radarr devuelve `alternateTitles`. Verificado contra la API real:
   `altTitles` es `null` en los 96 faltantes y la película 813 tiene **21** títulos
   alternativos sin usar. Resultado: un archivo llamado `Ton Nom (2016).mkv` no se encuentra.
2. **El selector "Idiomas:" del modal miente.** Tiene checkboxes, bloquea el botón de
   escaneo si no eliges ninguno, y el backend lo ignora por completo (`req.local_path` no
   se usa en ningún punto). Es la peor clase de UI: la que promete algo que no hace.

## Why

El usuario quiere que la búsqueda use los títulos en los idiomas que le interesan. La API
**no etiqueta** cada título alternativo con su idioma, así que "dame solo los de idioma X"
no se puede construir sin una dependencia externa (TMDB). Pero **usar todos los títulos**
consigue el objetivo real — encontrar el archivo esté en el idioma que esté — sin coste.

Para acotar a mano, en lugar de un selector que no puede cumplir lo que promete, un **input
de texto libre** sobre los resultados: más barato, más flexible y honesto.

## Scope

Dentro:

- Arreglar el campo de origen `altTitles` -> `alternateTitles` para Radarr (2 sitios).
- Input de filtro manual en el bloque de resultados del escaneo.
- Eliminar el selector de idiomas del modal y la validación asociada.
- Conservar el input "Título a buscar" (`customTitle`), que sí funciona.
- Dejar de enviar `local_path` desde `scanForMovies()`.

Fuera (documentado en el backlog):

- Etiquetar títulos por idioma vía TMDB (Fase 2, probablemente innecesaria).
- Filtro de idioma en el **listado**: está paginado (50 por página, 1981 episodios) y
  Radarr/Sonarr no ofrecen búsqueda por texto ni por idioma -> la misma trampa.

## Constraints

- El campo de **salida** de nuestra API sigue siendo `altTitles`: `frontend/src/types.ts:217`
  lo espera. Solo cambia el campo leído de Radarr, no el contrato interno.
- `routes/wanted.py:223` y `:271` consumen nuestra clave normalizada -> **no se tocan**.
- Sonarr ya usa `alternateTitles` correctamente -> **no se toca**.
- Los resultados del escaneo llegan completos en una sola respuesta (no paginados),
  por eso el filtro en cliente es honesto aquí y no en el listado.
- "Seleccionar todo" debe operar sobre lo **visible**, nunca sobre lo oculto por el filtro.

## Tasks

- [x] **T1** Arreglar `altTitles` -> `alternateTitles` en `clients.py` (Radarr, 2 sitios)
- [x] **T2** Test backend de regresión: el escaneo encuentra un archivo por título alternativo
- [x] **T3** Frontend: input de filtro manual en los resultados del escaneo
- [x] **T4** Frontend: eliminar el selector de idiomas y la validación asociada
- [x] **T5** Frontend: conservar "Título a buscar" y dejar de enviar `local_path`
- [x] **T6** Tests de frontend: filtrado, contador y "Seleccionar todo" sobre lo visible
- [ ] **T7** Verificación en vivo con `curl` del escaneo real
- [ ] **T8** Backlog: reescribir #19 y aparcar Fase 2 (TMDB)

## Acceptance criteria

- Un archivo cuyo nombre coincide con un título alternativo de Radarr aparece como coincidencia.
- El modal no tiene checkboxes de idiomas y el botón de escaneo no depende de ellos.
- El input filtra los resultados por nombre de archivo o título, sin distinguir mayúsculas ni acentos.
- El contador refleja `visibles de total`.
- "Seleccionar todo" solo marca lo visible.
- Backend y frontend en verde; pyflakes y vulture limpios.

## Applicable checks

- Backend: `cd backend && python -m pytest -q`
- Frontend: `cd frontend && npm test && npm run build`
- Linters: `python -m pyflakes *.py routes/*.py` y `python -m vulture` (desde `backend/`)

## TDD

Desactivado (`strict_tdd: false`, origen `sdd-init/flow-controller`). Se corren checks
funcionales por tarea, sin exigir RED-first.

## Progress

- Rama: `feat/faltantes-titulos-alternativos-y-filtro`
- **Todos los tasks hechos (T1-T8).**

## Verification evidence

- `python -m pytest -q` -> 172 passed. `npm test` -> 57 passed (39 -> 57).
  `npm run build` y `tsc -b --noEmit` limpios.
- **Guard del backend validado revirtiendo el fix:** sin el arreglo fallan 5 tests,
  incluido `test_scan_matches_file_named_after_an_alternate_title`.
  `test_scan_still_matches_the_primary_title` pasa en ambos casos, confirmando que
  la ruta del título principal nunca estuvo rota.
- **Guard del frontend validado:** al "simplificar" el deseleccionado a `new Set()`
  fallan 2 tests (`never touches matches hidden by the filter` y el round-trip).
- **Verificación en vivo (curl, datos reales) — el caso perfecto:**
  `/mnt/storage/movies/es/Everything Everywhere All at Once (2022)/` contiene
  `Todo a la vez en todas partes (2022) - Unknown - x264 MP3 .mkv`, título en
  **español**, distinto del principal.
  - `_match_score` vs principal `'Everything Everywhere All at Once'` -> **0.179** (bajo el umbral 0.5)
  - `_match_score` vs alternativo `'Todo a la vez en todas partes'` -> **0.85**
  - `curl POST /api/wanted/scan` **con el bug** -> `scanned_files: 1, matches: 0`
  - `curl POST /api/wanted/scan` **con el arreglo** -> `matches: 1`,
    `matched_title: Todo a la vez en todas partes`, score 0.85
- Barrido de regresión: 12 endpoints GET en HTTP 200.

## Por qué el bug sobrevivió tanto (hallazgo clave)

Al arreglar `clients.py` falló `tests_routes.py::test_wanted_returns_items_for_every_arr_service`.
El fixture declaraba `"altTitles": [{"title": "Alt Movie"}]` — **el mismo nombre equivocado que
leía el código**. El mock *estaba de acuerdo con el bug*, así que el test pasaba en verde
mientras la API real devolvía `alternateTitles`.

Lección: **un mock construido desde una suposición, y no desde una respuesta real capturada,
no verifica nada** — confirma el error. Los fixtures de `tests_wanted_scan.py` se copiaron de
respuestas reales de Radarr por ese motivo.

## Nota sobre el entorno

No se pudo crear un archivo de prueba en el storage: `/mnt/storage` es NFS4 con
root-squash (ni root escribe) y `/mnt/storage-6tb` rechaza escrituras incluso para
root. La verificación en vivo se hizo por tanto contra **archivos reales existentes**,
que resultó mejor prueba que un fixture. No se creó ni se dejó nada en disco.

## Next step

Ninguno: PR abierta.
