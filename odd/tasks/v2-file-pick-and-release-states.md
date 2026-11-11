# Películas V2: buscar-en-carpeta por archivo + estados honestos en Releases/Historial

Dos unidades sobre la sección de detalle de Películas V2: una feature (elegir un fichero
mejor desde cada fila de Archivos) y un bug de semántica (Releases marcaba peticiones, no
localizados; Historial no listaba las peticiones). Escritura secuencial por solapar ambas
`Peliculas.tsx`; entrega en PRs encadenados (bug primero, feature después).

## Specs

- **S1** (bug — marcado): En detalles → Releases, lo que se marca como descargado debe ser
  **sólo lo localizado**: «lo que se marca en esta parte son los ficheros que hemos puesto
  para descargar y no los localizados (aqui deberian salir los localizados siempre)». El
  caso observado (verbatim): «Cuando estamos navegando por las peliculas por ejemplo la de
  "Kubo and the two strings" en el listado sale los que tenemos descargados 1080, pero
  luego dentro de detalles -> release nos sale que hemos descargado los ficheros de 1080 /
  4k y 3d y en archivos no estan localizados.» La regla de localizado de Releases debe
  coincidir con la del listado V2 (mismo criterio de verdad, no una segunda interpretación).
- **S2** (bug — historial): «y en la parte de Historial deberiamos tener las peticiones de
  descarga que hemos ido teniendo» — la pestaña Historial lista las peticiones de descarga
  acumuladas (hoy sólo muestra la última del row: «Pedido el …/Nunca se pidió desde la
  app»), conservando la información que ya expone (fecha, destino).
- **S3** (feature): «implementar el buscar en carpeta que tenemos en la parte de archivos
  de la nueva seccion de detalles de peliculas v2, me gustaria que salga al lado de cada N
  archivos para que aunque haya alguno localizado pueda seleccionar uno mejor para
  sustituir el que haya o localizar uno que nuestro sistema no ha podido» — en la pestaña
  Archivos del detalle V2, cada fila de archivo lleva su propio «Buscar en carpeta», que
  permite seleccionar un fichero mejor: sustituir el localizado o crear la localización
  cuando el sistema no pudo. El «Escanear carpeta» existente (menú de acciones rápidas) se
  conserva.

## Tasks

- **T1** → S1-S2 · padre inline (writer rechazado por gate `Spec:`) · `done` · —
- **T2** → S3 · worker secuencial (tras T1) · `done` · —
- **T3** → S1-S3 · padre · gates completos + verificación visual en ambos temas · `in_progress` · —
- **T4** → S1-S2 + S3 · rama + commits separados por unidad + PR + Linear · `pending` · —
- **T5** → cierre · memoria + informe final · `pending` · —

## Log

- **L1** (usuario): «me gustaría implementar el buscar en carpeta que tenemos en la parte de archivos de la nueva seccion de detalles de peliculas v2, me gustaria que salga al lado de cada N archivos para que aunque haya alguno localizado pueda seleccionar uno mejor para sustituir el que haya o localizar uno que nuestro sistema no ha podido. He detectado tambien un bug.  Cuando estamos navegando por las peliculas por ejemplo la de "Kubo and the two strings" en el listado sale los que tenemos descargados 1080, pero luego dentro de detalles -> release nos sale que hemos descargado los ficheros de 1080 / 4k y 3d y en archivos no estan localizados. Lo que veo aquí es que lo que se marca en esta parte son los ficheros que hemos puesto para descargar y no los localizados (aqui deberian salir los localizados siempre) y en la parte de Historial deberiamos tener las peticiones de descarga que hemos ido teniendo.»
- **L2** (T1 verificado): RED 5 tests → GREEN 39/39 focal; gates exit 0 (vitest/tsc/eslint/build). Cambios: `ReleaseSearchModal.tsx` (fuente ② peticiones eliminada de tags/nota; `fetchOwnGrabs`+`grabsIdKindOf` exportados), `Peliculas.tsx` (PanelHistory = lista GET /api/grabs con fallback de carga y error honesto). Disclosures: el efecto comparte con Series (mismo panel — regla pedida uniforme); pestaña Estrenos/Series sin cambios (fuera de spec); id-kinds episode/series del endpoint quedan sin caller runtime (tsc los respalda). Tests: `hasFileTags.test.tsx` (nuevo, sustituye a `hasFileThreeSources`), sectionsTabs/estrenos/seriesEpisodes ajustados.
- **L3** (T2 verificado): worker `mwbxon3k` — RED 9 → GREEN 11 + suite **1105 (140)** + tsc/eslint 0 (padre re-observó). Sustitución = frontend-only (verificado en código: `place_file._place_file` renombra atómico sobre dst existente; probe en vivo capturó el body de cola con local_path = fila). Disclosures: filas-carpeta no sustituyen (copytree; localizan normal), chrome del ScanModal sin CSS (pre-existente — verificado: 0 reglas base en el repo), V1/Series sin botón (gated pageMode, test «no handler»), sandbox 403 pre-existente por rutas ficticias (capturas con fixture page.route).
- **L4** (decisión de entrega): T1 y T2 comparten `Peliculas.tsx` y el diff neto trae borrados grandes (test de 600 líneas sustituido) → **una rama, DOS commits separados (bug, luego feature), un PR con disclosure** en vez de PRs encadenados (evita splitting de hunks del mismo fichero con riesgo de rotura; rebanadas revisables por commit).
- **L5** (fronteras de rebanada): commit1 **`fd207a5`** = unidad de bug (618 líneas autor — sobre el presupuesto ~400 porque el test de contrato de ~600 líneas se RETIRA entero en esta misma unidad; disclosure en su mensaje); commit2 = unidad feature «Buscar en carpeta» por fila + este doc. Ambos en el PR único (L4).
