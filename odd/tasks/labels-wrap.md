# Feature: labels-wrap — todo label envuelve su control

Feature mini: aplicar la regla de diseño «el `<label>` envuelve al input/select que
nombra» en todo el frontend. Una sola unidad de comportamiento; superficies listadas.

## Specs

S1 — Petición original del usuario (verbatim): «estoy revisando como estas creando
los labels y los inputs y los labels deberian envolver los inputs, esto no debería ser
así. Como frontend y diseñador echa un vistazo al código del frontend y actua en
consecuencia.»

Auditoría del padre (contexto de implementación, no requisito nuevo): familias A = ya
envuelven (checkboxes de categorías, TraceActions, FileManager, MediaMixer, calendario,
source-rows, auto-refresh — NO se tocan); B = `htmlFor`/`id` sin envolver (SharedDirs,
Indexadores Nombre/URL/API Key, AltModal S2); C = huérfanos sin ninguna asociación
(`Field.tsx` — se asociaba solo con `aria-label` —, ScanModal «Título adicional:»,
FileNavigator `rootLabel`). La regla de S1 aplica a B y C.

## Tasks

- T1 — RED→GREEN de la envoltura en B y C: primero pruebas estructurales
  (el control con `closest('label')` no-nulo / `getByLabelText` que hoy falla por
  huérfano) observadas en rojo; luego reestructurar `Field.tsx`, SharedDirs,
  Indexadores ×3, AltModal, ScanModal, FileNavigator + CSS sin cambiar el layout
  visual ni tocar la familia A. Rutas en `## Allowed edit surfaces`.
- T2 — Padre: seam review + gates completos (vitest, tsc, eslint, build) + commit.

## Log

L1 — 2026-10-29, usuario: «estoy revisando como estas creando los labels y los inputs
y los labels deberian envolver los inputs, esto no debería ser así. Como frontend y
diseñador echa un vistazo al código del frontend y actua en consecuencia.»
L2 — Auditoría del padre: 3 familias (A/B/C arriba); decisiones de diseño: en
`Field.tsx` el `<label>` pasa a ser el contenedor de la fila conservando las mismas
clases (CSS sin cambios de selectores) y el `aria-label` del input SE MANTIENE (es lo
que fija el nombre accesible exacto cuando hay badge «Requiere reinicio» y lo que
resuelven los `getByLabelText` existentes); en SharedDirs/API Key los botones de fila
quedan FUERA del label (el control etiquetado es el input); en AltModal el label gana
`display:flex` columna; en ScanModal/FileNavigator el label envuelve control y
`scan-label` gana flex de fila.
L3 — 2026-10-29, seam review del padre sobre la entrega de T1 (worker
`mvtkbk0y-14-f5ab`: RED 6/9 → GREEN 6/6, 840/tsc/eslint en verde, cero test
existente tocado, superficie exacta): 3 hallazgos corregidos. (1) Comentarios
nuevos en español → traducidos a inglés (AGENTS.md:3-5, why ≤2 líneas) y
títulos/doc de los 6 test files a inglés (precedente: los existentes, en inglés).
(2) API Key: `<div>` + botón dentro del `<label>` viola el content model
(label = contenido phrasing + un único elemento labelable) y contradecía L2;
el error de handoff fue del padre (la tarea decía «dentro»). Corregido con
wrapper `.indexadores-key-field` en la fila, label dentro (regla
`> label { flex:1; min-width:0; margin-bottom:0 }`) y botón hermano con
`bottom:8` (anclado al input en cualquier ancho). Test de envoltura actualizado:
RED observado (1F/1P) → GREEN 6/6 (9/9). (3) El nombre accesible del toggle de
`Field` pasa al texto del label (spec-correcto, más informativo que «Sí»/«No»):
aceptado. Gates propios del padre: vitest 109 ficheros/840 tests, tsc, eslint,
build — todos rc=0.
L4 — Entrega: single PR con divulgación; frontera de rebanada registrada aquí
(superficie 551 L autóritas / 2 commits sobre origin/main: doc `d82d014` +
impl `f7fde6d`; el límite ~400 L se supera — una sola unidad de comportamiento).
