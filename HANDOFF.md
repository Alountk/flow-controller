# HANDOFF.md — flow-controller · continuidad de sesión

> Última actualización: 2026-10-22 · **PR #220 (conexión directa a aMule por EC)** · RDD global **on** / **clone-local OFF** (razón D, decisión del usuario)
> · specs: **1440 backend** / 673 frontend · main pre-#220 = `6a91b37` · público: próxima sesión + Raul.

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

**Verde**: `main` en `94292bb` (post-#220), run `39838355890` **pass** (backend-tests,
frontend-build, docker-verify, e2e y **docker-push** → deploy + Portainer notificado).
Specs: **1440 backend** / 673 frontend, working tree limpia.

**Tanda 2026-10-17/22 (PRs #206–#218)**:
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
- #213 — **`seguimiento-unificado` T1-T3** (feedback L33 de #212; decisiones L34-L36):
  **(T1)** `POST /api/files/queue/complete/{op_id}` marca `pending/running`→`done` en memoria
  Y fila SQLite (nuevo `history.get_operation`) + botón «Marcar como completada» en filas
  activas y atascadas; **(T2)** Seguimiento pasa de `[sg-board, sg-ops]` 70/30 a **UNA lista**
  con pestañas «Activas (n)»/«Completadas»/«Errores» + contador (trazas+copias+mezclas,
  mapping pinneado por test, contratos DOM/e2e reescritos, keys/polls intactos por `ssePollGate`);
  **(T3)** «Mezclar» aceptado → salto automático a Seguimiento con la fila hoisted + borde de
  acento (`#/seguimiento?highlight=<id>`, lifetime one-shot por visita). RED 6/15/5 observados;
  e2e `kanban-fit` 4/4 **observado en local** con shim nuevo `e2e/docker-compose.local.yml`
  (disclosed + disclosures de flake/rate-limit). Specs 1288/653.
- #214 — **fix bug de producción: «Mux failed» silencioso en el destino sustitutivo**
  (reportado en vivo tras el deploy de #213): `_substitution_temp_path` escribía a
  `.{nombre}.{id}.tmp` sin extensión y sin `-f` ⇒ ffmpeg rc=234 «Unable to choose an
  output format» ⇒ rama muda → «Mux failed» y `output_path: null`. Ahora
  `.{stem}.{id8}.tmp{suffix}` y el fallo es diagnósticable (`detail = "Mux failed
  (ffmpeg rc=N): …"` + log.error/exception; `_finalize_replace` loguea el OSError que
  tragaba). RED 4 observados (unidad + e2e ffmpeg REAL con skipif + bash rc≠0 + caplog),
  test cadena **order-independent** (`output_path` explícito en el body; el seed de env
  a nivel módulo perdía contra imports), suites **1293 backend / 653 frontend**,
  ratchet 3218→**3254** disclosed, contrato de detail de errores actualizado
  (`tests_mixer.py`). Review nativo: grupo 4 lentes **aprobado** (11 hallazgos
  informativos, ninguno bloqueante), autoridad quemada. Commit `9021d97`, merge
  `46a8de7`. Pendiente: retry de la mezcla en prod por el usuario.
- #215 — documentación del fix de #214 (HANDOFF: symptom→fix de «Mux failed», merge
  `7781f57`).
- #216 — **mixer: buscador en el picker + orden de salida de audio** (dos
  decisiones del usuario 2026-10-21): **(a)** input «Buscar carpeta o
  archivo…» en el modal que filtra carpetas y archivos del directorio
  visible (case-insensitive; estados «Sin subcarpetas»/«Sin carpetas»/
  «Sin coincidencias»; la query se limpia al abrir; mismo patrón que
  ScanModal); **(b)** flechas ▲▼ en las pistas marcadas que reordenan el
  payload `audio_sources` (estado por keys con reset en cada cotejo, bordes
  deshabilitados sin wrap, badge 1..n viajando con la fila; patrón
  preventDefault/stopPropagation de los botones «Marcar como castellano»)
  — **sin tocar backend**: `build_mux_command` ya mapeaba `-map` en orden de
  array. RED 4/4 y 2/3 observados; suites **1293 backend / 660 frontend**
  (+7), tsc/eslint 0, sin ratchet. PR único de 520 líneas / 2 commits
  (disclosed). Review nativo 3 lentes **aprobado** (9 hallazgos
  informativos; la admisión del reviewer reliability rechazó 1 payload con
  campo desconocido `severity_minor_note` y se re-ejecutó OK), autoridad
  quemada. Commits `675e036`+`aade27a`, merge `72c74c6`; e2e de main
  flakeó 1× en el build → rerun success.
- #217 — refresco de HANDOFF (tanda #206–#216; gotchas de e2e/CI).
- #218 — **`busqueda-idioma-prowlarr` T1–T6** (decisiones L2–L5 del feature doc):
  diagnóstico en vivo confirmado (Radarr sólo busca Original+English+Translated y
  jamás `alternateTitles` → Arthur 43 releases/0 rusos, Bolt 203/1) y solución por
  **Prowlarr** sólo en la alternativa: servicio `prowlarr` (config/settings/sonda
  `GET /api`), `POST /api/mixer/alternatives/language-search` con `GET /api/v1/search`
  **sin filtro `categories`** (NoNaMe reporta ids 100xxx y clasifica películas como
  TV/Other: con cats «Вольт 2008» 31→0), regla de relevancia (≥1 token no numérico
  ≥3 chars), sección «Búsqueda en idioma» con chips ORIGINAL/RU + input editable
  (sólo el modal de alternativa; los 4 mounts compartidos intactos) y descarga directa
  a qBittorrent vía `amutorrent_add_download` (costura ports/gateways, 502 si el
  servicio no está configurado). Suites **1335 backend / 673 frontend**, ratchet
  3268→**3270** disclosed, PR único de ~2225 líneas (divulgado). Review nativa 3
  lentes **aprobado** (6 hallazgos informativos; la admisión rechazó un payload con
  `severity_note` → STATUS + grupo re-ejecutado), autoridad quemada. Commits
  `2005f6f`+`03e63c7`+`c0d640e`, merge `84826b7`.
- #219 — refresco de HANDOFF (tanda hasta #218, merge `6a91b37`).
- #220 — **`conexion-directa-amule` T1–T6** (Steps 1-2 del plan «conexiones directas»;
  decisiones L3/L7): cliente EC stdlib (`amule_ec_client.py`: framing+tags, auth
  challenge con `AMULE_EC_PASSWORD` = hash md5 usado verbatim, búsqueda start/polls/
  results/stop, cola por hash) **verificado en vivo** (AUTH OK + 149 resultados contra
  el aMule 3.0.1 del usuario — la UI de amuleweb está rota, bug aMule #1556; `amuleapi`
  NO desplegado ⇒ cero infra nueva); seam ports/gateways/adapter con servicio `amule`
  (settings.json→env; 502 «no está configurado» fail-closed; `/api/services/test` no
  sondea EC porque es TCP); `grab_release` → EC por defecto (3 shapes de `guid`
  preservados, `asyncio.to_thread`, refusal con razón compartida); `copy_engine` → EC
  (`fix_category` con `amule_categories()` vía GET_PREFERENCES + binding live de sólo
  lectura verificado por 2 fuentes: 4=`radarr`, 6=`tv-sonarr`; borrado 0x6A completos /
  0x1D resto; `remove_queue` intacto = arr-REST); flag **`AMULE_EC_DIRECT=0`** = rollback
  byte-idéntico (pinnes diferenciales fixture-only, cero aserciones tocadas); SHA1/qbit
  sigue por WS. README + doc actualizados. RED→GREEN por capacidad; suites **1440
  backend / 673 frontend**, tsc/eslint 0, ratchet **3270→3292→3408** (+138 disclosed).
  PR único ~3715 líneas / 7 commits (divulgado). **Review nativa: 6 capturas rechazadas**
  («complete distinct current reviewer group» y «missing or stale» — bindings byte-idénticos
  a STATUS, incluso en transacción fresca tras abandon; el recordatorio del controller citaba
  otro target `14c45a43` ≠ `b4da832a` de la lineage) → decisión del usuario: abandon
  `operator_disposition` + **RDD clone-local OFF (D)** → merge por política ordinaria.
  Commits `e1ccec4`+`821a6fd`+`9122b96`+`aa99ed1`+`29b87a8`+`4ab904d`, merge `94292bb`.
  Feature doc: `odd/tasks/conexion-directa-amule.md` (S1–S7, T1–T6, Log L1–L8).

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

**RDD**: `gentle-ai review mode status` → global **on**, **clone-local OFF** (razón D;
la activa `gentle-ai review mode enable --scope clone`). La review nativa operó en
#214/#216/#218 (approved + autoridad quemada; #218: assess `nativeRisk medium`, 23
paths/2225 líneas, 3 lentes). En **#220 quedó atascada en collect**: 6 capturas
rechazadas (ver gotcha) → abandon + fallback autorizado del usuario → merge ordinario.
Gate: assess antes de reportar completo, capturas sólo con bindings del proveedor
(STATUS fresco antes de cada una) y verificación por tier.

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
- **Gate (RDD on global)**: `gentle_review assess` antes de reportar completo → sigue el
  plan que devuelva (review nativa operativa; último ciclo #218). Si el plan pide verifier,
  no degradar. TDD RED→GREEN obligatorio (RED observado antes de implementar); e2e de CI = gate.
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
5. **Plan «conexiones directas» — Steps 3-6** (L3/L7 de `conexion-directa-amule.md`):
   Step 3 cliente Torznab (`t=caps`/`search`/`movie|tvsearch`, parseo RSS) · Step 4 MVP
   **sección «Indexadores»** (CRUD SQLite `indexers` + caja de búsqueda unificada
   **Torznab + aMule + Prowlarr** reutilizando `ReleaseSearchModal`) · Step 5 Prowlarr:
   importar sus 13 indexadores como directos, re-cablear la búsqueda por idioma (#218) y
   retirarlo · Step 6 Radarr/Sonarr sólo archivos (ahí entra `remove_queue`).

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
  dated y owned en el PR (2578→2730→2750→2751→2782→2869→3016→3017→3218→3254→3270→3292→3408 hecho; entradas
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
- **Watcher de CI con `gh … --jq -e '…'` nunca termina**: `--jq` de `gh` no admite flags
  jq (`-e`) y la invocación falla al instante (`accepts at most 1 arg(s), received 2`),
  pero el `until` + `sleep 25` del bucle lo disfraza de espera infinita (job-11 «colgado»
  27 min con el run ya success). Forma correcta: `gh run watch <id> --exit-status` o
  comparar `--jq '.conclusion'` con grep, con `timeout` por invocación. Ante un watcher
  eterno: log del job + `ps` primero, no sospechar de la red.
- **Capturas de review rechazadas en bucle (#220)**: 6 intentos con bindings byte-idénticos
  al STATUS (`capture-group-rejected: must be the complete distinct current reviewer group`
  y `capture-binding-rejected: missing or stale`) en 4 formas (grupo strings/objetos/wrapper,
  slot singular) e incluso en una transacción NUEVA tras `abandon`. Tras 2 rechazos seguidos:
  NO iterar formas → decisión humana («review nueva» o D). El recordatorio del controller
  citaba target `14c45a43` mientras lineage/inspect decían `b4da832a` (desalineación no
  resoluble desde el modelo).
- **`subagent_run` task-mode = espera sin salida propia**: un worker cancelado con
  «The tool call was aborted» NO está colgado — `subagent_list_tasks` (turns/calls crecientes
  = vivo) + `ps` + `git status` primero (Engram 1446); exigir `timeout 30` por fetch externo
  en los task texts para que ninguna red parezca un cuelgue.
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
- `odd/tasks/busqueda-idioma-prowlarr.md` — búsqueda por idioma en la alternativa:
  specs S1–S7, tareas T1–T6, Log L1–L5 (decisiones de usuario y contrato Prowlarr).
- `odd/tasks/conexion-directa-amule.md` — **conexión directa EC a aMule**: specs S1–S7,
  tareas T1–T6, Log L1–L8 (decisiones, corrección de tipos EC, ratchet, gotcha de capturas).
- `prototypes/DESIGN.md` — handoff original de Stitch (tokens C-06 + briefs).
