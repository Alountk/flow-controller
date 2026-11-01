# Feature: umbral-calidad (roadmap «Calidad de biblioteca» B)

ODD feature doc. Makes the low-quality rule honest and configurable: a
resolution CLASS derived from the measured width (so cropped black bars never
lower it), a slider + manual field for the threshold, the chip obeying that
threshold, and the list of movies below it.

## Specs

- **S1 — Clase por ancho, bandas recortadas no rebajan.** «tenemos peliculas
  que son de 800p pero es porque son de 1080p que han recortado las bandas
  negras». The class of a measured file comes from its **width**, never from
  its bare height: 1920×800 / 1920×816 / 1920×872 are **1080p**; 3840×1600 is
  **4K**; 1280×536 is **720p**; 720×576 is **SD**; a probe that reports no
  video track is **desconocido** (never a class, never "low quality").
  This supersedes the shipped rule `height < 1080 ⇒ baja calidad`, which
  flags properly good cropped 1080p files.
- **S2 — Umbral configurable: slider de clases + campo manual.** «el umbral
  deberia ser un selector de slider y si lo queremos manual deberiamos
  hacer». Settings carries the threshold twice: a **slider over the classes**
  (SD · 720p · 1080p · 4K), default **1080p** («menos de 1080p» from the
  earlier decision), and a **manual width in pixels** that, when set,
  overrides the class comparison. Manual clears back to the slider value
  (empty = 0 = «usa la clase»).
- **S3 — El chip obedece el umbral.** The «Baja calidad» chip appears only
  when the file's measured class ranks **below** the configured threshold
  (or its width is below the manual value when that is set). Un-analyzed
  files still show no chip, and rendering still never runs ffprobe.
- **S4 — Lista de candidatas.** A list of library movies whose measured
  probe is below the threshold, one row per movie: title, file, measured
  resolution (e.g. «1280×536»), class, size and path. Un-analyzed movies are
  **counted apart** («N sin analizar»), never listed as low quality: the
  list can only claim what was measured. Re-reading the saved threshold
  refreshes the list.

## Tasks

- T1 — Backend class derivation: `resolution_class(width, height)` and
  `class_rank` in `backend/domain/quality.py` (S1, cropped-safe). Tests:
  1920×800→1080p, 3840×1600→4K, 1280×536→720p, 720×576→SD, no video→
  desconocido, exact boundaries. Route: backend.
- T2 — Backend threshold + list: `quality` section in the settings DEFAULTS
  (`min_class: "1080p"`, `min_width: 0`), and
  `GET /api/mixer/quality/below` returning the below-threshold movies from
  the catalogue joined with the persisted probes, plus the un-analyzed
  count. Tests: default threshold, manual override, un-analyzed excluded and
  counted, unconfigured Radarr reported honestly. Route: backend.
- T3 — Frontend class + chip: `shared/utils/resolution.ts` (one
  implementation of S1 for the UI) and the chip compares against the
  configured threshold instead of the hardcoded 1080. Tests: cropped 1080p
  gets NO chip, 1280×536 gets it, threshold change moves the chip. Route:
  frontend.
- T4 — Frontend Settings: threshold slider (SD · 720p · 1080p · 4K) plus the
  manual width field, wired through the existing settings form and Field
  idioms. Tests: slider saves the class, manual value saves, clearing manual
  falls back to the class. Route: frontend.
- T5 — Frontend list: the «por debajo del umbral» list in Películas (S4)
  with the un-analyzed count. Tests: rows render measured data, un-analyzed
  never listed. Route: frontend.
- T6 — Docs: ROADMAP task B marked delivered; slice/disclosure notes.

## Log

- L1 — User request verbatim (2026-10-31):
  «el umbral deberia ser un selector de slider y si lo queremos manual
  deberiamos hacer, tenemos que tener en cuenta que tenemos peliculas que son
  de 800p pero es porque son de 1080p que han recortado las bandas negras.»
  plus, answered in the same conversation: scale = **«Clases + campo
  manual»**, scope = **«Todo: arreglo + umbral + lista»**.
- L2 — Bug confirmed in the delivered `ffprobe-masivo` S2: the chip used
  `height < 1080`, so a 1920×800 1080p file reads as «Baja calidad». S1 here
  is the fix; the rule change is recorded rather than slipped in.
- L3 — Threshold semantics: the slider selects the MINIMUM ACCEPTABLE class
  (default 1080p = the user's earlier «menos de 1080p»), so a file is flagged
  when its class ranks strictly below it. `min_width > 0` overrides the class
  comparison for operators who think in pixels.
- L4 — Un-analyzed files: the chip stays absent (nothing measured) and the
  list counts them apart. Neither may ever claim «baja calidad» without a
  measurement — the honesty rule of the feature this corrects.
- L5 — Slice disclosure (recorded BEFORE T4's commit, harness ~400-line
  rule): after T3 the branch is **545 authored lines / 3 commits**
  (`a0c8586` T1 131 L, `b2b5bd5` T2 209 L, `cf84ba3` T3 205 L). Delivery
  strategy = **single PR with disclosures** (same as the two previous
  features); T6 keeps the tally current and the PR body carries the table.
- L6 — T5 incident and its fix (2026-10-31): mounting the list broke
  `calidadView.test.tsx` (5 tests, empty DOM) because that suite's fetch stub
  answers `{}` to any endpoint it does not know, and the component trusted
  the payload. Fixed in `fetchQualityBelow` (validates shape, throws
  «respuesta inesperada del servidor») — the existing tests were NOT touched.
- L7 — T6 close: ROADMAP task B marked delivered. Slice tally for the PR
  body: T1 `a0c8586` 131 L, T2 `b2b5bd5` 209 L, T3 `cf84ba3` 205 L, T4
  `7d6ed56` 166 L, T5 ~230 L → branch ≈ 940 authored lines, delivered as ONE
  PR with this disclosure (strategy recorded in L5). Gates at close: backend
  1838 passed (+ pyflakes/vulture clean), frontend 118 files / 922 tests,
  tsc/eslint/build 0.
