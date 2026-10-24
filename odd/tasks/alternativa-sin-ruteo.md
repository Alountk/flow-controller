# Feature: alternativa sin ruteo — descarga normal, sin opciones Normal/4k/3d

Origen: usuario, 2026-10-23, tras cerrar `config-1x1-fixes` (#226-#229). Modal de
alternativa del Mixer («Buscar y descargar alternativa», S10/T11 de `mixer-redesign`
+ sección de idioma «Sólo en alternativa» de `busqueda-idioma-prowlarr`).

## Specs

- **S1 (petición original, verbatim):** «cuando en el mixer le doy a buscar y descargar
  alternativa, cuando me salen las alternativas deberian descargarse en la carpeta normal
  de descarga y no mostrar las opciones de Normal / 4k / 3d esto machacaria los archivos
  que aislados»
- **S2 (interpretación registrada por el parent):** «la carpeta normal de descarga» =
  el **flujo de descarga normal de la app**: sin `destination` (hoy el botón «Normal» →
  `library=true`) → `run_grab` toma el camino **arr** (`arr_grab_release`): el arr
  descarga con su cliente e importa → `alternativeStatus` llega a `ready` vía
  `arr_movie_file` → auto-colocación en el slot (S10). El **ruteo queda excluido en el
  modal de alternativa**: con destino `path_4k`/`path_3d` (fuera de las raíces del arr)
  el worker hace descarga **directa** —«el arr no la verá ni la importará»
  (`grab_release.py:318-333`)—, el estado jamás llega `ready` y el fichero aterriza en
  la carpeta de ruteo **junto a las copias ya presentes ahí** (el «machacar» de S1).
  También se excluye la **sugerencia por calidad** (`destinationFor` → 4k para 2160p).
  Alcance: **sólo el modo alternativa** del `ReleaseSearchModal` (prop explícita);
  Películas/Series/calendario conservan las tres opciones byte-idénticas (ver S3).
- **S3 (sin regresiones):** gate backend ≥1588, frontend ≥743, `tsc`/`eslint` 0, cero
  pérdidas de tests; los usos NO-alternativa del modal quedan intactos con **tests
  diferenciales** que pinnean su payload de grab (destino 4k/3d/library tal cual hoy).

## Tasks

| ID | Specs | Ruta | Commit |
|----|-------|------|--------|
| T1 | S1-S3 | parent — doc + espejo Engram + branch | este commit |
| T2 | S1-S3 | worker — modo alternativa sin botones de destino, grab fijo al flujo normal, RED→GREEN + diferencial | `4560987` |
| T3 | S1-S3 | parent — gate + docs + PR único + merge | gate abajo; PR al cierre |

## Log

- L1 (2026-10-23, usuario, verbatim S1): «cuando en el mixer le doy a buscar y descargar
  alternativa, cuando me salen las alternativas deberian descargarse en la carpeta normal
  de descarga y no mostrar las opciones de Normal / 4k / 3d esto machacaria los archivos
  que aislados»
- L2 (diagnóstico del parent, código en mano): `POST /api/calendar/grab` resuelve
  `destination = None si library; si no req.destination o destination_for_quality(quality, is3d)`
  (`calendar.py:369-376`); en `run_grab` un destino fuera de las raíces del arr dispara la
  ruta **directa** (fora de arr, sin import — `grab_release.py:318-333`) y `alternativeStatus`
  sólo llega `ready` con `arr_movie_file` (`routes_mixer.py:497-541`). El modal de alternativa
  hoy renderiza las tres opciones F-12 (library/4k/3d) y sugiere 4k para 2160p
  (`ReleaseSearchModal.tsx:701-712`). Decisión de alcance: fijar el grab al flujo normal
  (`library`) y esconder las opciones **sólo** en modo alternativa; lenguaje de idioma (S6/T4
  «Descargar» directo del modal de idiomas) queda fuera de alcance sin petición explícita.
- L3 (gate y entrega — 2026-10-23): **gate observado por el parent**: backend **1588
  passed**, frontend **89 files / 754 passed** (base 743 → +11: 9 tests de
  `alternativeMode.test.tsx` — 6 de modo alternativa + 3 diferenciales — y 2 pins de
  wiring en `mixerRedesign`/`mixerIndexerLookup`), `tsc -b` 0, `eslint` 0. T2 `4560987`:
  prop `alternativeMode` (default off), bloque `.release-dest` completo (los tres
  botones + highlight `suggest` + tooltips) oculto sólo en alternativa, un «Descargar»
  acento → `handleGrab(guid,'library')`; payload byte-idéntico al «→ Biblioteca» clásico
  pinneado como test. Diferencial: pins exactos de payload para 4K
  (`destination:'/mnt/storage-6tb/4k'`), 3D (`destination+'/is3d:true`) y Biblioteca en
  usos clásicos. Adapters por scope (colisión «Descargar» con la sección de idioma,
  «3D» con el chip de título, asíncrono del highlight de folders) — ninguno aflojado.
  Verificado fuera de alcance (no omitido): `grabCalendarReleaseBatch` no tiene UI
  consumidora en ningún lado; `mixer-dest-picker` es el destino de SALIDA del mux (no
  del grab). **Frontera de slice registrada**: 550 líneas / 2 commits → PR único con
  divulgación. **Review nativa**: clone-local OFF (D) → sin review.
