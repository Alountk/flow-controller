# Stitch port 05 — Panel de detalle de Seguimiento (polish)

## Objetivo
Pulir `TraceDetailPanel` (F-09 fase 2) alineado con el diseño Stitch
"05 Seguimiento — FlowController" `9c704db13fc244c3abd8d55799ab72dd`
(proyecto `projects/4305330220058954866`).

## Diferencia actual → diseño
- **Actual**: un único `<dl>` plano con ~20 filas; título DEBAJO de la cabecera;
  motivo como lista simple al final.
- **Diseño 05**: cabecera = título + stage pill + chips + close (arriba a la
  derecha); cuerpo en **secciones** con jerarquía — General, Ficheros, Bloqueo —
  filas densas `label dim / value mono` (mono para rutas e IDs); lista de
  motivos de bloqueo con jerarquía clara (reason / source / timestamp cuando
  exista); progreso sólo cuando el payload lo lleva.

## Restricciones (no negociables)
- Honesty: sin speed/ETA — ya pinned por tests; nada nuevo inventado.
- Contratos e2e intactos: panel FUERA de `.sg` (`.sg == [sg-board, sg-ops]`),
  nombres accesibles auditados: `Ver detalles`, `Cerrar detalle`,
  `Detalle de {title}`, progressbar `Progreso de {title} (detalle)`.
- Sin cambios de rutas ni de datos; sólo presentación.
- Tokens C-06 (mono = `--mono`).

## Tasks
- [x] T1: reestructura del panel en secciones + estilos + tests (RED→GREEN)
      Ruta: delegated direct (writer) — trigger: 3 ficheros no triviales
      (Seguimiento.tsx, Seguimiento.css, Seguimiento.test.tsx).

## Checks
- desde `frontend/`: `./node_modules/.bin/vitest run`,
  `./node_modules/.bin/tsc -b --noEmit`, `./node_modules/.bin/eslint src/`
- e2e de CI es GATE (kanban-fit.spec.ts + selector audit)

## Estrategia de delivery
- ask-on-risk (default). 1 work-unit commit en `feat/panel-detalle-polish`.

## Progress
- 2026-10-11: doc creada, rama `feat/panel-detalle-polish` (desde main, paralela
  a #188). Mirror Engram pendiente (conflicto de sesiones).
