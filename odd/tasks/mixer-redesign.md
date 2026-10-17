# Mixer redesign — cotejo bloqueante, idiomas exigidos, audio ordenado y subtítulos externos

> Feature del bloque 🟡 (HANDOFF.md pendiente 1: "redesign del Mixer (feature grande)").
> Specs S1–S9 = decisiones verbatim del usuario (L1, L3–L6, L8–L11). S9 (proceso) obliga
> a la ronda Stich ANTES de implementar. Los demás puntos del bloque 🟡 no se tocan aquí.

## Specs

- **S1** (dos archivos, alcance): *"Mi idea es de poder utilizar dos archivos para hacer
  mixer"* — el flujo son siempre dos archivos (A y B) que se cotejan antes de mezclar
  (ya existe `/api/mixer/probe` + dos pickers con raíces; se conserva).
- **S2** (idiomas, orden y exigidos): *"mi ideal es de tener las peliculas en los
  siguientes idiomas castellano, ingles, ruso, catalan. Así es como deberiamos tener el
  orden de las pistas de audio."* + decisión ask: *"podriamos configurar que idiomas son
  exigidos y cuales no, pero cuando digo de buscar es en el indexador. Castellano tiene
  que estar siempre, es el minimo, pero solo hace falta que uno de los dos archivos lo
  tenga."* + de fábrica **"Solo castellano"** exigido (inglés/ruso/catalán opcionales,
  todos configurables). El check de exigidos se hace sobre la **unión de A+B** (basta
  que uno de los dos archivos tenga el idioma). **Ausencia de un idioma exigido ⇒ BLOQUEA
  el mezclado** (igual que S3: badge + Mezclar deshabilitado + 409), decisión L14.
- **S3** (cotejo que bloquea): *"Creo que el primer check deberia ser mirar los dos
  archivos, cotejar si son los mismos fps y la duracion y si no lo son marcar en algun
  lado que no son compatibles."* + decisión ask: **"Bloquear el mezclado"** → fps o
  duración que no cuadran ⇒ badge «no compatible» y botón de mezclar **deshabilitado**
  (hoy `check_compatibility()` solo emite warnings y `ok` es siempre `true`).
- **S4** (vídeo por calidad): *"Si lo son deberiamos entonces escojer la pista de video
  con mejor calidad y compresion."* — mejor pista **entre A y B** (hoy
  `select_best_video()` solo puntúa codec hevc>h264 y el mux siempre toma el vídeo de A;
  el selector de vídeo de B existe en la UI pero `canMux` lo ignora).
- **S5** (audio en orden): *"luego las pistas de audio en el orden que te comentado."*
  + decisión ask: **"4 automáticas, resto a elegir"** → las pistas de los 4 idiomas se
  preseleccionan y ordenan ca→en→ru→cat (vengan de A o de B); las pistas de otros
  idiomas aparecen desmarcadas para que se elijan a mano.
- **S6** (subtítulos externos): *"luego extraer los subtitulos a str o buscarlos los
  mismos idiomas de audio."* + decisión ask: **"Extraer + OpenSubtitles"** → extraer a
  `.srt` los streams de subtítulo de TEXTO embebidos en A/B + buscar en OpenSubtitles
  (API key nueva en Configuración) para los idiomas de audio; `.srt` como **sidecars
  junto al archivo de salida**.
- **S7** (buscar en el indexador): *"deberiamos pdoer tambien si no tenemos el archivo
  de en otro idioma buscarlo"* + aclaración: *"cuando digo de buscar es en el
  indexador"* + decisión ask: **"Botón con lookup automático"** → si falta un idioma
  exigido, botón que parsea el título del filename → `arr_movie_lookup` → si la
  película está en la librería se abre el `ReleaseSearchModal` con sus releases; si no,
  aviso con el título para añadirla primero.
- **S8** (sin transcodificar, salida solo externa): *"Esta seccion no es para
  transcodificar ni nada, es para hacer mixer y conseguir subititulos externos."* +
  decisión ask: **"Solo externos"** → salida = solo vídeo + audio ordenado (los streams
  de subtítulo embebidos NO se copian al contenedor); los subtítulos viven únicamente
  como `.srt` externos; `-c copy` puro, cero re-encode.
- **S9** (proceso): decisión ask: **"Ronda Stich primero"** → mockups del nuevo layout
  (badge de compatibilidad, lista de audio ordenada, panel de subtítulos, botón
  indexador) en el proyecto Stitch, aprobación del usuario, y SOLO DESPUÉS implementar.
  **Cerrado L14**: pantallas 10/11/12 aprobadas 2026-10-17 (con el chip «Bloqueante» de
  la 12 confirmado → regla añadida a S2).

Fuera de alcance: transcodificar/re-encode de vídeo o audio (S8), el resto de puntos del
bloque 🟡 (tabla densa Archivos, secciones Calidad/Avisos, 3 namings), cambios en otras
secciones de la app.

## Tasks

- [ ] **T1 [S9]** — Ronda Stich: mockup(s) del mixer nuevo en el proyecto Stitch
  `4305330220058954866` (badge no-compatible que bloquea, audio ca→en→ru→cat con 4
  automáticas + resto a elegir, panel de subtítulos, botón de indexador) → aprobación
  del usuario. Ruta: Stitch (sin repo). Commit: —.
  - [x] **Aprobada 2026-10-17** (L14): pantallas 10/11/12 conforme; «Bloqueante» se
    mantiene (S2). Tarea cerrada.
  - Evidencia (2026-10-17): 3 pantallas generadas en el proyecto Stitch —
    `fa62f3d03f614ff8b0a278aa190d0491` (10 Media Mixer — Cotejo compatible),
    `526b9df4e93d42f9ac4f28c2bed0afdb` (11 Media Mixer — No compatible),
    `185f57cb95904a85a000c93138f910f6` (12 Media Mixer — Idioma ausente). Ver L13.
- [x] **T2 [S3]** — backend: `check_compatibility()` devuelve `ok:false` cuando fps no
  coincide o duración difiere >2%; `/api/mixer/mux` rechaza la mezcla incompatible (409)
  además del badge. Tests RED→GREEN. Ruta: `backend/media_mixer.py`,
  `backend/interfaces/http/routes_mixer.py`, `backend/tests/interfaces/routes/tests_mixer_api.py`.
  Commit: —.
  - Evidencia (2026-10-17): RED observado **8 failed / 47 passed** (fps→ok:false+reasons,
    duración umbral 5%→2% con test 4.2% que bloquea, pin reasons==[] en resolución,
    409 con `probe_file` parcheado). Implementado: `reasons` (fps_mismatch |
    duration_mismatch) + gate en `/mux` que re-probea los ficheros distintos con
    `asyncio.to_thread`/`gather` y devuelve 409 `{error, reasons, compatibility}` antes
    de `start_mux`; un solo fichero ⇒ sin probe. **GREEN 55/55 tocados; suite completa
    1133/1133** (base 1130 + 3 tests nuevos); techo legacy `MAX_LEGACY_LOC=2751`
    intacto (docstring compactado en vez de subir el techo). Asserts cambiados por
    spec (vieja spec "solo warnings"): test_fps_mismatch, test_duration_mismatch_(over_2),
    test_duration_under_2 (antes under_5), test_all_mismatches — ahora exigen ok:false
    y reasons; ningún test borrado ni debilitado.
- [ ] **T3 [S4]** — backend: selección de vídeo por calidad+compresión
  (resolución > codec eficiente > bitrate) evaluando A y B, y el mux acepta vídeo de
  cualquiera de los dos. Tests RED→GREEN. Ruta: `backend/media_mixer.py` + tests.
  Commit: —.
  - [x] Evidencia (2026-10-17): RED observado (ImportError de `select_best_video_pair`,
    tests de ranking con la vieja regla «primer track gana», `best_video` KeyError en
    probe). Implementado: `_video_rank_key` (área > eficiencia de codec > bitrate),
    `select_best_video` reescrito, `select_best_video_pair` ({file, path, track_index
    ordinal para `-map v:N`, codec, width, height, fps, bitrate}; A gana en empate
    total), `best_video` en la respuesta de `/probe`. `test_mux_video_from_file_b_starts`
    fija que el mux acepta vídeo de B. **GREEN 63/63 tocados; suite completa 1141/1141**.
    El test de «empate» se recolocó con fixture real de empate (el viejo era 4K vs
    1080p: codificaba la spec vieja de solo-codec). **Deuda legacy: techo 2751 → 2782**
    (+31 líneas de ranking nuevo en `media_mixer.py`) con comentario `#:` de ownership en
    `tests/contracts/tests_architecture.py` y disclosure obligada en la descripción del
    PR de cierre.
- [ ] **T4 [S2]** — backend+settings: orden de audio ca→en→ru→cat con normalización
  ISO 639-2 (`spa`/`es`, `eng`/`en`, `rus`/`ru`, `cat`/`ca`), check de idiomas exigidos
  sobre la unión A+B, clave `mixer.languages` en settings (de fábrica: castellano
  exigido). Tests RED→GREEN. Ruta: `backend/media_mixer.py`, settings, tests backend.
  Commit: —.
- [ ] **T5 [S6,S8]** — backend: probe parsea streams de subtítulo (codec, idioma,
  texto vs bitmap); extracción a `.srt` sidecar junto a la salida para texto
  (subrip/ass/webvtt); bitmap (PGS/VobSub) marcado «no extraíble sin OCR»; el mux sigue
  sin mapear subtítulos al contenedor (S8). Tests RED→GREEN. Ruta: `backend/media_mixer.py`,
  `backend/interfaces/http/routes_mixer.py`, tests. Commit: —.
- [ ] **T6 [S6]** — backend+frontend: cliente OpenSubtitles + campo API key en
  Configuración; búsqueda/descarga de `.srt` por idioma de audio hacia el sidecar de la
  salida; tests con stub (sin red real). Ruta: backend (infra) + `frontend/src/features/settings/Settings.tsx`
  + tests. Commit: —.
- [ ] **T7 [S7]** — backend+frontend: botón «buscar en indexador» en el mixer cuando
  falta un idioma exigido: filename → `arr_movie_lookup` → `ReleaseSearchModal` si está
  en librería, si no aviso con el título. Tests. Ruta: backend (route) +
  `frontend/src/pages/MediaMixer.tsx` + tests. Commit: —.
- [ ] **T8 [S1–S8,S9]** — frontend: port del mockup Stich a `MediaMixer.tsx`/`MediaMixer.css`
  (badge que bloquea `canMux`, lista de audio ordenada con automático+manual, panel de
  subtítulos con estado extraído/buscado/no-extraíble, botón indexador). Tests
  RED→GREEN + checks. Commit: —.
- [ ] **T9 [S1–S9]** — docs y cierre: BACKLOG (fila del mixer/bloque 🟡) + HANDOFF
  (pendiente 1) + este doc (tasks/espejo); checks finales backend/frontend/tsc/eslint.
  Commit: —.

## Log

- **L1 (2026-10-17, usuario)**: "podemos continuar con el diseño de redesign mixer,
  quiero profundizar en esta seccion. Mi idea es de poder utilizar dos archivos para
  hacer mixer, deberiamos pdoer tambien si no tenemos el archivo de en otro idioma
  buscarlo, mi ideal es de tener las peliculas en los siguientes idiomas castellano,
  ingles, ruso, catalan. Así es como deberiamos tener el orden de las pistas de audio.
  Creo que el primer check deberia ser mirar los dos archivos, cotejar si son los mismos
  fps y la duracion y si no lo son marcar en algun lado que no son compatibles. Si lo
  son deberiamos entonces escojer la pista de video con mejor calidad y compresion.
  luego las pistas de audio en el orden que te comentado. luego extraer los subtitulos a
  str o buscarlos los mismos idiomas de audio. Esta seccion no es para transcodificar ni
  nada, es para hacer mixer y conseguir subititulos externos."
- **L2 (2026-10-17, evidencia explore)**: ya existe mixer completo: probe de 2 archivos
  (`POST /api/mixer/probe`), `check_compatibility()` con warnings NO bloqueantes
  (`ok` siempre `true`), `select_best_video()` solo por codec, mux `-c copy` que mapea
  solo vídeo+audio (descarta subs embebidos), UI con pickers + selector manual de pistas
  (`MediaMixer.tsx`, 733 líneas). El probe **no parsea streams de subtítulo**; no existe
  cliente de OpenSubtitles; para indexador ya hay `arr_movie_lookup()`/`arr_fetch_releases()`
  y el `ReleaseSearchModal` reutilizable; ffmpeg/ffprobe ya están en el Dockerfile.
- **L3 (2026-10-17, usuario, ask 1.1)**: buscador de idioma = *"cuando digo de buscar
  es en el indexador"*, *"podriamos configurar que idiomas son exigidos y cuales no"*,
  *"Castellano tiene que estar siempre, es el minimo, pero solo hace falta que uno de
  los dos archivos lo tenga"* → S2/S7.
- **L4 (2026-10-17, usuario, ask 1.2)**: **"Bloquear el mezclado"** ante fps/duración
  que no cuadran → S3.
- **L5 (2026-10-17, usuario, ask 1.3)**: **"Extraer + OpenSubtitles"** para subtítulos →
  S6.
- **L6 (2026-10-17, usuario, ask 1.4)**: **"4 automáticas, resto a elegir"** para el
  audio fuera de los 4 idiomas → S5.
- **L7 (2026-10-17, evidencia)**: `arr_movie_lookup()` (arr_client.py:1900) busca por
  título en Radarr y `ReleaseSearchModal` ya consume releases/grabs por `movie_id` — el
  flujo de S7 se engancha ahí; `config/settings.json` no tiene aún sección de mixer ni
  de subtítulos (secciones actuales: services, security, developer, paths, intervals,
  tracing, retention, server).
- **L8 (2026-10-17, usuario, ask 2.1)**: **"Botón con lookup automático"** (filename →
  lookup → modal si está en librería, si no aviso) → S7.
- **L9 (2026-10-17, usuario, ask 2.2)**: **"Solo castellano"** exigido de fábrica → S2.
- **L10 (2026-10-17, usuario, ask 2.3)**: **"Solo externos"** — los subs embebidos NO se
  copian a la salida → S8.
- **L11 (2026-10-17, usuario, ask 2.4)**: **"Ronda Stich primero"** → S9: mockups antes
  de implementar.
- **L15 (2026-10-17, T2 completada inline)**: como los gate de writer exigen el literal
  `Spec: odd/tasks/…` en la tarea, T2+T3 se ejecutan inline (parent). T2 GREEN 1133/1133
  con RED observado (8 failed). Aclaración del orden de T3: en el doc figuraba
  "codec > resolución > bitrate"; se corrige a **resolución > codec > bitrate** — S4 pide
  «mejor calidad y compresión», la calidad (píxeles) es primaria y el ejemplo del mockup
  10 (HEVC vs H.264 a misma resolución) no distingue entre ambos órdenes.
- **L16 (2026-10-17, T3 completada inline)**: RED observado → GREEN **1141/1141**
  (base 1130 + 11 tests nuevos de T2+T3). Deuda legacy 2751 → 2782 subida con
  comentario `#:` en el propio contrato («subir el techo es deuda a propósito — own it
  en la PR description») y disclosure quedará en la descripción del PR de cierre (T9).
- **L12 (2026-10-17, supuestos del parent, no objetados)**: umbrales del cotejo — fps
  debe coincidir exacto (tol. 0.001) y duración incompatible si difiere >2% (~2.4 min en
  2 h; corta cambios de montaje reales); idiomas con tags ISO 639-2 (`spa/eng/rus/cat`)
  normalizados también desde códigos cortos; subs bitmap (PGS/VobSub) no se vuelven
  `.srt` sin OCR ⇒ se marcan «no extraíbles»; sidecars con sufijo de idioma
  (`Mixer_20261017.es.srt`); el orden dentro de cada idioma: pista del archivo A antes
  que B y bitrate descendente.
- **L13 (2026-10-17, evidencia T1, ronda Stich)**: generadas 3 pantallas desktop
  dark-first en el proyecto `4305330220058954866` con el design system
  `assets/5781956853225900110` («FlowController»), estilo de las 01–09 (naming
  `NN … — FlowController`):
  `10 Media Mixer — Cotejo compatible` = `fa62f3d03f614ff8b0a278aa190d0491` (S3-verde,
  S4, S5, S6, S8) · `11 Media Mixer — No compatible` =
  `526b9df4e93d42f9ac4f28c2bed0afdb` (S3-rojo: badge «No compatible», valores fps/duración
  A|B en paralelo, botón «Mezclar» con `disabled` verificado en el HTML) ·
  `12 Media Mixer — Idioma ausente` = `185f57cb95904a85a000c93138f910f6` (S7: aviso
  «Falta castellano (exigido) en los dos archivos» + botón «Buscar en el indexador» con
  lookup por título). Verificado sobre el HTML (fuente, no captura): orden de audio
  ca→en→ru→cat con 4 checkboxes marcadas y francés/alemán sin marcar, chips de subtítulos
  «Extraído» (+ sidecar `Mixer_20261017.es.srt`) / «OpenSubtitles» / «Buscando…» /
  «No extraíble (bitmap PGS)», línea dim «Clave API de OpenSubtitles: Configuración →
  Servicios», y copy «copia de streams, sin transcodificar (-c copy)» junto a la acción.
  Ojo: Stitch añadió un chip «Bloqueante» en el aviso de idioma de la 12 — **resuelto
  en L14: se mantiene; idioma exigido ausente bloquea el mezclado**.
- **L14 (2026-10-17, usuario, aprobación S9 + decisión nueva)**: «Aprobar + bloquear por
  idioma» — las 3 pantallas (10 Compatible, 11 No compatible, 12 Idioma ausente)
  quedan aprobadas sin cambios; sin castellano (exigido) no se mezcla, coherente con
  «castellano es el mínimo» → regla añadida a S2 (badge + Mezclar deshabilitado + 409
  en el mux). Abre el gate de implementación T2–T9.
