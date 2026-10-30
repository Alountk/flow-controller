# filtros-directos — Restaurar Calidad/Idioma en las búsquedas con nuestras fuentes

Bug reportado por el usuario 2026-10-30: al servir las búsquedas con nuestras
fuentes (fan-out directo) desaparecieron los chips de Calidad e Idioma. Causa
raíz localizada (L2); fix por derivación de tokens que el título declara.

## Specs

S1 — Petición original del usuario (verbatim): «hemos perdido la parte de los
idiomas y calidades en las busquedas de los archivos al mudar de servicios de
busqueda.»

## Tasks

- T1 — Fix backend TDD (RED primero, observado por el padre o con su recibo
  cruzado): helper puro `backend/domain/release_tokens.py`
  (`quality_from_title`, `languages_from_title`) + integración en
  `calendar.py::_release_row` + docstring actualizado. Vocabulario: calidad
  Radarr `Contenedor-Resolución` (Bluray/WEBDL/WEBRip/HDTV × 2160p/1080p/720p…,
  solo con ambos tokens; sin ambos → clave ausente) e idiomas con nombre
  (Spanish/English/Russian/French/German/Italian/…) con códigos cortos solo si
  están soltos en MAYÚSCULAS; sin token → clave ausente (la regla honesta de
  ausencia de S5 sobrevive). Tests: `backend/tests/domain/tests_release_tokens.py`
  (unitario RED) + job endpoint con fila «…1080p BluRay…SPANISH» → campos
  presentes + accounting en `test_post_starts_a_job_over_our_own_sources`
  (dict exacto gana `quality: "Bluray-1080p"`) + test UI que afirme los chips
  PRESENTES cuando las filas traen campos (hoy no existe). Verificar antes de
  tocar: payload de grab del modal (si reenvía `quality`, la derivación de
  destino de `calendar.py:435-437/:502` cambiaría enrutado → documentar/parar).
- T2 — Padre: seam review, gates completos (pytest backend baseline 1744,
  vitest/tsc/eslint/build), commit de rebanada, PR.

## Log

L1 — 2026-10-30, usuario: «hemos perdido la parte de los idiomas y calidades en
las busquedas de los archivos al mudar de servicios de busqueda.»
L2 — Diagnóstico (skill diagnosing-bugs): chips `Calidad`/`Idioma` =
`ReleaseSearchModal.tsx:1215/1235`, condicionados a
`collectQualities/collectLanguages` (`shared/utils/releaseFilters.ts:82/93`) que
leen los campos de las filas de `POST /api/calendar/releases`. El mapeador
`calendar.py:215-243 _release_row` solo propaga title/guid/link/size/indexer/
source/seeders con el docstring «The arr's fields (quality, languages, ...) are
NEVER invented» (diseño S1 de calendario-directo). Antes `arr_fetch_releases`
(`arr_client.py:2139-2143`) traía `quality` de Radarr → al migrar a servicios
propios los campos murieron. No hay `<select>` de servicio: el «mudar» es el
fan-out a nuestras fuentes. No existe parser de título previo (grep: solo
`domain/quality.py` enrutado y `naming.py` vocabulario).
L3 — Pines: `test_rows_carry_what_the_sources_said_and_invent_nothing` usa
títulos SIN tokens → sus asserts siguen válidos (no reescribir);
`test_post_starts_a_job_over_our_own_sources` (fila «Blade Runner 1982 (1982)
1080p BluRay», `==` exacto) → accounting obligatorio; S5
`ReleaseSearchModal.test.tsx:197` sigue válida (filas sin campos → sin chips);
no existía test de chips PRESENTES → añadir. Lado abierto: si el grab reenvía
`quality`, `destination_for_quality` en `calendar.py:435-437/:502` pasaría a
derivar destino (p. ej. 2160p → path_4k) — verificar payload y documentar.
L4 — Delegación: backstop de contexto 151k → worker tras completar T1 de
movies-ffprobe (superficies `backend/interfaces/http/routes/` en uso por ese
worker: writers secuenciales, nunca en paralelo con solape).
L5 — T1 ENTREGADO (`mvvk24zf-5-az1u`) + VERIFICADO por el padre: helper puro
`backend/domain/release_tokens.py` (bordes `(?<![a-z0-9])`, salida exacta
`Bluray-1080p`/`WEBDL-2160p`…, códigos solo MAYÚSCULAS soltas, DUAL jamás) +
`_release_row` con claves solo si no vacías y docstring que cita S1. RED del
worker (25 sin recoger + 1 endpoint fallido) → GREEN (25+3); UI de chips
PRESENTES añadida (no existía). Verificación de enrutado: `grabCalendarReleaseBatch`
(`grabs.ts:169`) tiene CERO call sites → la calidad derivada no puede rerutear
⇒ sin STOP. Seam review del padre PASS. **Gates**: backend FULL **1771 passed
rc=0** (1744 + 26 + 1 `Blu-ray`), vitest release-search 118/118, tsc/eslint/
build 0. Cierres del padre: comentarios obsoletos (`destinationFor`,
`releaseTypeContract`) actualizados; variante `Blu-ray` con RED 1 → GREEN 26
(borde `blu[.\s-]?ray`); riesgo «sugerencia 4K por fila 2160p» ACEPTADO (misma
convención que `movieClass`/`destination_for_quality`, y todo botón de grab
envía destino explícito → `destination_for_quality` inalcanzable desde el
modal). Nota baseline: esta rama parte de main (1744); los +8 de movies-T1
viven solo en `feat/movies-ffprobe` (1752 allí).
