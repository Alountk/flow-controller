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
