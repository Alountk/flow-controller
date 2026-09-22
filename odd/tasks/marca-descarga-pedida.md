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
- **La marca de serie depende de que la fila guarde `series_id`, y hoy no se escribe.** El lector
  emite la clave de serie solo cuando la fila trae `series_id` (verificado). Pero la **única** ruta
  que llama a `record_own_grab` es el grab del Calendario (`routes/calendar.py`), y **no envía
  `series_id`**: `CalendarGrabRequest` solo lleva `movieId` y `episodeId`, y el item del Calendario
  no incluye el id de serie. Consecuencia: la marca de serie de "Todas" está **cubierta por tests a
  nivel de mapa (`tests_history.py`) y de endpoint (`tests_routes.py`, sembrando la fila
  directamente)**, pero **no se encenderá en producción** hasta que el path de escritura lleve el
  id de serie (añadir `seriesId` al modelo de grab, propagarlo en el frontend y, si acaso, exponer
  `seriesId` en `fetch_sonarr_calendar`). Se deja fuera de esta ampliación por alcance y se documenta
  para no dar por hecho algo que no lo está. Es el hueco más importante que queda abierto.
- **`grabbed_at` siempre está presente** en `/api/wanted`, `/api/wanted/all`,
  `/api/wanted/series/all` y `/api/calendar` (`None` cuando no hay marca), para que el frontend no
  tenga que distinguir "ausente" de "desconocido".
- **Sin entrada nueva en `vulture_whitelist.py`**: cada función nueva tiene un llamador real
  (`formatGrabMark` lo usan las tres superficies; `_attach_grabbed_at` las cuatro rutas).

## Next step

Cerrar la tarea. Los commits de la ampliación están en `feat/marca-todas-calendario` (base
`origin/main`); el padre decide el troceado en PRs (cada commit es un slice por debajo de 400
líneas). No se ha hecho push ni PR. Queda abierto, fuera de alcance, el `series_id` del path de
escritura del grab descrito arriba.
