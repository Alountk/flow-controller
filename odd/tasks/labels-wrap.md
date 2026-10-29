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
