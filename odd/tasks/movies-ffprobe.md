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
- T6 — Extensión del payload habilitadora de T4 (parada L7): `parse_probe_data`
  (`backend/media_mixer.py`) emite en cada pista de vídeo `profile` y `level`
  (ffprobe `profile`/`level`, p. ej. `High`/`40`) y la evidencia HDR/rango
  dinámico cruda (`color_transfer`, `color_primaries`, `pix_fmt`) — sin inventar
  etiquetas (HDR10/HLG se derivan en la UI de T4) — siguiendo la convención de
  presencia del parser; `frontend/src/shared/api/probe.ts` crece en paralelo
  (tipos que anclan el parser, T2) y tests del contrato del endpoint. RED→GREEN.

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
L5 — T2 ENTREGADO (worker `mvvk3oav-6-kcjw`, seam review + vitest del padre
6/6 rc=0): `shared/api/probe.ts` con los tipos `Probe*Track/ProbeFile`
CRUZADOS campo a campo contra `parse_probe_data` (`media_mixer.py:160-205`,
11/11 exactos, incl. `extractable`), unión `ProbeFileResult`
(`{ok:true,probe}|{ok:false,detail}`) y `probeFile()` never-reject al molde
de `grabs.ts` (detalle `HTTP <status>` de fallback, «Error de conexión» en
transporte). RED (import fallido) → GREEN 6/6 (`probe.test.ts`). El worker
no encontró este doc ni el endpoint T1 en su árbol (corrió en la rama del
fix) — implementó con la spec inline del padre; resuelto en commits por
ruta. NOTA T4: importar los tipos de `probe.ts`, NO los de `mixer.ts`.
L6 — T3 ENTREGADO INLINE (el gate rechazó el launch: «write this unit inline
yourself now» — no se reintentó): RED 2 ficheros RC=1 → GREEN 26/26 rc=0 →
gates TSC/ESLINT/VITEST/BUILD=0. Diseño: `PanelFiles` gana la prop opcional
`folders` (Series byte-idéntico, verificado por sectionsTabs); clasificador
puro `shared/utils/fileSections.ts` — reglas: dir/no-vídeo→Otros (prueba
nada, molde `holdsCopy`), `looksThreeD`→3D, pertenencia path_3d→3D,
path_4k→4K, 2160p/4K→4K, 1080p→1080, otra resolución declarada (720p/480p/
576p/360p/dvd)→Otros, carpeta base sin token→1080 (default de biblioteca,
respaldado por el preview S3 del usuario), resto→Otros; precedencia S1
3D>4K>1080>Otros. Secciones «1080», «4K», «3D», «Otros» (h4+section,
etiqueta de `hasFileTags`), vacío honesto «Sin archivos en esta sección»;
copias de enrutado con matching de prefijo `copyPrefixOf≠''` + descenso de
UN nivel (layout `path_4k/<folder>/<file>`), fallo de lectura = alerta por
fuente y sin nota de vacío (failed≠empty); carpetas vía `['routing-folders']`
(misma key que Calidad; settings solo con la pestaña abierta). `sectionsTabs`
reescrito para la nueva presentación de Películas (la pestaña pedida en S1);
Series intacta. Archivos: `fileSections.ts`+test (9), `PanelFiles.tsx`,
`Peliculas.tsx`, `Sections.css`, `panelFilesSections.test.tsx` (7),
`sectionsTabs.test.tsx`. Rebanadas: T2 = `9aa0e96` (188 L/1C, dentro de
cuarto); T3 = `74ed136` (506 L/1C, **>400 → disclosure obligatorio en el PR**,
frontera registrada aquí según la estrategia de entrega); doc en commit
aparte.
L7 — T4 STOPPED LEGÍTIMO (worker `mvvlyqea-7-a3sl`, 0 ficheros tocados): el
preview verbatim de S3 exige `H.264 High@4.0` (perfil+nivel) y «perfil HDR/
rango dinámico», campos que `parse_probe_data` (`media_mixer.py:164-175`)
descarta — cláusula STOP «falta un campo del payload, no adivinar». DECISIÓN
padre = **opción A** (el spec es literal; extender el payload es fontanería,
no producto) → nuevo T6; el preview NO se degrada. Etiquetas del preview
GANAN sobre los helpers existentes y se anclan en tests de T4: `AC3` (no
`AC-3`), `640kbps` (sin espacio), `español`/`inglés` (no `Castellano`/`Inglés`),
subtítulo `(srt)` (no `subrip`). Helpers verificados reutilizables con export
mínimo: `codecLabel` (`MediaMixer.tsx:119`), `formatFps` (`:89`),
`formatBitrate` (`:82`), `formatDuration` (`:53`), `formatSize`
(`useFilesNavigator.ts:10`). Mapeo de estado: PR #259 (fix filtros) creado y
en CI; assess de su candidato = `reviewDue:false` (under_budget, 390 L/8 paths).
L8 — T6 ENTREGADO (worker `mvvmgygr-8-qz2f`; seam review del padre PASS):
`parse_probe_data` emite los 5 campos crudos por pista de vídeo con la
convención keys-always del parser (sentinela `"unknown"` en strings, `0` en
nivel, `-999` jamás se filtra: `max(int,0)`) + tipos `probe.ts` 16/16
(antes 11/11, JSDoc en inglés) + 3 tests nuevos (RED `KeyError: 'profile'`
→ GREEN 202/202 suites focales) + accounting en los 2 fixtures exact-dict
de `tests_mixer_api`. STOP legítimo del worker: ratchet legacy 3456→3462
(+6 = 5 campos + 1 comentario). La regla del contrato autoriza subir el cap
«as debt on purpose — own that in the PR description» → **padre subió
`MAX_LEGACY_LOC = 3462`, disclosure obligatorio en el PR**. DECISIÓN de
etiqueta HDR para T4 (honestidad): `smpte2084` → «HDR», `arib-std-b67` →
«HLG», ausente → sin etiqueta; **nunca** «HDR10» ni «Dolby Vision» sin
`side_data_list` (un DV P8 reporta smpte2084 → se mal etiquetaría sin
side_data); side_data passthrough = candidato a issue/roadmap. PR #259
MERGEADO (`37d5d34`) con CI de PR y post-merge verdes (Engram 1505).
