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
- [ ] **T3** Función pura: traza → decisión, con la ventana de gracia
- [ ] **T4** Marca de idempotencia persistida + guarda `has_file`
- [ ] **T5** Registro de grabs propios (id del título + instante) y casamiento posterior por hash exacto
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
- [x] **T1-T2 implementados y verificados** (evidencia abajo). El resto del plan (T3-T9) sigue sin
      empezar: esto arregla el motor, no el disparador.

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

## Next step

**T1-T2 hechos** (commits `f00d620` y `03c70da`; evidencia arriba), en la rama
`feat/auto-copia-import-tras-grab` (base `main`; la cadena de PRs de "En carpeta" es independiente y
no debe ser su base). El siguiente paso es **T3-T9**: la decisión pura, la idempotencia, el registro
de grabs y el driver.

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
