# Feature: labels-wrap — todo label envuelve su control

Feature mini: aplicar la regla de diseño «el `<label>` envuelve al input/select que
nombra» en todo el frontend. Una sola unidad de comportamiento; superficies listadas.

## Specs

S1 — Petición original del usuario (verbatim): «estoy revisando como estas creando
los labels y los inputs y los labels deberian envolver los inputs, esto no debería ser
así. Como frontend y diseñador echa un vistazo al código del frontend y actua en
consecuencia.»

S2 — Corrección del usuario (verbatim): «tampoco se le esta poniendo el name ni el
enlace de label, que tipo de desarrollador de frontend eres? esto es algo basico el
hmtlfor y el name para poder enlazar las dos cosas y normalmente el label envolviendo
el input.» Requisito: cada par label↔control lleva los **tres** mecanismos a la vez:
(1) el label envuelve al control, (2) asociación explícita `htmlFor`/`id` (el `for`
puede apuntar a su propio descendiente — válido), y (3) `name` en el control
(input/select/textarea/button). `id` y `name` nunca pueden colisionar dentro del
montaje simultáneo (Settings mantiene los tres paneles montados → `Field` usa
`useId` y `name` = slug del label; en sitios concretos, `id` = `name` = string
de la tabla de T4/T5, con clave de fila donde aplica). El `aria-label` existente
se conserva (fija el nombre accesible exacto). Sin cambios visuales ni strings nuevos.

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
- T3 — Input de búsqueda «Buscar en todas las fuentes…» (IndexadoresSection:416,
  único caso sin label tras T1): envolver en `<label>` con el texto del placeholder
  como contenido oculto (mismo string, sin strings nuevos) + clase `sr-only`;
  prueba RED→GREEN y paridad de layout (flex de la search bar intacto).
- T4 — (S2, rutas de settings/alternative/media-pane/shared) RED→GREEN: añadir
  `htmlFor`/`id`/`name` a: Field (useId + name=slug del label, en input y toggle),
  SharedDirs `shared-dirs-ruta`, Indexadores `indexadores-nombre`, `indexadores-url`,
  `indexadores-api-key`, `indexadores-search`, categorías `indexadores-cat-todas` /
  `indexadores-cat-${id}`, AltModal `alt-modal-titulo`, ScanModal `scan-titulo-adicional`,
  FileNavigator `fm-volume-root` (label solo si hay rootLabel; `name` siempre),
  auto-refresh `settings-auto-refresh`. Asserts nuevos en los 6 test de envoltura.
- T5 — (S2, familias A fuera de settings) RED→GREEN: TraceActions (4 labels),
  FileManager `fm-select-all`, MediaMixer (labels de :1005 y `mixer-audio-row`,
  radio `mixer-video` ya tiene name → solo id/htmlFor si su label lo envuelve),
  ReleaseSearchModal `calendar-site-${row.id}` ×3 y `release-filter-seeders`.
  Asserts como bloques `it` nuevos en los test existentes de cada componente.
- T6 — (S2, cierre de brechas detectadas en el seam review del padre sobre T4/T5)
  RED→GREEN: filas de fuentes de AltModal (`AlternativeModal.tsx:222` `rows.map` y
  `:236` aMule) ganan `htmlFor`/`id`/`name` (`alt-modal-source-${slug(id)}` /
  `alt-modal-source-amule`, sin romper `aria-label` existentes); aserción de
  cobertura de `settings-auto-refresh` en `apiKeyMask.test.tsx` (el par ya está
  implementado en `Settings.tsx:75`, falta el assert — Settings ya se monta ahí
  con `mockFetch`); consolidar `slug` duplicada en 4 sitios →
  `frontend/src/shared/utils/slug.ts` (Field, Indexadores, TraceActions,
  ReleaseSearchModal, MediaMixer la importan).

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
L5 — 2026-10-29, usuario reporta que en prod `/configuracion` siguen los inputs
fuera de su label: **causa = prod no corre labels-wrap** (assets `index-BduVpnN1.js`/
`index-CX9zka5w.css` con 0 marcas nuevas — corre `sha-a4c6dd9`; hace falta el
redeploy a `sha-fcf2b28`). Auditoría residual en main: único caso = input de búsqueda
«Buscar en todas las fuentes…» (sin label, solo placeholder+aria-label). Pregunta
focalizada → decisión del usuario: **envolver con label oculto** (mismo texto del
placeholder, visual idéntico). Implementa T3.
L6 — 2026-10-29, usuario (tras revisar el trabajo): «tampoco se le esta poniendo el
name ni el enlace de label, que tipo de desarrollador de frontend eres? esto es algo
basico el hmtlfor y el name para poder enlazar las dos cosas y normalmente el label
envolviendo el input.» Contexto verificado: `htmlFor`=0 en todo el frontend (en la
familia B los quité en vez de re-emplazarlos) y `name` solo existía en
`MediaMixer:1011`. Nueva spec S2 + tareas T4/T5; PR #258 CI verde pero SIN mergear
— se amplía con T4/T5 en la misma rama para entregar el patrón completo.
L7 — 2026-10-29, seam review del padre sobre T4 (worker `mvvggkt8-2-x8u9`,
RED 6F/10P → GREEN 16/16 según recibo) y T5 (worker `mvvgg633-1-avaj`, RED
8F/67P → GREEN 75/75, 30 ficheros/219 tests ampliados): AMBAS diffs correctas
(tabla exacta de ids/names, radios `mixer-video` con name compartido + ids únicos,
`calendar-site-amule/prowlarr` como ids semánticos pineados por test, la
`mixer-audio-row` pasa de la asociación implícita (primer control = ▲) a la
explícita al checkbox — más correcta, ningún test dependía del comportamiento
anterior). Inventario repo-wide de los 11 ficheros con `<label`: todos con
`htmlFor` salvo las filas de AltModal :222/:236 → brecha S2 registrada como T6.
Hallazgo adicional del padre: `slug` estaba duplicada en 4 sitios (Field exporta,
Indexadores importa + 3 copias locales idénticas en T5) → consolidación a
`shared/utils/slug.ts` dentro de T6. Los recibos de los workers NO se dan por
válidos: gates completos del padre pendientes antes de commit.
L8 — 2026-10-29, entrega de T4+T5+T6 (padre): RED de T6 observado (1F/19P —
filas de AltModal sin id: `'' → 'alt-modal-source-7'`; la aserción de
`settings-auto-refresh` nace verde por estar ya implementada). GREEN enfocado
111/111 (14 ficheros) y total **109 ficheros/857 tests** (baseline 841 + 16
asserts nuevos: 6 T4 + 8 T5 + 2 T6); gates tsc/eslint/build todos rc=0 (fix en
caliente: cast a HTMLInputElement en alternativeModal.test.tsx:182, TS2339);
7 comentarios añadidos al diff, todos en inglés. **Frontera de rebanada** (2ª vez
que se supera ~400 L): 586 L autóritas en 3 commits sobre origin/main
(`0aa4d14` T3 + `2f8d989` S2 impl + commit de doc) — una sola unidad de
comportamiento (patrón S2 completo: envoltura + htmlFor/id + name en todo el
frontend), entregada como único PR #258 con divulgación en el cuerpo.
