# Backlog

Estado: `main` = `8cd4dce`. Documento vivo — el detalle largo vive en `README.md`
(## Backlog de mejoras) y en `ROADMAP.md`.

Todo lo de este documento está creado en **Linear**, proyecto **`flow-controller`** (equipo
`RAU`), en estado `Backlog`:

| ID | Linear | ID | Linear |
|----|--------|----|--------|
| B-04 | RAU-124 | C-01 | RAU-131 |
| B-03 | RAU-125 | C-02 | RAU-132 |
| B-02 | RAU-126 | C-03 | RAU-133 |
| B-01 | RAU-127 | C-04 | RAU-134 |
| F-01 | RAU-128 | C-05 | RAU-135 |
| F-03 🟡 | **Wizard de primera puesta en marcha** paso a paso (tipo Overseerr/aMuleTorrent). **Parte 1 (backend)** ✅ — `/api/setup` acepta **todos los grupos** (parcial-seguro), `/api/services/test` acepta **candidatos sin guardar**, y `save_settings` expone **`persisted`** para no decir "guardado" con el volumen de solo lectura. **Parte 2 (frontend)** ⬜ — rutas unificadas + el wizard | 🟦🟦 |
| F-02 | RAU-130 | C-07 | RAU-137 |
| C-08 | RAU-138 |  |  |

---

## 🔴 Bugs abiertos

| ID | Bug | Severidad | Evidencia | Estado |
|----|-----|-----------|-----------|--------|
| **B-04** | `POST /api/actions/*` devuelve **500**: `routes/actions.py:46` hace `from state import _http_session` y `state.py` no define ese símbolo (vive en `app.py:48`). Ninguna acción de la UI funciona. | **Alta** | Verificado en runtime con Python. `tests.py:422` solo publica una acción *desconocida*, por eso la suite está en verde. | ✅ |
| **B-03** | El escaneo encola la operación como `move` → `routes/files.py:219` `os.rename`, y en EXDEV copia **y borra el origen** (`:226`). Rompe el hardlink con el que aMule/qBittorrent siguen compartiendo el archivo. Debería copiar (idealmente `os.link`, como ya hace `copy_engine.copy_file_chunked`). | **Alta** | `MissingContent.tsx:126` → `queueAdd('move', …)` | ✅ |
| **B-02** | "Buscar" a veces no muestra el listado de indexadores: el error se traga en **tres capas** y devuelve `[]`, indistinguible de "no hay indexadores". Además no hay caché ni clave por `source`. | Media | `clients.py:766,787` → `[]`; `routes/calendar.py:343-351` sin campo `error`; `ReleaseSearchModal.tsx:96-102` `.catch(() => {})` | ✅ |
| **B-01** | Al pasar a naranja, la barra izquierda de la card se queda roja. **Dos causas distintas**: (a) `MissingContent.css:187-191` pinta `border-color: var(--warn)` y luego `border-left-color: var(--bad)` en la *misma* regla, con guarda solo para `.status-ok`; (b) `clients.py:1001,1049` comprueba `os.path.isdir` con la **ruta cruda del arr** sin pasar por `host_path()`, así que una película sana se clasifica `status-error`. | Media | Verificado en disco ambas | ✅ |
| **B-06** | La página **Disco** etiquetaba un directorio del rootfs del propio contenedor como **"Storage (6TB)"**. `/api/disk` hardcodeaba dos rutas y usaba `shutil.disk_usage`, que devuelve el uso del *sistema de ficheros que contiene* un camino — así que un directorio corriente devuelve el rootfs. **Cero tests** previos. | Media | Reportado en runtime: 63 GB (`/dev/loop2`) servidos como volumen 6TB | ✅ PR #103 |

**B-06 resuelto** — PR #103, `1cc1fcd`. Dos cambios, una causa raíz: **nadie comprobaba qué
  es la ruta**. Los volúmenes salen ahora de `paths.allowed_roots` (la autoridad que ya decide
  qué carpetas puede escribir la app) en vez de estar hardcodeados, y cada uno se comprueba con
  `os.path.ismount` **antes** de medir: si no es punto de montaje → mensaje explícito y **cero
  números**, porque esos números describen otro disco. Dos matices que no son cosméticos: un
  path inexistente conserva su `"no disponible"` (hay que preguntar por existencia **antes**,
  porque `ismount` devuelve `False` y no lanza), y el nombre pasó a ser el último componente de
  la ruta — `"Storage (6TB)"` prometía una capacidad que nunca se midió. **8 tests** donde
  antes no había ninguno.

  ⚠️ **Esto no arregla el síntoma original.** En este host los dos montajes están sanos y el
  compose los bind-mounta; lo que encaja es un **bind-mount capturado demasiado pronto**: con la
  propagación `rprivate` por defecto, un montaje posterior en el host no se cuela dentro del
  contenedor. **Eso se arregla reiniciando el contenedor** — infraestructura, fuera del repo.

**B-04 resuelto** — rama `fix/actions-session-import`: la sesión ahora se abre por petición
  en `routes/actions.py` (igual que el resto de rutas), y el global muerto de `app.py` se eliminó
  porque nunca lo leía nadie. Regresión cubierta por
  `tests.py::TestRunActionValidation::test_a_valid_action_reaches_do_action`, que hoy da 500
  si alguien reintroduce el import roto.

**B-03 resuelto** — rama `fix/scan-places-without-destroying`. El escaneo ahora encola
  **`copy`** en vez de `move`, y la rama de copia de la cola pasó por `_place_file`:
  **enlace duro primero** (instantáneo, cero bytes extra, el origen sigue sembrando), creación
  del directorio destino, guarda `samefile` para no vaciar un inodo compartido y copia atómica
  por temporal. `move` sigue existiendo y sigue siendo un movimiento honesto — es el botón del
  FileManager. Tests: `TestConsumeQueuePlacesWithoutDestroying` (2; RED observada: directorio
  destino inexistente y `b'' == b'payload'`) y `scanFolderNav.test.tsx` (RED:
  `expected 'move' to be 'copy'`).

**B-02 resuelto** — rama `fix/indexers-surface-the-error`. El error ya no se traga en ninguna
  de las tres capas: `arr_indexers` devuelve `indexers` + `error_kind`/`error` vía `arr_failure`
  (mismo patrón que `fetch_wanted_movies`), la ruta devuelve lo mismo, y el modal lo pinta con
  `role="alert"` y botón *Reintentar*. Caché **por `source`** en ambos lados: backend 300 s que
  **nunca cachea un fallo**, y react-query con `queryKey: ['indexers', source]` y `staleTime`
  5 min — así la lista de Radarr pedida una vez no se vuelve a pedir a los minutos, y la de
  Sonarr es otra. `calendar_releases` reutiliza esa caché en vez de re-preguntar en cada
  búsqueda. Contrato cambiado: `test_unknown_source_returns_empty` afirmaba el bug y se
  reescribió. Tests nuevos: 7 en backend, 2 en frontend (`indexerList.test.tsx`).

**B-01 cerrado — no era un defecto.** Confirmado por el usuario: se ve en *Faltantes* con
`✗ Sin archivo`, que es **el diseño intencional** (comentario en `MissingContent.css:182-186`:
el rojo dice *que no hay archivo*, el naranja *que ya se pidió* — dos hechos, ninguno pisa al
otro; esa es la razón de ser del estado).

**Queda registrado aparte, sin confirmar en producción:** la *otra* causa que encontré al
analizarlo — `clients.py:1001` y `:1049` hacen `os.path.isdir(path)` con la **ruta cruda del
arr**, sin pasar por `host_path()`, mientras `copy_engine.py:88,493` sí traduce. Si Radarr
reporta `/data/...` y el backend solo ve `/mnt/storage/...`, una película **sana** de la pestaña
*Todas* se clasificaría `status-error` y mostraría `✗ Ruta no encontrada`. No es lo que se
reportó, así que no entra en B-01 — pero es un fallo latente de dos líneas con `host_path()`.

---

| **B-05** ✅ | `PROTOTYPES_DIR` resolvía a **`/prototypes`** dentro del contenedor: `BASE_DIR` es `dirname(config.py)`, que localmente es `<repo>/backend` pero en la imagen es `/app` (el Dockerfile aplana `backend/*.py` con `COPY`), así que `../prototypes` apuntaba a un sitio inexistente. `isdir` → false → **`[]`**: la página mostraba su estado vacío con los ficheros dentro de la imagen | Media |

**B-05 resuelto** — rama `fix/prototypes-dir-in-container`. `_resolve_prototypes_dir()` mira
**ambos** layouts (hermano de `backend/` localmente, dentro de `/app` en la imagen) y se queda
con el que exista, sin meter ninguno de los dos como respuesta fija. Un test fija el destino del
`Dockerfile` para que la asunción no se pudra en silencio.

**Ojo con el razonamiento que llevó a esto:** la sección *Prototipos* es una entrada **fija**
del sidebar (no está en `hiddenPages`), así que verla **no demuestra** que el directorio esté
bien — solo que la ruta existe en el menú.

## 🟢 Features

### F-01 — Upgrade de calidad desde la biblioteca (4K / 3D) + destino · **Grande** · ✅ **Cerrado** (PRs #101, #102, #104)

Pedida: acceso a las películas ya agregadas en Radarr, descargar en formato de más calidad
(4K) o 3D, escoger el destino y renombrar el archivo una vez copiado.

**Lo que ya existe** (no reimplementar):

| Pieza | Dónde |
|-------|-------|
| Búsqueda de releases (`POST /api/v3/release`) con calidad expuesta al cliente | `clients.py:1312-1373`, `routes/calendar.py:177-202` |
| Filtros combinables (texto / calidad / idioma / seeders) | `utils/releaseFilters.ts` |
| Selector de destino por grab | `GET /api/calendar/destinations`, `own_grabs.destination` → `dest_root` |
| Copia hardlink-first | `copy_engine.copy_file_chunked` (`os.link` primero, `:49`) |
| Renombrado manual | `POST /api/files/rename`, `FileManager.tsx` |
| Biblioteca completa con pósteres | pestaña "Todas", `GET /api/wanted/all` |

**Los huecos (etapas):**

1. **Entrada para películas con archivo.** El modal es un callejón sin salida:
   `ReleaseSearchModal.tsx:349` solo pinta "✓ Ya tiene archivo descargado" y no ofrece buscar;
   `Calendar.tsx:94` ni siquiera deja abrirlo. Sin esto no hay upgrade.
2. **Eje "resolución" + presets 4K.** `releaseFilters.ts` solo compara la calidad *exacta*;
   no hay 2160p/1080p/720p ni noción de "4K". Como `quality` ya llega al cliente, **esto no
   toca backend**.
3. **Detección de 3D.** Cero ocurrencias de 3D/HSBS/HTAB/SBS en todo el repo. *Decisión:*
   parsear el título (frágil) · confiar en los flags del indexador · etiquetado manual.
4. **Acotar la búsqueda en servidor (opcional).** `arr_fetch_releases` solo manda
   `movieId`/`episodeId`; Radarr acepta `quality` y `minimumSeeders` y hoy no se usan. La
   búsqueda puede tardar hasta **240 s** (`clients.py:1322`).
5. **Destino en upgrades.** ⚠️ `auto_copy.py:100` hace *SKIP* cuando `arr_has_file` es
   `True`, que en una película con archivo **siempre lo es** → el destino que elijas hoy es
   un no-op. Hay que decidir: upgrade dentro de la biblioteca (Radarr reemplaza y renombra él)
   o copia a carpeta externa (fuera del control de Radarr).
6. **Renombrado al llegar.** ✅ **Cerrado en 2 PRs** (#105 `0fd967e`, #106 `6356104`) —
   ***pedido explícitamente por el usuario*** y con alcance acotado a **solo las carpetas
   4K/3D**. Hoy solo se *detecta*: `clients.py:576` lee
   `GET /api/v3/rename` y reporta `renamed_needed`, pero **nadie ejecuta nunca el rename**.
   Falta un paso tras `run_copy_background` (`copy_engine.py:179`).

#### Decisión tomada por el usuario: **conviven**, cada calidad en su ruta

> *"conviven juntos: 4K va a una carpeta específica, 3D a otra; las pelis de 1080p están en otra ruta."*

Esto **cambia el alcance a mejor**:

| Lo que estaba abierto | Cómo queda |
|---|---|
| ¿El 4K **sustituye** o **convive**? | ✅ **Conviven.** Cero upgrade de Radarr, cero reemplazo, cero "qué hago con el viejo" |
| ¿Destino por release o por lote? | ✅ **Derivado por release, automáticamente** — desaparece la limitación de "un destino para todo el lote" |
| ¿Pre-chequear el perfil de calidad? | ⚠️ Sigue abierto: si el perfil no admite 2160p, el grab devuelve un 400 (ya lo parseamos) |

**La maquinaria de destino existe — pero está apagada justo para este caso.**
`own_grabs.destination` (PRs #66-#73) ya lleva un destino hasta `copy_engine`, que lo usa como
`dest_root`: se valida con `path_is_allowed`, se escribe **tal cual** y copia con
`import_after_copy=not dest_root` → **el arr ni se entera**. Eso es exactamente lo que hace
falta para que un 4K conviva sin tocar el 1080p.

⚠️ **Pero `auto_copy.py` devuelve SKIP cuando `arr_has_file` es `True`** — y el destino solo se
aplica *después* de esa decisión (`auto_copy_driver.py:351` → `:434`). Para una película que
**ya tiene archivo** (que es *siempre* en "conviven"), `arr_has_file` es `True` → **el destino
nunca llega a disco**. Ese guard hay que abrir o reencuadrar, y es el verdadero bloqueo de F-01.

Así que F-01 pasa de "construir el emplazamiento" a **tres cosas concretas**:

| # | Qué | Dificultad |
|---|---|---|
| 1 | **Abrir ese SKIP** para grabs con destino explícito (el arr ya tiene el 1080p; eso es lo que queremos) | media — toca la política de auto-copy, que está cubierta de tests |
| 2 ✅ | **Elegir el destino según la calidad**: `paths.path_4k` (vacío = desactivado = hoy), 1080p → biblioteca — **PR #102** | Baja, como se preveía: la detección de 4K es `release.quality` → `endswith('2160p')`, **ya llegaba al cliente** (`clients.py:1344`) |
| 3 ✅ | **Detección de 3D** — **PR #104** | Como se decidió: tokens acotados por palabra (sin `\b`, `ABSORB` casaría con `sbs`) + corrección manual que **sobrescribe**. **`is3d` manda sobre `2160p`**: una 3D es 3D sea la resolución que sea |

#### Reparto (medido, no supuesto — decidido antes de empezar)

| PR | Contenido | Por qué va solo |
|----|-----------|-----------------|
| **A** ✅ | **Abrir el `SKIP` de `decide_copy`** para grabs con destino explícito — **PR #101**, `42d1acb`, 626 tests | Era un **bug latente ya shipped**: elegir un destino para una película con archivo no hacía nada. Ahora sí, y un destino que cae **dentro de una raíz de Radarr** sigue sin abrirse (fail-closed: sin raíces comprobables no se amplía nada) |
| **B** ✅ | Destino por calidad — **PR #102**, `627de9f`, `paths.path_4k` + detección de `2160p` | Depende de A, ya en `main`. **El batch se parte en una llamada por clase**: `grab-batch` tiene un solo campo `quality`, y fusionarlas mandaría `1080p` para una fila 4K → Radarr la importaría y **reemplazaría** el fichero que debía conservarse |
| **C** ✅ | Detección de 3D (título + corrección manual) + **`paths.path_3d`** — **PR #104**, `ef182a0`, 648 backend / 260 frontend | La corrección manual es un control **siempre visible** en cada fila: ofrecerlo solo cuando el heurístico ya adivinó dejaría sin forma de corregir un fallo, que es justo el caso de la opción 4 |

#### Decisión de producto pendiente (resuelta):

- **¿Cómo identificamos un release como 3D?** En todo el repo hay **cero** ocurrencias de
  3D/HSBS/HTAB/SBS. Opciones:
  1. **Por el título** del release (`3D`, `HSBS`, `HTAB`, `SBS`) — cero dependencias, pero frágil
     y propenso a falsos positivos con "3D" en títulos normales.
  2. **Por los flags del indexador** (`indexerFlags` de Torznab) — fiable si el indexador los
     pone, y silenciosamente vacío si no.
  3. **Etiquetado manual** — el usuario marca la release como 3D antes de descargar; cero
     fallos, pero es trabajo por cada una.
  4. **(1) + (3)** — automático con corrección manual. ✅ **Elegida por el usuario.**

**Cómo se implementa la opción 4:** el título se analiza **al hacer el grab** (el mismo momento
en que ya elegimos destino), y el resultado viaja en la petición — igual que `destination`, que
ya viaja hasta `own_grabs`. La corrección manual es un control en la propia lista de releases
que **sobrescribe** lo detectado: lo que detecta el título es una *sugerencia*, no una verdad.

*(El resto de lo que había pendiente queda resuelto o sin objeto: "¿sustituye o convive" →
conviven; "destino por release o por lote" → por release automáticamente; "qué pasa con el
fichero viejo" → nada, se queda.)*
**, en 4 rutas), `record_own_grab` ×2 y la lectura de `/api/auto-copy/history`. `_attach_grabbed_at` pasa a `async def` con 5 sitios con `await` | Media |
| F-02g ✅ | Log **append-only** (`os.open(O_APPEND)` + un `os.write`). Antes: leer hasta 500 líneas y reescribir **cada WARNING**, en el loop, con ~37 sitios `log.warning` — un arr caído generaba uno por intento | Baja |
| F-02h ✅ | `config.SERVICES` se congelaba en el import: guardar no servía de nada hasta reiniciar. **(A)** `config.rebuild()` con contenedores rellenados **in situ** + fuera las **3 copias duras** de `allowed_roots` + `RESTART_REQUIRED_FIELDS` honesto. **(B)** todos los escalares leídos en tiempo de llamada, incluidos los **46 sitios** de `REQUEST_TIMEOUT` | Baja |

**F-02h, parte 1** — rama `fix/config-rebuild-roots`. `config.rebuild()` se llama tras
**ambos** `save_settings` (endpoint y first-run) y rellena `SERVICES`, `ALLOWED_ROOTS` y
`_DOWNLOAD_CLIENT_PATHS` **in situ** — `from config import SERVICES` mantiene el mismo objeto,
así que ningún llamador cambia. Las **tres copias duras** de `["/mnt/storage", "/mnt/storage-6tb"]`
(`routes/files.py`, `routes/wanted.py`, `routes_mixer.py`) desaparecen: la raíz que configures
deja de ser ignorada por el explorador de ficheros.

Y `RESTART_REQUIRED_FIELDS` pasa a lo que **genuinamente** no puede aplicarse en caliente:
`security.api_key` ya se leía en vivo (su propio docstring lo dice) y los servicios ahora
también — la UI dejaba de mentir en una dirección para seguir mintiendo en la otra.

**F-03, parte 2 (frontend)** — dirección **elegida por el usuario tras ver los tres prototipos**:
**focus card** (`setup-02`), no el híbrido que se había propuesto antes de desplegar. Tarjeta
centrada de 520px, contador `n de 8` + puntos, **sin lista de pasos** y sin salto: solo
`Atrás`/`Siguiente`. Coste asumido — el progreso no se puede recorrer, hay que retroceder.

**Regla de validación (decisión del usuario):** **Radarr y Sonarr obligatorios, al menos uno de
los dos**; **aMuTorrent opcional** (paso rotulado `aMuTorrent (opcional)`). El gate vive en el
paso de resumen: `Entrar` exige URL + clave en Radarr o en Sonarr. Avanzar por los pasos de
servicio **no** está bloqueado — un servicio puede estar reiniciándose y una instalación solo de
películas o solo de series es válida.

**Aplazado a un ciclo futuro (pedido, no olvidado): varias instancias de Radarr/Sonarr.** El
esquema actual es `services.radarr` / `services.sonarr` **unitario**, así que admite una URL por
servicio. Soportar varias toca `settings.py` (esquema), `config.SERVICES` (lista con clave por
instancia), `find_service`/`configured_services` (que hoy filtran por `key` fijo), el bloque de
servicios de la UI y la selección de fuente en toda la app (`source=radarr|sonarr`). Es una
migración de esquema, no un ajuste de UI — de ahí que vaya aparte.

**F-03, parte 1 (backend)** — rama `feat/setup-wizard-backend`. Tres huecos entre
`POST /api/setup` y un wizard real:

1. **Solo copiaba `services.*`** — un paso que guardara `paths` o `intervals` los mandaba y se
   perdían. La única alternativa, `POST /api/settings`, **no es parcial-seguro** (`_deep_merge(
   DEFAULTS, data)` → todo lo omitido vuelve a su default).
2. **"Probar conexión" solo sonda lo guardado** → imposible validar una URL antes de
   comprometerse, que es justo lo que hace un paso de wizard.
3. **`save_settings` devuelve `False`** con el directorio de configuración de solo lectura y
   **ambas rutas respondían `ok: true`** — la misma mentira que arreglamos en F-02g.

Y `restart_needed` filtraba `services.*` sobre un conjunto que ya solo contiene `server.port`,
así que **siempre devolvía `[]`**: cambiar el puerto no se reportaba.

**C-08 acotado a torrents** — rama `fix/seed-guard-torrents-only`. El guard cubría
`FOLDER_DOWNLOAD_AMULE` **y** `FOLDER_DOWNLOAD_TORRENT`; ahora solo el segundo, porque las dos
razones coinciden en que aMule no necesita esa protección:

- los ficheros de aMule están en **`/mnt/storage-6tb`** y la biblioteca en **`/mnt/storage`**
  → montajes distintos → **un hardlink entre ellos es imposible**, no había nada que proteger;
- aMule no tiene ratio ni obligación de enjambre, y un ED2K se vuelve a bajar de la red: allí un
  fichero es **desechable con un plazo**, no una semilla frágil.

Esto además despeja el camino a la retención de aMule: el guard ya no se interpone entre el
ciclo de vida del fichero y su borrado programado.

**F-02h, parte 2** — rama `fix/config-live-scalars`. Los escalares que `from config import X`
había congelado pasan a leerse en tiempo de llamada: `SAFE_MODE` (la UI decía "guardado" para
`security.safe_mode` y **era un no-op**), `DEVELOPER`, `CHECK_INTERVAL`, `TRACE_LIMIT`,
`FOLDER_DOWNLOAD_*`, `MAX_RETRIES`, `RETRY_DELAY`, `IMPORT_POLL_TIMEOUT` y — el último —
`REQUEST_TIMEOUT` con sus **46 sitios** en `clients.py`.

`RESTART_REQUIRED_FIELDS` queda en `{"server.port"}`: lo único que uvicorn solo lee al arrancar.

**F-02f hecha** — rama `perf/sqlite-off-hot-path`. El contrato venía escrito en el propio
`history.py` ("callers hand it to `asyncio.to_thread`") y unos 8 sitios lo ignoraban.
`own_grabs_latest_map` se queda **inline** a propósito: con `rows` ya leídos es una proyección
de dict sin I/O.

**Queda anotado, no hecho:** `auto_copy_driver.py` hace ~10 round-trips síncronos **por traza**
durante un sweep, y `own_grabs` no tiene **índice en `grabbed_at`** (migración que subiría
`SCHEMA_VERSION`) — el índice ayudaría también a los que ya usan `to_thread`.

**F-02g hecha** — rama `perf/append-only-log`. El trim sigue existiendo pero está
**amortizado**: un reescritura por cada 512 KiB de warnings, no una por registro. El contador
`_LOG_BYTES` se inicializa leyendo el tamaño real del fichero, así que el umbral mide el
fichero y no lo que llevamos escrito.

**F-02d y F-02e hechas** — rama `perf/trace-ttl-and-queue-singleflight`. Dos cosas que no son
solo "rendimiento": el consumidor de la cola **no era secuencial** (varias copias a la vez) y
`/api/trace` se pagaba entero por cada pestaña. Ambas fuera de alcance y anotadas: la colisión
de `op.id` en el mismo milisegundo y el tope de 50 que solo poda terminados.

**F-02c hecha** — rama `perf/shared-http-session`. El seam vive en `state.http_session()`, no
en `app.py`: las rutas no pueden importar `app` sin crear un ciclo. **Bajo el lifespan** (producción,
un solo loop) todo el mundo recibe *la misma* sesión → keep-alive y un techo único de sockets;
**sin lifespan** (los tests, que nunca entran en él) cada ámbito recibe la suya y la cierra al
salir — que es exactamente lo que ya asertaban los tests de ruta, por lo que **no hizo falta
cambiar ni un test existente**.

Corrige la cifra original: eran **28 construcciones en todo el código**, no "30 por request".

**F-02a y F-02b hechas** — rama `perf/offloop-blocking-calls`. La comprobación no cronometra
nada: cada test pregunta *en qué hilo* corrió la operación con `asyncio.get_running_loop()`,
que es thread-local — dentro del loop resuelve, en un worker de `to_thread` lanza
`RuntimeError`. RED observado en los cinco: `assert True is False`.

Pendiente en la misma serie: **F-02c** (sesión compartida + `TCPConnector`) — va en un PR
aparte porque toca los mismos ficheros. No tocado a propósito: `file_browse` (2 `stat` por
entrada sobre el mount de red) y `clients.py:1001,1049` (un `isdir` por fichero de la
biblioteca).

### F-03 — Wizard de primera puesta en marcha (tipo Overseerr / aMuleTorrent) · ✅ **Entregado**

**Ya existe** una pantalla de setup (`SetupPage.tsx` + `GET/POST /api/setup`), pero no es una
ruta, no valida paso a paso y **descarta el `restart_required`** (`SetupPage.tsx:62`), así que
el usuario nunca se entera de que hay que reiniciar.

**Los 9 pasos que la configuración real implica:**

1. Bienvenida + detección de estado · 2. Secreto `FC_SECRET` (solo verificable, es env-only) ·
3. Radarr (URL + API key → `GET /api/services/test`) · 4. Sonarr · 5. aMuTorrent ·
6. Rutas y raíces permitidas · 7. Clave de API de la app (opcional, no reinicia) ·
8. Avanzado (intervalos, `tracing.limit`, `safe_mode`, `developer`, `port`) ·
9. Revisar y guardar → mostrar `restart_required`.

**Huecos:** no hay endpoint que valide existencia/escritura de rutas (seguía fuera de alcance
en F-03). ~~`needs_setup` se quedaba colgado~~ y ~~`RESTART_REQUIRED_FIELDS` hacía que la UI
mintiera con `safe_mode`/`intervals`/`paths`~~ → **lo arregló F-02h**: `config.rebuild()`
refresca `SERVICES` en caliente y la lista quedó en `{"server.port"}`.

**Decisión (F-03):** la clave de la app va **al final** — en cuanto existe, `POST /api/setup`
devuelve 403 y `needs_setup` pasa a false; ponerla antes cortaría el wizard.

#### Renombrado al llegar — cerrado (PRs #105, #106)

**El hecho que lo condiciona todo:** Radarr renombra **lo que es suyo** — `GET /api/v3/rename`,
`RenameMovie` y `RenameFiles` operan sobre la biblioteca — y **no expone** un endpoint
*"¿cómo se llamaría este fichero?"* para uno fuera de sus raíces. Solo entrega su **plantilla**
(`GET /api/v3/config/naming`), y evaluar el formato ajeno es exactamente donde un nombre se
escribe **mal con toda la confianza**.

Por eso la plantilla **nunca se toma por confianza**: `reproduced_radarr` la re-evalúa para el
fichero **que Radarr ya posee** y la compara con el nombre **que Radarr eligió**. Solo un
acierto gana el derecho a nombrar el que vamos a escribir. Si no coincide → el nombre de
siempre, plano, y **el motivo en el detalle de la tarea**.

| Decisión | Por qué |
|---|---|
| **Carpeta desde `movie.path`**, no evaluando `movieFolderFormat` | Es una respuesta que Radarr **ya ejecutó**; no necesita interpretación |
| **Tokens acotados** (`{Release Group}`, `{MEDIAINFO ...}` → no) | Describen un fichero **que no hemos escaneado**; rellenarlos sería invención |
| **Token no opcional sin dato → falla toda la evaluación** | Acortar el nombre en silencio es peor que no renombrar |
| **Lista explícita de extensiones**, no `suffix` | Un `suffix` llamaría `.PROPER` extensión y lo cortaría → **la feature off justo en los despliegues con proper releases** |
| **La calidad se guarda ahora** (v8, `own_grabs.quality`) | Sin ella `{Quality Full}` — el token del formato por defecto — no tiene dónde leerse. `None` se queda en `None`: una calidad adivinada **es un nombre de fichero que nadie notará mal** |

**No se toca** el rename de biblioteca — decisión de alcance del usuario: Radarr ya renombra lo
que es suyo.


---

### F-04 — Selector múltiple en el explorador de ficheros · ✅ **Entregado**

Pedida: *"en la sección de archivos, que es como un explorador de carpetas, un selector de varios archivos"*.

**Estado actual:** `frontend/src/components/FileManager.tsx:47` guarda `selected: string | null`
— **selección unitaria**. Todas las acciones viven en la fila (`handleQueue(type, item)` en `:177`,
`deleteItem(p)`), y no hay checkbox ni "seleccionar todo".

Lo que implica:

1. **Estado** `Set<string>` + UI por fila. Ojo: `utils/selection.ts` **ya existe** y se usa en el
   escaneo y en los indexadores con la regla *"seleccionar todo solo sobre lo visible"* — usar
   esa, no una segunda copia.
2. **Acciones en lote.** O N llamadas a los endpoints actuales, o endpoints `batch`. Con N
   llamadas hace falta informar **por fichero**: una puede ser rechazada y las otras no.
3. ⚠️ **El guard de semilla de C-08 corta en seco un "mover" en lote desde la carpeta de
   descargas.** El resultado parcial pasa a ser **el caso normal**, no la excepción: la UI
   tiene que mostrar qué se colocó, qué se rechazó y el motivo de cada uno.
4. La cola ya es secuencial (F-02e) y persistente (SQLite), así que encolar N es barato.

**Abierto:** ¿qué hace la selección con carpetas (todo el árbol)? ¿límite de elementos?
¿"eliminar en lote" necesita confirmación distinta de la actual (`confirm()` por fichero)?

---

### F-05 — Retención de las descargas de aMule · ✅ **Entregado**

Pedida: *"en la carpeta de amule me gustaría saber si los archivos están controlados por radarr
o sonarr, podríamos marcarlos de alguna manera, para localizar los que puedo borrar"*.

**F-04 entregado** — rama `fix/file-manager-multiselect`. Selección con
`Set<item.path>` + *Seleccionar todo* **reusando `utils/selection.ts`** (su docstring advierte
de lo que cuesta copiarla), barra de lote `Copiar · Mover · Eliminar · Limpiar`, y **N llamadas
secuenciales** a los endpoints existentes — sin endpoints nuevos. Un `Promise.all` no vale aquí:
50 `unlink` en paralelo contra un montaje de red es como se consiguen timeouts.

**Resultado por fichero**: toast con recuentos + informe persistente de *Rechazados* con el
`detail` literal del backend. Un `move` que el guard de semilla rechaza a mitad de lote es un
**resultado correcto**, no un crash. El borrado en lote pide confirmación con la **cuenta y la
frase de irreversibilidad**.

`size:exception` concedido: **585 líneas** (287 componente+CSS, 298 del test nuevo). El corte
honesto no deja piezas que funcionen por separado — ver `odd/tasks/f04-multiselect.md`.

Y un dato: **`FileManager.tsx` no tenía ni un test**; este trabajo lo crea (4, RED comprobado).

**Decisión del usuario: el borrado es SUYO, siempre con aviso de irreversibilidad.**

**Parte B (frontend) entregada** — en el explorador: chip `hace N días` / `hoy` / **`caducado`**
(tono `--warn`, nunca `--bad`: es un *estado*, no un error), y el botón **Marcar caducados**
que selecciona exactamente los caducados — un clic para localizar lo que puedes borrar, y el
borrado en lote con el aviso de irreversibilidad que ya traía F-04. El fichero **sin edad**
(`age_days: null`, almacén ilegible) no lleva chip: nunca una edad inventada.

**La procedencia queda fuera y pasa a F-07** — ver ahí el motivo.

**Parte A (backend) entregada** — `GET /api/files/retention?path=` devuelve
`{days, files:[{name, first_seen_at, age_days, expired}]}`. Solo marca: **nunca borra**, y si
la BD no está disponible devuelve el fichero **sin edad** en vez de inventar una. Migración
`SCHEMA_VERSION` 6 → 7 con la disciplina de v2-v6 (tabla nueva que un fichero viejo gana sin
`ALTER`). Falta la parte B (chips en el explorador + *Marcar caducados* + campo en
Configuración) y, aparte, la **procedencia** — que necesita mover la caché de `build_traces`
y por eso no entra aquí.

El sweep **nunca** borra solo: marca y deja que tú lo borres (en lote, con F-04), y antes de
ejecutar aparece un aviso explícito de que **no se puede recuperar**. Un borrado automático es
una opción futura con interruptor, no el comportamiento por defecto.

#### Qué guarda y cómo

| Pieza | Detalle |
|---|---|
| Tabla nueva | `amule_downloads(path PRIMARY KEY, first_seen_at REAL)` — mismo patrón de migración que `auto_copy_seen` (`history.py:110`), que **ya usa `first_seen_at`** |
| Sweep | recorre `FOLDER_DOWNLOAD_AMULE` y registra por primera vez cada fichero. ⚠️ `first_seen_at` se escribe **solo una vez**: refrescarlo en cada vuelta haría que nada caducara nunca |
| Caducidad | `edad = ahora - first_seen_at ≥ retención` → marcado como **caducado** |
| Duración | configurable en Configuración, **7 días** por defecto |
| Borrado | botón + confirmación con el aviso de irreversibilidad; idealmente en lote vía F-04 |

#### ¿Y si a los N días el arr nunca lo importó?

La otra mitad de lo que pediste: saber qué ficheros están **controlados por Radarr o Sonarr**.

| Señal | Fuente | Dice |
|---|---|---|
| Cola del arr | `GET /api/v3/queue` (`clients.py:731`) | `cola · importando` |
| Histórico del arr | `GET /api/v3/history` (`clients.py:715`) | `histórico` |
| Nuestras peticiones | tabla `own_grabs` | `lo pedimos nosotros` |
| ~~Inodo compartido~~ | `st_nlink > 1` + mismo `(st_dev, st_ino)` | **No aplica a aMule**: montaje distinto, el hardlink es imposible. Sí sirve para torrents |
| Ninguna | — | `desconocido` |

⚠️ La marca **no** dice "puedo borrar sin coste": en aMule no hay semilla que romper, pero
puede que **el arr nunca lo haya importado** y entonces borrarlo sí pierde el dato. Se **muestra
y no bloquea** en la v1 — tú decides, con el aviso — y se puede promover a condición si alguna
vez se clavan ficheros.

**Coste:** cruzar descarga y biblioteca es I/O sobre el montaje de red → cachear por sesión y
limitarlo a `ALLOWED_ROOTS`.


---

### F-06 — Estudio: motor propio de aMule · **Estudio (para más adelante)**

Pedida: *"explorar el cómo sería de viable implementar un motor de amule en nuestro proyecto
para tener más control sobre los archivos y el flow del programa"* — **para un estudio más
adelante**, no ahora.

#### Por qué interesa precisamente ahora

Casi todo lo que hemos hecho en este ciclo existe **porque no controlamos dónde cae el
fichero**: el escaneo de la carpeta, la colocación con enlace duro (B-03), el guard de semilla
(C-08), la retención de aMule (F-05), el selector múltiple para limpiar (F-04). Un motor
nuestro que decidiera **la ruta de descarga desde el principio** eliminaría la fase de escaneo y
colocación **entera** — que es la causa raíz de B-03 y de media F-05.

#### Qué dependemos hoy (verificado en `ROADMAP.md`)

Nunca hablamos con aMule directamente. Hablamos con **aMuTorrent** en el puerto 4000, que expone:

1. **Indexador Torznab** (`/indexer/amule/api`) — puente ED2K → el `enclosure` es un
   `magnet:` cuyo `downloadId` es un **hash ED2K** (16 bytes + relleno);
2. **API compatible con qBittorrent** (`/api/v2/...`).

Y ni `amuled`, ni `aMuleWeb`, ni el protocolo **EC (External Connections)** aparecen en el repo:
**la vía de control directo ni siquiera está explorada.**

#### Las cuatro opciones que el estudio debe comparar

| Opción | Qué da | Coste |
|---|---|---|
| **(a) Motor propio** — reimplementar ED2K + Kad | Control total de la ruta de descarga; desaparecen escaneo y colocación | Muy alto: protocolo, DHT, descarga multi-fuente, verificación MD4, cola, NAT/obfuscación. **Sin biblioteca Python madura** que reutilizar |
| **(b) Controlar aMule vía EC** (`amuled` / `aMuleRemote`) | RPC sobre TCP con contraseña MD5: añadir ED2K/magnets, listar, pausar, borrar, **fijar el directorio de descarga** | Medio. Da control de *flujo*, pero el *emplazamiento* sigue en manos de aMule |
| **(c) Sustituir por un cliente API-first** (p.ej. `mldonkey`, daemon con RPC que soporta eDonkey) | Transferencia ya controlable por API | Medio-alto: migración operativa y otra pieza en el stack |
| **(d) Mantener aMuTorrent y completar lo que falta** | Ya tenemos Torznab + API qBit verificados | Bajo — es el status quo |

#### Qué tiene que decidir el estudio con evidencia

1. **Qué control de emplazamiento necesitamos de verdad**: ¿que el fichero caiga donde
   queremos con hardlink y sin copia? Si la respuesta es sí, (a) o (c) son los únicos que lo
   dan; (b) no.
2. **Esfuerzo real de (a)** — con bibliotecas concretas, no con impressiones.
3. **Coste de mantenimiento** de cada opción frente a la que ya funciona.
4. **Si (a) o (c), ¿sigue haciendo falta aMule?** — y con él, el puente aMuTorrent.

#### Restricción de licencia a comprobar (no es menor)

Este proyecto es **MIT** (`README.md`), y aMule se distribuye bajo **GPL** — *confirmar la
versión exacta en el estudio*. **Reimplementar un protocolo a partir de las especificaciones no
es copiar código**, y eso es compatible; pero **reutilizar código de aMule dentro de un
proyecto MIT lo convertiría en GPL**. Cualquier opción que contemple fork o vinculación debe
resolver eso *antes* de estimar esfuerzo.

**No empieza hasta que se diga.** Sin fecha, sin PR, sin hueco en el orden.

---

### F-07 — Marcar la procedencia de los ficheros de aMule · **Pendiente**

La segunda mitad de lo que se pidió: *"saber si los archivos están controlados por radarr o
sonarr"*. La primera (F-05, por edad) ya responde a *"localizar los que puedo borrar"*; esta
da el **por qué**.

| Señal | Fuente | Dice |
|---|---|---|
| Cola del arr | `GET /api/v3/queue` | `cola · importando` |
| Histórico del arr | `GET /api/v3/history` | `histórico` |
| **Inodo compartido** | `st_nlink > 1` + mismo `(st_dev, st_ino)` | **No aplica a aMule** — montaje distinto; sirve para torrents |
| Nuestras peticiones | `own_grabs` | `lo pedimos nosotros` |

`traces.py:172` ya pone `"source": key` en cada traza y `:188`/`:192` resuelven `current_path` /
`content_path`, así que la atribución **existe**: hay que casarla con los nombres de la carpeta.

**Va aparte porque no es gratis:** reutilizar `build_traces` obliga a mover su caché, y esa
caché vive en `routes/status.py` con tests propios (`tests_trace_cache.py`) que parchean
`routes.status.build_traces` — moverla los rompe. Es un cambio con su propio coste, no un
apéndice de la retención.

**Decisión ya tomada:** se **muestra y no bloquea**. La marca no puede decir "puedo borrar sin
coste": en aMule no hay semilla que romper, pero puede que el arr nunca lo haya importado — y
ahí borrar sí pierde el dato.

---

### F-08 — Secciones **Películas** y **Series** · **Grande** · 🔄 *prototipos decididos, falta implementar*

Pedida: dos secciones nuevas que **reunifiquen** lo que hoy está repartido entre
`Faltantes` · `Calendario` · el modal de releases · `Archivos`.

**Prototipos entregados**: 4 de Películas + 4 de Series (**PR #108**), con la galería
rediseñada para enseñar elegidos y descartados (**PR #107**).

#### ✅ Decisión del usuario: **maestro–detalle en las dos secciones**

> *"Son el Maestro-detalle. Se aprende una vez y todo funciona igual."*

| Sección | Elegido | El que perdió | Por qué perdió |
|---|---|---|---|
| **Películas** | `peliculas-02-maestro-detalle` | rejilla · pestañas · pipeline | Consistencia; y además la rejilla **ocultaba las acciones de descarga** tras un hover |
| **Series** | `series-04-maestro-detalle` | **`series-01-arbol`** (la recomendada) | **Consistencia ganó a idiomático**: árbol para series y lista para pelis serían **dos lenguajes** |

**El trade-off está registrado en el manifiesto**, no solo aquí: `series-01` lleva en su
nota que fue **la recomendada** y perdió, para que nadie vuelva a proponerla sin saber que
ya se decidió.

#### El modelo elegido

```
┌────────────────┬──────────────────────────────────────┐
│ Lista densa    │  Póster grande · metadatos           │
│ (mini póster,  │  ┌────────┬─────────┬────────────┐   │
│  título, año,  │  │Episodios│ Releases│ Archivos   │   │
│  estado,       │  └────────┴─────────┴────────────┘   │
│  calidad, ruta)│  [Destino ▾] [Calidad ▾]  Descargar  │
└────────────────┴──────────────────────────────────────┘
```

Lo que absorbe de la web actual, por sección:

| Sub-vista | Películas | Series |
|---|---|---|
| **Biblioteca** | pestaña *Todas* de `Faltantes` | ídem |
| **Faltantes** + escaneo | ✔ | ✔ |
| **Estrenos** | `Calendario` (pelis) | `Calendario` (episodios) |
| **Releases / grab** | `ReleaseSearchModal` → **panel de detalle** | ídem, por episodio |
| **Calidad** (4K/3D, F-01) | ✔ | ✔ |
| **Archivos** (renombrar, escanear) | pestaña del panel | pestaña del panel |

**Fuera de las dos secciones** (sin cambio): `Dashboard`, `Trazabilidad`, `Disco`,
`Media Mixer`, `Configuración`.

#### Qué falta

| PR | Contenido | Estado |
|----|-----------|--------|
| **1** | Techo: navegación, `Page`/`PAGE_PATHS` **unificados** en el hook, envolturas maestro–detalle con estados vacíos | ✅ **PR #110**, `00b042a`, 284 tests |
| **2** | Mover **Biblioteca + Faltantes** (`MediaPane` extraído) | ✅ **PR #111**, `32ef040`, 291 tests |
| **3** | **Estrenos** en las dos secciones (`Calendar` con filtro por tipo) | ✅ **PR #112**, `040dd09`, 296 tests |
| **4** | **Calidad**: el backend expone `quality` para la biblioteca (**hoy no existe**) + sub-vista con badges 4K/3D | ⬜ |
| **5** | El modal de releases → **panel de detalle** (el corazón del diseño) | ⬜ |
| **6** | **Archivos** como pestaña del panel; retirar `Faltantes`/`Calendario` del menú | ⬜ |

> **El plan creció de 4 a 6 PRs** al comprobar que `AllMovie` **no lleva `quality`** y que
> **ningún endpoint** la expone para la biblioteca — la sub-vista *Calidad* no tenía de dónde
> leer. Por eso Calidad ganó su propio slice de backend y el modal→panel se separó.

**La extracción** (PR 2): `MissingContent` pasó de **929 → 84 líneas**; el listado entero —
4 queries infinitas, observer, búsqueda con debounce, ambos modales, acciones — vive ahora en
**`MediaPane`**, que reutilizan las dos secciones. Las **sub-vistas son el filtro**
(`Biblioteca` → `all`, `Faltantes` → `missing`), y **cada vista tiene su espacio de hash
propio** para que una búsqueda no se filtre a otra.

🔒 **La garantía**: los **6 tests que fijan el comportamiento de `MissingContent` quedaron con
`git diff` vacío** — una extracción que obliga a editarlos sería la extracción equivocada.

**Detalle que no es cosmético**: las dos páginas van en `hiddenPages` como
`trace`/`wanted`/`calendar` — leen de Radarr y Sonarr, así que **sin arr desaparecen** en vez
de mostrar dos envolturas muertas.

**`Page` estaba duplicado** (hook + Sidebar) y nada impedía que se desincronizara; el hook es
ahora el **único dueño** y el Sidebar re-exporta el tipo.

## 🔵 Recomendaciones y reglas del ciclo

C-01…C-07 son mías; **C-08 es tuya** («siempre hardlink») y ya está aplicada.

| ID | Feature | Por qué, con evidencia |
|----|---------|------------------------|
| **C-01** | **Aviso de import bloqueado** (webhook/Telegram/email) | La app *existe* para detectar que el flujo se corta, y hoy solo te enteras si miras la pantalla. El ROADMAP ya lo tenía en Fase 4. |
| **C-02** | **Gestor de import bloqueado**: reintentar / limpiar en un clic | Hay un caso real documentado en producción (`Transformers … 2160p`, `importBlocked`). Hoy solo se *ve*, no se actúa. |
| **C-03** ✅ | **E2E con Playwright** | **Entregado en #97-#100**: `e2e/` + 5 specs + stub `fake-arr` con payloads capturados + CI en dos fases (bare / con stub). B-01 y B-02 eran exactamente el tipo de fallo que ni el CSS ni los tests unitarios cazan. |
| **C-04** | **Upgrades automáticos programados** 1080p → 4K | Extensión natural de F-01: en vez de pedirlo a mano, una cola de upgrade por perfil de calidad. |
| **C-05** | **Rate limiting + Request ID** | Ya en el backlog (#13/#14). Ahora que hay auth por API key, una key filtrada sin límite es un agujero. |
| **C-06** | **Responsive + dark mode** | Ya en el backlog (#10/#11). Ninguna prueba visual. |
| **C-07** | **Ajuste de `IMPORT_TIMEOUT` desde la UI** | Lo que ya estaba pendiente en este documento: el backend lo soporta (`intervals.import_timeout`), falta el control en la pestaña *Configuración*. Ojo: `intervals.*` **no** está en `RESTART_REQUIRED_FIELDS` pero `background_checker` lo lee en import (`status.py:79`). |
| **C-08** | **Regla «siempre hardlink»** — nada rompe la semilla | Un cliente de descargas comparte la **ruta**, no el inodo: renombrar o mover borra la entrada sembrada aunque los datos sobrevivan. Aplicada a la cola (move), a `rename`, al endpoint muerto `/api/files/move` (fuera) y a `copytree` (ahora enlace duro por fichero). **Pendiente:** `importMode: "Move"` en `clients.py:1465,1474`, a probar contra el ajuste de hardlinks de Radarr. | ✅ |

**Descartadas (con motivo):** *WebSockets para progreso* — la cola ya usa polling adaptativo
(3-5 s activo / 15-30 s en reposo) y el WebSocket de aMuTorrent es de comandos, no de
progreso (verificado). *DI con `Depends()`* — refactor sin efecto observable.

---

### C-03 · Decisiones de implementación (tomadas)

| Pregunta | Decisión | Por qué |
|---|---|---|
| **¿Servidor arr falso?** | **Sí, stub con payloads capturados** — pendiente de implementar | El repo ya tiene la convención: `tests_wanted_scan.py` dice *"Shape captured from a real Radarr response"*. Un stub alimentado con capturas reales miente mucho menos que datos escritos a mano, y un stub **aparte** no toca una línea de código de producción (un modo `FC_FAKE_ARR` dentro del backend sería una costura que puede quedarse colgada) |
| **¿El `e2e` frena `docker-push`?** | **De momento no** — y el criterio de promoción está escrito **en `ci.yml`**, junto al job | Un e2e rojo ya se ve en el PR y en `main`; lo que no debe pasar es que una suite de browser nueva inestable retenga imágenes. Criterio: **20 corridas verdes seguidas en `main`** sin intervención y sin `waitForTimeout` en los specs |
| **`scripts/test-calendar-grab.sh`** | **Reubicado** a `e2e/smoke/calendar-grab.sh` | No era un test: **cero aserciones**, esperas fijas de hasta 250 s, selectores por clase, `npx playwright test --config=/dev/null \|\| node`. Y pedía la API key **como argumento** con un ejemplo que era **tu servidor de producción**. Sigue existiendo porque es lo único que ejercita el grab real — pero ahora sin URL por defecto y con la clave **solo de entorno** |

**Los 6 endpoints que un stub tendría que servir** para el flujo del backlog:
`/api/v3/wanted/missing` · `/api/v3/movie/{id}` · `/api/v3/release` · `/api/v3/indexer` ·
`/api/v3/command` (grab) · `/api/v3/queue`. Para toda la app, **23** (añade `history`,
`downloadclient`, `rootfolder`, `remotepathmapping`, `series/*`, `calendar`, `rename`,
`manualimport`…). Un "grab" falso no descarga nada: se prueba el **flujo de UI**, no la
descarga — legítimo, pero hay que saberlo.

---

## 🗄️ Completado (histórico)

Ver `README.md` → *Backlog de mejoras* para las tablas cerradas (#1-#24).

---

## Orden propuesto

`F-07` → `F-01` → `C-01/C-02` — **F-06 aparte, sin fecha**
