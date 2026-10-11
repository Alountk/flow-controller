# Stitch brief 3 — Dark mode polish (contraste + color-mix)

## Objetivo
Cerrar el brief 3 del handoff: tints vía `color-mix` en familias accent/error y
contraste legible sobre `--bg-elev` en AMBOS modos. Auditoría WCAG hecha por
explorador (path:line incluidos); este doc es el alcance.

## Alcance (4 tareas)
- [x] T1: rellenos de éxito blancos sobre `--ok` → `--ok-dim`
      - `Settings.css:121-122` `.settings-toast` (blanco sobre `#22c55e` = **2.3:1** en dark)
      - `shared/ui/Field.css:61-62` `.settings-toggle.on` (mismo patrón)
      - `--ok-dim`: dark #15803d ≈5:1, light #166534 ≈7:1 — arregla ambos modos
- [x] T2: texto de chips de error → `var(--bad-text)` (token **muerto**, existe en ambas
      paletas `global.css:35/85`): dark #fca5a5 ≈8:1 (hoy 4.0), light sin cambio.
      Sitios: `Sections.css:454-457`, `Seguimiento.css:206-208`,
      `MediaMixer.css:318-320`, `PipelineVisual.css:177`, `AutoCopyPanel.css:129`,
      `Prototypes.css:170-172`
- [x] T3: text-dim en tintes y badge selected
      - `Prototypes.css:166-167` `.proto-badge.selected`: `--accent` → `--info`
        (2.9:1 → 4.7:1 en dark)
      - chips con texto `--text-dim` sobre tinte (dark ≈3.2): `MediaMixer.css:323-331`,
        `AutoCopyPanel.css:131`, `PipelineVisual.css:178` →
        `color: color-mix(in srgb, var(--text) 70%, transparent)` (≈6.5 light / ≈8.8 dark)
- [x] T4: **solo bloque oscuro** de `global.css`: `--text-dim`/`--text-dim2` #71717a →
      #8b8b93 (hoy 3.7:1 sobre #18181b → ≈5.2:1). Es el fix sistémico de los ~100
      usos de dim en small text. ⚠ Ajusta un valor C-06 aprobado — el PR lo marca
      para la revisión visual pendiente de C-06. Light intacto.

## Aceptado documentado (sin cambio)
- Chips accent-on-tint en dark: tope duro 3.97:1 (el propio `--accent #6366f1` lo
  limita; ningún `color-mix N%` llega a 4.5). Cambiar exigiría paleta o rellenar
  sólido (diseño distinto) → decisión de usuario si quiere estricto AA.
- `on-warn` sobre `--warn` light 4.3:1 (borderline, sin token limpio).
- Unificación `transparent` en 2 sitios (visualmente nulo) — fuera.

## Verificado ya correcto (no re-checkear)
- Cero hex/rgba hardcodeados en CSS de componentes (todo tokenizado o color-mix);
  los rgba existentes son sombras/scrim.
- ok-on-tint 6.0, warn-on-tint 6.9, white-on-accent 4.47, `--text-3` dark 6.9.

## Tasks / ruta
Ruta: delegated direct (writer) — trigger: 4 tareas en ~9 ficheros no triviales.
TDD: contract tests de uso de token (T1/T2) y de valor de token en el bloque dark
(T4) — RED primero.

## Checks
- desde `frontend/`: `./node_modules/.bin/vitest run`,
  `./node_modules/.bin/tsc -b --noEmit`, `./node_modules/.bin/eslint src/`
- e2e de CI es GATE

## Estrategia de delivery
- ask-on-risk. Forecast <400 líneas → 1 PR.

## Progress
- 2026-10-11: doc creada, rama `feat/dark-mode-polish` desde main (65317c4).
