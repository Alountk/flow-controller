# movies-ffprobe — specs de ffprobe en la vista de ficheros de películas

Tres secciones de archivos (1080/4K/3D + «Otros») en la pestaña Archivos del detalle
de película, con análisis ffprobe bajo demanda y specs completos por archivo.
Specs S1–S4 son literal del usuario (peticiones + decisiones); nada se añade.

## Specs

S1 — Petición original del usuario (verbatim): «nueva tarea: me gustaria que en la
seccion de movies, cuando seleccionamos una pelicula y vamos a la parte de ficheros
me gustaría ver las tres secciones de archivos 1080/4k/3d y dentro de estos me
gustaría que con ffprobe analizara los tres archivos y me diera los specs más
importantes (codec, resolucion, bitrate, pistas de audio, etc...)»

S2 — Decisión del usuario sobre el disparo del probe (verbatim, opción elegida
«Bajo demanda»): «Nada corre solo: un botón «Analizar» por sección/archivo».

S3 — Decisión del usuario sobre el nivel de specs (verbatim, opción elegida
«Completo»): «Esenciales + contenedor, perfil HDR/rango dinámico, todas las pistas
de audio y subtítulos». Ejemplo entregable (preview elegido, verbatim):

```
**1080p** · `ParaNorman.mkv`
MKV · H.264 High@4.0 · 1920×1080 · 8.2 Mbps · 23.976 fps
Audio 1: AC3 5.1 640kbps español
Audio 2: AAC 2.0 128kbps inglés
Subtítulos: ESP (srt), ENG (srt)
1h 35m · 5.4 GB
```

S4 — Decisión del usuario sobre archivos fuera de las tres secciones (verbatim,
opción elegida «Cuarta sección «Otros»»): «Agrupación honesta: todo lo no
clasificable aparece visible en su propia sección».

## Tasks

- T1 — Backend: endpoint de sonda de UN archivo (reusar `probe_file`/
  `parse_probe_data` de `backend/media_mixer.py:85+`; correr en `asyncio.to_thread`
  — regla dura `tests/contracts/tests_offloop.py`; contrato 400 (path ilegible /
  ffprobe rc≠0 / timeout) y 500 (binario ausente) espejando `POST /api/mixer/probe`;
  respetar los contratos de arquitectura `tests_architecture.py` y el de finura de
  `routes/files.py`). Tests RED→GREEN junto al endpoint.
- T2 — Frontend: cliente/tipos de la sonda (`shared/api/…`) con fetch en la frontera
  de red; tests RED→GREEN.
- T3 — Frontend: tres secciones + «Otros» en la pestaña Archivos (`PanelFiles` /
  `Peliculas` detalle): agregación de las tres ubicaciones (carpeta de la película +
  `path_4k` + `path_3d` con el matching de prefijo ya usado en `ReleaseSearchModal`)
  y clasificación (3D > 4K > 1080 > Otros según S4); estado honesto de vacío por
  sección. Tests RED→GREEN.
- T4 — Frontend: botón «Analizar» por sección/archivo (S2) + estado de carga
  «Ejecutando ffprobe…» + specs completos (S3) con `codecLabel`/formato de fps
  reusando los helpers de `MediaMixer.tsx`. Tests RED→GREEN.
- T5 — Padre: seam review de cada entrega, gates completos (vitest/tsc/eslint/build
  + pytest backend), commits de rebanada (~400 L) en rama feature.

## Log

L1 — 2026-10-30, usuario: «nueva tarea: me gustaria que en la seccion de movies,
cuando seleccionamos una pelicula y vamos a la parte de ficheros me gustaría ver
las tres secciones de archivos 1080/4k/3d y dentro de estos me gustaría que con
ffprobe analizara los tres archivos y me diera los specs más importantes (codec,
resolucion, bitrate, pistas de audio, etc...)»
L2 — Exploración (explore `mvvhf36g-3-rwdy`): Películas → detalle → pestaña
«Archivos» = `Peliculas.tsx:678` → `PanelFiles` (tabla plana actual, sin secciones);
convención 1080/4K/3D ya viva (roots `role:4k/3d` en `routes/files.py:147-148`,
clase en `Peliculas.tsx:93-99`, tres fuentes de «tiene copia» en
`hasFileThreeSources.test.tsx:10` con `listing4kQuery`/`listing3dQuery` y
`holdsCopy` en `ReleaseSearchModal.tsx:410,419,845-858`); ffprobe ya operativo
(`probe_file` `media_mixer.py:85-131`, `POST /api/mixer/probe` con
`asyncio.to_thread`, binario en el Dockerfile raíz vía paquete `ffmpeg`).
L3 — 2026-10-30, decisiones de producto del usuario (ask de 3 preguntas):
disparo = **«Bajo demanda»** (botón «Analizar», nada corre solo); nivel =
**«Completo»** (contenedor, perfil HDR, todas las pistas de audio y subtítulos);
excepciones = **«Cuarta sección «Otros»»** (agrupación honesta). Son S2–S4.
L4 — T1 ENTREGADO (worker `mvvip6ds-4-a5vt`, seam review + gates del padre
verificados): `POST /api/mixer/probe-file` en `routes_mixer.py:428+` con
`ProbeFileRequest`; RED 8 failed → GREEN 8 passed; contrato espejo de `/probe`
(raíces permitidas: 403, fichero ausente/entrada ilegible/timeout 400, binario
ausente 500, `asyncio.to_thread` con prueba offloop). Colocación en
`routes_mixer.py` (router ya registrado; un router nuevo tocaría `app.py` fuera
de superficies y el ratchet `MAX_LEGACY_LOC=3456`). Gates del padre: `npm run
build` rc=0 (reconstruye `dist` y desactiva el fallo preexistente de
frescura `tests_dist_fresh`), backend **1752 passed** (1744 + 8), contratos
16/16. Nota (fuera de alcance, para issue futura): `alternatives/lookup` no
valida raíces permitidas — hueco latente heredado.
