# Feedback de descargas en la cola de operaciones

## Objective

Ver por dónde va cada descarga lanzada desde los indexadores, sin salir de la app.

## Problem

Al añadir una descarga no hay ninguna señal de progreso. La única forma de saber qué pasa es
entrar a Radarr/Sonarr o a aMuTorrent por separado.

## Why

La app existe para detectar dónde se rompe el pipeline, y la fase de descarga es hoy un agujero.
Hay un caso real en el servidor: `Transformers El ultimo caballero (2017)` en
`trackedDownloadState: importBlocked` con `status: warning` — descarga terminada e import
bloqueado, que es exactamente lo que esto debe hacer visible.

## Scope

Dentro:

- Endpoint nuevo `GET /api/downloads`, ligero y con errores por fuente.
- Unión Radarr/Sonarr `downloadId` <-> aMuTorrent `hash` (ya existe `normalize_hash`).
- Panel de descargas en el sidebar de operaciones, **dividido en vertical**.
- Estados problemáticos destacados (`importBlocked`, `warning`, `failed`).

Fuera:

- WebSocket / push en tiempo real: el WS de aMuTorrent es de comandos, no un stream.
- `/api/v2/sync/maindata`: devuelve 401 con API key (requiere sesión de login).

## Constraints

- **Coste**: `/api/v2/torrents/info` sin filtro son 1097 KB / 813 torrents. Medido que
  `hashes=` y `filter=` se ignoran y **`category=` sí funciona** (1 torrent / 1.4 KB).
- **Categorías reales**: además de `radarr`/`tv-sonarr` existen `radarr-ru` y `tv-sonarr-ru`.
  Filtrar solo las base perdería las descargas rusas.
- **Si la cola está vacía no se llama a aMuTorrent**: en reposo el coste es cero.
- **Errores por fuente, explícitos**: si aMuTorrent cae, mostrar el progreso de Radarr y marcar
  velocidad/ETA como no disponibles; si cae Radarr, decirlo. Nunca un fallo de red debe
  parecerse a "no hay descargas".
- **División vertical**, no horizontal: el sidebar mide ~260 px y hay títulos como
  `Transformers El ultimo caballero (2017).BDrip 2160p x265 10Bit DV HDR DUAL ac3-eac3.(.HispaShare.).mkv`.

## Tasks

- [x] **T1** `clients.py`: fetch de torrents filtrado por categorías de los servicios arr
- [x] **T2** `routes/downloads.py`: endpoint con la unión y errores por fuente
- [x] **T3** Frontend: cliente API y estado
- [x] **T4** Frontend: panel de descargas con división vertical en el sidebar
- [x] **T5** Tests backend (unión, categorías, errores)
- [x] **T6** Tests frontend (render, estados destacados, error)
- [x] **T7** Verificación en vivo
- [x] **T8** README: cerrar #21

## Acceptance criteria

- Las descargas activas aparecen con progreso, velocidad, ETA y seeds cuando la unión funciona.
- `importBlocked` / `warning` / `failed` se distinguen visualmente.
- Con la cola vacía no se consulta aMuTorrent.
- Si una fuente falla, se dice cuál y por qué, y **no** se muestra como "sin descargas".
- El sidebar no se rompe visualmente con títulos largos.

## Applicable checks

- Backend: `python -m pytest -q`, `python -m pyflakes *.py routes/*.py`, `python -m vulture`
- Frontend: `npm test`, `npm run build`

## TDD

Desactivado (`strict_tdd: false`, origen `sdd-init/flow-controller`).

## Progress

- Rama: `feat/feedback-descargas-cola`. **Todos los tasks hechos.**

## Verification evidence

- **Verificación en vivo** contra la descarga real del servidor: unión correcta
  (`matched: true`), velocidad 4680957 B/s, ETA 483 s, 1 seeder, y `problem: true` con
  `importBlocked` + `warning` y el mensaje real `Failed to import movie`.
- **Coste medido**: 813 torrents / 1097 KB sin filtro frente a 1 torrent / 1.4 KB por categoría.
- Backend: **216 passed**. Frontend: **127 passed**. `pyflakes` y `vulture` limpios.
- **Guards validados revirtiendo:** filtrar solo las categorías base (perdiendo `-ru`) hace
  fallar `test_queries_localized_category_variants`; ocultar los errores del cliente de
  descargas hace fallar `reports a download-client failure instead of showing an empty panel`.

## Nota de test

`_StubSession` solo miraba la URL, pero la categoría viaja en `params`, así que servía el
payload equivocado. Ahora incorpora los query params a la coincidencia.

## Next step

Ninguno: PR abierta.
