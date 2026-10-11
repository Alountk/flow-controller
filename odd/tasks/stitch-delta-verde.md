# Stitch — bloque 🟢 de deltas (6 gaps baratos)

## Objetivo
Cerrar los 6 gaps reales de bajo riesgo identificados en la revisión de deltas
(03/04/06/07), sin tocar nada del bloque 🟡 (decisiones de producto).

## Tasks
- [x] T1: chip `monitored` en la lista de Series (dato ya en `shared/types.ts:356`;
      hoy `SectionRow` solo mira `has_file`/`path_exists`)
- [x] T2: Ruta en monospace por fila en Archivos (hoy solo basename en la fila,
      ruta en la toolbar)
- [x] T3: filtro de filas por nombre en Archivos
- [x] T4: API keys con `type="password"` en Ajustes (Setup ya lo hace)
- [x] T5: paths en mono en la pestaña Archivos de Películas (`.sec-files-table`)
- [x] T6: split por pantalla — Películas 60/40 y Series 40/60 (regla compartida
      `Sections.css:74` = 52/48 hoy; hace falta override con scope por pantalla)

Ruta: delegated direct (writer) — trigger: 6 cambios en ≥5 ficheros no triviales.
TDD: RED→GREEN por cambio con comportamiento observable (chip, filtro, password,
ratio); los meros estilos usan contract test de CSS si aporta.

## No tocar (bloque 🟡, decisión de producto)
- pestaña "Archivos" (el diseño dice "Ficheros") — tests lo afirman
- chips de procedencia (F-07: copia backend-owned, tests de retención)
- 8 dots de Setup (contrato + decisión deliberada setup-02)
- árbol de temporadas, estados de episodio con cola, tabla densa Archivos,
  secciones Calidad/Avisos (no existen en backend), rediseño del Mixer

## Checks
- desde `frontend/`: `./node_modules/.bin/vitest run`,
  `./node_modules/.bin/tsc -b --noEmit`, `./node_modules/.bin/eslint src/`
- e2e de CI es GATE

## Estrategia de delivery
- ask-on-risk. 1 work-unit commit (o pocos) en `feat/stitch-delta-verde`, 1 PR.

## Progress
- 2026-10-11: doc creada, rama `feat/stitch-delta-verde` desde main
  (9aa5b43). Mirror Engram pendiente (conflicto de sesiones).
