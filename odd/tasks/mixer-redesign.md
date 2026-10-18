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
  + enmienda L24: *"pero pasa una cosa hay a veces que los idiomas castellano no vienen
  como spa y vienen como und, deberiamos poder marcar las pista und si son las castellanas
  para poder pasar el flag"* → cada pista de audio `und` puede **marcarse como castellano**
  desde la lista; el mux lo lleva en `language_overrides` y el backend lo acepta solo si
  la pista apuntada es `und` y el idioma destino es válido (si no, 400
  `invalid_language_override`), contándolo como `spa` en el gate de exigidos y en el plan
  de subtítulos (S6). La marca vive en la sesión de la selección (se limpia al re-cotejar).
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

- **S10 (descarga de alternativa en los slots, L25–L28)**: *"podemos introducir en el
  flow que cuando en una de las dos opciones de examinar el archivo (cuando seleccionamos
  los dos), en una de las opciones busque una alternativa en los indexadores y la
  descarge? una vez descargada la seleccionamos en esa seccion."* + decisión ask L26:
  **"Título del otro slot (auto)"** → el botón solo aparece en el slot vacío cuando el
  otro slot ya tiene archivo, y el título sale de ese archivo + respuesta custom L26:
  *"Lo suyo es que sea automatico, pero tambien tenemos que tener opcion de que si no se
  descarga que hacer, si cancelar y buscarlo en otro indexador."* → auto-colocación al
  completarse y salida de la espera; «cancelar» = decisión L27 **"Abandonar la espera
  aquí"** (la descarga sigue en su cola normal, sin endpoint destructivo) + decisión L27
  **"Aviso si no está permitida"** (si la ruta final no está en `allowed_roots`: aviso
  con la ruta y NO se coloca) + L28: *"huelga decir que esa busqueda deberiamos poder
  hacerla por idiomas si no nos buscaria el mismo que ya tenemos"* → el modal recibe los
  idiomas de audio del otro archivo (`item.languages`) y su filtro de chips de idioma
  (ya existente) restringe la búsqueda.

Fuera de alcance: transcodificar/re-encode de vídeo o audio (S8), el resto de puntos del
bloque 🟡 (tabla densa Archivos, secciones Calidad/Avisos, 3 namings), cambios en otras
secciones de la app **salvo el prop opcional `onGrabStarted` del `ReleaseSearchModal`
(aditivo, S10)**.

### S11 — Cola de mezcla, progreso real y destino sustitutivo (L29–L32)

Al pulsar «Mezclar» la tarea se **envía a la cola**, con destino informado y
estado visible desde cualquier consola en **Seguimiento**:

1) **Destino obligatorio (L30)**: la barra de acciones ofrece «Carpeta de A» /
   «Carpeta de B» **sin default** — sin elegir destino, «Mezclar» no se
   activa. El resultado **sustituye al fichero original** de esa carpeta (misma
   ruta y nombre): ffmpeg escribe un temporal en la misma carpeta y, solo si
   termina con éxito (y hay salida verificable), un rename atómico reemplaza
   al original; si algo falla, el original queda intacto. El fichero de la
   otra carpeta no se toca. La sustitución es el **último paso** de la tarea
   (tras la extracción de subtítulos, que sigue leyendo los originales). La UI
   informa la ruta exacta que se va a sustituir.
2) **Toast + Seguimiento (L31)**: al enviar se muestra el toast «Enviado a la
   cola». La sección «Tareas» del mixer se **elimina**; el estado de las
   mezclas vive en **Seguimiento** junto a la cola de copias (orden, progreso
   real y controles pausar/cancelar/reanudar).
3) **Progreso real**: el progreso de ffmpeg se lee de la salida por la que
   realmente lo emite y la barra avanza durante `running` (refresco activo
   mientras haya mezclas en curso, con o sin SSE).
4) **Cola serie (L32)**: una mezcla a la vez; con una en curso, las siguientes
   esperan con estado `queued` y arrancan en orden FIFO (el endpoint de tareas
   las devuelve en orden de cola). Cancelar una `queued` la retira **sin
   ejecutarla**; pausa/reanúsa, TTL, subtítulos y semántica terminal
   conservan lo actual.
5) El destino se envía como `destination_path` (ruta completa de uno de los
   inputs); el servidor lo valida **fail-closed** (400 `invalid_destination`
   si no es exactamente el realpath de A o de B o no pasa
   `path_is_allowed`). Sin `destination_path` el endpoint conserva el modo
   legacy de directorio (compatibilidad interna; el UI siempre envía destino).
   Ningún gate 409 (compatibilidad, idiomas) ni la selección A/B cambian.

> **Delivery**: single PR a cierre de T9 (regla del usuario). Slices ya en la rama:
> C1 `6b6c0d8` docs (176), C2 `2774227` T2+T3 (339), C3 `b5eeeb1` T4 (460),
> C4 `761e0e0` T5 (788), C5 `6f26951` T6 (969), C6 `c811282` T7 (603),
> C7 `b5a16cc` T8 (2300) — 6006 líneas acumuladas, frontera de slice registrada aquí
> según avisa el commit; T9 cierra con los docs en un último commit dentro del PR.

## Tasks

- [x] **T1 [S9]** — Ronda Stich: mockup(s) del mixer nuevo en el proyecto Stitch
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
- [x] **T3 [S4]** — backend: selección de vídeo por calidad+compresión
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
- [x] **T4 [S2]** — backend+settings: orden de audio ca→en→ru→cat con normalización
  ISO 639-2 (`spa`/`es`, `eng`/`en`, `rus`/`ru`, `cat`/`ca`), check de idiomas exigidos
  sobre la unión A+B, clave `mixer.languages` en settings (de fábrica: castellano
  exigido). Tests RED→GREEN. Ruta: `backend/media_mixer.py`, settings, tests backend.
  Commit: —.
  - [x] Evidencia (2026-10-18): RED observado **19 failed / 72 passed** —
    `AttributeError: module 'media_mixer' has no attribute 'normalize_language'`
    (15 tests nuevos de tests_mixer.py: normalize/order_and_mark/check_required),
    `KeyError: 'language_check'` (2 de probe), `200 == 409` (mux sin gate) y
    `None == ['spa']` (settings sin sección `mixer`); los otros 2 tests nuevos ya
    pasaban en RED (pines de la unión A+B y del override en settings.json).
    Implementado: `normalize_language` (solo los 4 idiomas mapean a canónico, el
    resto pasa lowercased), `ORDERED_AUDIO_LANGUAGES=("spa","eng","rus","cat")`,
    `order_and_mark_audio` (lenguaje > archivo A antes que B > bitrate desc;
    primera entrada de cada idioma ordenado = «automática», resto a elegir),
    `check_required_languages` sobre la unión A+B, DEFAULTS
    `mixer.required_languages=["spa"]` (L9), `_required_languages()` que fuerza
    `spa` primero (L3), `language_check` + `audio_ordered` en `/probe` (contrato
    aditivo) y gate en `/mux` tras fps/duración: 409 body
    `{"error": "missing_required_language", "missing": ["spa"], "required": ["spa"]}`
    antes de `start_mux`. **GREEN 91/91 tocados; suite completa 1162/1162**
    (base 1141 + 21 tests nuevos; nada borrado ni debilitado). **Deuda legacy:
    techo 2782 → 2869** (+87 en `media_mixer.py`) con comentario `#:` de ownership
    en `tests/contracts/tests_architecture.py` y disclosure en la PR de cierre.
- [x] **T5 [S6,S8]** — backend: probe parsea streams de subtítulo (codec, idioma,
  texto vs bitmap); extracción a `.srt` sidecar junto a la salida para texto
  (subrip/ass/webvtt); bitmap (PGS/VobSub) marcado «no extraíble sin OCR»; el mux sigue
  sin mapear subtítulos al contenedor (S8). Tests RED→GREEN. Ruta: `backend/media_mixer.py`,
  `backend/interfaces/http/routes_mixer.py`, tests. Commit: —.
  - Evidencia (2026-10-18): RED observado **18 failed / 82 passed** —
    `KeyError: 'subtitle_tracks'` (parse ignora subs), `AttributeError` de
    `build_subtitle_extract_command`/`subtitle_sidecar_path`, `TypeError: start_mux()
    got an unexpected keyword argument 'subtitle_plan'` + `KeyError: 'subtitle_plan'`
    (la ruta no construye plan) y `KeyError: 'subtitles'` en `get_task`. Implementado:
    `subtitle_tracks` en `parse_probe_data` (+ `track_index` ordinal en vídeo/audio/subs,
    L18), `build_subtitle_extract_command`, `subtitle_sidecar_path`, plan en `/mux`
    (unión de idiomas de audio, extraíble preferido entre archivos) y extracción post-mux
    en `start_mux`/`_run_mux_background`. Contrato `task["subtitles"]` (desde la creación,
    expuesto en `GET /api/mixer/tasks/:id`): `{language_code, language, path,
    track_index, codec, extractable, status, detail, sidecar}` con estados
    `pending|extracted|failed|not_extractable|missing|skipped`. **GREEN 100/100 tocados;
    suite completa 1180/1180** (base 1162 + 18 tests nuevos). Deuda legacy:
    techo **2869 → 3016** con `#:` en `tests/contracts/tests_architecture.py`.
    `task_manager.py` sin cambios. Tareas de un solo fichero: sin probe ⇒ plan vacío.
- [x] **T6 [S6]** — backend+frontend: cliente OpenSubtitles + campo API key en
  Configuración; búsqueda/descarga de `.srt` por idioma de audio hacia el sidecar de la
  salida; tests con stub (sin red real). Ruta: backend (infra) + `frontend/src/features/settings/Settings.tsx`
  + tests. Commit: —.
  - Evidencia (2026-10-18): RED observado backend **9 failed / 63 passed** (72 tocados) —
    8 tests nuevos de `TestSubtitleSearchEndpoint` (la ruta no existía: 404 `Not Found` en
    vez de 404 `"Task not found"`/400/200) + `test_the_key_is_stored_as_ciphertext` (clave
    guardada en claro); vitest **3 failed / 581 passed** (campo «Clave API de
    OpenSubtitles» inexistente ×2 + `apiKeyMask` con 3 de 4 campos). Implementado: settings (`DEFAULTS["services"]["opensubtitles"]`, env
    `OPENSUBTITLES_API_KEY` y cifrado en reposo vía `credentials.ENCRYPTED_SECRET_FIELDS`,
    como radarr/sonarr/amutorrent); cliente síncrono `infrastructure/opensubtitles_client.py`
    (`search_subtitles` aplanado por fichero con `limit`, `download_subtitle` gzip→`.srt`,
    stubs con `httpx.MockTransport`, cero red real) con `OpenSubtitlesError` definido en
    `application.ports` (como `CopyCancelled`: la excepción cruza la costura); wiring
    hexagonal `OpenSubtitlesClient` (ports) + delegados `gateways.search_subtitles`/
    `download_subtitle` + bind en `app.py`, cliente parcheado en
    `infrastructure.opensubtitles_client.*` (precedente gateways); y el endpoint
    `POST /api/mixer/tasks/:id/subtitles/search` — 404 `{"detail": "Task not found"}`, 400
    `{"detail": {"error": "opensubtitles_not_configured"}}` antes de buscar, objetivos
    `missing|not_extractable|failed` ∩ filtro `languages`, primer candidato descargado al
    sidecar `<stem>.<sufijo>.srt` de la salida con estado **`downloaded`** (nuevo), sin
    candidato `detail: "not_found"`, `OpenSubtitlesError` por entrada sin frenar el resto
    y guardas `no_output_path`; mutación en la tarea viva (patrón cancel/pause) y red vía
    `asyncio.to_thread`. Cuerpo feliz: `{"ok": true, "results": [{"language": "es",
    "language_code": "spa", "status": "downloaded", "sidecar": "<out>.es.srt"}]}`.
    **GREEN 72/72 tocados; suite completa 1209/1209** (base 1180 + 16 cliente + 5 settings
    + 8 endpoint) y frontend **584/584**, tsc 0, eslint 0 (campo + test nuevo
    `opensubtitlesApiKey.test.tsx`; `apiKeyMask` 3→4 campos — nada borrado ni debilitado).
    `media_mixer.py` intacto: la tarea ya lleva `output_path` cuando hay objetivos
    (se fija al terminar el mux). Deuda legacy: techo **3016 → 3017** (la línea
    `opensubtitles=` del bind en `app.py`) con `#:` en el contrato; disclosure en la PR.
- [x] **T7 [S7]** — backend+frontend: botón «buscar en indexador» en el mixer cuando
  falta un idioma exigido: filename → `arr_movie_lookup` → `ReleaseSearchModal` si está
  en librería, si no aviso con el título. Tests. Ruta: backend (route) +
  `frontend/src/pages/MediaMixer.tsx` + tests. Commit: —.
  - Evidencia (2026-10-18): RED observado backend **14 failed / 42 passed** (56
    tocados) — 6 de `TestTitleFromFilename` (`AttributeError: _title_from_filename`)
    + 8 de `TestLookupEndpoint` (la ruta no existía: `404 Not Found` en vez de
    400/200/502); vitest **4 failed / 1 passed** (5 tocados; el negativo «sin aviso ni
    botón cuando `ok: true`» ya pasaba en RED). Implementado: `_title_from_filename`
    (extensión fuera, `.`/`_` → espacios, corte en el primer tag de release, año
    final `(YYYY)`/` YYYY ` conservado) + `POST /api/mixer/lookup`
    `{"filename": …}` → `{"ok": true, "title": "<derivado>", "movie": {"id",
    "title", "year", "source": "radarr"} | null}` (movie solo si está en la
    librería de Radarr); 400 `"filename is required"` / `"Cannot derive a title
    from: …"`; 502 `"radarr no está configurado (…)"` y `"Radarr lookup failed:
    …"`. **Sin puerto nuevo**: se reutiliza `arr_movie_lookup` + `arr_movie_exists`
    del puerto `ArrClient`/`gateways` (el mismo que `/api/calendar/add`); stubs en
    `interfaces.http.routes_mixer.*` (precedente calendar). Frontend: aviso «Falta
    castellano (exigido) en los dos archivos» + botón «Buscar en el indexador» iff
    `language_check.ok === false`; in-library → `ReleaseSearchModal` sin tocar;
    `movie: null` → «`<title>` no está en la librería — añádela primero en Radarr»;
    502 → la `fm-error` de siempre. **GREEN 1223/1223 backend** (base 1209 + 14) y
    **589/589 vitest** (base 584 + 5), tsc 0, eslint 0; `MAX_LEGACY_LOC=3017`
    intacto (sin tocar `ports.py`/`gateways.py`/`app.py`). Desviación menor: el
    `ProbeResult` del frontend vive en `shared/api/mixer.ts` (fuera de superficie) ⇒
    `MixerLanguageCheck`/`MixerLookup*` en `shared/types.ts` + intersección aditiva
    en `MediaMixer.tsx`; la llamada fetch del lookup va inline en `MediaMixer.tsx`.
- [x] **T8 [S1–S8,S9]** — frontend: port del mockup Stich a `MediaMixer.tsx`/`MediaMixer.css`
  (badge que bloquea `canMux`, lista de audio ordenada con automático+manual, panel de
  subtítulos con estado extraído/buscado/no-extraíble, botón indexador). Tests
  RED→GREEN + checks. Commit: —.
  - [x] Evidencia (2026-10-18): RED observado **27 failed / 584 passed** (611
    tocados) — 15 nuevos de `mixerRedesign.test.tsx` + 7 de
    `mixerSubtitlePanel.test.tsx` + los 5 de `mixerIndexerLookup.test.tsx` (T7),
    que en RED fallan por los renames de copy que fuerza el port («Browse»→
    «Examinar…», «Probe Files»→«Cotejar archivos», «← Back»→«Cancelar»: el mockup
    trae «Examinar…» y la action row «Cancelar»/«Mezclar»). Implementado el port
    de las pantallas 10/11/12 con los tokens de `prototypes/DESIGN.md`: cotejo
    A|B + strip de compatibilidad (verde con valores / rojo «No compatible» con
    `fps: A … | B …` y `duración … (Δ …)` desde `compatibility.warnings`) que
    bloquea `canMux` junto con `language_check.ok` («Mezclar» con `disabled`
    real), 409 de `/mux` con `detail.error` superficiado (badge rojo +
    `fm-error`), panel de vídeo con `best_video` (puede nombrar a B; chip «Auto ·
    mejor compresión»), audio MERGEADO en el orden entregado (4 automáticas +
    resto a elegir, nº = orden de salida), panel de subtítulos (Extraído+sidecar
    / OpenSubtitles / Buscando… / No extraíble (bitmap PGS) derivado de `detail`
    / No encontrado / candidatos del probe sin tarea) con «Buscar subtítulos»
    (`languages` de 3 letras → refresh de la tarea), y aviso de idioma con chip
    «Bloqueante» + lookup de T7 intacto. **L18 fijado**: `video_source` y
    `audio_sources` = `{path, track_index}` ORDINAL (posición en
    `video_tracks`/`audio_ordered[].track_index`), nunca `track.index` absoluto —
    pin con assert exacto de payload (fixture con `index` absoluto 5/3 ≠
    ordinal 1/1). **GREEN 611/611 vitest** (base 589 + 22 nuevos), tsc 0,
    eslint 0; backend **1223/1223** y `git status --short backend/` limpio.
    Tests preexistentes que codificaran la spec vieja (payload `track.index`
    absoluto, auto-selección de `default` por archivo): **no existían** — el
    único mixer con tests era el lookup de T7; sus 5 tests solo se adaptaron a
    los renames de copy (fixtures intactas, comportamiento idéntico). Desviaciones
    del mockup (reportadas): helper «resolución > codec > bitrate» (L15 corrige
    el orden), «Destino:» solo cuando la tarea tiene `output_path` real (regla
    de no inventar datos), chips «Pendiente»/«Sin pista embebida»/«Extraíble»/
    «Omitida» para estados que el mockup no define, y fps/duración en rojo en
    ambas columnas del header (el mockup solo marca B).
- [x] **T9 [S1–S9]** — docs y cierre: BACKLOG (fila del mixer/bloque 🟡) + HANDOFF
  (pendiente 1) + este doc (tasks/espejo); checks finales backend/frontend/tsc/eslint.
  Commit: C8 (docs de cierre, dentro del PR #209).
  - Evidencia (2026-10-18): **BACKLOG no contiene fila propia del mixer** (solo referencias
    incidentales) → sin cambios allí. HANDOFF actualizado: header (specs 1223/611, PR
    #209), bloque «Verde» + tanda #206–#209, pendiente 1 del bloque 🟡 marca el mixer
    como hecho, gotchas nuevos (ratchet hasta 3017, contrato ordinal `track_index`, gate
    de writers `Spec:`), mapa de docs con este feature doc. **PR #209 abierto** con body
    completo: disclosure de deuda 2751→3017, tabla de slices C1–C8, checks (backend
    **1223/1223**, vitest **611/611**, tsc 0, eslint 0), limitaciones conocidas y
    `Risk: item 4` (fase de extracción y búsqueda OpenSubtitles mutan `task["subtitles"]`
    desde corutina y ruta; orden secuencial + escrituras por entrada, sin test de
    concurrencia). Merge `--merge --delete-branch` al estar CI verde (regla del usuario).
- [ ] **T10 [S2]** — enmienda L24 (amarra a L23): marcar pistas `und` como castellano
  para pasar el flag de exigidos. Backend: `MuxRequest.language_overrides`
  (`[{path, track_index, language}]`), validación solo-pista-`und` + idioma en
  `ORDERED_AUDIO_LANGUAGES` (si no → 400 `invalid_language_override`), aplicado al gate
  de exigidos del mux y al `_build_subtitle_plan` (spa cuenta en la unión y genera
  entrada de sidecar). Frontend: botón «Marcar como castellano» (y deshacer) en las
  filas `und`, efectivo en banner/`canMux`/etiquetas de fila y `language_overrides` en el
  payload de mux; la marca se limpia al re-cotejar o reiniciar. RED→GREEN en ambos
  stacks. Commit: —.
  - Evidencia (2026-10-18): RED backend 5/5 (`-k language_override`) y RED frontend 3/16;
    GREEN backend **1228/1228** (5 tests nuevos: gate con override, 400 en no-und /
    idioma desconocido / ruta desconocida / ordinal fuera de rango, y plan con `spa`),
    GREEN frontend **615/615** (4 tests: botón+desbloqueo, payload `language_overrides`
    exacto, ausencia del botón en filas no-und, re-bloqueo al desmarcar), `tsc -b` 0,
    eslint 0. Rama `feat/mixer-und-spanish-mark` → **PR #210** (448 líneas, 1 commit:
    frontera de slice registrada aquí — T10 completo en un solo work unit). Merge
    `430e718` (CI verde, docker-push → deploy).
- [x] **T11 [S10]** — descarga de alternativa desde los slots A/B (RED→GREEN en ambos
  stacks; los workers NO hacen git — los commits son del padre). Contrato exacto:
  **Backend** (nuevo; `/api/mixer/lookup` de T7 NO se toca):
  - `POST /api/mixer/alternatives/lookup {path}` → `200 {ok, title, movie|null,
    audio_languages}`: título con `_title_from_filename` + Radarr siguiendo el patrón T7
    (`movie` solo si está en librería; 400 si falta `path` o ffprobe falla; 502 si Radarr
    caído/no configurado) + `audio_languages` = códigos 3 letras de los audios de
    `probe_file(path)` (en `asyncio.to_thread`), `normalize_language` + orden
    `ORDERED_AUDIO_LANGUAGES`, dedup.
  - `GET /api/mixer/alternatives/status?movie_id=<int>&title=<str>` → `200 {state,
    progress, path, allowed}`, `state ∈ 'ready'|'downloading'|'unknown'`:
    1) **ready** — Radarr tiene el fichero de la película: extender el patrón Arr de
    `application/gateways` + `infrastructure/arr_client` con `arr_movie_file(session,
    service, tmdb_id) -> str | None` (siguiendo el estilo y tests MockTransport
    existentes); `path` = ruta absoluta, `allowed = config.path_is_allowed(path)`,
    `progress = null`;
    2) **downloading** — `application.use_cases.downloads_cache.get_downloads()` sin
    fichero aún: fila cuyo título normalizado con `normalize_title` en **ambos lados**
    (filas puntuadas de release incluidas) contenga el `title` normalizado → `progress`
    de esa fila (null si no se puede saber), `path = null`, `allowed = false`;
    3) **unknown** — sin file ni fila. `movie_id <= 0` o `title` vacío → 400.
  **Frontend**:
  - `shared/api/mixer.ts`: tipos + `alternativeLookup(path)` + `alternativeStatus(movieId, title)`.
  - `ReleaseSearchModal`: prop opcional `onGrabStarted?: (taskId: string) => void`,
    invocado una sola vez cuando el grab devuelve `task_id` (aditivo, con sus tests).
  - `MediaMixer`: en cada slot VACÍO con el otro slot lleno → botón «Buscar y descargar
    alternativa». Click → `alternativeLookup(path del otro slot)` → `movie: null` →
    aviso «añádela primero en Radarr» (patrón T7) → ok → abrir `ReleaseSearchModal` con
    `item` (id/title del lookup + `languages: audio_languages`) y `onGrabStarted` que
    pone el slot en ESPERA: «Descargando… <title>» (+ % si `progress` llega) y botón
    «Dejar de esperar» (abandonar = vuelve al botón inicial; NO se toca nada más).
    Poll `alternativeStatus` (useQuery ~5 s, solo en espera): `ready && allowed` →
    `onSelect(path)` + aviso «Colocado automáticamente: <basename>»; `ready && !allowed`
    → aviso «El fichero quedó en <path> — añade esa carpeta a allowed_roots» (sin
    colocar); `downloading`/`unknown` → sigue la espera (sin timeout automático).
  Tests RED primero: backend (lookup 200/400/502 + `audio_languages` ordenado; status
  ready/downloading/unknown/400) y frontend (botón solo con otro slot lleno y slot
  vacío; espera con `onGrabStarted`; auto-colocado; aviso allowed_roots; «Dejar de
  esperar»; `item.languages` enviado). Suites verdes al final (backend ≥1228+6, vitest
  ≥615+6, `tsc -b` 0, eslint 0). Commit: C2 `8091846` (backend), C3 `3923f3e` (frontend),
  C4 (docs de cierre).
  - Evidencia (2026-10-18): dos workers `gentle-ai-worker` en paralelo (superficies
    disjuntas) con RED observado por cada uno — backend 31 tests (10 lookup + 11 status
    + 10 `arr_movie_file`), frontend 11 (8 flujo de slots + 3 `onGrabStarted`; RED 10) —
    más el fix del padre con su propio RED (fila de release punteada → `normalize_title`
    en **ambos** lados; contrato T11 enmendado aquí). Suites: backend **1261/1261**
    (base 1228 + 31 propios + 1 fix + 1 del sweep GET preexistente que ya parametriza
    `/alternatives/status`), frontend **626/626**, `tsc -b` 0, eslint 0.
    Interpretaciones registradas en el PR body: `movie_id` = id interno de Radarr
    (acepta también tmdbId); probe→400 (manda el contrato); `ready && !allowed` mantiene
    la espera; `progress` 0–100. **PR #211** — slices C2 ~650 / C3 ~600 líneas
    (frontera de slice registrada aquí: backend y frontend por separado).
- [x] **T12 [S11]** — backend: cola serie (encolado FIFO con estado `queued`,
  una mezcla a la vez, cancel de `queued` sin ejecutar), progreso real (el
  parser de ffmpeg lee la salida por la que emite de verdad — RED primero,
  con el test existente de stderr como regresión que hay que mover), destino
  `destination_path` fail-closed 400 `invalid_destination` + sustitución
  atómica (temporal en la misma carpeta → rename solo tras éxito, último paso
  tras subtítulos). RED→GREEN; los workers NO hacen git — los commits son del
  padre. Criterios S11-1,3,4,5.
  - Evidencia (2026-10-18): worker `gentle-ai-worker` con **STOP inicial** correcto
    (ratchet `MAX_LEGACY_LOC=3017` a headroom 0; desbloqueo del padre = opción 1:
    surfaces + techo al mínimo medido con `#:`) — RED observado **17 failed / 1265
    passed** (bug vivo `assert 0.5 in [1.0]`, TypeError `destination_path`, cola
    `running×3`, orden de lista, cancel de `queued`) → GREEN **1282/1282** (base
    1261 + 21, cero regresiones); techo final **3218** (media_mixer 760→957,
    task_manager 133→137, disclosure en PR #212). Interpretación de pausa aprobada
    (pausa conserva el slot, reanudar relanza, cancelar pausada libera el slot).
    `assess` con `escalate item 1` → plan self-verification + verificador
    independiente; el lanzamiento del verificador fue **rechazado por gate** (tarea
    sin línea `Risk:` → orden de verificar inline, sin reintentar) → **verificador
    no disponible** reportado; self-verification del padre = spot-check de los hunks
    (validación fail-closed previa a los 409, temporal same-dir, `os.replace` solo
    con salida verificable y tras extraer subtítulos) + focused **188 passed** +
    suite completa **1282**. Commits: C1 `442d213` (spec), C2 `c3563aa` (backend,
    slice con Risk item 1 aislado), C4 (docs de cierre). **PR #212**.
- [x] **T13 [S11]** — frontend: selector obligatorio «Carpeta de A»/«Carpeta
  de B» en la barra de acciones («Mezclar» desactivado sin destino; informe de
  la ruta que se sustituye; envía `destination_path`), toast «Enviado a la
  cola», **eliminación** de la sección «Tareas» del mixer, y banda de mezclas
  en **Seguimiento** (junto a `OpsBand`) con orden de cola `queued`, progreso
  real y pausar/cancelar/reanudar. RED→GREEN; los workers NO hacen git — los
  commits son del padre. Criterios S11-1,2,3.
  - Evidencia (2026-10-18): worker `gentle-ai-worker` — RED observado **21 failed /
    43 passed** (selector ausente, «Tareas» presente, toast vacío, banda «Mezclas»
    inexistente) → GREEN **636/636** (base 626 + 10; `tsc -b` 0, `eslint` 0). Copy
    nueva llevada al español por el padre («Sustituirá `<basename>` (carpeta …)»,
    «Aún no hay mezclas») con sus asserts re-pinados, y verificación completa
    re-ejecutada: **636/636 + tsc 0 + eslint 0**. Contrato `destination_path`
    coherente con T12 (ruta exacta del input elegido en el body). Commit: C3
    `bdffa97`.

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
- **L17 (2026-10-18, T4 completada subagent)**: RED observado (19 failed) → GREEN
  **1162/1162** (base 1141 + 21 tests nuevos de T4). En `media_mixer.py`:
  `normalize_language` (solo `spa/eng/rus/cat` y sus códigos cortos `es/en/ru/ca`
  mapean a canónico; `fra→fra`, `fr→fr`, `und→und` pasan lowercased),
  `ORDERED_AUDIO_LANGUAGES=("spa","eng","rus","cat")` fijo (S2),
  `order_and_mark_audio` (rango de idioma > A antes que B > bitrate desc; la
  primera entrada de cada idioma ordenado es la «automática», L6) y
  `check_required_languages` sobre la unión A+B (L3). Settings: DEFAULTS
  `mixer.required_languages=["spa"]` (L9) y la ruta fuerza `spa` el primero
  siempre (L3: «es el minimo») — la config solo puede añadir exigidos.
  `/probe` expone `language_check` + `audio_ordered` (contrato aditivo) y `/mux`
  responde **409**
  `{"error": "missing_required_language", "missing": ["spa"], "required": ["spa"]}`
  antes de arrancar ffmpeg, después del check de fps/duración (S3 «el primer
  check»). Deuda legacy 2782 → **2869** con `#:` en el contrato; disclosure
  obligada en la descripción de la PR de cierre (T9).
- **L18 (2026-10-18, contrato `track_index` — requisito para T8)**: el campo `index` de
  los tracks del probe es el **índice absoluto de stream de ffprobe**, pero
  `build_mux_command` mapea con ordinales (`-map 0:v:N`/`0:a:N`). El frontend actual
  (`MediaMixer.tsx:536-548`) envía `track.index` absoluto ⇒ para audio típico
  (vídeo=0, audio=1) hay un off-by-one preexistente (`a:1` selecciona el segundo audio
  o falla). **Decisión de contrato: `MuxRequest.track_index` = ordinal dentro del tipo
  de stream del fichero** (coherente con `-map` y con `best_video.track_index` de T3).
  T8 debe cambiar el frontend para enviar ordinales (posición en `video_tracks` /
  `audio_tracks`, no `track.index`) y el selector dejar de usar `track.index` como
  valor de selección. Bug preexistente, no introducido por T2-T4 — queda fijado en el
  port del mockup.
- **L19 (2026-10-18, T5 completada subagent)**: RED observado (18 failed) → GREEN
  **1180/1180** (base 1162 + 18 tests nuevos de T5). En `media_mixer.py`:
  `parse_probe_data` construye `subtitle_tracks` (codec, idioma raw +
  `language_code`, `title`/`forced`/`default`, `kind` text|bitmap|unknown y
  `extractable` solo para `TEXT_SUBTITLE_CODECS`) y vídeo/audio/subtítulo llevan
  `track_index` ordinal para `-map v:N/a:N/s:N` (L18, `index` absoluto intacto);
  nuevos `build_subtitle_extract_command` (`ffmpeg -y -i … -map 0:s:N -c:s srt …`,
  re-mux de texto, no transcodifica vídeo — S8) y `subtitle_sidecar_path`
  (`<stem>.<sufijo>.srt` con `spa→es/eng→en/rus→ru/cat→ca`, resto el código
  normalizado). `/mux` construye `subtitle_plan` server-side desde los probes
  (unión de idiomas de audio, orden S2; un track por idioma con extraíble
  preferido entre archivos; bitmap/unknown solo ⇒ queda «no extraíble»; idiomas
  sin pista también tienen entrada para la búsqueda de T6) y
  `start_mux(..., subtitle_plan=)` lo guarda como `task["subtitles"]` desde la
  creación. Tras mux OK se extraen los sidecars: éxito → `extracted` + `sidecar`;
  fallo → `failed` + snippet de stderr en `detail`; sin pista → `missing`;
  bitmap/unknown → `not_extractable` con `detail: "bitmap: <codec>"`; cancelada
  la fase de mux → todo lo pendiente `skipped` y sin extracción. El mux sigue
  mapeando solo vídeo+audio (S8). Un solo fichero ⇒ sin probe ⇒ plan vacío.
  `task_manager.py` sin cambios. Deuda legacy 2869 → **3016** con `#:`;
  disclosure obligada en la descripción de la PR de cierre (T9).
- **L20 (2026-10-18, T6 completada subagent)**: RED observado (9 failed backend + 3
  vitest) → GREEN **1209/1209** backend y **584/584** vitest (tsc 0, eslint 0). El
  vocabulario de `task["subtitles"]` gana el estado **`downloaded`** (junto a
  `pending|extracted|failed|not_extractable|missing|skipped`): el `.srt` encontrado en
  OpenSubtitles se escribe en el MISMO sidecar `<stem>.<sufijo>.srt` junto a la salida.
  `POST /api/mixer/tasks/:id/subtitles/search` busca por idioma para los estados que la
  extracción no pudo dar, toma el primer candidato y sigue aunque una entrada falle
  (`detail` corto por entrada; `not_found` sin candidato). API key en
  `services.opensubtitles.api_key` (Configuración → Servicios, copy del mockup) y
  **cifrada en reposo** como el resto de credenciales
  (`credentials.ENCRYPTED_SECRET_FIELDS`; feature sin estrenar ⇒ sin migración).
  Cliente `infrastructure/opensubtitles_client.py` síncrono (httpx; tests con
  `httpx.MockTransport`, sin red nunca) con `OpenSubtitlesError` declarado en
  `application.ports` — como `CopyCancelled`, la excepción cruza la costura y ni la ruta
  puede importar el adapter ni al revés (arquitectura: interfaces jamás importa
  infrastructure; comprobado con tests de contrato). Wiring: puerto `OpenSubtitlesClient`,
  delegados `search_subtitles`/`download_subtitle` en `gateways` y bind en `app.py`;
  `bind()` acepta `opensubtitles` opcional y si se omite deja el slot como estaba (una
  composición parcial no puede desactivar un adapter ya bindado). La API key nunca viaja
  al CDN del `link` de descarga ni aparece en mensajes de error. Guarda `no_output_path`
  cuando la tarea no tiene salida que nombre el sidecar (detalle, no estado). Deuda
  legacy 3016 → **3017** (línea `opensubtitles=` del bind en `app.py`) con `#:`;
- **L21 (2026-10-18, T7 completada subagent)**: RED observado (14 failed backend + 4
  vitest) → GREEN **1223/1223** backend y **589/589** vitest (tsc 0, eslint 0).
  `POST /api/mixer/lookup` con `{"filename": …}` (el frontend manda el filename del
  archivo A, con fallback al B): `_title_from_filename` deriva el título (corte en
  el primer tag de release — `1080p|2160p|720p|x26[45]|h26[45]|hevc|web-?dl|
  webrip|bluray|bdrip|hdtv|dts|aac|ddp?5?[.\s]?1`, micro-adaptación `[.\s]?` porque
  los `.` ya son espacios cuando se busca el tag — y año final conservado) →
  `arr_movie_lookup` → `arr_movie_exists` por `tmdbId`; `movie` solo con la
  película YA en la librería (shape del item de `ReleaseSearchModal`:
  `{id, title, year, source: "radarr"}`), `movie: null` si no (o si el lookup viene
  vacío), 502 si Radarr no está configurado o el puerto lanza. **Sin puerto nuevo**
  (S7 se engancha al `ArrClient` existente del flujo wanted/calendar) ⇒ sin tocar
  `ports.py`/`gateways.py`/`app.py` ni mover `MAX_LEGACY_LOC=3017`. Frontend:
  `language_check` tipado aditivamente (`MixerLanguageCheck` en `shared/types.ts` —
  el `ProbeResult` vive en `shared/api/mixer.ts`, fuera de superficie de T7 — y
  intersección opcional en `MediaMixer.tsx`), aviso exacto del mockup 12 + botón
  «Buscar en el indexador» que abre `ReleaseSearchModal` sin modificarla, aviso
  inline «<title> no está en la librería — añádela primero en Radarr» con el título
  devuelto por el backend, y errores Radarr en la `fm-error` existente. Riesgo
  conocido: `arr_movie_lookup` (arr_client.py, fuera de superficie) se traga los
  errores de red y devuelve `{}` ⇒ un Radarr caído pero configurado degrada a
  `movie: null` en vez de 502 (el 502 cubre no-configurado y excepciones que suban
  del puerto); corregirlo requiere tocar el adapter en un task futuro.
- **L22 (2026-10-18, T8 completada subagent)**: RED observado **27 failed** (15+7
  tests nuevos + los 5 de T7 adaptados a los renames «Examinar…»/«Cotejar
  archivos»/«Cancelar») → GREEN **611/611 vitest** (base 589 + 22 nuevos), tsc 0,
  eslint 0; backend 1223/1223 sin tocar (`git status --short backend/` limpio).
  Port de las pantallas Stich 10/11/12 a `MediaMixer.tsx`/`MediaMixer.css` con los
  tokens de `prototypes/DESIGN.md`. Contrato **L18 fijado** con assert exacto:
  `video_source`/`audio_sources` = `{path, track_index}` ordinal (fixture con
  `index` absoluto ≠ ordinal para que el pin sea real); `canMux` =
  `compatibility.ok && language_check.ok` + selecciones, con `disabled` real en
  «Mezclar» (mockup 11); 409 de `/mux` con `detail.error` superficiado (badge
  rojo + `fm-error`; `MuxError.conflict` aditivo en `shared/api/mixer.ts`);
  audio mergeado en el orden entregado con las 4 automáticas marcadas; panel de
  subtítulos combinando `subtitle_tracks` del probe con `task["subtitles"]` +
  «Buscar subtítulos» (3 letras → refresh de la tarea); aviso de idioma con
  «Bloqueante» + «Buscar en el indexador» (T7) intacto dentro del layout nuevo.
  Tipos: `shared/types.ts` sin cambios — los adicionales viven en
  `shared/api/mixer.ts` y el workaround `ProbeResultWithChecks` queda eliminado.
  Desviaciones del mockup documentadas en la evidencia de T8 (orden de ranking
  L15, «Destino:» solo con dato real, chips de estados no maquetados, rojo en
  ambas columnas del header).
- **L23 (2026-10-18, T9/cierre)**: PR **#209** creado desde `feat/mixer-redesign`
  (8 commits, ~6006+ líneas): docs → T2+T3 → T4 → T5 → T6 → T7 → T8 → cierre. Toda la
  feature verificada por spot-check del padre en cada tarea: RED observado siempre, suites
  completas en verde en ambos stacks, espejo de Engram `odd/mixer-redesign/tasks`
  actualizado por task transition. Cerrado el bloque 🟡 del Mixer (S9 gate: mockups 10/11/12
  aprobados antes de implementar, L14). Merge: `89b1e2d` (CI completo verde, docker-push
  success → deploy automático; fix intermedio de paridad `tsc -b` en `d1103e3`).
- **L24 (2026-10-18, usuario, enmienda S2 → T10)**: "ok estoy testeando, cuando no
  encuentra el idioma castellano me bloquea eso es bien, pero pasa una cosa hay a veces
  que los idiomas castellano no vienen como spa y vienen como und, deberiamos poder
  marcar las pista und si son las castellanas para poder pasar el flag"
- **L25 (2026-10-18, usuario, requiso S10 → T11)**: "podemos introducir en el flow que
  cuando en una de las dos opciones de examinar el archivo (cuando seleccionamos los dos),
  en una de las opciones busque una alternativa en los indexadores y la descarge? una vez
  descargada la seleccionamos en esa seccion."
- **L26 (2026-10-18, ask → alcance y finalización)**: respuestas: **"Título del otro slot
  (auto)"** (botón solo con el otro slot lleno; título = el de ese archivo) y custom:
  "Lo suyo es que sea automatico, pero tambien tenemos que tener opcion de que si no se
  descarga que hacer, si cancelar y buscarlo en otro indexador."
- **L27 (2026-10-18, ask → cancelar y ruta)**: respuestas: **"Abandonar la espera aquí"**
  (sin endpoint destructivo; la descarga sigue en la cola normal) y **"Aviso si no está
  permitida"** (auto-selección solo si la ruta está en `allowed_roots`; si no, aviso con
  la ruta).
- **L28 (2026-10-18, usuario → filtro por idiomas, S10)**: "huelga decir que esa busqueda
  deberiamos poder hacerla por idiomas si no nos buscaria el mismo que ya tenemos
- **L29 (2026-10-18, usuario, requiso S11 → T12-T13)**: "creo que en el mixer cuando
  le damos a mezclar deberia mandar la tarea a la cola, ahora mismo aparece abajo del
  todo una seccion de tareas, pero que además la barra no se mueve. podrias mirar esto?
  Esto creo que deberia verse tal vez en una seccion en seguimiento y cuando le damos a
  mezclar un toast que diga que se ha enviado a la cola. para cualquier consula puede
  ver el estado en la cola de seguimiento. Tampoco informamos y no dejamos escoger el
  destino del archivo, normalmente deberiamos guardarlo en una de las dos rutas de los
  dos archivos y luego sustituir el que hay (no se si me explico)"
- **L30 (2026-10-18, ask → destino)**: respuesta: **"Selector A/B, sin default"**
  (preview elegido: "Destino: ( ) Carpeta de A  ( ) Carpeta de B   ← obligatorio").
- **L31 (2026-10-18, ask → ver cola)**: respuesta: **"Seguimiento + quitar
  Tareas"** (preview elegido: "Seguimiento ▸ [Mix] Dune 2024 — running 42% ▸
  pausar/cancelar / Mixer: (sin sección Tareas; toast «Enviado a la cola»)").
- **L32 (2026-10-18, ask → semántica de cola)**: respuesta: **"Serie (1 a la
  vez)"** (preview elegido: "cola: [Dune running] → [Blade Runner queued] → …")."
- **L33 (2026-10-18, usuario → feedback sobre PR #212, origen de la feature
  `seguimiento-unificado`)**: "una vez le doy al mezclar pierdo la tarea, no se donde
  visualizarla, además creo que el nuevo diseño del seguimiento es muy malo, crea mucho
  ruido y no puedo ver nada, tendriamos que darle una vuelta. Y habria que permitir marcar
  como completadas de manera manual algunas tareas (estas por detras se han hecho pero se
  quedan bloqueadas)." → nueva feature doc `odd/tasks/seguimiento-unificado.md` (S1–S3 /
  T1–T3); no reabre T12/T13 (S11 cumplida; PR #212 mergeado `4b82be2` con CI de main
  verde, specs 1282/636, ratchet 3218 disclosed).
- **L34 (2026-10-18, ask → dónde están las bloqueadas)**: respuesta:
  **"Operaciones de la derecha"**.
- **L35 (2026-10-18, ask → diseño de Seguimiento)**: respuesta: **"Vista única con
  filtros"** (preview elegido: "Activas (3)  Completadas  Errores / ───── / ● Dune
  Parte Dos 67% [cancelar] / ● mezcla X en cola [pausar] / ● copia Y en curso /
  (completadas ocultas bajo su pestaña)").
- **L36 (2026-10-18, ask → trazabilidad tras Mezclar)**: respuesta: **"Saltar a
  Seguimiento"** (preview elegido: "Al pulsar Mezclar → /seguimiento con «mezcla X»
  destacada en la lista (borde de acento)").
