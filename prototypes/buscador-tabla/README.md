# prototypes/buscador-tabla

Design iterations for the release search and the movies detail panel, kept so
the evolution stays reviewable after the implementation replaces the current
views.

Source: Stitch project **FlowController — Diseños** (`4305330220058954866`),
design system **FlowController** (`assets/5781956853225900110`).

## Files

| File | Stitch screen | Status |
|------|---------------|--------|
| `14-busqueda-unificada-resultados.html` | `14 Búsqueda unificada — Resultados` (`3ada202109524a658e41cadd1ed6fc7a`) | **chosen** for the search view |

## Fidelity caveat

These are **render-condensed** copies, not byte-identical exports. Stitch's
download endpoint requires OAuth (`401` without a token), so each file was
pulled through the MCP reader and re-written here: the markup, classes and
copy are the design's own, while the generated Tailwind colour-palette block
was trimmed because the screens style everything with arbitrary-value classes
(`bg-[#0f1117]`, …). Open the file in a browser and it renders as designed;
diffing it against a Stitch export will show the trimmed config, nothing else.

To get a byte-exact copy, use Stitch's own download button on the screen.

## Still to export (on request)

- `Películas — Panel de Detalle (ParaNorman)` — the approved V1 detail panel
  (`fe9f10ae2bb543458b3d99656db2f3ed`)
- `Películas — Panel de Detalle (Archivos)` — same panel, Archivos tab active
  (`2f0554135bd04b4bbfe9b124ae50a0eb`)
- `15 Búsqueda unificada — Cómoda` (`e397a854cabb4b00bf44f4fc5a444415`)
- `16 Búsqueda unificada — Split View` (`4bfc200c4cc9498e8e74a3848f56f0d9`)
- `Películas — Variante L1 (Tabla Técnica Densa)` (`97a7c28324e64679b583d16b87d48fe2`)
- `Películas — Variante L2 (Filas con Póster)` (`3df91e1aaee3452f80c627b386df7712`)
- `Películas — Variante L3 (Agrupada por Clase)` (`730accd37b0e495c810ec987ecff4085`)
- `Películas — Panel de Detalle (Acordeón Vertical)` (`83d18751739945669877faeb75ebfdcf`)
- `Películas — Detalle Variante 3 (Doble Columna)` (`a8df74f829dd47668fd98a3879509f14`)
