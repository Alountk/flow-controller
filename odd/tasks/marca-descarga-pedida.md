# Marca de "descarga pedida" en Faltantes

## Objective

Que en Faltantes se vea de un vistazo si un título **ya se pidió a descargar** y **cuándo**, para
no volver a pedirlo y para distinguir "no lo he pedido" de "lo pedí y no ha llegado".

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

- **`history.py`**: `own_grabs_latest_map(since)` → `{(source, "movie"|"episode", id): grabbed_at}`,
  con `MAX(grabbed_at)` por grupo. Sin `LIMIT`: el lector existente tiene uno por defecto y usarlo
  aquí truncaría marcas **en silencio**.
- **`routes/wanted.py`**: enriquecer los items de `/api/wanted` (películas y episodios) con
  `grabbed_at`. **Fuera de la caché** de `_fetch_all_wanted`: esa caché es de los datos del arr, la
  marca es nuestra.
- **Frontend**: card de película y fila de episodio en naranja con `Pedida el <fecha>`.
- **`TraceActions.tsx`**: quitar el guard `queueId` que esconde **"Reintentar import"** en
  `import_blocked`. La acción no usa ningún id — manda `ProcessMonitoredDownloads`, un comando **sin
  argumentos** — así que el guard es más estricto que la acción y esconde el botón justo cuando el
  item ya no está en la cola del arr y más falta hace.

Fuera:

- La pestaña **"Todas"** y el **Calendario**: decisión de alcance del usuario, solo Faltantes.
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
- [x] **T5** Registro y evidencia

## Acceptance criteria

- Una película o un episodio con un grab propio y sin fichero muestra la marca **y la fecha**.
- Uno sin grab no muestra nada — no un guión ni un lugar vacío.
- Un título que se importó desaparece de Faltantes, y con él la marca.
- "Reintentar import" aparece en `import_blocked` **aunque no haya `queue_id`**.
- Backend y frontend en verde; `pyflakes` y `vulture` limpios.

## Applicable checks

- Backend: `cd backend && python3 -m pytest -q`, `python3 -m pyflakes *.py routes/*.py`,
  `python3 -m vulture`
- Frontend: `cd frontend && npm test && npm run build`

## TDD

Desactivado (`strict_tdd: false`, origen `sdd-init/flow-controller`). Checks funcionales por tarea.

## Progress

- [x] T1-T4 implementados y verificados; T5 registrada abajo. Alcance respetado: solo Faltantes
  (más el arreglo del guard). La rama es `feat/marca-descarga-pedida`, con base en `main`.

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

### Comandos de verificación (resultado literal)

- `cd backend && python3 -m pytest -q` → `449 passed, 2 warnings in 58.43s` (antes: 437; +12 pruebas)
- `cd backend && python3 -m pyflakes *.py routes/*.py` → sin salida, exit 0
- `cd backend && python3 -m vulture` → sin salida, exit 0 (sin entradas nuevas en el whitelist)
- `cd frontend && npm test` → `Test Files 27 passed (27)`, `Tests 197 passed (197)` (antes: 190; +7 pruebas)
- `cd frontend && npm run build` → `tsc -b && vite build`, `✓ 131 modules transformed`, `✓ built in 1.90s`

Los dos comandos de frontend se ejecutaron en pasos separados, nunca en paralelo.

### Decisiones que el plan no fijaba

- **Ventana de lookback** (`WANTED_GRAB_LOOKBACK = 90 días`, en `routes/wanted.py`). Compromiso:
  una ventana corta pierde la marca de una descarga realmente atascada justo cuando más importa;
  una larga deja que una marca de un intento antiguo afirme que el faltante actual se pidió cuando
  no fue así. 90 días cubren un pack de temporada lento y un mes de reintentos sin dejar de ser una
  afirmación sobre el estado presente.
- **Formato de fecha.** Lista de meses en español fijada a mano (`ene…dic`) para renderizar
  exactamente `19 sep 2026`: `toLocaleDateString('es-ES', { month: 'short' })` produce `sept` en
  este runtime y varía entre versiones de ICU. Sigue la convención de helpers locales ya existente
  (`FileManager.formatDate`, `TraceView.relativeTime`).
- **Convivencia con el estado previo.** La card de Faltantes de una película no tenía badge; el
  hecho "falta" lo comunica la clase `status-error` (barra izquierda roja). La marca se superpone
  como `status-grabbed`: borde y tinte naranjas con la barra izquierda roja intacta, de modo que
  ambos hechos siguen visibles y ninguno sobrescribe al otro. No se añadió un badge nuevo.

### Notas honestas

- **Las marcas empiezan vacías.** `own_grabs` solo escribe desde que T5 esté desplegado; las
  descargas pedidas antes no aparecerán marcadas y no se rellenan hacia atrás (fuera de alcance).
- **La pestaña "Todas" queda fuera de alcance** por decisión del usuario: renderiza sus propias
  cards y no se tocó, igual que el Calendario.
- **`grabbed_at` siempre está presente** en `/api/wanted` (`None` cuando no hay marca), para que el
  frontend no tenga que distinguir "ausente" de "desconocido".
- **Sin entrada nueva en `vulture_whitelist.py`**: cada función nueva tiene un llamador real.

## Next step

Cerrar la tarea. Los commits están en `feat/marca-descarga-pedida`; el padre decide el troceado en
PRs (cada commit es un slice por debajo de 400 líneas). No se ha hecho push ni PR.
