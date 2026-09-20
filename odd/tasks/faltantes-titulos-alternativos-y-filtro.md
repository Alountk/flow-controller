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
- [ ] **T3** Frontend: input de filtro manual en los resultados del escaneo
- [ ] **T4** Frontend: eliminar el selector de idiomas y la validación asociada
- [ ] **T5** Frontend: conservar "Título a buscar" y dejar de enviar `local_path`
- [ ] **T6** Tests de frontend: filtrado, contador y "Seleccionar todo" sobre lo visible
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
- **T1 + T2 hechos.** `clients.py` lee `alternateTitles` de Radarr en
  `arr_movie_metadata` y en `fetch_wanted_movies`. Nuevo `tests_wanted_scan.py`
  (8 tests). Pendiente T3-T8.

## Verification evidence

- `python -m pytest tests_wanted_scan.py -q` -> 8 passed.
- **Guard validado revirtiendo el fix:** sin el arreglo fallan 5 (incluido
  `test_scan_matches_file_named_after_an_alternate_title`, el bug real del
  archivo `Ton Nom`); con el arreglo pasan 8.
  `test_scan_still_matches_the_primary_title` pasa en ambos casos, confirmando
  que la ruta del título principal nunca estuvo rota.

## Next step

T3: input de filtro manual en el bloque de resultados del escaneo.
