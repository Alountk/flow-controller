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
- [ ] **T6** Driver sobre las trazas existentes + respeto de `SAFE_MODE`
- [ ] **T7** Fila de historial por disparo, con su motivo
- [ ] **T8** Tests de la función pura (los tres resultados) y de la idempotencia
- [ ] **T9** Verificación en vivo en el entorno real

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
      grabación en las rutas y el matcher puro. **T6-T9** siguen sin empezar.

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

## Next step

**T1-T5 hechos** (commits `f00d620` y `03c70da` para T1/T2; `f69c66a` para T3; `01259f2` y `e8e01b1`
para T4; `b578116` y `3cdb487` para T5; evidencia arriba), base `main` (la cadena de PRs de "En
carpeta" es independiente y no debe ser su base; T3 y T4 van en la rama `feat/auto-copy-decision`,
**desde la que se corta `feat/auto-copy-own-grabs` para T5**, porque `main` no los lleva). T4 supera
un único PR de ~400 líneas (543 cambiadas), así que su slice son dos PR encadenados: el commit 1
(identidad + marca, 380) y el commit 2 (guarda `has_file`, 163). T5 también supera ~400 en total
(576), así que va en dos unidades: registro + ruta (327) y matcher (249). El siguiente paso es
**T6-T9**: el driver sobre las trazas (que debe añadir el lector `list_own_grabs` sobre `own_grabs`
y llamar a `matches_own_grab`, eliminando de paso todas las entradas de auto-copia del whitelist de
vulture), la fila de historial por disparo y la verificación en vivo. **T8** sigue sin marcar: la
idempotencia de extremo a extremo depende de T6.

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
