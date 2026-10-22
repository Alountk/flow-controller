# Feature: indexadores-directos — Steps 3-4 del plan «conexiones directas»

Cliente Torznab propio + nueva sección «Indexadores» (CRUD SQLite con test `t=caps`) + caja de búsqueda unificada (**Torznab + aMule + Prowlarr**, alcance L3) con grab por el flujo ya existente.
Steps 5-6 (importar/retirar Prowlarr; Radarr/Sonarr sólo archivos, incluido `remove_queue`) quedan para una feature posterior con su propio documento.

## Specs

S1: Cliente Torznab — `backend/infrastructure/torznab_client.py` siguiendo el molde de `prowlarr_client.py` en sus aspectos de transporte: `url` y `api_key` llegan como **argumentos** de cada llamada (salen de las filas de la tabla `indexers` — no hay un servicio único que `find_service`; la ausencia/fuente-caída se gestiona en S3/S4), seam `session` (`state.http_session()` por defecto), errores `aiohttp.ClientError` en no-200/cuerpo inválido, timeout `config.REQUEST_TIMEOUT * 12`, params como mapping percent-encoding (`params=` load-bearing, cf. `prowlarr_client.py:1-48`). Endpoints: **`t=caps`** (autodescubrimiento: capabilities/namespaces del indexador) y **`t=search|movie|tvsearch`** con `q=`, `cat=` (sólo si el indexador lo declara en caps) y `apikey` como query param (precedente real: `arr_client.py:1089-1093` pide `{...}/indexer/amule/api?...&apikey=...`). Parseo **RSS 2.0 con `ElementTree`** (precedente `arr_client.py:1108-1130`): `item/enclosure@url|@length`, `guid`, `title`, `pubDate`, y atributos **`torznab:attr`** (`name="seeders"|"size"|"infohash"`); plantillas (`download`/`infohash`) sin expandir salvo que traigan `magnet:` ya literal. Query shaping = mirror de `_search_query` (`arr_client.py:1028-1046`). Percent-encode UTF-8 (lección #218); nunca `categories` fijas salvo `t=caps` dígalo (ids NoNaMe 100xxx, L-decisiones previas).

S2: Storage — tabla **`indexers`** en el `SCHEMA` de `sqlite_history.py` (`CREATE TABLE IF NOT EXISTS`, `:30-200`; las tablas nuevas no necesitan ALTER, sólo `_apply_migrations` si hubiera columnas nuevas — `:209-239`). Columnas: `id` PK, `name` NOT NULL, `url` NOT NULL, `api_key` TEXT DEFAULT '' (cifrada en reposo con el precedente de credentials **o** enmascarada en respuestas como `routes/settings.py:122-128` — elegir y justificar), `categories` TEXT DEFAULT '', `enabled` INTEGER DEFAULT 1, `created_at`/`updated_at`. **Nunca `config/settings.json`** (decisión L3). Toda escritura bajo el patrón de `sqlite_history` (lock de módulo, degradación graciosa si `_conn is None`).

S3: API CRUD — router nuevo `backend/interfaces/http/routes/indexers.py` con `verify_api_key` (`interfaces/http/deps.py:27-40`): `GET /api/indexers` (lista con api_key enmascarada), `POST /api/indexers` (alta), `PUT /api/indexers/{id}` (editar; api_key vacía en el body = conservar la guardada, precedente `routes/settings.py:84-92`), `DELETE /api/indexers/{id}`, y `POST /api/indexers/{id}/test` que llama `t=caps` contra esa URL/key y responde `{ok, detail|caps}` sin persistir (200 con ok:false en fallo, como el resto del repo). Registro en `app.py` junto a los demás routers. Contratos automáticos: cada GET nuevo se smoke-testea solo (`tests_routes.py:126-141` enumera `app.openapi()["paths"]`) y toda ruta `/api/` debe declarar `x-api-key` (`test_every_data_route_requires_the_api_key :2131`).

S4: Búsqueda unificada — `POST /api/indexers/search` con body `{query, sources?}` (sources = subconjunto de `["torznab","amule","prowlarr"]`; default las tres): consulta **en paralelo** (`asyncio.gather` con `return_exceptions=True`) los indexadores Torznab `enabled` de la tabla, `prowlarr_search` (se existe el servicio) y `gateways.amule_search` (`asyncio.to_thread` — el adapter EC es síncrono), y devuelve `{"results": [{source, indexer?, name, size, seeders?, infohash?/hash?, link, ...}]}` normalizados a un shape único por fila. Fuentes no configuradas/deshabilitadas se omiten con `skipped: [{source, reason}]` — **jamás un `[]` silencioso disfrazado de «sin resultados»** cuando TODAS las fuentes fallaron (devolver `ok:false`+motivo, precedente Prowlarr 502/no-silencio). Filtro de relevancia mínimo ≥1 token no numérico ≥3 chars (regla congelada de #218).

S5: Frontend sección «Indexadores» — en `features/settings/Settings.tsx`, sección nueva siguiendo el patrón standalone de `SharedDirsSection.tsx` (lista + añadir + editar + toggle enabled + botón «Probar» que llama `{id}/test`), módulo API nuevo `frontend/src/shared/api/indexers.ts` con tipos+fetch (molde `shared/api/releases.ts`). Y **caja de búsqueda unificada** reutilizando el combo de fuentes del `ReleaseSearchModal` (`groupByIndexer`/`selectedIndexer`, `ReleaseSearchModal.tsx:31-36,344-355`) sobre el nuevo `POST /api/indexers/search`: pestaña/chips por fuente (torznab/amule/prowlarr) con conteo, estados vacíos honestos («Sin resultados», «Fuente no configurada», «Error: …») y botón de descarga que **reutiliza el flujo de grab existente** (`grabCalendarRelease`/`POST /api/calendar/grab` con `guid` ed2k o magnet — el worker de grab ya resuelve esos shapes directos, `grab_release.py:313-390`; para filas Torznab sin link directo, mostrar el link del indexador y/o magnet si existe). Sin cambios en `grab_release.py`.

S6: Alcance de fuentes — la caja busca en **Torznab + aMule + Prowlarr** a la vez (decisión del usuario, L3); Prowlarr **no se retira** en esta feature (es el Step 5). La búsqueda por idioma de la PR #218 queda intacta.

S7: Verificación — TDD: RED observado antes de cada implementación; suite backend completa verde (base **1440**) con `../.venv/bin/python -m pytest` desde `backend/`; frontend `./node_modules/.bin/{tsc -b,eslint,vitest}` con `tsc`=0 `eslint`=0; ratchet `MAX_LEGACY_LOC` **sólo** sube si este cambio toca un fichero legacy (rutas nuevas no lo son) — si sube, disclosure en el PR. Sin secretos impresos (api_keys de indexadores).

## Tasks

| ID | Specs | Ruta | Commit |
|----|-------|------|--------|
| T1 | S1-S7 | parent — feature doc | (este commit) |
| T2 | S1, S7 | worker — `torznab_client.py`: caps + search + parseo RSS/`torznab:attr`, tests RED→GREEN | pendiente |
| T3 | S2, S3, S7 | worker — tabla `indexers` + CRUD `/api/indexers` + test-caps, tests (smoke+key automáticos) | pendiente |
| T4 | S4, S7 | worker — `POST /api/indexers/search` paralelo (torznab+prowlarr+amule) con skipped/ok-falso honestos, tests | pendiente |
| T5 | S5, S6, S7 | worker — sección «Indexadores» en Settings + `shared/api/indexers.ts` + caja de búsqueda con combo de fuentes y grab existente, tests frontend | pendiente |
| T6 | S7 | parent — gate (backend completo + tsc + eslint + vitest + ratchet), README/docs, PR único con divulgación, merge | pendiente |

## Log

L1 (petición original, registro literal — línea truncada en el historial compactado):
- «ok, como estoy viendo que estoy teniendo muchos problemas, creo que vamos a implementar las conexiones directas con amule, qbittorrent y los indexadores. y dejaremos radarr y sonarr solo para el tema ...»

L2 (decisiones heredadas de `odd/tasks/conexion-directa-amule.md` L3 — siguen vigentes):
- Alcance de la caja de búsqueda del MVP «Indexadores»: **«Torznab + aMule + Prowlarr»**.
- Prowlarr a medio plazo: «Importar catálogo y retirarlo» (Step 5, fuera de esta feature; la búsqueda por idioma #218 se re-cableará entonces).
- Storage de indexadores: **tabla SQLite `indexers`**, nunca `config/settings.json`.

L3 (autorización): «**dale**» — 2026-10-22, tras el cierre de `conexion-directa-amule` (PR #220/#221), para arrancar los **Steps 3-6** del plan; este doc cubre los **Steps 3-4**.

L4 (evidencia de exploración, mapa `path:line`): molde `prowlarr_client.py:1-48` (config por llamada, `params=` percent-encoding, seam `session`); consumo Torznab existente sólo en `arr_client.py:1049-1150` (`t=search` RSS + `ElementTree`, `_search_query :1028`); cadena de búsqueda actual `ReleaseSearchModal.tsx:344` → `/api/calendar/indexers` + `POST /api/calendar/releases` → `release_search.py` → `arr_fetch_releases`; grab tras elección → `POST /api/calendar/grab` → `grab_release.py` (EC por defecto desde #220); SQLite: `SCHEMA` en `sqlite_history.py:30-200` (tablas nuevas sin ALTER); UI: `Settings.tsx` stack de `<Section>`, patrón lista+añadir en `SharedDirsSection.tsx`; contratos: smoke automático de GET (`tests_routes.py:126-141`) y key obligatoria en toda ruta `/api/` (`:2131`).

L5 (alcance): feature = **Steps 3-4**; Steps 5-6 (Prowlarr import+retire con re-cableado de #218, Radarr/Sonarr sólo archivos incluyendo `remove_queue`) = feature posterior con su propio doc.
