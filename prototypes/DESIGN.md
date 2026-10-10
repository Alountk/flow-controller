# DESIGN.md — FlowController · Stitch handoff

Purpose: feed Stitch with the **shipped** design system of FlowController (a media-download
manager: Radarr/Sonarr/aMule home server) so generated screens start from the real identity
instead of defaults. Extracted verbatim from `frontend/src/styles/global.css` (C-06, merged
2026-10-10). Light and dark are the SAME token names; the dark palette applies via system
preference (`prefers-color-scheme: dark`) — there is deliberately no toggle.

## Design system

- **colorMode**: both `LIGHT` and `DARK` required (system-preference driven).
- **Body font**: Inter (fallbacks: system-ui, -apple-system, Segoe UI, Roboto, sans-serif).
- **Mono font**: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace (`--mono` — used for
  file paths, IDs, logs).
- **Roundness**: cards/modals ~8px, buttons ~6px, chips/badges pill (999px).
- **Breakpoints**: 640 / 768 / 900 / 1280 px. Seguimiento pins a fixed **70/30** board/tail
  split at ≥768 and stacks below.
- **Layout idioms**: left sidebar (nav) + topbar (title/status); master–detail on Películas
  and Series (list left, detail panel right with tabs); Seguimiento = kanban board (70%) +
  operations tail (30%) + overlay detail panel (30%, right).

### Palette — LIGHT (`:root`, `color-scheme: light`)

| Token | Value | Role |
|---|---|---|
| `--bg` | `#f4f4f5` | app background |
| `--bg-elev` | `#ffffff` | raised surface / card |
| `--bg-elev-2` | `#fafafa` | second elevation |
| `--text` | `#18181b` | primary text |
| `--text-2` | `#3f3f46` | secondary text |
| `--text-dim` | `#52525b` | dim |
| `--text-dim2` / `--text-3` | `#71717a` | dimmest |
| `--border` | `#e4e4e7` | hairline |
| `--border-color` | `rgba(0,0,0,0.15)` | structural border |
| `--ok` / `--ok-dim` | `#15803d` / `#166534` | success |
| `--warn` | `#a16207` | warning |
| `--bad` / `--bad-strong` / `--bad-dim` / `--bad-text` | `#b91c1c` / `#991b1b` / `#7f1d1d` / `#b91c1c` | error family |
| `--accent` | `#4f46e5` | brand accent (indigo) |
| `--info` | `#2563eb` | info (blue) |
| `--hover` | `rgba(0,0,0,0.04)` | hover wash |
| `--on-fill` | `#ffffff` | text on filled controls |
| `--on-warn` | `#000000` | text on warning fills |

Derived (declared once, follow the palette): `--accent-soft` = accent 12% transparent,
`--ok-soft` = ok 15% transparent, `--surface/--surface-1/--surface-2`, `--card-bg`,
`--accent-bg`, `--err`, `--text-secondary`.

### Palette — DARK (`@media (prefers-color-scheme: dark)`, `color-scheme: dark`)

| Token | Value |
|---|---|
| `--bg` | `#111113` |
| `--bg-elev` | `#18181b` |
| `--bg-elev-2` | `#1c1c21` |
| `--text` | `#fafafa` |
| `--text-2` | `#d4d4d8` |
| `--text-dim` / `--text-dim2` | `#71717a` |
| `--text-3` | `#a1a1aa` |
| `--border` | `#27272a` |
| `--border-color` | `rgba(255,255,255,0.18)` |
| `--ok` / `--ok-dim` | `#22c55e` / `#15803d` |
| `--warn` | `#eab308` |
| `--bad` / `--bad-strong` / `--bad-dim` / `--bad-text` | `#ef4444` / `#dc2626` / `#991b1b` / `#fca5a5` |
| `--accent` | `#6366f1` |
| `--info` | `#4a9eff` |
| `--hover` | `rgba(255,255,255,0.04)` |
| `--on-fill` | `#ffffff` |
| `--on-warn` | `#000000` |

## Screen inventory (current app)

1. **Dashboard** — stat cards (Stuck → Seguimiento), health strip. *(Known defect: 4-column
   grid squeezes at ~360px — good brief for variants.)*
2. **Películas / Series** — master–detail: filtered list + detail panel with tabs (Releases,
   ficheros…), poster-first cards, action bar (search bulk + per-row actions).
3. **Seguimiento** — kanban board 4 columns (downloading · downloaded/importing ·
   import_blocked/failed · sent) + operations tail band (30%) + detail overlay panel.
4. **Archivos (FileManager)** — file table with provenance/age chips, destination combo.
5. **SetupPage** — step-by-step first-run wizard (focus card, verify inline).
6. **Settings** — grouped form sections with Field primitives.
7. **Media Mixer** — two-pane tool.

## Briefs for Stitch (first variant rounds)

1. **Seguimiento detail panel polish** — overlay 30% over the operations tail; dense
   definition-list rows (label dim / value mono for paths+IDs); header = title + stage pill +
   chips; close top-right. Explore: grouping of the ~20 fields, hierarchy of the block-reason
   list, progress emphasis. Dark mode matters equally.
2. **Dashboard responsive** — single column stack ≤640, 2-col ≤900; cards must survive long
   titles and 360px without horizontal scroll.
3. **Dark mode polish** — soft tints via color-mix on the accent/error families; verify text
   contrast on `--bg-elev` in both modes.

## Constraints for generated screens

- Keep the token names above; every surface color must map to a token.
- No invented metrics (the app refuses to show speed/ETA it cannot know — honesty over
  decoration; avoid fake numbers in mockups too).
- UI copy in Spanish (the app's user-facing strings are Spanish).
