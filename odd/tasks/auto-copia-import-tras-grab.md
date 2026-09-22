# Auto-copia a la carpeta final e import tras el grab

## Objective

Que una descarga lanzada desde la app acabe sola en la carpeta final del título y se importe,
sin tener que buscarla a mano en "En carpeta".

## Problem

Al buscar releases y descargar (`ReleaseSearchModal` → `grabCalendarRelease`), la descarga la hace
aMuTorrent, pero el archivo no acaba en la carpeta de la biblioteca: hoy hay que ir a "📁 En
carpeta", localizarlo y moverlo. Ese paso manual es lo que el usuario quiere eliminar.

**Hallazgo que redefine el trabajo**: el "motor" ya existe. `copy_engine.do_action("copy_files")`
resuelve la carpeta final (`arr_series_root_folder` + `Season N`, `arr_movie_root_folder`), construye
el nombre correcto (`Serie - S03E07 - Título.ext` / `Título (Year) Quality.ext`), copia troceado con
progreso y cancelación, y después dispara `ProcessMonitoredDownloads` + `verify_import`, que sondea
hasta `IMPORT_POLL_TIMEOUT` (40 s) distinguiendo `imported`, `renamed_needed` e `import_timeout`
(`copy_engine.py:337-409`, `run_copy_background`, `verify_import`).

Lo que falta **no es un motor: es un disparador.** Cambia el tamaño y los riesgos del trabajo.

Dos límites reales del motor actual, que hay que arreglar antes de automatizarlo:

1. El **smart rename solo se aplica cuando la fuente es un fichero** (`copy_engine.py:366`). Con un
   payload en carpeta —lo normal— los ficheros van a la raíz de la biblioteca con el nombre crudo.
2. En carpeta copia **solo el primer nivel** (`src.iterdir()`, no recursivo): un release con
   subcarpetas pierde contenido.

## Why

Petición del usuario, textual: "una vez se descargue el archivo se copie (ya que hay que
compartirlo unos días) a la carpeta final y luego se importe, así nos ahorramos lo de buscarlo
en la carpeta porque ya sabemos dónde se va a guardar".

Y una consecuencia de coste que conviene ver: copiar mantiene el original para seguir sembrando,
lo que **duplica el espacio** durante la ventana de compartición. Si origen y destino están en el
mismo volumen —el caso de torrents, `/mnt/storage` para ambos— un **hardlink** da lo mismo (queda
en la biblioteca y sigue sembrando) con **cero espacio extra** y sin copiar 20 GB. El fallback a
copia es para cuando cambia el volumen (p. ej. `shared-downloads` en `/mnt/storage-6tb`).

## Hechos verificados contra la API real (2026-09-22)

Verificado con llamadas de solo lectura a Sonarr y Radarr reales. Esto cierra los dos desconocidos
que bloqueaban el diseño:

1. **`/api/v3/episode?seriesId=<id>` SIN `seasonNumber` devuelve TODAS las temporadas.**
   Medido: `seriesId=1` → **204 episodios, temporadas 0 a 9**. Campos confirmados uno a uno:
   `id`, `seriesId`, `seasonNumber`, `episodeNumber`, `title`, `airDateUtc`, `hasFile`.
   Consecuencia: el enriquecido por serie no necesita abanico por temporada.

2. **El registro de grab del arr trae los identificadores que hacen falta.**
   En `/api/v3/history?eventType=1` (grab):

   | Campo | Dónde | Valor observado |
   | --- | --- | --- |
   | `movieId` | nivel raíz (Radarr) | `855` |
   | `seriesId` / `episodeId` | nivel raíz (Sonarr) | `28` / `2286` |
   | `downloadId` | nivel raíz | `467250D5…414A00000000` (mayúsculas, **con** relleno) |
   | `data.guid` | dentro de `data` | `467250d5…414a` (minúsculas, **sin** relleno) |
   | `data.torrentInfoHash` | dentro de `data` | igual que `downloadId` |
   | `data.downloadClientName` | dentro de `data` | `aMuTorrent` |

   **Matiz importante, y corrección de mi primera lectura**: `data.guid` **no** es el guid del
   release del indexador; es el hash del cliente de descarga (idéntico a `downloadId` sin relleno).
   Por tanto **no se puede casar el grab de la app contra el historial por el guid del release**.
   El casamiento fiable es por **(id del título + ventana temporal)**, y a partir de ahí por hash.

   Detalle bonito que además valida el parser: entre los grabs reales de Sonarr aparece
   `Padre.made.in.USA.(American.dad).3x07.De.Hombres.y.hielo…` — es exactamente el ejemplo que puso
   el usuario (`s03e07 Of Ice Men 2006-11-27`). La forma `NxNN` no es hipotética en esta biblioteca.

3. **Mapa de sistemas de ficheros (medido, no supuesto).** Un hardlink solo es posible dentro del
   **mismo sistema de ficheros**, así que importa el `st_dev`, no la ruta ni la "carpeta":

   | Origen | Destino de biblioteca | Mismo FS | Resultado |
   | --- | --- | --- | --- |
   | Torrents `/mnt/storage/downloads/qbittorrent/completed` (NFS, dev 2097182) | Películas `/mnt/storage/movies/es` (mismo NFS, dev 2097182) | ✅ | **hardlink** |
   | Torrents (dev 2097182) | Series `/mnt/storage-6tb/shared-media/shows` (ZFS, dev 2097230) | ❌ | copia |
   | aMule `/mnt/storage-6tb/shared-downloads/amule` (ZFS, dev 2097230) | Series (ZFS, dev 2097230) | ✅ | **hardlink** |
   | aMule (dev 2097230) | Películas (dev 2097182) | ❌ | copia |

   El resultado es **diagonal**: los torrents enlazan con películas, los de aMule con series. Un
   hardlink dentro del mismo montaje NFS es una operación del servidor (no cruza datos por la red),
   así que también es barato ahí.

   ⚠️ **La mudanza planificada invierte el mapa.** Llevar los torrents a
   `/mnt/storage-6tb/shared-downloads/torrents-download` los mueve al FS de 6tb: **ganan** el
   hardlink con series y **pierden** el de películas — esas volverían a copiar y a duplicar espacio
   durante toda la ventana de compartición. Mejor saberlo antes de la mudanza que después.

## Decisiones de diseño

**Validadas por el usuario el 2026-09-22**: D1 (barrido on-demand sobre las trazas), D2 (disparar
solo si el arr no va a importar) y D3 (solo los grabs hechos desde la app).

### D1 — Dónde vive la vigilancia → **función pura + barrido on-demand**

| Opción | Pro | Contra |
| --- | --- | --- |
| (a) Bucle en el backend | funciona con la app cerrada; estado único | ciclo de vida, cancelación y rehidratar pendientes tras reinicio |
| (b) Barrido sobre las trazas que ya se calculan | cero infraestructura nueva; `build_traces` ya reúne grab + cola + torrents + rutas y ya calcula `derive_stage`; trivial de testear y depurar | solo actúa con la app abierta |
| (c) Webhook de Radarr/Sonarr | dirigido por evento, latencia cero | hay que configurarlo fuera de la app; endpoint de entrada nuevo; eventos perdidos si la app está caída |

**Propuesta**: (b), con la decisión escrita como **función pura sobre la traza**. El driver es un
detalle: el día que se quiera (a) es envolverla en un bucle, y (c) es llamarla desde un webhook.
Empezar por (a) es el camino caro — meter ciclo de vida y estado antes de saber si la decisión es
buena.

### D2 — Cuándo disparar → **solo cuando el arr NO va a importar**

Disparar "al terminar la descarga" está mal: Radarr/Sonarr importan solos en el camino feliz, así
que competir con ellos produce **dos copias del mismo contenido**, un fichero huérfano en la
biblioteca y dos candidatos para el mismo título. El propósito de esta app es la **excepción**
(import bloqueado por categoría o mapeo), no duplicar lo normal.

**Propuesta**: disparar cuando la traza dice que el arr no va a importar — `import_blocked`,
`importPending` persistente o "completado sin fichero tras N minutos" — reutilizando `derive_stage`.
Más **marca persistida** en el historial SQLite para idempotencia: sin ella, entre "copié" y "el arr
lo ve" hay una ventana (rescan/refresh tarda) y el ciclo siguiente copia otra vez. Y `has_file` como
guarda barata antes de tocar nada.

### D3 — Alcance → **solo los grabs hechos desde la app**

Registro propio, casado por `(id del título, instante del grab)` y después por hash.
Cubrir todo el historial mete a la app a mover contenido que nadie le pidió, y convierte "copiar a
la biblioteca equivocada" en un fallo posible. Ampliar cuando lo actual sea aburrido de fiable es
fácil; recortar después de que haya movido algo mal, no.

## Constraints

- **Nada de matching difuso en un camino que escribe.** `hash_matches` (`traces.py:69`) normaliza a
  minúsculas y prueba `rstrip("0")` de forma **exacta** — eso es seguro — pero su último recurso es
  comparación por **prefijos**. En automático se usa solo la parte exacta, nunca el prefijo.
- Escribir en la biblioteca es una mutación: debe respetar `SAFE_MODE`. Con modo seguro activo,
  detectar y proponer en lugar de actuar.
- El import del `arr` es el dueño de la biblioteca; esta ruta es la excepción, no la norma.
- `copy_files` con payload en carpeta no renombra ni baja de nivel (ver Problem).
- La app no tiene worker propio salvo `state.queue_consumer_task`.

## Plan

0. **[HECHO]** Verificar contra la API real los dos desconocidos (ver arriba).
1. **Arreglar `copy_files` antes de automatizarlo**: smart rename también para payload en carpeta, y
   recorrido recursivo. No tiene sentido automatizar un camino que hoy ensucia la biblioteca.
2. **Hardlink cuando origen y destino comparten volumen** (`os.stat().st_dev`), con fallback a copia.
   Es la diferencia entre duplicar 20 GB durante días y no gastar nada.
3. **La decisión como función pura**: traza → `copiar | esperar | no`, con marca de idempotencia.
4. **Driver (b)**: engancharla donde ya se calculan las trazas. Sin bucle ni ciclo de vida.
5. **Respetar `SAFE_MODE`** en el disparo automático.
6. **Observabilidad**: cada disparo como fila de historial con su motivo ("el arr no lo importó en
   N minutos"), para poder reconstruir qué hizo la app y cuándo.

## Tasks

- [x] **T1** `copy_files`: smart rename para payload en carpeta + recorrido recursivo
- [x] **T2** Copia con hardlink cuando el volumen coincide; fallback a copia
- [x] **T3** Función pura: traza → decisión, con la ventana de gracia
- [x] **T4** Marca de idempotencia persistida + guarda `has_file`
- [x] **T5** Registro de grabs propios (id del título + instante) y casamiento posterior por hash exacto
      — ver la corrección de alcance en la evidencia: el "hash exacto" del enunciado es
      `auto_copy_key` de **T4**; T5 cubre el registro y el casamiento por (id del título + instante)
- [x] **T6** Driver sobre las trazas existentes + respeto de `SAFE_MODE`
- [x] **T7** Log de transiciones de decisión, con su motivo — ver la corrección de alcance en la
      evidencia: no es "una fila por disparo" sino una fila por **cambio** de resultado, y cubre
      también `wait`/`skip`
- [ ] **T8** Tests de la función pura (los tres resultados) y de la idempotencia
- [ ] **T9** Verificación en vivo en el entorno real
- [x] **T10** Referencia temporal persistida para que la ventana de gracia pueda dispararse

## Acceptance criteria

- Tras un grab desde la app, si el arr no importa, el contenido acaba en la carpeta final **sin
  pasos manuales**.
- El original sigue disponible para seguir sembrando, y si el volumen coincide no hay copia física.
- Si el arr importó correctamente, la app **no hace nada** (cero duplicados).
- Un reinicio no re-copia lo ya copiado.
- Con `SAFE_MODE` activo, la app detecta y propone en lugar de actuar.
- El import queda confirmado o el fallo se reporta honestamente.

## Applicable checks

- Backend: `cd backend && python3 -m pytest -q`, `python3 -m pyflakes *.py routes/*.py`,
  `python3 -m vulture`
- Frontend: `cd frontend && npm test && npm run build`

## TDD

Desactivado (`strict_tdd: false`, origen `sdd-init/flow-controller`). Checks funcionales por tarea.

## Progress

- [x] Diseño cerrado: los dos desconocidos verificados contra la API real y **D1/D2/D3 validadas por
      el usuario** el 2026-09-22. Mapa de sistemas de ficheros medido.
- [x] **T1-T2 implementados y verificados** (evidencia abajo): esto arregla el motor, no el disparador.
- [x] **T3 implementado y verificado** (evidencia abajo): la decisión pura.
- [x] **T4 implementado y verificado** (evidencia abajo): la identidad estable, la marca
      idempotente persistida y la guarda `has_file`.
- [x] **T5 implementado y verificado** (evidencia abajo): el registro de grabs propios, la
      grabación en las rutas y el matcher puro.
- [x] **T6 implementado y verificado** (evidencia abajo): el driver del barrido, el disparador POST
      explícito, la corrección de la semántica de la marca y la deuda de vulture saldada.
- [x] **T10 implementado y verificado** (evidencia abajo): la referencia temporal persistida que
      cierra el hueco que T6 dejó abierto, y el arreglo del guard `arr_has_file=None` que solo se
      vuelve alcanzable con ella.
- [x] **T7 implementado y verificado** (evidencia abajo): el log append-only de transiciones de
      decisión (una fila por **cambio** de resultado, `wait`/`skip` incluidos), el cableado del
      driver, el endpoint `GET /api/auto-copy/history` y el panel de historial en Trazabilidad.
      **T8 y T9** siguen sin marcar.

## Verification evidence

Commits de código de este slice (rama `feat/auto-copia-import-tras-grab`, base `main`):

- **T1** `f00d620` — `fix(copy-engine): copy a folder payload recursively instead of dropping its subfolders`
- **T2** `03c70da` — `perf(copy-engine): hardlink instead of copying when the destination is on the same filesystem`

Comandos ejecutados en `backend/` (literal, sin recortes):

| Comando | Resultado literal |
| --- | --- |
| `python3 -m pytest -q` | `326 passed, 2 warnings in 14.73s` (en `main` eran `320 passed`; este slice añade 6 tests en `backend/tests_copy_engine.py`) |
| `python3 -m pyflakes *.py routes/*.py` | sin salida, exit 0 |
| `python3 -m vulture` | sin salida, exit 0 |

Tamaño del slice: `git diff --shortstat main...HEAD` → `2 files changed, 155 insertions(+), 8 deletions(-)`
(163 líneas cambiadas, por debajo del presupuesto de ~400). No incluye este fichero de diseño, que se
añade en el commit de documentación.

Alcance verificado y no verificado:

- **T1** quedó implementado como decidió la política de nombres: el payload en carpeta se copia
  **recursivo conservando la estructura relativa** y **no** se le aplica smart rename — el renombrado
  es del arr. El camino de un solo fichero mantiene su smart rename intacto. Esto es lo que pedía la
  decisión, aunque la descripción original de la tarea (arriba, T1) mencionara smart rename en carpeta.
- **T2** elige hardlink vs copia por filesystem (`os.link` primero; `EXDEV` y cualquier otro `OSError`
  caen a la copia troceada). El fallback por `EXDEV` está probado con `os.link` monkeypatcheado.
- **No verificado**: la ejecución real sobre los volúmenes de producción (T9) sigue pendiente. Lo que
  está probado es la lógica con tests locales, no el entorno NFS/ZFS real.
- **Frontend**: no se tocó en este slice.

### T3 — la decisión pura (commit `f69c66a`, rama `feat/auto-copy-decision`, base `main`)

`backend/auto_copy.py` (79 líneas) expone `COPY` / `WAIT` / `SKIP`,
`DEFAULT_GRACE_SECONDS` y `decide_copy(trace, *, now, since, ...)`: nueve reglas en orden,
primera que casa gana, con la ventana de gracia al final. Importa **nada** con efectos
secundarios (sin sesión, sin `state`, sin `config`, sin reloj). `backend/tests_auto_copy.py`
(160 líneas) cubre cada regla, el desempate `queue["status"]`, el fail-closed ante un
`stage` desconocido y un guard estructural de imports.

Comandos ejecutados en `backend/` (literal, sin recortes):

| Comando | Resultado literal |
| --- | --- |
| `python3 -m pytest -q` | `349 passed, 2 warnings in 20.93s` (en `main` eran `330`; este slice añade 19 tests en `backend/tests_auto_copy.py`) |
| `python3 -m pyflakes *.py routes/*.py` | sin salida, exit 0 |
| `python3 -m vulture` | sin salida, exit 0 |

Tamaño del slice: `git show --stat f69c66a` → `3 files changed, 248 insertions(+), 1 deletion(-)`
(248 líneas cambiadas, por debajo del presupuesto de ~400). El commit de documentación no
cuenta aquí.

Decisiones que este task tuvo que fijar y que el diseño no fijaba:

- **Ventana de gracia por defecto: 30 min** (`DEFAULT_GRACE_SECONDS = 1800.0`). Es el tiempo
  que se le concede al arr para importar solo antes de dejar de esperar.
- **`since` lo aporta el llamador, no se deriva de `trace["date"]`.** `date` es el instante
  del grab, no el de la condición observada; medir la ventana con él mediría lo que no es.
  Por eso la firma acepta `since=None` y **espera**: la política no adivina.

Cobertura de los 19 tests, regla a regla: `is_own_grab=False`, `already_handled`,
`arr_has_file=True`, `failed`, `sent`/`downloading`, `importing`, `import_blocked` con
`queue["status"] == "warning"`, `import_blocked` **sin** warning (el desempate que evita la
carrera de D2), `downloaded` con la ventana de gracia, el borde por dentro y por fuera,
`since` futuro (clock skew), `since=None`, `arr_has_file` `False`/`None`, `stage`
desconocido, traza sin `queue` ni `stage`, no mutación de la traza y el guard de imports.

**T8 sigue sin marcar**: la mitad de "tests de la función pura (los tres resultados)" la cubre
este slice; la mitad de **idempotencia** pertenece a **T4** (marca persistida). El estado actualizado
de esa mitad está en la sección de T4, abajo.

### T4 — identidad estable, marca persistida y guarda `has_file` (commits `01259f2`, `e8e01b1`)

Rama `feat/auto-copy-decision`, base `main`. `backend/auto_copy.py` (141 líneas) añade
`auto_copy_key(trace)` y el centinela `UNIDENTIFIED`: la identidad de un candidato, pura y sin
imports con efectos secundarios (el guard estructural de T3 sigue pasando). `backend/history.py`
sube `SCHEMA_VERSION` a 2 y añade la tabla `auto_copy_handled` con `mark_auto_copy` /
`is_auto_copy_handled`. `backend/clients.py` añade `arr_has_file`. Tests: 8 casos en
`backend/tests_auto_copy.py`, 6 en `backend/tests_history.py` y 9 en el nuevo
`backend/tests_arr_has_file.py`.

Comandos ejecutados en `backend/` (literal, sin recortes):

| Comando | Resultado literal |
| --- | --- |
| `python3 -m pytest -q` | `372 passed, 2 warnings in 16.54s` (en T3 eran `349 passed`; este slice añade 23 tests) |
| `python3 -m pyflakes *.py routes/*.py` | sin salida, exit 0 |
| `python3 -m vulture` | sin salida, exit 0 |

Tamaño del slice: `git diff --shortstat 6e7b535..HEAD` → `7 files changed, 531 insertions(+), 12
deletions(-)` (543 líneas cambiadas). **Por encima de un único PR de ~400**, así que va partido en
dos unidades de trabajo coherentes y encadenables: commit 1 `368 insertions(+), 12 deletions(-)`
(380 cambiadas) y commit 2 `163 insertions(+)` (163); cada una por debajo del presupuesto de ~400.
El commit de documentación no cuenta aquí. No se recortaron tests ni comentarios para caber: el
número real es el de arriba.

**Deuda de vulture, declarada** (`backend/vulture_whitelist.py`, sección "Not yet wired: the
auto-copy policy and marker await their driver"): se añaden `auto_copy_key`, `mark_auto_copy` e
`is_auto_copy_handled` (commit 1) y `arr_has_file` (commit 2); `decide_copy` ya venía de T3. Cada
entrada dice que es la política/marca de auto-copia a la espera del driver de **T6**. **T6 debe
eliminar TODAS las entradas de auto-copia** una vez que exista el driver: `decide_copy`,
`auto_copy_key`, `mark_auto_copy`, `is_auto_copy_handled`, `arr_has_file` y `matches_own_grab`
(esta última añadida por T5). Son deuda declarada, no
excepciones permanentes. Nota: `arr_has_file` no lo reporta vulture por casualidad —`decide_copy`
tiene un parámetro con el mismo nombre, así que el nombre ya "aparece referenciado"—; se whitelistea
explícitamente para que un futuro renombrado de ese parámetro no convierta deuda real en un hallazgo
sorpresa.

Decisiones que este task tuvo que fijar y que el diseño no fijaba:

- **La regla de normalización de la identidad**: `strip` y minúsculas; si el valor mide **más de
  40** caracteres y **todo lo que va después del 40 es cero**, se conservan los primeros 40; en
  cualquier otro caso se conserva entero. Un id genuino de **40** caracteres que termina en ceros
  **no** se trunca: sus ceros son parte del id, no relleno. Así el hash rellenado y el plano del arr
  (`467250D5…414A00000000` y `467250d5…414a`) dan la **misma** clave.
- **El matcher difuso queda prohibido en la identidad**: `traces.hash_matches` acaba en comparación
  por prefijos. Eso está bien para un humano mirando una pantalla, pero una identidad con un
  "casi" significa repetir una copia que no debía o saltarse una que tocaba. La clave es
  determinista y punto; el prefijo no entra aquí.
- **`arr_has_file` es de tres valores**: `True` si el arr dice que tiene el fichero, `False` solo
  si dice explícitamente que no, y `None` ante cualquier error, non-200 o campo ausente. El `None`
  no se colapsa a `False` en ningún punto: si lo hiciera, un fallo transitorio de red parecería
  "aún no importado" e invitaría a una copia duplicada. El episodio pregunta por
  `/api/v3/episode/{id}`, no por la serie entera, porque `arr_import_status` lee el primer episodio
  de una temporada y es demasiado grueso para "este episodio ya está importado".

**T8 sigue sin marcar.** Mitad de función pura: cubierta en T3. Mitad de idempotencia: **parcialmente
cubierta aquí** — el marcador se escribe y se relee, se re-marca como upsert, una clave desconocida
lee como no manejada, y la migración v1→v2 existe y es usable (`backend/tests_history.py`); la
identidad sobre la que se indexa el marcador está cubierta en `backend/tests_auto_copy.py`. Lo que
**no** está cubierto: el comportamiento de idempotencia **de extremo a extremo** (un driver que
consulta la marca y se salta la segunda copia tras un reinicio), que necesita a T6. No se reclama
T8.

### T5 — saber qué grabs son nuestros (commits `b578116`, `3cdb487`)

Rama `feat/auto-copy-own-grabs`, base `feat/auto-copy-decision`. Nota honesta de base: **`main`
todavía NO lleva T3/T4** (`backend/auto_copy.py` no existe ahí y su `history.py` es
`SCHEMA_VERSION = 1`), así que ramificar desde `main` habría exigido reimplementar T3/T4 —
justo lo prohibido. La rama se corta desde la rama que de verdad los lleva.

`backend/history.py` sube `SCHEMA_VERSION` a 3 y añade la tabla `own_grabs` con la misma
disciplina que v2 (`CREATE TABLE IF NOT EXISTS` dentro del `executescript` que `init_db` corre en
cada arranque, así que un v2 real gana la tabla sin ALTER) más el escritor `record_own_grab`.
Es best-effort: bloqueo del módulo, log de aviso y retorno; nunca excepción, porque corre dentro
del handler del grab y **no puede** tumbar la app ni convertir un grab correcto en un fallo.
**No** se añade el lector todavía: su único consumidor es el driver de T6 y una función pública
sin llamador sería otra entrada de vulture. El contrato que T6 debe implementar queda escrito en
un comentario: `list_own_grabs(...) -> list[dict]`, filas más nuevas primero con las columnas de
`own_grabs` (`id`, `source`, `movie_id`, `episode_id`, `series_id`, `guid`, `indexer_id`,
`grabbed_at`), listas para pasar a `matches_own_grab`. `backend/routes/calendar.py` registra en
`calendar_grab` y en `calendar_grab_batch` cada grab que de verdad tuvo éxito —una fila por guid
en el lote— sin cambiar la respuesta ni el comportamiento de la ruta.

**Corrección de alcance, explícita.** La mitad del enunciado "casamiento posterior por **hash
exacto**" **ya estaba entregada por T4**: `auto_copy_key` normaliza el id de descarga de forma
determinista (40 caracteres más cola de ceros, matcher difuso prohibido) y es la identidad del
marcador de idempotencia. T5 **no** la reimplementa ni la toca. T5 cubre las otras dos mitades:
**el registro** de grabs propios y **el casamiento por (id del título + instante)**. Que nadie
lea la fila de T5 y crea que se saltó algo: el "casamiento por hash" del enunciado es
`auto_copy_key`, de T4.

**El `guid` es solo auditoría.** En un registro de grab del arr, `data.guid` es el hash del
**cliente de descarga**, no el guid del release del indexador (medido contra la API real). Por eso
no se puede casar el grab de la app contra el historial por el guid del release; el casamiento es
por (id del título + instante). El `guid` se guarda para auditoría y el comentario del esquema
avisa de que no se "optimice" a un join por guid.

### T5 — el matcher puro (`backend/auto_copy.py`)

`matches_own_grab(trace, own_grabs, *, window_seconds=DEFAULT_GRAB_WINDOW_SECONDS) -> bool` es
puro y mantiene la regla estructural del módulo: sigue sin `aiohttp`, `state`, `history`,
`config`, `os` ni `time` (el guard de imports de T3 sigue pasando); solo añade `datetime`.
Responde sí/no:

- mismo `source` que la fila del registro;
- misma identidad de título: `ids["movie_id"]` compara movie ids, `ids["episode_id"]` compara
  episode ids; una traza sin ninguna de las dos **no casa** (respuesta honesta; la política ya
  trata un no-casamiento como "skip");
- el `date` de la traza dentro de
  `[grabbed_at - GRAB_CLOCK_SKEW_SECONDS, grabbed_at + DEFAULT_GRAB_WINDOW_SECONDS]`. El arr
  escribe su fila momentos **después** de nuestra petición, así que cae justo pasado `grabbed_at`;
  exigir igualdad exacta no casaría nada;
- un `date` ausente o no parseable es un no-casamiento: nunca adivina y nunca lanza.

**Constantes y por qué**:

- `DEFAULT_GRAB_WINDOW_SECONDS = 120.0` (2 min): tolerancia, no rango de búsqueda. Demasiado
  estrecha y se pierde el grab de un arr lento (la app no actúa: el statu quo); demasiado ancha y
  un grab manual **posterior** del mismo título se nos atribuye y la app lo copia. Se inclina a
  estrecha por D3 ("ampliar cuando lo actual sea aburrido de fiable es fácil; recortar después de
  que haya movido algo mal, no"). El límite superior es inclusivo y está probado por dentro y por
  fuera.
- `GRAB_CLOCK_SKEW_SECONDS = 30.0`: si el reloj de este host va por delante del del arr, el `date`
  del arr puede caer antes de `grabbed_at`; esto solo cubre ese desfase, y por eso el límite
  inferior es `grabbed_at - skew`, no igualdad exacta.

Tests: 13 casos en `backend/tests_auto_copy.py` (mismo movie, mismo episode, source distinto, id
distinto, borde por dentro/por fuera de la ventana, borde de skew, fecha ausente, fecha no
parseable, sin identidad de título, registro vacío, fila sin `grabbed_at`), 4 en
`backend/tests_history.py` (round-trip, instante por defecto, no-op con la BD no disponible,
migración v2→v3 sobre una base v2 construida a mano) y 4 en `backend/tests_routes.py` (grab OK
registra ids y source, grab fallido no registra nada, el lote registra uno por guid OK, BD no
disponible no hace fallar el grab). Un test existente (`test_init_db_migrates_a_v1_database...`)
afirmaba `user_version == 2`; se actualizó a `history.SCHEMA_VERSION` porque un fichero v1 ahora
avanza hasta la versión actual. El resto de sus aserciones (tabla nueva usable, fila legacy
intacta) siguen igual.

Comandos ejecutados en `backend/` (literal, sin recortes):

| Comando | Resultado literal |
| --- | --- |
| `python3 -m pytest -q` | `393 passed, 2 warnings in 17.08s` (en T4 eran `372 passed`; este slice añade 21 tests) |
| `python3 -m pyflakes *.py routes/*.py` | sin salida, exit 0 |
| `python3 -m vulture` | sin salida, exit 0 |

Tamaño del slice: `git diff --shortstat b580f33..3cdb487` → `7 files changed, 572 insertions(+), 4
deletions(-)` (576 líneas cambiadas), **por encima del presupuesto de ~400**. Se parte en dos
unidades de trabajo coherentes y encadenables, cada una por debajo del presupuesto: commit 1
`b578116` `324 insertions(+), 3 deletions(-)` (327 cambiadas: el registro + la ruta) y commit 2
`3cdb487` `248 insertions(+), 1 deletion(-)` (249 cambiadas: el matcher). El commit de
documentación no cuenta aquí. No se recortaron tests ni comentarios para caber: el número real es
el de arriba.

**Deuda de vulture declarada**: se añade `matches_own_grab` a `backend/vulture_whitelist.py` (su
único llamador es el driver de T6). Con esto, **T6 debe eliminar TODAS las entradas de auto-copia**
una vez que exista el driver: `decide_copy`, `auto_copy_key`, `mark_auto_copy`,
`is_auto_copy_handled`, `arr_has_file` y **`matches_own_grab`**.

**T8 sigue sin marcar.** La mitad de función pura está más cubierta ahora (T3 + el matcher de T5),
pero la mitad de **idempotencia de extremo a extremo** (un driver que consulta la marca y se salta
la segunda copia tras un reinicio) sigue necesitando a T6. El registro de T5 aporta la materia
prima del casamiento, no el comportamiento de idempotencia completo.

### T6 — el driver, el disparador y la marca (commits `bc23be8`, `d9ed9ba`, `7fe1f53`)

Rama `feat/auto-copy-sweep`, **cortada explícitamente de `origin/main`** (`git fetch origin` +
`git checkout -b feat/auto-copy-sweep origin/main`; `origin/main` = `85c92ce`, el merge de T5, y se
comprobó con `git merge-base --is-ancestor origin/feat/auto-copy-own-grabs origin/main` antes de
empezar). No se ramificó de `main` local.

Tres unidades de trabajo, cada una con el árbol en verde (se verificó cada commit de forma aislada):

| Commit | Qué entrega | Líneas cambiadas (add+del) |
| --- | --- | --- |
| `bc23be8` | `fix(history)`: la marca solo cuenta como "hecha" si se actuó | `95 insertions(+), 11 deletions(-)` → **106** |
| `d9ed9ba` | `feat(auto-copy)`: el driver `auto_copy_driver.sweep`, el lector `list_own_grabs`, el POST `/api/auto-copy/sweep`, la deuda de vulture saldada | `536 insertions(+), 38 deletions(-)` → **574** |
| `7fe1f53` | `test(auto-copy)`: los tests del driver y de la ruta | `564 insertions(+)` → **564** |

El commit de producción (`d9ed9ba`) y el de sus tests (`7fe1f53`) van separados por una restricción
real, no por gusto: `backend/tests_static.py::test_backend_has_no_dead_code` ejecuta vulture, y
`auto_copy_driver.sweep` no tiene llamador de producción hasta que existe la ruta, así que el driver
no puede aterrizar antes que el endpoint. Con eso, la unidad código+tests del driver+endpoint serían
~1138 líneas cambiadas, muy por encima del presupuesto. El corte honesto más pequeño es
producción (`574`) y luego sus tests (`564`); ambos commits dejan el árbol en verde. Si el padre
prefiere tests junto al código, `d9ed9ba`+`7fe1f53` son un mismo slice de PR de ~1138 líneas.

Comandos ejecutados en `backend/` (literal, sin recortes):

| Comando | Resultado literal |
| --- | --- |
| `python3 -m pytest -q` | `426 passed, 2 warnings in 18.63s` (en `main` eran `393 passed`; este slice añade **33 tests**) |
| `python3 -m pyflakes *.py routes/*.py` | sin salida, exit 0 |
| `python3 -m vulture` | sin salida, exit 0 |

Reparto de los 33 tests nuevos: 9 en `backend/tests_history.py` (5 de la semántica de la marca + 4
del lector `list_own_grabs`), 19 en `backend/tests_auto_copy_driver.py` y 5 en
`backend/tests_auto_copy_routes.py`.

**El disparador es una acción explícita, no un efecto de leer.** Es `POST /api/auto-copy/sweep`,
tras `Depends(verify_api_key)`, en un router propio (`routes/auto_copy.py`) registrado como los
demás. La operación desatendida es responsabilidad del usuario con un temporizador externo
(cron/systemd) que llame a ese endpoint: **no se añade bucle de fondo** (D1 lo rechazó) y **no se
engancha `GET /api/trace`**, que la UI sondea cada 15 s — engancharlo convertiría un GET en una
escritura de la biblioteca y dos pestañas abiertas en dos barridos.

**Arreglo de la semántica de la marca.** `is_auto_copy_handled` devolvía `True` para *cualquier*
fila de `auto_copy_handled`. Como un barrido con `SAFE_MODE` ahora registra una propuesta, esa fila
habría leído como "ya hecho" y, al apagar el modo seguro, el barrido siguiente habría creído que el
trabajo estaba hecho y **no habría copiado nunca, en silencio**. El arreglo: la `decision` guardada
distingue una acción tomada de una propuesta, y `is_auto_copy_handled` cuenta solo las actuadas.
`history.py` posee la etiqueta que él lee (`DECISION_ACTIONED`); el driver posee las que él escribe
(`proposed`, `dispatch_failed`). Un `dispatch_failed` tampoco bloquea, para que un fallo transitorio
no prohíba el reintento. Los tests prueban las dos direcciones: una propuesta **no** bloquea un
barrido posterior que actúa; una marca actuada **sí** bloquea; y un fallo se reintenta.

**El sentinela compartido no se toca.** Si `auto_copy_key` devuelve la forma `:title:unidentified`
(la traza no lleva ningún identificador), el barrido la salta sin leer ni escribir marca: todas las
trazas sin identificar comparten esa clave y una marca ahí suprimiría descargas no relacionadas.
El test lo prueba (`mark_auto_copy` y `is_auto_copy_handled` no se llaman).

**`has_file` se pregunta solo si la respuesta puede cambiar el resultado.** Se envía la sonda al
arr solo para trazas plausiblemente accionables (nuestro grab, no ya tratado y una etapa que pueda
llevar a una copia: `import_blocked`, `downloaded`); en cualquier otro caso se pasa `None`, que la
política trata como desconocido, nunca como "no hay fichero". El test cuenta las llamadas (una por
barrido con una traza accionable). Preguntarlo por cada traza sería una petición por traza y barrido.

**Un solo vuelo.** Un `asyncio.Lock` a nivel de módulo hace que un segundo barrido concurrente
devuelva un resultado honesto con `running=True` en vez de encolarse; el test lanza dos barridos
concurrentes y comprueba que solo hay un dispatch.

**Deuda de vulture saldada.** Se eliminaron las **seis** entradas de auto-copia de
`backend/vulture_whitelist.py` (`decide_copy`, `auto_copy_key`, `mark_auto_copy`,
`is_auto_copy_handled`, `arr_has_file`, `matches_own_grab`); las seis tienen ya llamador de
producción en `auto_copy_driver.py` y `vulture` pasa limpio. En el whitelist solo quedan
`queue_consumer_task` (referencia intencional para el GC) y `select_best_video` (decisión de
producto pendiente, ajena a este trabajo).

Alcance verificado y no verificado:

- **Verificado**: el árbol final pasa pytest/pyflakes/vulture. Cada uno de los tres commits se
  comprobó de forma aislada (con `git stash` ocultando lo posterior): `bc23be8` → `398 passed`;
  `d9ed9ba` → `402 passed`; `7fe1f53` → `426 passed`; los tres con pyflakes y vulture limpios.
- **La ruta tiene su propio router**, no se metió en `routes/actions.py`: `sweep` no es una acción
  del registro `ACTIONS` (no toma un `ActionRequest`) y el módulo de rutas sigue el patrón de "cada
  módulo registra su APIRouter". Así el feature puede crecer (la fila de historial de T7) sin tocar
  el ejecutor de acciones.
- **Cerrado por T10 — la ventana de gracia temporizada ya puede dispararse.** T6 dejó el driver
  pasando `since=None` a propósito: la traza no lleva el instante en que se observó por primera vez
  la condición actual, y su único timestamp —el `date` del grab— es *anterior* a la descarga, así
  que medir la gracia con él arrancaría el reloj antes de que la descarga terminara y competiría con
  el arr (lo que T3 advirtió). La consecuencia honesta de T6 fue que la única acción desatendida era
  el **warning de import** del arr (copia inmediata), mientras `downloaded` e `importPending` sin
  warning esperaban para siempre. T10 cierra ese hueco persistiendo la referencia ("primera vez
  visto") en la tabla `auto_copy_seen`, con `stage` incluido en la identidad; ver la evidencia de
  T10 más abajo.
- **No verificado — la FK de la función pura** no se toca: `backend/auto_copy.py` sigue sin imports
  con efectos secundarios y su guard estructural sigue pasando.
- **Frontend**: no se tocó en este slice. El botón de la UI es una tarea aparte (abajo).

### T10 — referencia temporal persistida para que la ventana de gracia pueda dispararse (commits `d3011d0`, `6e88902`)

Rama `feat/auto-copy-first-seen`, **cortada explícitamente de `origin/main`** (`git fetch origin` +
`git checkout -b feat/auto-copy-first-seen origin/main`; `origin/main` = `d3acd82`, el merge de la
documentación de T6; se comprobó con `git ls-tree origin/main backend/auto_copy_driver.py` que el
driver existe en esa base antes de empezar). No se ramificó de `main` local.

**El hueco que T6 dejó abierto, cerrado.** El barrido pasaba `since=None` a la política, así que la
ventana de gracia no podía dispararse nunca: la app solo actuaba sobre el **warning de import** del
arr, jamás sobre "la descarga terminó y el arr no se enteró" — el caso de categoría equivocada, que
es el común. El motivo de aquel `None` era real y sigue siéndolo: la traza no lleva el instante en
que se observó por primera vez la condición, y su único timestamp —el `date` del grab— es *anterior*
a la descarga, así que medir la gracia con él arrancaría el reloj antes de que esta terminara y
competiría con el arr (D2). La referencia se **persiste nosotros**: la primera vez que vemos un
candidato en una condición dada.

Cómo: `backend/history.py` sube `SCHEMA_VERSION` a 4 y añade la tabla
`auto_copy_seen (key TEXT PRIMARY KEY, stage TEXT NOT NULL, first_seen_at REAL NOT NULL)` con la
misma disciplina que v2/v3 (`CREATE TABLE IF NOT EXISTS` dentro del `executescript` que `init_db`
corre en cada arranque, así que un v3 real gana la tabla sin ALTER y el bump solo lo registra).
`note_auto_copy_seen(key, stage, *, seen_at=None) -> float` es **un único upsert atómico**
(`INSERT ... ON CONFLICT DO UPDATE ... RETURNING first_seen_at`) que devuelve el valor efectivo, con
estas semánticas: clave nueva → guarda `seen_at` (por defecto ahora) y lo devuelve; misma clave y
misma etapa → **conserva y devuelve el instante original** (esto es lo que permite a un barrido
posterior ver que la ventana venció); misma clave y **etapa distinta** → resetea `first_seen_at` a
`seen_at` y lo devuelve, porque una descarga que pasa de `downloading` a `downloaded` es una
condición NUEVA y su ventana arranca en la transición. Si la base no está disponible devuelve
`seen_at`, que se lee como "la ventana acaba de empezar" y hace que el barrido **espere** en vez de
actuar: la dirección segura. Ser atómico importa: con dos barridos concurrentes, un leer-y-luego-
escribir haría que ambos se vieran "nuevos" y se resetearan la ventana mutuamente.

`backend/auto_copy_driver.py` llama a `note_auto_copy_seen(key, trace.get("stage"))` y pasa el valor
**devuelto** como `since` a `decide_copy`, sustituyendo el `None` fijo. Solo lo llama para las etapas
que la política pueden decidir en la ventana (`downloaded`, e `import_blocked` **sin** warning) y
solo cuando la traza es nuestra y no está ya tratada; para `sent`, `downloading`, `importing` o
`failed` no escribe fila: esas trazas resuelven antes de la ventana y la tabla solo se llenaría de
ruido. Todo lo que T6 dejó establecido se mantiene: el lock de un solo vuelo, el centinela compartido
`UNIDENTIFIED` intacto, la sonda `has_file` solo para trazas plausiblemente accionables, `WAIT`/`SKIP`
sin escribir marca de manejado, y `SAFE_MODE` proponiendo en vez de actuar.

**El arreglo sutil que solo se vuelve alcanzable con ella** (`backend/auto_copy.py`). Al poder
vencer la ventana, un `downloaded` puede por fin llegar a la rama de copia, y entonces
`arr_has_file is None` deja de ser inofensivo: `None` significa que **no se pudo preguntar** al arr
(sin id, non-200, timeout, error de cliente), **no** que "el arr no tiene fichero". La política solo
saltaba con `True` y en cualquier otro caso caía a la ventana de gracia, así que un fallo transitorio
del arr más una ventana vencida **copiarían un fichero que el arr quizá ya importó** — un duplicado
en la biblioteca, justo lo que D2 y toda la guarda existen para evitar. Ahora, dentro de la ventana:
`since is None` → `WAIT`; ventana pendiente → `WAIT`; **ventana vencida y `arr_has_file is None`** →
`WAIT`, con motivo honesto ("no se pudo comprobar si el arr ya tiene el fichero"); ventana vencida y
guarda `False` → `COPY`. La rama `import_blocked` **con warning** no se toca: ahí el arr ya nos ha
dicho que está atascado y **sigue copiando aunque la sonda falle**, para que un fallo de sonda no
desactive en silencio el único camino que funciona hoy. El módulo sigue puro: sin `aiohttp`, `state`,
`history`, `config`, `os` ni `time` (el guard estructural de T3 sigue pasando).

Dos tests existentes se **corrigieron** (no se debilitaron ni borraron) porque fijaban el
comportamiento antiguo: `test_copies_just_after_the_grace_window` pasa ahora `arr_has_file=False`
para seguir probando el borde de la ventana, y `test_arr_has_file_unknown_does_not_skip` se convierte
en `test_arr_has_file_unknown_waits_after_the_window` porque un guard desconocido con la ventana
vencida ahora espera. También se actualizó una aserción de la migración v2→v3 en
`backend/tests_history.py` (`user_version == 3` → `history.SCHEMA_VERSION`), igual que T5 hizo con la
v1: un fichero v2 ahora avanza hasta la versión actual.

Comandos ejecutados en `backend/` (literal, sin recortes):

| Comando | Resultado literal |
| --- | --- |
| `python3 -m pytest -q` | `437 passed, 2 warnings in 19.87s` (en `main` eran `426 passed`; este slice añade **11 tests**) |
| `python3 -m pyflakes *.py routes/*.py` | sin salida, exit 0 |
| `python3 -m vulture` | sin salida, exit 0 |

Reparto de los 11 tests nuevos: 7 en `backend/tests_history.py` (6 de la semántica de
`note_auto_copy_seen` + la migración v3→v4 sobre una base v3 construida a mano), 1 en
`backend/tests_auto_copy.py` (el warning de import copia aunque la sonda no responda) y 3 en
`backend/tests_auto_copy_driver.py` (la referencia viene del store, la tabla se escribe solo para las
etapas relevantes, y la integración de dos barridos que acaba copiando al vencer la ventana).

Tamaño del slice: dos unidades de trabajo coherentes y encadenables, cada una por debajo del
presupuesto de ~400, pero el total **por encima** de un único PR:

| Commit | Qué entrega | Líneas cambiadas (add+del) |
| --- | --- | --- |
| `d3011d0` | `fix(auto-copy)`: el guard `arr_has_file=None` espera en vez de copiar | `55 insertions(+), 7 deletions(-)` → **62** |
| `6e88902` | `feat(auto-copy)`: la tabla `auto_copy_seen`, `note_auto_copy_seen` y el cableado del driver | `360 insertions(+), 11 deletions(-)` → **371** |

Total de código: **433 líneas cambiadas**, por encima de ~400. Se parte en dos commits por unidad de
trabajo (cada uno < 400); como PR único serían 433. El commit de documentación no cuenta aquí. No se
recortaron tests ni comentarios para caber: el número real es el de arriba.

**El orden de los commits es deliberado, no cosmético.** `d3011d0` (la guarda) va **primero**: en
cuanto la ventana puede vencer, la combinación `since` real + `arr_has_file=None` + ventana vencida
es un camino de copia duplicada. Poner el arreglo del guard antes evita que exista un commit
intermedio con esa vulnerabilidad. Cada commit se verificó de forma aislada: `d3011d0` →
`427 passed`; `d3011d0`+`6e88902` → `437 passed`; ambos con pyflakes y vulture limpios.

Alcance verificado y no verificado:

- **Verificado**: el árbol final pasa pytest/pyflakes/vulture. La integración de dos barridos con
  store real cierra el hueco: el primero persiste la referencia y espera, un segundo dentro de la
  ventana **no la resetea**, y un tercero con `now` pasado de la ventana **copia**.
- **No se añadió ninguna entrada a `backend/vulture_whitelist.py`.** `note_auto_copy_seen` tiene
  llamador de producción real en el driver; no hay deuda nueva que declarar.
- **Frontend**: no se tocó en este slice. El botón de la UI sigue siendo una tarea aparte (abajo);
  no se ejecutaron sus checks.

### UI — el disparador explícito en Trazabilidad (commits `226ee62`, `9795351`, `ec53b75`)

Rama `feat/auto-copy-ui`, **cortada explícitamente de `origin/main`** (`git fetch origin` +
`git checkout -b feat/auto-copy-ui origin/main`; `origin/main` = `16ae45b`, el merge de T10; se
comprobó con `git ls-tree origin/main backend/auto_copy_driver.py` que el driver existe en esa base
antes de empezar). No se ramificó de `main` local. **Nada bajo `backend/` se tocó.**

Tres unidades de trabajo, cada una por debajo del presupuesto de ~400:

| Commit | Qué entrega | Líneas cambiadas (add+del) |
| --- | --- | --- |
| `226ee62` | `feat(auto-copy)`: los tipos y el cliente de la API | `124 insertions(+)` → **124** |
| `9795351` | `feat(trace)`: el botón "Revisar descargas" y el panel de resumen | `324 insertions(+)` → **324** |
| `ec53b75` | `test(trace)`: los tests del disparador y sus estados | `237 insertions(+)` → **237** |

Total del slice: **685 líneas cambiadas**, por encima de un único PR de ~400. Se parte en tres
unidades de trabajo coherentes y encadenables. Los tests van en un commit propio por una
consecuencia aritmética, no por preferencia: el código de UI son 324 líneas, así que UI + tests
juntos serían 561 y rebasarían el presupuesto; separarlos mantiene cada commit revisable sin
recortar ni un test. El commit de documentación no cuenta aquí.

**Los tipos espejan la forma exacta del resumen, sin inventar campos.** `AutoCopySweepCounts` son
las claves de `_zero_counts()` (`traces`, `copy`, `copied`, `proposed`, `wait`, `skip`, `failed`);
`AutoCopySweepEntry` son las de `_entry()` (`key`, `source`, `title`, `decision`, `reason`,
`action`, `detail`); `AutoCopySweepResult` es la de `_summary()` (`ok`, `running`, `safe_mode`,
`detail`, `counts`, `entries`, `errors`, `started_at`, `finished_at`). `started_at`/`finished_at`
son opcionales porque el cuerpo de último recurso de `routes/auto_copy.py` no los trae, y `counts`
puede llegar como `{}` ahí: el panel los lee de forma defensiva (`?? 0`) en vez de confiar en el
tipo en tiempo de ejecución. Los nombres salen del driver, no de lo que un resumen "debería" tener
—la lección registrada de no construir un mock desde una suposición.

**`api/autoCopy.ts` es total: nunca rechaza.** `runAutoCopySweep()` hace `POST` a
`/api/auto-copy/sweep` por `apiFetch`, como el resto de módulos de api, y convierte un fetch
rechazado (offline, abortado, DNS), un non-2xx o un cuerpo ilegible en un resumen fallido con
`ok: false` y `errors`. Es el patrón de `grabCalendarRelease` en `api/calendar.ts`, y existe por la
misma razón: un spinner atascado fue un bug real y el botón no puede quedarse en "Revisando…".

**El botón reutiliza `actions.safe_mode`, no inventa una segunda fuente de verdad.** La página ya
recibe ese campo, y es la señal honesta de lo que el barrido hará; el panel lo usa para el aviso
destacado ("Modo seguro activo: no se ha copiado nada. Lo que sigue es lo que el barrido haría.").
Esa frase es lo que separa "la biblioteca se escribió" de "no se escribió", y tiene un test
dedicado que la afirma literal. Con `running: true` el panel dice que ya hay un barrido en curso en
vez de mostrar los ceros de la negativa; con `errors` no vacía los muestra, porque la ruta está
construida para no devolver 500 y esa lista **es** la señal de fallo; las entradas
`copied`/`proposed`/`failed` se listan con su `title` y su `reason` en español, mientras que las
`wait`/`skip` son solo un número para no llenar el panel de ruido; y cuando no hay nada accionable
hay un estado vacío honesto, no un panel en blanco.

**El componente no necesita `QueryClientProvider`.** Se comprobó renderizando `TraceView` con
props planas (`data={null}`): sin trazas no se monta `TraceActions`, que es el único hijo que
consulta. Los tests lo renderizan así, con `vi.stubGlobal('fetch', …)` y el mismo stub `ok/json` de
`__tests__/scanFolderNav.test.tsx`.

Cobertura de los 8 tests (`frontend/src/__tests__/traceAutoCopy.test.tsx`): el POST a la URL y el
método, los counts renderizados, la frase de modo seguro literal, el `reason` de una entrada, la
negativa por barrido en curso (sin ceros), la lista de `errors`, el estado vacío y el botón
deshabilitado durante la petición.

Comandos ejecutados en `frontend/` (literal, sin recortes):

| Comando | Resultado literal |
| --- | --- |
| `npm test` | `Test Files 25 passed (25)` / `Tests 190 passed (190)` (en `origin/main` eran `Test Files 24` / `182 passed`; este slice añade **8 tests**) |
| `npm run build` | `tsc -b && vite build` → `✓ 131 modules transformed` / `✓ built in 2.02s` |

También se ejecutó, sin tocarlo, el suite de backend para confirmar que sigue intacto:
`cd backend && python3 -m pytest -q` → `437 passed, 2 warnings in 19.59s`. `git status --short
backend` no devuelve nada: **el backend no se tocó**.

Alcance verificado y no verificado:

- **Verificado**: el árbol final pasa `npm test` y `npm run build` (que incluye `tsc -b`, así que
  cubre los errores de tipo). El conteo de tests sube: 182 → 190.
- **Verificado**: el botón solo dispara el `POST` explícito; no engancha el `GET /api/trace` que la
  UI sondea, así que leer trazas sigue siendo un GET.
- **No verificado**: la ejecución contra el backend real (T9). Lo probado es el panel con un fetch
  stub, no un barrido real con `SAFE_MODE` en el entorno del usuario.

### T7 — el log de transiciones de decisión (commits `197bfa9`, `32e7a8a`, `d4bf175`)

Rama `feat/auto-copy-history`, **cortada explícitamente de `origin/main`** (`git fetch origin` +
`git checkout -b feat/auto-copy-history origin/main`; `origin/main` = `ce0669d`, el merge de
`feat/marca-todas-calendario`; se comprobó con `git ls-tree origin/main backend/auto_copy_driver.py`
que el driver existe en esa base antes de empezar). No se ramificó de `main` local.

**Refinamiento del plan, y por qué.** T7 decía "fila de historial por disparo, con su motivo". Dos
problemas al tomarlo al pie de la letra:

1. **`auto_copy_handled` hace upsert por clave**, así que contiene *estado* (lo que la marca sabe
   ahora), no un historial: no puede dar una fila por disparo.
2. Un log que solo registrara lo que la app **hace** no respondería a la pregunta que toda esta
   feature plantea: *¿por qué no copió esto?* Un "esperar" silencioso es el resultado más común y el
   menos explicado.

Lo entregado es un **log append-only de transiciones de decisión**, por candidato: una fila cada vez
que su resultado **cambia**, no una por barrido. Con un temporizador de 15 minutos, una fila por
barrido enterraría la línea interesante bajo miles de "wait" idénticos. Se incluyen `wait` y `skip`
porque sus transiciones **son** la respuesta al "por qué no".

**"`WAIT` no escribe nada" no se contradice.** Esa regla gobierna la **marca de manejado**
(`auto_copy_handled`), que existe para impedir una segunda copia. Una fila del log no afirma nada y
no bloquea nada: solo deja constancia de que en ese instante el resultado observado era
`wait`/`skip`. La marca y el log tienen trabajos distintos, y la diferencia es deliberada.

**El valor registrado es el RESULTADO del barrido**, no el veredicto crudo de la política: la acción
cuando la hay (`copied`/`proposed`/`failed`) y la decisión de la política en caso contrario
(`wait`/`skip`). Un solo campo, así la UI no necesita una segunda consulta — y la transición
`proposed` → `copied` al apagar el modo seguro queda visible, que es justo el tipo de cambio que
merece una fila.

**El driver registra desde UN solo sitio**, el bucle de `_run_sweep` donde ya se calcula el resultado
de cada traza, para que ninguna rama de la política pueda olvidarse. El centinela compartido
`UNIDENTIFIED` nunca llega al log: todas las trazas sin identificar comparten esa clave, así que una
fila suya no describiría ninguna descarga concreta. El "último resultado por clave" se lee en **una
sola consulta agrupada por barrido** (`latest_auto_copy_decisions`), no una por traza; el escritor
(`log_auto_copy_decision`) mantiene su propia comprobación dentro del `INSERT` para que su contrato
valga para cualquier llamante. `recent_auto_copy_log` lee más-nuevo-primero y acota el `limit` (el
`LIMIT -1` de SQLite significa "sin límite"); `GET /api/auto-copy/history` va tras
`Depends(verify_api_key)` y devuelve `{items, error?}`: un almacén no disponible es una lista vacía
con el motivo, nunca un 500.

Tres unidades de trabajo, cada una por debajo del presupuesto de ~400 salvo la primera, que queda
~1% por encima:

| Commit | Qué entrega | Líneas cambiadas (add+del) |
| --- | --- | --- |
| `197bfa9` | `feat(auto-copy)`: la tabla `auto_copy_log` (v5), `log_auto_copy_decision`, `latest_auto_copy_decisions`, `recent_auto_copy_log`, `store_available`, el cableado del driver, el endpoint y los tests del store | `403 insertions(+), 2 deletions(-)` → **405** |
| `32e7a8a` | `test(auto-copy)`: los tests del cableado del driver y del endpoint | `197 insertions(+), 3 deletions(-)` → **200** |
| `d4bf175` | `feat(trace)`: los tipos, el cliente, el panel de historial y sus tests | `363 insertions(+), 3 deletions(-)` → **366** |

Total del slice: **971 líneas cambiadas**. `197bfa9` (405) queda marginalmente por encima del
presupuesto de ~400; los otros dos, por debajo. No se recortaron tests ni comentarios para caber: el
número real es el de arriba. El commit de documentación no cuenta aquí.

Comandos ejecutados (literal, sin recortes):

| Comando | Resultado literal |
| --- | --- |
| `cd backend && python3 -m pytest -q` | `489 passed, 2 warnings in 41.73s` (en `origin/main` eran `464 passed`; este slice añade **25 tests**) |
| `cd backend && python3 -m pyflakes *.py routes/*.py` | sin salida, exit 0 |
| `cd backend && python3 -m vulture` | sin salida, exit 0 |
| `cd frontend && npm test` | `Test Files 31 passed (31)` / `Tests 209 passed (209)` (en `origin/main` eran `Test Files 30` / `205 passed`; este slice añade **4 tests**) |
| `cd frontend && npm run build` | `tsc -b && vite build` → `✓ 132 modules transformed` / `✓ built in 1.79s` |

Reparto de los 25 tests nuevos del backend: **24 explícitos** —13 en `backend/tests_history.py` (la
regla de transición en las dos direcciones, la misma decisión con otro motivo que no añade fila,
`wait`/`skip`, `proposed` → `copied`, el mapa de últimos resultados, el lector más-nuevo-primero, el
límite y su acotado, la clave vacía, la degradación y la migración v4→v5 sobre una base v4 construida
a mano; 7 en `backend/tests_auto_copy_driver.py` (una fila por resultado, la acción gana al veredicto,
`dispatch_failed`, el centinela nunca llega, un resultado repetido no se registra, `proposed` →
`copied` de extremo a extremo y dos barridos idénticos dejan una sola fila; y 4 en
`backend/tests_auto_copy_routes.py` (items, pass-through del límite, auth y almacén no disponible sin
500)— más **1 caso parametrizado** que aparece solo: el guard genérico
`tests_routes.py::test_get_route_does_not_500_when_network_is_down` se parametriza sobre
`_get_paths()`, que lee el OpenAPI, así que la ruta nueva suma un caso. También se actualizó la
aserción de la migración v3 en `backend/tests_history.py` (`user_version == 4` →
`history.SCHEMA_VERSION`), igual que T5 y T10 hicieron con v1 y v2.

**No se añadió ninguna entrada a `backend/vulture_whitelist.py`.** `log_auto_copy_decision`,
`latest_auto_copy_decisions` y `recent_auto_copy_log` tienen llamador de producción en el driver y la
ruta; `store_available` lo tiene en la ruta. `auto_copy_log` es v5 y sigue la disciplina de migración
de v2/v3/v4: `CREATE TABLE IF NOT EXISTS` dentro del `executescript` que `init_db` corre en cada
arranque, así que un fichero v4 real gana la tabla sin ALTER y el bump solo lo registra.

Alcance verificado y no verificado:

- **Verificado**: el árbol final pasa pytest/pyflakes/vulture y `npm test`/`npm run build`. El
  conteo sube en ambos lados: backend 464 → 489 y frontend 205 → 209.
- **Verificado**: la regla de transición en las dos direcciones, con store real, tanto a nivel de
  store como de extremo a extremo con el driver (`proposed` → `copied`; dos barridos idénticos dejan
  una fila).
- **Verificado**: la migración v4→v5 sobre una base v4 construida a mano; las tablas y filas
  anteriores (`operations`, `auto_copy_handled`, `own_grabs`, `auto_copy_seen`) sobreviven.
- **Verificado**: el panel de historial carga con la página, refresca tras un barrido, rotula cada
  resultado en español y muestra un estado vacío honesto (o el motivo si el store no se puede leer).
- **No verificado**: la ejecución contra el backend real (T9). Lo probado es el panel con un fetch
  stub, no un historial real del entorno NFS/ZFS.
- **No verificado / abierto**: la suite completa no se corrió en cada commit intermedio de forma
  aislada; se corrió sobre el árbol final, y pyflakes/vulture (que no dependen de tests ni del
  frontend) dan limpio en ese mismo árbol. `197bfa9` (405 líneas) queda marginalmente por encima del
  presupuesto de ~400 por commit; el padre puede partirlo si lo prefiere.

## Next step

**T1-T6, T7, T10 y la UI hechos** (commits `f00d620` y `03c70da` para T1/T2; `f69c66a` para T3;
`01259f2` y `e8e01b1` para T4; `b578116` y `3cdb487` para T5; `bc23be8`, `d9ed9ba` y `7fe1f53` para
T6; `d3011d0` y `6e88902` para T10; `226ee62`, `9795351` y `ec53b75` para la UI; `197bfa9`,
`32e7a8a` y `d4bf175` para T7; evidencia arriba).

El siguiente trabajo es **T9** —**verificación en vivo en el entorno real**—, que es segura de
ejecutar con `SAFE_MODE` activo porque en ese modo el barrido solo propone y no toca la biblioteca.
**T8** sigue como estaba: la mitad de función pura está cubierta por T3 + T5 y la idempotencia de
extremo a extremo por T6 (`tests_auto_copy_driver.py`: una propuesta no bloquea, una marca actuada
sí, y un fallo se reintenta), pero darlo por cerrado es decisión del padre.

**T8 y T9 siguen sin marcar.** Lo probado hasta ahora es la lógica y los paneles con tests locales,
no el entorno NFS/ZFS real.

- **T1** `copy_files_to_root`: payload en carpeta → copia recursiva del árbol al destino
  **conservando la estructura relativa** y sin sobrescribir lo que ya exista. El camino de un solo
  fichero (smart rename) no se toca.
- **T2** Hardlink primero (`os.link`) y, si el destino está en otro sistema de ficheros (`EXDEV`) o
  el enlace no es posible, caer a la copia troceada. Validado por el mapa de FS medido.

Entrega de esta feature: `ask-on-risk` (por defecto), a decidir cuando se conozca el tamaño del slice.

Queda documentada abajo la decisión de nombres y las opciones que se descartaron.

## Política de nombres (decidida, T1)

**Decisión del usuario (2026-09-22): copiar todo, recursivo, tal cual**, conservando la estructura
interna del payload, y dejar que renombre el arr.

**Por qué conservar la estructura no es cosmético**: aplanar un recorrido recursivo metería
`Sample/sample.mkv` en la raíz de la carpeta de la película, y eso deja **dos vídeos en la misma
carpeta** — material perfecto para que el arr importe el sample como si fuera la película. Con la
estructura intacta, el vídeo principal sigue siendo el único de la raíz y las subcarpetas siguen
siendo subcarpetas.

Consecuencias aceptadas:

- El renombrado pasa a ser responsabilidad del arr (`Rescan`/`Refresh` ya se llaman desde
  `post_move_import`).
- Puede llegar material de relleno; con hardlink no cuesta espacio, solo orden.
- El payload de **un fichero** mantiene su smart rename actual: no se toca un camino que hoy funciona
  y que el usuario usa a mano.
- Los ficheros que ya existan en el destino **no se sobrescriben**.

Opciones consideradas (registro):

`copy_files` hoy solo renombra cuando la fuente es **un fichero** (`copy_engine.py:366`), y en carpeta
copia solo el primer nivel (`src.iterdir()`). Al escribir la especificación apareció el hueco: **no
está definido cómo elegir "el vídeo" ni qué hacer con lo que lo acompaña**, y hay tres casos reales
que se comportan distinto:

- Un release de película: una carpeta con **un** vídeo + subtítulos + `.nfo` + capturas.
- Un release de episodio con la carpeta `Subs/` dentro: los subtítulos no están junto al vídeo.
- Un **season pack**: una carpeta con **varios** vídeos, uno por episodio. Aquí "el vídeo" no existe
  en singular, y `arr_episode_metadata` devuelve los datos de un episodio, no de la temporada.

Opciones:

| Opción | Pro | Contra |
| --- | --- | --- |
| (a) Vídeo principal + sus acompañantes | biblioteca limpia; mantiene la idea original del smart rename | hay que definir el caso season pack (probablemente renombrar cada vídeo por su propio `SxxExx` parseado) |
| (b) Copiar todo, recursivo, conservando estructura | cero pérdida y cero política inventada | puede meter basura (samples, capturas) en la biblioteca y los nombres quedan crudos hasta que el arr renombre |
| (c) Copiar a un staging visible y dejar que **el arr** importe (`arr_manual_import`) | el dueño de la biblioteca decide nombres, incluido el pack | asimétrico: `import_service` solo usa manual import en Radarr; en Sonarr hoy solo hace rescan/refresh, así que no está garantizado |

**Recomendación**: (a) con regla explícita para season packs. (c) es arquitectónicamente más puro
—el arr es quien sabe nombrar— pero depende de que el manual import acepte lo que le des, y en Sonarr
esa ruta no existe hoy. Es la opción a la que me movería si (a) empieza a acumular casos especiales.
