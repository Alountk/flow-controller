# calendario-directo — búsqueda y grab del calendario sobre fuentes propias

Fuente de verdad de la feature. Specs con citas verbatim del usuario; tareas T# con
commit; Log al final con L1 = petición original literal. Nunca resume ni añade
requisitos no pedidos.

- Estado: EN PLANIFICACIÓN (doc creado antes de la primera escritura de código, ODD paso 5).
- Alcance: `POST /api/calendar/releases` y `POST /api/calendar/grab` (single + lote)
  dejan de pasar por Radarr/Sonarr/Prowlarr para buscar y descargar; usan los
  indexadores del proyecto (Torznab registrado + aMule EC + Prowlarr si está
  configurado) y el despacho directo (qBittorrent nativo / EC).
- Riesgo de contorno: **item 3** (contratos `/api/calendar/releases` y `/api/calendar/grab`
  consumidos por `ReleaseSearchModal` y las páginas de calendario).

## Specs

- **S1 — La búsqueda de releases del calendario consulta NUESTRAS fuentes.**
  `POST /api/calendar/releases` deja de llamar a `arr_fetch_releases` y consulta
  las fuentes directas con el mismo fan-out que `POST /api/indexers/search`
  (indexadores Torznab habilitados + aMule EC + Prowlarr si está configurado),
  con el título del ítem como query. El contrato de la tarea NO cambia: POST
  responde `{ok, task_id, status, detail}` y el polling
  `GET /api/calendar/releases/{task_id}` sigue sirviendo `{"ok": True, **task}`
  con `releases` y `detail`. Las filas llevan sólo lo que las fuentes propias
  realmente tienen (title/name, link, guid, size, seeders cuando existan,
  indexer/source); **nunca se inventan** quality, languages, protocol,
  releaseGroup ni indexerFlags: si la fuente no lo dice, el campo va ausente y
  la UI no lo pinta. Los fallos por fuente se dicen honestamente (mismo
  espíritu que `skipped` de `/api/indexers/search`), y si TODAS fallan la tarea
  termina `status="error"` con `detail` explicativo — nunca `releases: []`
  silencioso. El trigger legado `POST /api/calendar/search` (comando arr, hoy
  muerto en el frontend) NO se toca.

- **S2 — El grab del calendario despacha directo, sin `arr_grab_release`.**
  Tanto el single (`POST /api/calendar/grab` → `run_grab`) como el lote
  (`calendar.py` batch) añaden por forma del enlace, igual que
  `POST /api/indexers/download`: `ed2k://` → EC directa, hash de 32 hex →
  `DOWNLOAD_SEARCH_RESULT` de EC, magnet/http(s) → cliente qBittorrent nativo.
  **No se re-busca el enlace** (`_ec_search_link`/`amutorrent_search_link`
  sobran: la fila ya trae `link`/`guid`). Cada descarga exitosa se registra en
  `own_grabs` con `direct=True`, su `destination`, `quality` y la identidad de
  cliente (para que `traces`+sweep la copie a su destino). El detalle de
  éxito es honesto sobre qué pasa con la importación (quién importa: ver S3;
  qué NO hace el arr: ver mensaje existente de la ruta directa).

- **S3 — Destino y categoría: el arr sólo importa.** Resolución de destino
  SIN cambios (`library` → `None`, explícito, o
  `destination_for_quality(quality, is3d)` + `path_is_allowed`). La categoría
  del add se elige por destino:
  - destino `None` (biblioteca) → **categoría que el arr tiene vigilada en
    qBittorrent, literal por source: `radarr` / `tv-sonarr`** — así
    Radarr/Sonarr importan y organizan como hoy (Step 6 del plan aprobado:
    arrs = mantenimiento de archivos, fuera de búsquedas y grabs). Evidencia
    del literal: el backend ya filtra `?category=radarr` al leer los torrents
    de Radarr (tests de downloads_cache) y copy_engine usa `categoryName: radarr`.
  - destino explícito (4K/3D/fuera de biblioteca) → **categoría `flow`**
    (cliente propio, el arr no lo importa) y la copia la hace el sweep vía
    `own_grabs(direct=True, destination)`.
  El gate `path_is_allowed` sigue vigente; la comprobación de raíces del arr
  (`arr_root_folders`) ya no aplica porque nada pasa por el arr.

- **S4 — El lote fuera de biblioteca deja de estar prohibido.** La negativa
  actual del lote con destino fuera de las raíces del arr existía porque el
  lote «va directa al cliente sin pasar por el arr» era falso entonces; con S2
  ya no pasa por el arr, así que el lote con destino permitido por
  `path_is_allowed` se despacha fila a fila igual que el single. La denegación
  que queda es SÓLO `path_is_allowed`.

- **S5 — La UI pinta filas de fuentes directas.** `ReleaseSearchModal` (flujo
  normal de calendario: `Calendar.tsx`, `Peliculas.tsx`, `Series.tsx`,
  `MediaMixer` S7) renderiza las filas de S1: agrupación por `indexer/source`,
  chips sólo de campos presentes (quality/languages/seeders ausentes = sin
  chip, sin `undefined`), botones de destino (Biblioteca/4K/3D) que mandan
  `destination` explícito para 4K/3D y payload con `link ?? guid` +
  `indexerId` ausente → 0. Se apoya en los precedentes ya aceptados:
  `AlternativeModal` (filas de `/api/indexers/search`) y S6 de
  `alternativa-indexadores` (movieId 0 sin gate).

- **S6 — Fuera de alcance (no se toca):** `wanted.py` (faltantes sigue en
  arr); Prowlarr como fuente del fan-out (su retiro es el Step 5 pendiente);
  el trigger muerto `POST /api/calendar/search`; `remove_queue`/Seguimiento;
  flujos de alternativa y búsqueda en idioma ya entregados; flag de rollback
  `AMULE_EC_DIRECT`.

## Tasks

- **T1 · S1** · rama `feat/calendario-directo` · backend: re-sourcing de
  `/api/calendar/releases` (route + use case + fetcher de fuentes directas +
  mapeo de filas + RED primero) · commit pendiente.
- **T2 · S2-S4** · misma rama · backend: despacho directo del grab (single +
  lote, categorías por destino, `own_grabs(direct=True)`, retiro de
  `arr_grab_release`/raíces en este flujo, RED primero) · commit pendiente.
- **T3 · S5** · misma rama · frontend: `ReleaseSearchModal` acepta y pinta
  filas directas (types + chips condicionales + payload, RED primero) ·
  commit pendiente.
- **T4 · S1-S6** · gates completos (backend/frontend/tsc/eslint/build),
  assess con escalate item 3, PR + CI + merge + Log + espejo + informe ·
  commit pendiente.

## Log

- **L1 (verbatim):** «perfecto, creo que deberiamos ya empezar a utilizar
  nuestros propios indexadores y nuestro buscador de amule en vez de pasar por
  amutorrent o radarr/sonarr.»
- **L2 (decisión del usuario):** pregunta «¿Por dónde empiezo esta conversión a
  fuentes directas?» → eligió **«Calendario → directo (B)»**: *«Búsqueda y grab
  del calendario pasan a nuestros indexadores + aMule EC en vez de
  arr_search/arr_fetch/arr_grab. Es lo que pedís literalmente; toca resolver
  cómo queda Radarr para importar y la puerta de biblioteca.»*
- **L3 (arquitectura, decisión mía para el doc):** «cómo queda Radarr para
  importar» se resuelve con S3 — Radarr/Sonarr importan porque el add en
  biblioteca usa su categoría vigilada (`radarr`/`tv-sonarr`), coherente con el
  Step 6 ya aprobado («Radarr/Sonarr sólo mantenimiento de archivos
  (rename/organize/import), fuera de búsquedas/grabs», Engram 1444). La
  «puerta de biblioteca» ya no es gate: sólo queda `path_is_allowed` (S3/S4).
- **L4 — T1+T2 backend (2026-10-25, implementación):** T1 (S1) RED 10 → GREEN 14
  (5 use case + 9 ruta): `search_sources` extraído de `indexers.py` byte-idéntico y
  compartido, `CalendarReleasesRequest.title` obligatorio tras validación service+type,
  `start_release_search(source, req_type, req_id, *, query, fetcher)` (caen
  session_factory/enrich/service), `_direct_release_fetch` + `_release_row` (NUNCA inventa
  quality/languages/indexerId/leechers/protocol/releaseGroup/indexerFlags; `seeders` sólo si
  la fuente lo dijo; `guid` cae a `link`), todas-las-fuentes-fallan → `status="error"` con
  los motivos, `_enrich_indexer_ids` huérfano eliminado (`_indexers_for` se queda para
  `GET /api/calendar/indexers`). **Ratchet: 3408 → 3409** (+1 `title`, divulgado en el
  comentario del test y para el PR). T2 (S2-S4) RED 5 → GREEN: `dispatch_direct(target,
  category)` extraído de `download_indexer` (byte-idéntico, 27 tests de
  `POST /api/indexers/download` intactos) e inyectado en `start_grab/run_grab` (la capa
  application no importa interfaces); `CalendarGrabRequest.link` +
  `CalendarGrabBatchRequest.links` (alineado a `guids` como `indexerIds`); categoría por
  destino (None → literal `radarr`/`tv-sonarr`; explícito → `flow`) SÓLO en la rama
  qBittorrent (EC conserva su comportamiento); sufijo «— directa: el arr no la verá ni la
  importará» sólo en `flow`; gate único `path_is_allowed`; negativa del lote fuera de
  biblioteca RETIRADA (S4); re-búsqueda del enlace (`_ec_search_link`/`amutorrent_search_link`)
  eliminada (S2); `own_grabs(direct=True)` en todo éxito. **Ratchet: 3409 → 3411** (+2,
  divulgado). **Decisiones registradas:** (a) split `direct` deliberado — payload del task
  `direct=True` SÓLO en el caso `flow` (emparejado con el sufijo; la biblioteca la importa
  el arr) mientras el REGISTRO `own_grabs.direct=True` en todo éxito (S2/S3: el sweep
  necesita `arr_untracked`); (b) `GrabBody.size` queda aceptado-y-no-leído (compat de
  wire); (c) accounting completo de ~59 tests de contrato reescritos/retirados con su
  razón S2-S4 (reporte del worker; `tests_routes.py` con 0 cambios de aserción — sólo el
  seam); (d) **huérfanos divulgados**: `arr_grab_release` y `amutorrent_search_link`
  (+gateways/ports) se quedan SIN caller productivo, sus tests aún los cubren — limpieza
  post-PR; (e) incidente de orden de imports resuelto con import perezoso en el test EC
  (52 tests unrelated re-verdes). Suite: **1642 → 1628 / 0** (neto −14 por tests
  obsoletos retirados con accounting). Verificado por el padre de forma independiente.
  **Slice:** 2546 líneas en 1 commit (`dc3084f`) — supera ~400 → estrategia registrada:
  **PR ÚNICO con divulgación** (misma disposición que L6 de qbit-nativo); fronteras:
  backend T1+T2 = `dc3084f`, frontend T3 = commit siguiente, cierre T4.
- **L5 — T3 frontend (2026-10-25, implementación):** S5 RED 6 runtime + 3 de tipos →
  GREEN: `startCalendarReleaseSearch(source, type, id, title)` (campo
  `ReleaseSearchItem.title` existente — 0 cambios en los 4 openers), `Release` honesto
  (`link`/`source` nuevos, `seeders?`, los 7 campos arr opcionales-con-significado), chips
  sólo de campos presentes (nunca «undefined»), agrupación `r.indexer || r.source`, payload
  con `link ?? guid` + `indexerId`→0, body de grab SIN `quality` cuando la fila no lo trae
  (nunca inventar). **Colisión resuelta con mi autorización (Option 1):** el tipo honesto
  forzó 5 guards behavior-preserving en `releaseFilters.ts` (superficie extendida;
  `releaseFilters.test.ts` intacto). **Regresión diferencial detectada y arreglada (RED
  observado):** el `<select>` de indexador del modal listaba los indexadores de ARR
  (`GET /api/calendar/indexers`) y filtraba `r.indexer === nombre_arr` → con filas
  nuestras NO matcheaba nada; fijo = opciones derivadas de las propias filas (misma
  etiqueta `releaseLabel` que `groupByIndexer`) + test nuevo (falló con
  `['Todos los indexadores', 'aMuTorrent']` → verde seleccionando/deseleccionando).
  Fixtures/asserions reescritos con accounting (chips-presentes, body sin quality, flujo
  de elección re-exprimido al alcanzable). Lote: sin UI de batch → `links` no hizo falta.
  Nota: los episodios envían el TÍTULO DEL EPISODIO (S1: «título del ítem»); si el
  filtro de relevancia ruidoso, ajuste de query fuera de este alcance. Gates:
  vitest **763/92 → 772/95**, tsc 0, eslint 0 — verificados por el padre.
- **L6 — e2e de CI roto por S5 y adaptado (2026-10-25, T4):** el run 40295562604 de
  PR #242 falló sólo en e2e: `flow-release-search.spec.ts:77` esperaba la opción
  «Torznab» PRE-búsqueda (el select listaba los indexadores de Radarr = exactamente
  lo que S5 cambió). Diagnóstico completo: en e2e sólo existía `RADARR_URL` (fan-out
  nuevo = torznab+amule+prowlarr, Radarr ya no es fuente) → search→error y grab sin
  cliente, y el spec fijaba además «Release encolado para descarga» (texto de
  `arr_grab_release`, huérfano desde T2). Fix en inline (el launcher rechazó la
  delegación por unidad sin backstop medido): (a) spec reescrito al contrato S5 —
  **RED observado**: `:81 «3 releases encontrados»` inexistente con el stub viejo;
  (b) `fake-arr` habla ahora `GET /torznab/api` (Atom de `releases.json`, enclosure
  http + `torznab:attr seeders`) y el qB Web API (login `test/test` → 200 "Ok." +
  cookie SID; `torrents/add` → 200 "Ok." registrando `urls`+`category`); (c) sembrado
  vía API — registry con name exacto **«Torznab»** (la etiqueta de la opción/filas) y
  `services.qbit` vía GET→merge→POST (contrato `DEFAULTS["services"]`); (d) step de
  CI `Phase 2 — seed our sources (Torznab registry + qbit service)` insertado entre
  health-check y auth-contract (200/409 idempotente; `jq` preinstalado en
  ubuntu-latest) + `e2e/README.md` (fases, curls verbatim, endpoints nuevos).
  Evidencia GREEN: smoke Atom ✅; seed verificado (indexer id=1 enabled; qbit url
  127.0.0.1:4400/user test); grab local `qbit add … category=radarr` ✅; **paridad-CI
  fase2 (trio) 6/6 en 2.7s con 0×429**. Artefactos locales diagnosticados SIN fix
  (documentados en README): `dashboard-bare` corre en CI fase 1 sin seed (correr
  fases juntas localmente contra instancia sembrada lo rompe) y el fallo inicial de
  `kanban:119` fue rate-limit 429 por apilar RED+fase1+fase2 en una sola app.
  Gates: backend 1628/0, frontend 772/95, tsc 0, eslint 0, `node --check` ✅.
  Superficies: spec+stub (padre, inline); ci.yml+README (worker mvp2pvz9-g-zt2e).
