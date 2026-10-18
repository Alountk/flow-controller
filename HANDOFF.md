# HANDOFF.md — flow-controller · continuidad de sesión

> Última actualización: 2026-10-18 · **PR #212 (S11 cola/progreso/destino)** · RDD **on** (global)
> · specs: 1282 backend / 636 frontend · main pre-#212 = `ce08db5` · público: próxima sesión + Raul.

## Estado actual

**Desplegado en producción**: la instancia del usuario corre hasta `56bd09d` (6 PRs del
2026-10-11/12: #193 timeout · #194 async grab · #195 SSE · #196 B1 · #197 B2) con NPM
proxyando `/api/events` (bloque location copiado en `routes/events.py` docstring). Usuario
validó en vivo: eventos llegan y disparan la UI.

**Deploy = automático**: cada merge a main publica `ghcr.io/alountk/flow-controller:latest`
(+ tag `sha-XXXX`) en el job `docker-push` y notifica a Portainer por webhook (HTTP 204);
el stack redeploya solo. **Verificado en vivo por el usuario 2026-10-17**: corre los cambios
recientes sin intervención. Si un deploy se pierde: `docker compose -f
docker-compose.deploy.yml pull && up -d` (o redeploy manual en Portainer).

**Verde**: `main` en `ce08db5` (pre-#212), CI (GitGuardian/backend/frontend/e2e/docker)
pass. Tras #212: specs 1282 backend / 636 frontend, working tree limpia.

**Tanda 2026-10-17/18 (PRs #206–#212)**:
- #206 — refresco de HANDOFF (tanda #198–#205, backstop de contexto, gotchas).
- #207 — corrección del HANDOFF sobre deploy: **es automático** (webhook Portainer 204
  verificado en vivo).
- #208 — **C-06 cerrado**: revisión visual del dark mode aprobada (mediciones Playwright
  AA: `--text-dim` 5.24–5.58:1).
- #209 — **redesign del Mixer** (feat/mixer-redesign, specs S1–S9 + gate de mockups S9
  aprobado): cotejo fps/duración con `ok:false` + **409** antes de ffmpeg; ranking de
  vídeo A/B (`resolución > codec > bitrate`, `best_video` en el probe); audio fusionado
  ca→en→ru→cat con «4 automáticas» e idiomas exigidos (`mixer.required_languages`, de
  fábrica solo castellano, unión A+B); subtítulos `.srt` extraídos a sidecars tras el mux
  + OpenSubtitles (`POST /tasks/{id}/subtitles/search`, API key **cifrada en reposo**);
  lookup al indexador con `ReleaseSearchModal`; port de las pantallas Stitch 10/11/12 a
  `MediaMixer` con badge bloqueante y panel de subtítulos. Deuda legacy 2751→3017→3218
  (`MAX_LEGACY_LOC`, disclosure en el PR). Feature doc: `odd/tasks/mixer-redesign.md`.
- #210 — **enmienda L24/T10**: las pistas de audio `und` reales pueden **marcarse como
  castellano** en la lista («Marcar como castellano»/«Quitar marca») para pasar el flag
  de exigidos: `MuxRequest.language_overrides` con validación fail-closed (solo targets
  `und`, idiomas ordenados, rutas cotejadas, ordinales en rango → si no, 400
  `invalid_language_override`) aplicado al gate y al plan de subtítulos. Specs 1228/615.
- #211 — **S10/T11 descarga de alternativa**: el slot vacío (con el otro slot lleno)
  busca en los indexadores una alternativa del archivo del otro slot y la auto-coloca al
  terminar: `POST /api/mixer/alternatives/lookup` (título T7 + `audio_languages`) +
  `GET /api/mixer/alternatives/status` (`ready|downloading|unknown`; gateway
  `arr_movie_file`, fila de downloads con `normalize_title` en ambos lados,
  `path_is_allowed`), prop aditivo `onGrabStarted` del `ReleaseSearchModal`, espera con
  poll ~5 s, aviso si la ruta no está en allowed_roots (L27), «Dejar de esperar» sin
  endpoint destructivo (L27), `item.languages` → chips de idioma existentes (L28).
  Specs 1261/626.
- #212 — **S11/T12-T13 cola, progreso real y destino sustitutivo**: «Mezclar» →
  cola serie (`queued` FIFO, una a la vez, cancel de queued sin ejecutar), selector
  obligatorio «Carpeta de A»/«Carpeta de B» con `destination_path` fail-closed
  (400 `invalid_destination` previo a los 409) y **sustitución atómica** del original
  (temporal same-dir → `os.replace` solo con salida verificable, como último paso
  tras subtítulos), progreso leído del **stdout** real de ffmpeg (bug: se leía
  stderr), toast «Enviado a la cola», sección «Tareas» del mixer **fuera**, banda
  «Mezclas» en **Seguimiento** (`.sg-ops`). Ratchet **3017→3218** (`#:` disclosure).
  Verificador independiente no disponible (gate: sin Risk en la tarea; self-
  verification inline: spot-check + focused 188 + suite 1282). Specs 1282/636.

**Tanda 2026-10-16 (8 merges, PRs #198–#205)**:
- #198/#199/#200 — puertos design-01 dashboard y design-03 Películas (chips, cards,
  incidentes, mapper, contador, escala de cards, un solo título de página).
- #201 — tabla *Actividad reciente* (GET /api/activity + Stitch 01 §3).
- #202 — .gitignore de ruido + alta de B-12 en BACKLOG.
- #203 — **árbol Series** (feat/stitch-series-tree, specs S1–S5): serie→temporada→episodio
  reemplaza la lista de cards, pastillas de cola cruzadas honestas (S4/S5), nodo compacto
  sin card/ruta (S2). Feature doc: `odd/tasks/stitch-series-tree.md` (Log L7–L9 incluye
  la frontera de slice y la decisión de entrega single-PR).
- #204 — npm audit: `source-map-js` 1.2.1→1.2.2 (lockfile), 0 vulnerabilities.
- #205 — **B-12 resuelto**: guarda de petición en vuelo en el botón Actualizar.

**RDD**: `gentle-ai review mode status` → global **on**, clone-local unset. El binario
nativo de review no está en este entorno (`package-local-binary-missing` → assess devuelve
`nativeRisk: unassessable` y plan `writerSelfVerification`) — el gate es igual: assess antes
de reportar completo, verificación del writer + spot-check del padre.

**Stitch**: proyecto `FlowController — Diseños` (`projects/4305330220058954866`) con design
system "FlowController" (`assets/5781956853225900110`) + 9 pantallas numeradas 01–09
(ids en `odd/tasks/stitch-*.md` de la sesión 2026-10-11). Sirven como fuente de diseño para
ports futuros; los ids y nombres están en los feature docs.

## Patrones no negociables (aprobados en esta saga)

- **Grab = task**: `POST /api/calendar/grab` devuelve `task_id` (refusals síncronas sin
  task_id). Worker en `application/use_cases/grab_release.py`. No reintroducir trabajo lento
  (ED2K ~30-60s) en la request HTTP — nginx corta a ~60s.
- **SSE**: `GET /api/events` (auth por `?key=` via `key_matches`), wire `event: <kind>` +
  `data: {json}`, heartbeat `: ping` /15s. Publicadores: TaskManager (transiciones
  done/error, con `channel`), `check_all` (status, en finally), `get_traces` (trace, tras
  refresh real), downloads poller. `subscriber_count()` gasta el refresher de traces.
- **Polls**: apagados con `connected ? false : interval` (EventStreamContext, default
  disconnected = fallback). **NO** apagar sin cubrir por evento: `['queue']` 2/10s
  (`/api/queue`), `['actions']` 60s, `DiskSpace` 30s quedan; `actions`/`queue` no tienen
  publisher (candidatos a B3 si se quiere).
- **trace_cache**: refresh lectura-driven, 9 HTTP + SQLite por build, `TRACE_TTL=10` →
  nunca cadencias <10s. El refresher backend existe (`trace_refresher`, lifespan).
- **Honestidad de datos**: la app no muestra speed/ETA/% que no conoce — pinned por tests,
  también en mockups/diseños.
- **Sidebar/nav de diseño**: solo Seguimiento con badge numérico (rojo, bloqueadas).
- **Queries abortables**: `fetchJson(url, init?)` propaga `RequestInit` a `apiFetch`; toda
  `queryFn` que pueda cancelarse entrega `({ signal })` (B-12: contract activityAbort.test).

## Entorno local (repro/diagnóstico)

```bash
# backend (settings.json con prioridad > .env; sembrado en config/)
set -a; source .env.local; set +a          # load_dotenv() NO lee .env.local
CONFIG_DIR=$PWD/config PYTHONPATH=$PWD/backend \
  .venv/bin/python -m uvicorn app:app --app-dir backend --port 8000
# frontend
cd frontend && ./node_modules/.bin/vite --host   # proxy /api → :8000
```
- `.env.local:32` requiere comillas (requoteada en sesión). API key = `API_KEY` de ese fichero.
- `.local-config` no existe: se usa `config/` (gitignored).
- Venv en la RAÍZ: `../.venv/bin/python -m pytest` desde `backend/`.

## Reglas de trabajo (usuario)

- **Delivery**: 1 rama = 1 PR → main, merge `--merge` + `--delete-branch`, **single PR
  aunque >400 líneas** (decisión explícita repetida), merge al estar CI verde sin preguntar.
  PR bodies vía `--body-file` (zsh se come backticks); prosa en español, código en inglés;
  todo PR cierra con `Risk: item N`.
- **Gate (RDD on global)**: `gentle_review assess` antes de reportar completo → plan
  (hoy: writerSelfVerification, binario native ausente). Si el plan pide verifier, no
  degradar. TDD RED→GREEN obligatorio (RED observado antes de implementar); e2e de CI = gate.
- Writers `gentle-ai-worker`: **no ejecutan git** (reportan `partial` si toca commitear) →
  el padre commitea. Handoff de writer con heading `## Allowed edit surfaces` (rutas
  exactas, una por línea) + rediseño TDD ya cerrado para que solo ejecute.
- Runner frontend **nunca `npm`** (alias pnpm): `./node_modules/.bin/{vitest,tsc,eslint}`.
- **Backstop de contexto (150k)**: delegar la siguiente unidad acotada (sus reads, edits y
  checks) al worker con handoff autocontenido; ediciones sueltas pequeñas quedan inline.

## Pendientes (orden sugerido)

1. **Bloque 🟡 de diseño — resto** — ya hecho: árbol Series + estados de cola (S1–S5, PR
   #203) y el **redesign del Mixer** (S1–S9, PR #209 — cotejo bloqueante, audio por
   idiomas, subtítulos externos + OpenSubtitles, lookup al indexador, port Stitch 10/11/12).
   Quedan, con decisión de usuario antes de tocar: tabla densa Archivos (choca con
   dual-pane), secciones Calidad/Avisos (no existen en backend = feature nueva), y
   3 namings donde la recomendación es NO cambiar
   ("Archivos"≠"Ficheros", chips F-07 backend-owned, 8 dots de Setup).
2. Backlog menores: C-01 canal de avisos, dedupe `formatBytes` (3 copias), dark/light toggle,
   un-ack `Descartar bloqueo`, knobs rate limit, fila C-08, F-06(b) GPL. (B-12 y audit:
   cerrados 2026-10-16; **C-06 cerrado 2026-10-17** — revisión visual del dark de #191
   aprobada, verificada con Playwright: `--text-dim` 5.24–5.58:1 en 34 elementos, AA.)
3. Posibles B3: publishers para `/api/queue` y `/api/actions` (apagar 2/10s y 60s);
   query key de `/api/downloads` si la vista de descargas vuelve (hoy: 0 consumidores
   frontend — decisión de producto del BACKLOG:737).
4. Operaciones: health de Radarr sigue con `RemotePathMappingCheck` (qBittorrent-novpn) y
   carpeta de colección ausente — no es del código, revisar en su Radarr.

## Gotchas que costaron esta sesión

- **jsdom dispara `click` en botones `disabled`** (`fireEvent.click` no respeta disabled) →
  la guarda de un botón en vuelo va en el handler (`onClick={inFlight ? undefined : fn}`),
  no solo en el atributo (B-12).
- **`invalidateQueries` cancela su espera (`cancelRefetch: true`) pero no la red**: si la
  `queryFn` no lee `({ signal })`, la petición vieja sigue viva en el backend. Pinned por
  contract test (`activityAbort.test.tsx`).
- **Stitch MCP en OpenCode roto**: tools con parámetro objeto → "invalid argument";
  `generate` timeout a ~60s. Solución: JSON-RPC directo `https://stitch.googleapis.com/mcp`
  + `STITCH_API_KEY` (script temporal `stitch_mcp.py`, 900s). `edit_screens` NO edita in
  situ; HTML de `get_screen` cacheado → verificar por captura (recorte PIL).
- **Radarr**: valida conexión al guardar indexador (cuelga ~200s → 400 si la IP no es
  alcanzable desde SU host); circuito "All indexers unavailable" **no se autocura** →
  toggle enable/disable del indexador. `PUT` idéntico = 202 instantáneo (sonda barata).
- **`str(TimeoutError())` = ""** → mensajes "TimeoutError: " vacíos; usar el helper
  `_empty_answer_detail` (arr_client.py).
- **TestClient de Starlette mata workers fire-and-forget** → `post_grab_and_settle`
  (`backend/tests/_stubs.py`, httpx ASGITransport en un loop).
- **Ratchet `MAX_LEGACY_LOC`** (`tests/contracts/tests_architecture.py`): event_bus/app.py
  y `media_mixer.py` son legacy; cualquier línea nueva exige subir el máximo CON comentario
  dated y owned en el PR (2578→2730→2750→2751→2782→2869→3016→3017→3218 hecho; entradas
  `#:`). **Headroom 0**: a tope, cualquier fix legado exige subir el techo en la misma
  PR (STOP del worker T12 → opción 1 del padre: surfaces + mínimo medido).
- **`track_index` del mux = ORDINAL** (posición en `video_tracks`/`audio_tracks` para
  `-map 0:v:N/a:N`), NO `track.index` (índice absoluto de ffprobe). El frontend viejo
  enviaba el absoluto ⇒ off-by-one preexistente en audio; corregido y fijado con asserts
  de payload en #209 (feature doc L18). `POST /tasks/{id}/subtitles/search` filtra por
  `language_code` de 3 letras ("spa"), no por código corto ("es").
- **Gate de writers**: la tarea delegada DEBE empezar con el literal
  `Spec: odd/tasks/<feature>.md, T<n>`; sin él el runtime rechaza el lanzamiento (y sin
  feature doc, ejecutar inline). T2–T3 de mixer cayeron así a inline.
- **CI corre `tsc -b` (build mode, incluye `__tests__`)** — el `tsc` plano local pasa sin
  type-checkear los tests y `vitest`/`eslint` tampoco lo hacen → un error de tipos en un
  test solo revienta en `frontend-build`. Chequear local con `./node_modules/.bin/tsc -b`.
  Caso #209: captura `let x: F|null = null` asignada solo en un closure ⇒ CFA la estrecha
  a `null` en el guard y el call queda `never` (TS2349) → holder de objeto
  (`const armed: {fire?: () => void}`).
- zsh se come backticks en `gh pr create --body` → siempre `--body-file`.
- Engram: si `mem_save` falla con "multiple active runtime sessions" → `engram doctor
  --json` y `mem_session_end` de la sesión runtime zombie (funcionó: `ses_ee284984...`).
  Los feature docs viven en el espejo de Engram (p. ej. `odd/stitch-series-tree/tasks`,
  obs 1404) — actualizar espejo al marcar tareas COMPLETADAS.
- Baselines de test: si un writer discute el baseline, creerle y recalcular (míos hoy:
  1113→1130 backend, 529→582 frontend durante la saga).

## Mapa de docs

- `BACKLOG.md` — tabla C/F con estado real (reconciliado 2026-10-11; B-12 ✅ 2026-10-16).
- `odd/tasks/sse-poll-off.md` — inventario completo de polls + reglas B1/B2.
- `odd/tasks/async-grab.md`, `sse-events.md` — contratos del grab async y del bus.
- `odd/tasks/stitch-*.md` (9) — puertos de diseño con evidencia; `stitch-series-tree.md`
  incluye specs S1–S5 y el Log de entrega (T1–T5).
- `odd/tasks/mixer-redesign.md` — **redesign del Mixer completo**: specs S1–S9, tareas
  T1–T9, Log L1–L23 (decisiones verbatim, aprobación de mockups L14, contrato ordinal L18,
  evidencia por tarea y fronteras de slice C1–C8).
- `prototypes/DESIGN.md` — handoff original de Stitch (tokens C-06 + briefs).
