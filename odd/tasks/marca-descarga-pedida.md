# Marca de "descarga pedida" en Faltantes

## Objective

Que en Faltantes se vea de un vistazo si un título **ya se pidió a descargar** y **cuándo**, para
no volver a pedirlo y para distinguir "no lo he pedido" de "lo pedí y no ha llegado".

> El alcance se amplió después, a petición del usuario, a la pestaña "Todas" y al Calendario (ver
> `Scope`). El mecanismo es el mismo; en "Todas" la marca sigue visible aunque el título ya haya
> llegado, porque ahí la pregunta es "¿lo pedí?".

## Problem

Las cards de Faltantes no dicen nada de esto. Si pediste una descarga y el título sigue faltando,
la card se ve exactamente igual que si nunca la hubieras pedido. Y esas dos situaciones significan
cosas opuestas: una es "hazlo tú", la otra es "esto está atascado en algún sitio".

Petición del usuario, textual: *"tanto los episodios o películas que le he dado a descargar debería
tener una marca de que se le ha dado a descargar […] es para saber si he puesto a descargar algo o
no, en las cards no sale ninguna información. Tal vez deberían salir en naranja estas cards y la
fecha de cuando se pidió la descarga."*

## Why

El dato **ya existe**: la tabla `own_grabs` (T5) guarda `source`, `movie_id` / `episode_id`,
`series_id`, `guid`, `indexer_id` y `grabbed_at` por cada grab lanzado **desde esta app**. Lo único
que falta es exponerlo.

Y la señal es más útil de lo que parece: como una descarga que se importa bien **desaparece** de
Faltantes, la marca solo se ve mientras el título sigue faltando. Un naranja con fecha de hace tres
días significa exactamente *"esto lo pedí y no ha llegado"* — que es justo lo que hoy no se puede
saber.

## Scope

Dentro:

- **`history.py`**: `own_grabs_latest_map(since)` → `{(source, kind, id): grabbed_at}` con `kind`
  en `{"movie", "episode", "series"}`, `MAX(grabbed_at)` por grupo. Una fila de episodio emite la
  clave del episodio **y** la de su serie, porque la pestaña "Todas" muestra cards de serie y una
  serie necesita su propia marca. La marca de serie es el grab de episodio más reciente. Sin
  `LIMIT`: el lector existente tiene uno por defecto y usarlo aquí truncaría marcas **en silencio**.
- **`routes/wanted.py`**: enriquecer con `grabbed_at` los items de `/api/wanted` (películas y
  episodios), `/api/wanted/all` (películas) y `/api/wanted/series/all` (series). Un solo helper
  `_attach_grabbed_at` cubre las dos formas de cuerpo (el agrupado de `/api/wanted` y la lista
  plana de los `/all` y el Calendario). **Fuera de la caché** de `_fetch_all_wanted`: esa caché es
  de los datos del arr, la marca es nuestra.
- **`routes/calendar.py`**: `/api/calendar` marca cada item por su propio `source` y `type` (los
  items ya traen ambos campos, así que el helper lee la clave del item).
- **Frontend**: card de película y fila de episodio en Faltantes, cards de película y serie en
  "Todas", y cards del Calendario, en naranja con `Pedida el <fecha>`. La lógica de la fecha se
  extrae a `frontend/src/utils/grabMark.ts` (una sola copia).
- **`TraceActions.tsx`**: quitar el guard `queueId` que esconde **"Reintentar import"** en
  `import_blocked`. La acción no usa ningún id — manda `ProcessMonitoredDownloads`, un comando **sin
  argumentos** — así que el guard es más estricto que la acción y esconde el botón justo cuando el
  item ya no está en la cola del arr y más falta hace.

Fuera:

- ~~La pestaña **"Todas"** y el **Calendario**: decisión de alcance del usuario, solo Faltantes.~~
  **REVERSADO por el usuario (2026-09-22)**: pidió explícitamente la marca también en la pestaña
  "Todas" y en el Calendario. Ambas superficies pasan a `Dentro` (T6-T9). La línea original se
  conserva tachada, no borrada, para no reescribir la historia de la decisión.
- **Rellenar marcas hacia atrás** desde el historial de los arrs: las descargas pedidas antes de
  desplegar T5 no aparecerán marcadas.

## Constraints

- Las marcas **empiezan vacías**: `own_grabs` solo escribe desde que T5 esté desplegado.
- El naranja es un **tercer estado** sobre cards que ya usan verde y rojo para otra cosa: tiene que
  convivir sin romperlos.
- Faltantes se pide en cada visita: el enriquecido es **una consulta**, no una por card.
- Sin límite arbitrario en el lector nuevo, o se pierden marcas sin avisar.

## Tasks

- [x] **T1** `own_grabs_latest_map` + tests (agrupación, máximo por grupo, ventana, degrada a `{}`)
- [x] **T2** Enriquecer `/api/wanted` con `grabbed_at` + tests (con marca y sin marca)
- [x] **T3** Cards y filas en naranja con la fecha + tests
- [x] **T4** Quitar el guard `queueId` de `retry_import` + test de visibilidad
- [x] **T5** Registro y evidencia (alcance original, solo Faltantes)
- [x] **T6** `own_grabs_latest_map` emite además la clave de serie + tests
- [x] **T7** Marcar `/api/wanted/all`, `/api/wanted/series/all` y `/api/calendar` + tests
- [x] **T8** Extraer `utils/grabMark.ts` y usarlo en Faltantes sin cambiar su comportamiento
- [x] **T9** Marca en las cards de "Todas" (película y serie) y del Calendario + tests
- [x] **T10** Registrar la ampliación de alcance y su evidencia (este documento)
- [x] **T11** Resolver el `series_id` en el path de escritura del grab del Calendario + tests de ida y vuelta (ruta → fila → mapa)

## Acceptance criteria

- Una película o un episodio con un grab propio y sin fichero muestra la marca **y la fecha**.
- Uno sin grab no muestra nada — no un guión ni un lugar vacío.
- Un título que se importó desaparece de Faltantes, y con él la marca.
- La card de una serie en "Todas" muestra la marca cuando se pidió **cualquiera** de sus episodios,
  y una card de película la muestra con su propio grab.
- Un item del Calendario muestra la marca según su propio `source` y `type`.
- `/api/wanted/all`, `/api/wanted/series/all` y `/api/calendar` devuelven `grabbed_at` **siempre
  presente** (`None` cuando no hay marca).
- "Reintentar import" aparece en `import_blocked` **aunque no haya `queue_id`**.
- Backend y frontend en verde; `pyflakes` y `vulture` limpios (sin entradas nuevas en el whitelist).

## Applicable checks

- Backend: `cd backend && python3 -m pytest -q`, `python3 -m pyflakes *.py routes/*.py`,
  `python3 -m vulture`
- Frontend: `cd frontend && npm test && npm run build`

## TDD

Desactivado (`strict_tdd: false`, origen `sdd-init/flow-controller`). Checks funcionales por tarea.

## Progress

- [x] T1-T4 implementados y verificados; T5 registrada abajo. Alcance original: solo Faltantes
  (más el arreglo del guard). La rama fue `feat/marca-descarga-pedida`, ya fusionada en
  `origin/main`.
- [x] T6-T9 implementados y verificados tras la **ampliación de alcance pedida por el usuario**
  (marca también en "Todas" y en el Calendario); T10 es este registro. La rama de la ampliación es
  `feat/marca-todas-calendario`, con base explícita en `origin/main` (no en un `main` local).
- [x] T11 implementado y verificado: el path de escritura del grab resuelve y guarda el `series_id`,
  así que la marca de serie de "Todas" ya puede encenderse en producción. Cierra el hueco que
  registraban las notas honestas de T6-T9.

## Evidencia de implementación

### Commits (un work unit por tarea)

| Tarea | Commit | Líneas cambiadas | Archivos |
|-------|--------|------------------|----------|
| T1 | `a5b25653e81f77f3231a9d87ab9e3b34613af1c3` | 97 (+97/-0) | `backend/history.py`, `backend/tests_history.py` |
| T2 | `a0d486ece1e89037a88c4f422fa65bee7aaf25f5` | 147 (+144/-3) | `backend/routes/wanted.py`, `backend/tests_routes.py` |
| T3 | `9f609920f52dd1bcf858101e8aee3ff0637a52a4` | 213 (+211/-2) | `frontend/src/types.ts`, `MissingContent.tsx`, `MissingContent.css`, `__tests__/grabbedMark.test.tsx` |
| T4 | `76468fa77fe35adacfe4c3f3a87ccd6c4a5189ab` | 80 (+79/-1) | `frontend/src/components/TraceActions.tsx`, `__tests__/traceActionsRetryImport.test.tsx` |

Total contra `origin/main`: **531 inserciones + 6 eliminaciones = 537 líneas cambiadas**. El
presupuesto de revisión es ~400, así que el conjunto **no cabe en un solo PR**. Cada commit es un
slice candidato y todos quedan por debajo de 400 (97, 147, 213, 80): se recomienda PR encadenado,
no recortar código ni tests para entrar en el presupuesto.

> T1-T5 ya están en `origin/main` (PR #51). La evidencia de esta tabla se conserva como historia;
> el PR de la ampliación NO los vuelve a contar.

### Commits de la ampliación (T6-T10, base `origin/main`)

| Tarea | Commit | Líneas cambiadas | Archivos |
|-------|--------|------------------|----------|
| T6 | `5e51a0b` | 86 (+69/-17) | `backend/history.py`, `backend/tests_history.py` |
| T7 | `5692fe0` | 219 (+197/-22) | `backend/routes/wanted.py`, `backend/routes/calendar.py`, `backend/tests_routes.py` |
| T8 | `9756329` | 262 (+148/-114) | `frontend/src/utils/grabMark.ts`, `frontend/src/components/MissingContent.tsx`, `frontend/src/__tests__/grabMark.test.ts` |
| T9 | `64e561f` | 345 (+253/-92) | `frontend/src/types.ts`, `frontend/src/components/MissingContent.tsx`, `frontend/src/components/MissingContent.css`, `frontend/src/__tests__/grabbedMarkTodas.test.tsx` |
| T9 | `97a1549` | 168 (+139/-29) | `frontend/src/components/Calendar.tsx`, `frontend/src/components/Calendar.css`, `frontend/src/__tests__/grabbedMarkCalendar.test.tsx` |

Total del código de la ampliación (T6-T9, sin el documento): **795 inserciones + 263 eliminaciones
= 1058 líneas cambiadas** (14 archivos). Todos los slices quedan por debajo de ~400 (86, 219, 262,
345, 168), así que se recomienda **PR encadenado**: cada commit es un slice candidato. T8 y T9
cuentan bastante **eliminación** porque el refactor convirtió dos `map` de expresión en `map` con
cuerpo (`const grabbed = …`) y eso reindenta bloques ya existentes; no se borró código, tests ni
comentarios para entrar en el presupuesto.

El commit de documentación (T10) es este mismo commit — no puede citar su propio SHA — y añade
`odd/tasks/marca-descarga-pedida.md`. El código de la rama contra `origin/main` son las 1058 líneas
en 14 archivos de arriba; el PR de la ampliación es ese código más este documento.

### Comandos de verificación (resultado literal)

- `cd backend && python3 -m pytest -q` → `449 passed, 2 warnings in 58.43s` (antes: 437; +12 pruebas)
- `cd backend && python3 -m pyflakes *.py routes/*.py` → sin salida, exit 0
- `cd backend && python3 -m vulture` → sin salida, exit 0 (sin entradas nuevas en el whitelist)
- `cd frontend && npm test` → `Test Files 27 passed (27)`, `Tests 197 passed (197)` (antes: 190; +7 pruebas)
- `cd frontend && npm run build` → `tsc -b && vite build`, `✓ 131 modules transformed`, `✓ built in 1.90s`

Los dos comandos de frontend se ejecutaron en pasos separados, nunca en paralelo.

### Verificación de la ampliación (resultado literal, estado final de la rama)

- `cd backend && python3 -m pytest -q` → `460 passed, 2 warnings in 99.36s` (antes: 449; +11 pruebas)
- `cd backend && python3 -m pyflakes *.py routes/*.py` → sin salida, exit 0
- `cd backend && python3 -m vulture` → sin salida, exit 0 (sin entradas nuevas en el whitelist)
- `cd frontend && npm test` → `Test Files 30 passed (30)`, `Tests 205 passed (205)` (antes: 197; +8 pruebas)
- `cd frontend && npm run build` → `tsc -b && vite build`, `✓ 132 modules transformed`, `✓ built in 1.67s`

Cobertura nueva (+11 backend): 3 tests de la clave de serie en `tests_history.py`; 8 tests de
endpoint en `tests_routes.py` (5 para los `/all`, 3 para el Calendario). Cobertura nueva (+8
frontend): 2 de `formatGrabMark`, 4 de las cards de "Todas", 2 del Calendario. Los tests de
Faltantes (`grabbedMark.test.tsx`) siguen pasando sin cambios.

Los dos comandos de frontend se ejecutaron en pasos separados, nunca en paralelo.

### Fix del `series_id` en el path de escritura (T11)

**Commit:** `af123ef` — `fix(calendar): record the series id a grabbed episode belongs to`.
**Tamaño:** **181 líneas cambiadas** (180 inserciones + 1 eliminación) en 3 archivos:
`backend/clients.py` (7), `backend/routes/calendar.py` (47), `backend/tests_routes.py` (127). Por
debajo del presupuesto (~400) en un solo slice.

**Qué faltaba.** `own_grabs_latest_map` solo emite la clave `(source, "series", id)` si la fila
lleva `series_id`, pero el **único** escritor de `own_grabs` — la ruta de grab del Calendario — no
lo enviaba: `grep -n "series_id" backend/routes/calendar.py` no devolvía nada. En producción
`series_id` era siempre NULL, la clave de serie no existía y las cards de serie de "Todas" no podían
encenderse nunca. `arr_episode_metadata` ya devolvía `seriesId` (desde `b02d222`; solo faltaba
documentarlo), así que el arreglo no necesitó tocar el cliente.

**Qué se hizo.** No se añadió `seriesId` a los modelos de request ni se tocó el frontend: los items
del Calendario no llevan id de serie, así que un valor enviado por el frontend habría dejado ese
camino roto igual. El arr ya conoce la serie, así que se pregunta una vez, en el grab: la ruta lee
`seriesId` tras un grab de episodio con éxito y lo pasa a `record_own_grab(..., series_id=...)`. La
consulta va **dentro de la misma sesión** del grab (un GET al mismo arr; abrir otra sesión solo
añadiría una conexión). Si la consulta falla, **degrada a `None`**: el grab se registra igual y la
respuesta sigue siendo `ok` — una descarga que funcionó no puede parecer fallida por una consulta de
seguimiento. Un grab de película pasa `None` y no emite clave de serie. La batch resuelve la serie
**una vez por petición** (todos los guids apuntan al mismo título) y la reutiliza para cada guid con
éxito.

**Cobertura nueva (+4 backend, `tests_routes.py::TestGrabWritesSeriesId`):** ida y vuelta por la
ruta (grab de episodio → fila con `series_id` real → `own_grabs_latest_map` emite la clave de
serie); película sin clave de serie; lookup fallido que aun así registra y responde `ok`; y la batch
registrando la serie por cada guid con éxito.

**Verificación (resultado literal, estado final de la rama):**
- `cd backend && python3 -m pytest -q` → `464 passed, 2 warnings in 57.32s` (antes: 460; +4 pruebas)
- `cd backend && python3 -m pyflakes *.py routes/*.py` → sin salida, exit 0
- `cd backend && python3 -m vulture` → sin salida, exit 0 (sin entradas nuevas en el whitelist)
- Frontend **no tocado** por este fix: no se ejecutaron sus checks.

**La lección (mismo modo de fallo que el bug de `altTitles`).** El lector estaba cubierto a nivel de
mapa (`tests_history.py`) y de endpoint (`tests_routes.py`), pero **cada test sembraba la fila con
`record_own_grab`** — escribía él mismo el `series_id` que el path real nunca escribía. El test
**estaba de acuerdo con el bug**: verde mientras producción tenía `series_id` siempre NULL,
exactamente el patrón del fixture de `altTitles` que declaraba el nombre equivocado que el código
leía. Los tests nuevos atraviesan la ruta y **después** leen el mapa, así que la marca de serie solo
puede ser un hecho de ida y vuelta. Comprobado en rojo: con la ruta importando el lookup pero sin
guardar su resultado, el test de ida y vuelta falla en `assert rows[0]["series_id"] == 99`; con el
fix, pasa.

### Decisiones que el plan no fijaba

- **Ventana de lookback** (`WANTED_GRAB_LOOKBACK = 90 días`, en `routes/wanted.py`). Compromiso:
  una ventana corta pierde la marca de una descarga realmente atascada justo cuando más importa;
  una larga deja que una marca de un intento antiguo afirme que el faltante actual se pidió cuando
  no fue así. 90 días cubren un pack de temporada lento y un mes de reintentos sin dejar de ser una
  afirmación sobre el estado presente.
- **Formato de fecha.** Lista de meses en español fijada a mano (`ene…dic`) para renderizar
  exactamente `19 sep 2026`: `toLocaleDateString('es-ES', { month: 'short' })` produce `sept` en
  este runtime y varía entre versiones de ICU. Sigue la convención de helpers ya existente
  (`FileManager.formatDate`, `TraceView.relativeTime`). T8 lo movió a un helper compartido
  (`utils/grabMark.ts`) en cuanto pasó de uno a cuatro consumidores.
- **Convivencia con el estado previo.** La card de Faltantes de una película no tenía badge; el
  hecho "falta" lo comunica la clase `status-error` (barra izquierda roja). La marca se superpone
  como `status-grabbed`: borde y tinte naranjas con la barra izquierda roja intacta, de modo que
  ambos hechos siguen visibles y ninguno sobrescribe al otro. No se añadió un badge nuevo.
- **La marca de serie se resuelve con un máximo en Python, no en SQL.** El `GROUP BY` de
  `own_grabs_latest_map` es por episodio, así que varios grupos pueden compartir una serie y
  quedarse con "la última fila leída" habría hecho el resultado dependiente del orden. El bucle
  conserva el `grabbed_at` mayor por serie explícitamente; hay un test que lo fija con dos episodios
  en orden invertido (`test_a_series_mark_is_the_newest_of_its_episode_grabs`).
- **La barra izquierda de las cards de "Todas".** `status-grabbed` fija `border-left-color:
  var(--bad)` pensando en superponerse a `status-error`. En "Todas" una card `status-ok` (con
  archivo) habría quedado con barra roja, afirmando un problema inexistente. Se añadió
  `.wanted-card.status-ok.status-grabbed` (mayor especificidad) que conserva la barra verde; el
  Calendario no tiene barra izquierda, así que allí no hizo falta.

### Notas honestas

- **Las marcas empiezan vacías.** `own_grabs` solo escribe desde que T5 esté desplegado; las
  descargas pedidas antes no aparecerán marcadas y no se rellenan hacia atrás (fuera de alcance).
- **La marca de serie se cerró arreglando el path de escritura, no el frontend.** El hueco que
  dejaron T6-T9 — `series_id` siempre NULL porque el único escritor, el grab del Calendario, no lo
  enviaba — está resuelto en T11: la ruta resuelve el id de serie preguntándoselo al arr en el
  momento del grab y lo guarda. No se añadió `seriesId` a los modelos de request ni se tocó el
  frontend, porque los items del Calendario no llevan id de serie y un valor enviado desde ahí
  habría dejado ese camino roto. Detalle y evidencia en "Fix del `series_id` en el path de
  escritura (T11)".
- **`grabbed_at` siempre está presente** en `/api/wanted`, `/api/wanted/all`,
  `/api/wanted/series/all` y `/api/calendar` (`None` cuando no hay marca), para que el frontend no
  tenga que distinguir "ausente" de "desconocido".
- **Sin entrada nueva en `vulture_whitelist.py`**: cada función nueva tiene un llamador real
  (`formatGrabMark` lo usan las tres superficies; `_attach_grabbed_at` las cuatro rutas).

## Next step

Cerrar la tarea. Los commits de la ampliación están en `feat/marca-todas-calendario` (base
`origin/main`); el padre decide el troceado en PRs (cada commit es un slice por debajo de 400
líneas). No se ha hecho push ni PR. El hueco del `series_id` en el path de escritura del grab quedó
cerrado en T11 (`af123ef`, 181 líneas); ya no queda ningún hueco conocido abierto.
