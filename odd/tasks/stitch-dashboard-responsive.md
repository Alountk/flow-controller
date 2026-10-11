# Stitch port 01/02 — Dashboard responsive

## Objetivo
Portar el diseño Stitch "01 Dashboard — FlowController" / "02 Dashboard Modo Oscuro" al dashboard
real, corrigiendo el defecto conocido: `.dashboard-grid` es `repeat(4, 1fr)` sin media queries y
se aplasta a ~360px (sin scroll horizontal que quepa).

## Fuente de diseño
- Stitch: proyecto `projects/4305330220058954866`, pantallas
  - 01 Dashboard — FlowController `2d435715b5324f809d4be6fd5a29a2ab`
  - 02 Dashboard Modo Oscuro — FlowController `73b9a7c6ac42475397da034c3343de89`
- Brief del handoff (`prototypes/DESIGN.md`): 1 col ≤640, 2 col ≤900, 4 col ≥1280; tarjetas
  sobreviven títulos largos y 360px sin scroll horizontal (min-width:0 + line-clamp).

## Alcance autorizado
- Solo el dashboard: grid + tarjetas `.dash-card` (y su test).
- Tokens C-06 existentes (`--bg-elev`, `--border`, `--text-dim`, …); dark ya va por
  `prefers-color-scheme` (no tocar).
- Alineación de radio de tarjeta 14px → 8px (roundness del handoff).
- NO se añaden secciones nuevas del mockup (incidencias/actividad) — requieren backend.

## Tasks
- [x] T1: responsive grid + robustez de tarjetas + contrato de test (RED → GREEN)
      - media queries: ≤640 1 col, ≤900 2 col, default 4 col
      - `min-width: 0` en hijos, `overflow-wrap`/`line-clamp` para títulos largos
      - radio `.dash-card` 14px → 8px
      - test contract que falle sin las media queries
      Ruta: delegated direct (writer) — trigger: 2+ ficheros no triviales (CSS + test).

## Checks
- desde `frontend/`: `./node_modules/.bin/vitest run`, `./node_modules/.bin/tsc -b --noEmit`,
  `./node_modules/.bin/eslint src/`
- e2e de CI es GATE (no se corre localmente)

## Estrategia de delivery
- ask-on-risk (default). Objetivo: 1 work-unit commit en `feat/dashboard-responsive`.

## Progress
- 2026-10-11: doc creada, rama `feat/dashboard-responsive`. Mirror Engram: pendiente (ver nota).
