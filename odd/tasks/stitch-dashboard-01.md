# Stitch port 01 — Rediseño visible del Dashboard

## Objetivo
Que el dashboard de producción se parezca al diseño Stitch "01 Dashboard —
FlowController": copy, chips de servicios en el topbar, tarjetas con
ojasa/iconos/footers y banda de incidencias. La tabla "Actividad reciente" queda
para un segundo PR.

## Fuente de diseño
- **HTML** de la pantalla `projects/4305330220058954866/screens/2d435715b5324f809d4be6fd5a29a2ab`
  (obtenido con `get_screen`; el HTML es la fuente de port, la captura solo sirve
  de referencia visual).
- Handoff de tokens: `prototypes/DESIGN.md` (C-06; sin métricas inventadas).

## Decisiones del usuario (2026-10-13)
- **"Quitar PipelineVisual"** — el diseño 01 no lleva grafo de flujo: se retiran
  `PipelineVisual` + `flow-banner` + leyenda; los chips de estado del topbar
  cubren su función de salud.
- **"Diseño sin tabla primero"** — este PR NO incluye la tabla "Actividad
  reciente"; va en un segundo PR.

## Specs
- **S1** — El dashboard debe mostrar el diseño Stitch: usuario: *"no veo el
  diseño de stitch en mi produccion y deberia verlo"*, empezando por el dashboard
  porque *"tiene sentido que el dashboard, porque sigo viendolo igual."*
- **S2** — Quitar PipelineVisual (grafo + flow-banner + leyenda) y sustituir su
  señal de salud por chips en el topbar con la forma del diseño:
  `Radarr: Conectado` (tinte ok) / `AmuTorrent: Alerta` (tinte bad) — etiqueta de
  servicio = `SERVICES` real (`App.tsx:56-59`: Radarr, AmuTorrent, Sonarr);
  estado desconocido ⇒ texto honesto `Sin datos` (tinte neutro).
- **S3** — Primer PR sin la tabla de actividad: copy + chips + tarjetas + banda.
- **S4** — Copy del diseño, verbatim donde el dato lo permite:
  - Content header: `Dashboard` + subtítulo `Vista general del servidor multimedia`.
  - Tarjetas (ojasa uppercase + icono + valor grande + subtítulo + footer con
    filete): `DESCARGAS ATASCADAS` · `IMPORTACIONES BLOQUEADAS` ·
    `ESPACIO EN DISCO` · `ESTADO DE SERVICIOS`.
  - Footer tarjeta 1 (solo si hay bloqueos): `Requiere revisión manual`.
  - Footer tarjeta 2 (mono, si hay destino): `Destino: <ruta>`.
  - Footer tarjeta 3 (mono): `Punto de montaje: <ruta>`.
  - Footer tarjeta 4 (solo si hay servicio offline): línea de error con el
    `reason` real del servicio caído.
  - Banda: `<N> incidencias pendientes requieren atención` + desglose honesto
    `<B> bloqueos de importación, <F> fallos` + CTA `Ver en Seguimiento (<N>)`.
  - Chips de topbar por servicio: `<label>: Conectado | Alerta | Sin datos`.
- **S5** — Honestidad (regla C-06/DESIGN.md, pinned por tests): ningún footer ni
  subtítulo se renderiza sin dato real que lo respalde; sin speed/ETA/%.
- **S6** — La tabla "Actividad reciente de transferencias e indexación" NO se
  implementa en este PR (segundo PR; aprovechará la query `['downloads']` nueva).

## Mapeo diseño → datos (evidencia)
| Tarjeta | Fuente | Evidencia |
|---|---|---|
| Descargas atascadas | `GET /api/downloads` → `problem: true` (`PROBLEM_STATES`: "done or stuck and the import did not complete") + desglose por `source` | `downloads_cache.py:63-101` |
| Importaciones bloqueadas | `trace.summary.import_blocked` + `destination` de la primera traza bloqueada | `types.ts:85-156` |
| Espacio en disco | `GET /api/disk` → `volumes[0] {path, free_bytes, total, percent}` (query `['disk']` ya existe) | `calendar.py:565`, `DiskSpace.tsx:5-35` |
| Estado de servicios | `services[] {label, state, reason}` | `App.tsx:204-224` |
| Banda de incidencias | `summary.import_blocked + failed` → `setPage('seguimiento')` | `App.tsx:226-229` |

## Contratos que se mueven (los actualiza este PR)
- Copy `Resumen del sistema` → `Dashboard`: `configuredServices.test.tsx:174`,
  `setupPage.test.tsx:296`; e2e `auth.spec.ts:14,22`, `dashboard-bare.spec.ts:16`,
  `kanban-fit.spec.ts:82,109,155`.
- CSS de tarjetas vive HOY en `PipelineVisual.css` → se muda a `Dashboard.css`;
  el contrato responsive (`PipelineVisual.css.contract.test.ts:94-134`) se re-apunta
  al fichero nuevo (mismas aserciones). `darkModePolish.css.contract.test.ts:82,102`
  (`.node-state.*`) se retira: su sujeto desaparece con el grafo.
- `PipelineVisual.tsx`/`Connector`/`ServiceNode`/`PipelineVisual.test.tsx` se
  eliminan junto con su uso.

## Tasks
- [ ] T1 (RED→GREEN): chips de servicios en `Topbar` (`right`) — render por
      estado con tintes ok/bad/neutral + tests.
- [ ] T2 (RED→GREEN): copy del content header (S4) + actualización de los tests
      y specs e2e que pinnean `Resumen del sistema`.
- [ ] T3 (RED→GREEN): 4 tarjetas del diseño en `App.tsx` + queries `['downloads']`
      (SSE-gated: `connected ? false : interval`) y `['disk']` + footers honestos (S5).
- [ ] T4 (RED→GREEN): banda de incidencias con CTA a Seguimiento; oculta si N=0.
- [ ] T5: retirar PipelineVisual/flow-banner/leyenda; crear `Dashboard.css` con
      las reglas de tarjetas/grid; re-apuntar y limpiar contratos; borrar tests del
      componente.
- [ ] T6 (RED→GREEN): invalidar `['downloads']` en `useEventStream` cuando llegue
      el evento `downloads` (hoy sin oyentes — BACKLOG:737).

## Ruta y gates
- Ruta: inline en el padre — **subagentes no disponibles** (fallo de proveedor:
  "No API key found for openrouter"); se reporta como fallback.
- TDD RED→GREEN por tarea con comportamiento observable; estilos vía contract test.
- Checks por tarea: desde `frontend/`: `./node_modules/.bin/vitest run`,
  `./node_modules/.bin/tsc -b --noEmit`, `./node_modules/.bin/eslint src/`.
- e2e de CI es GATE (no se corre localmente).

## Estrategia de delivery
- Rama `feat/stitch-dashboard-01` desde main; 1 work-unit commit por tarea;
  1 PR (preferencia establecida del usuario), merge con CI verde.

## Progress
- 2026-10-13: doc creada antes de la primera escritura; decisiones del usuario
  registradas; mapa diseño→datos con evidencia.
- 2026-10-13: **T1 [x]** commit `3df6695` (ServiceChips + topbar right, RED→GREEN
  4 tests). Checks: vitest 533/533 (baseline 529+4), tsc 0, eslint 0.
- 2026-10-13: **T2 [x]** commit `497efce` (título h1+subtítulo en Topbar, se retira
  content-header; unit×2 + e2e×3 re-punteados a heading 'Dashboard'; +1 test de
  subtítulo). Checks: vitest 533/533, tsc 0, eslint 0. e2e: GATE en CI.
- 2026-10-13: **T5 [x]** commit `b7b68fb` (PipelineVisual+banner+leyenda fuera;
  Dashboard.css con grid/tarjetas/error-box; pulse→Topbar.css; content-header CSS
  fuera de global.css; contrato responsive re-apuntado; darkModePolish −2 entries
  `.node-state`; −664 líneas). ⚠ Incidente: el `git rm` de pipeline-visual borró
  `node-fs.d.ts` (shim ambiental `declare module 'node:fs'` — el paquete NO tiene
  @types/node) → TS2307 en 4 tests; recreado en `src/test/node-fs.d.ts` (causa
  raíz verificada con stash/probe). Checks: vitest 518/518, tsc 0, eslint 0.
- 2026-10-13: **T3 [x]** commit de este mismo cambio (hash anotado en T4)
  (DashboardCards: 4 tarjetas design-01
  con footers honestos, puerta C-11 → card1; queries ['downloads'] SSE-gated y
  ['disk'] dashboard-only; .dash-foot; dash-value 24px/700). RED→GREEN: 10 tests
  nuevos; test C-11 re-punteado. Checks: vitest 528/528 (65→66 files), tsc 0,
  eslint 0.

## Log
- L1 (2026-10-13, usuario): "podemos empezar a implementar el nuevo diseño hecho
  en stitch? propon por donde empezar"
- L2 (2026-10-13, usuario): "estas mirando los screenshots de stitch cuando
  deberias mirar el html que te ofrece stitch"
- L3 (2026-10-13, usuario, respuesta a por dónde empezar): "tiene sentido que el
  dashboard, porque sigo viendolo igual."
- L4 (2026-10-13, usuario, respuesta a namings/visibilidad): "no veo el diseño de
  stitch en mi produccion y deberia verlo"
- L5 (2026-10-13, usuario, decisiones): "Quitar PipelineVisual" · "Diseño sin
  tabla primero"
