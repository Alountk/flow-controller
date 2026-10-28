# idiomas-metadata — selector de idioma en pistas + metadata de salida normalizada

Feature grande (ODD): reetiquetado de idioma en audio y subtítulos del Media Mixer y
salida con metadata limpia. Rama: `feat/idiomas-metadata`. Prioridad: petición directa
del usuario tras cerrar el 500 de Cotejar (PR #248).

## Specs

S1 (pedido original, verbatim): «en las pistas de audio y pistas de subtitulos podamos
seleccionar el idioma y normalizar sus metadatas, ya que muchos videos les ponen metadata
de alguna pagina y no me gusta.»

S2 (audio — decisión del usuario «Selector en todas las pistas»): cada fila de pista de
audio del mixer lleva un selector con las opciones de `LANGUAGE_LABELS`
(`MediaMixer.tsx:93-96`, 12 incluidas `und`), no sólo las pistas `und`. Reetiquetar una
pista que ya trae idioma está permitido: `_resolve_language_overrides` deja de exigir que
la pista pruebe como `und` (relaja la regla L24 actual) y acepta los 12 códigos. Efectos
observables: `startMux` envía `language_overrides: [{path, track_index, language}]` para
toda fila cuya selección difiere del valor sondeado (selección igual al sondeo ⇒ sin
override); el gate `missing_required_language` (409) cuenta las selecciones igual que hoy;
rutas/ordinales inválidos siguen siendo 400 `invalid_language_override` (fail-closed).

S3 (subtítulos — decisión «Selector por fila editable»): cada fila del panel de subtítulos
tiene su propio selector con `LANGUAGE_LABELS`. El idioma elegido manda en tres efectos:
(a) nombre del sidecar `<stem>.<lang>.srt` (`subtitle_sidecar_path`), (b) códigos con que
«Buscar subtítulos» llama a OpenSubtitles, (c) las entradas del `subtitle_plan` que viajan
a la tarea de mux. La petición nuevo campo opcional `subtitle_languages` (lista de códigos,
en orden de fila); cuando ausente ⇒ comportamiento actual exacto (derivar del union de
audio, retrocompatible). Códigos duplicados o fuera de `LANGUAGE_LABELS` ⇒ 400. Los
subtítulos siguen siendo externos: el contenedor de salida NO gana pistas de subtítulo.

S4 (metadata — decisión «Limpiar todo + idiomas»): `build_mux_command` escribe
`-map_metadata -1` (nada heredado a nivel contenedor: título de la web, comentarios,
encoder…), `-map_metadata` negativo por pista mapeada (tampoco hereda metadata por pista),
`-metadata title=<nombre del fichero de salida sin extensión>` y
`-metadata:s:a:N language=<código>` por cada pista de audio seleccionada (donde N es el
índice de salida). Efecto observable: un ffprobe del MKV de salida muestra `title` = nombre
del archivo y `language=` correcto por pista (incluido `und` cuando se eligió), y ninguna
tag de origen. Los subtítulos normalizan idioma vía nombre de sidecar (S3).

## Tasks

T1 (S2,S4) BE — `backend/interfaces/http/routes_mixer.py`: relajar
`_resolve_language_overrides` (cualquier pista + 12 códigos; path/ordinal siguen fail-closed)
y su gate; `backend/media_mixer.py`: `build_mux_command` con `-map_metadata -1`, limpieza
por pista, `title=` y `-metadata:s:a:N language=`. RED primero (tests no-und aceptados que
hoy dan 400; comando con las flags nuevas). Commit: `6db49c6` (feat/mixer: allow re-tagging
any audio track and normalize output metadata) — 184/184 foco + 17/17 contracts verificados;
ratchet 3427→3454 dueñado en el mensaje.

T2 (S3) BE — `MuxRequest` acepta `subtitle_languages` opcional; `_build_subtitle_plan` lo
respeta (sidecar + códigos de búsqueda + plan de la tarea); validación fail-closed (dup/fuera
de lista ⇒ 400); ausente ⇒ plan actual. RED primero. Commit: `feat(mixer): honor user-chosen subtitle languages in plan and sidecars`.

T3 (S2,S3) FE — `frontend/src/pages/MediaMixer.tsx`: dropdown en todas las filas de audio
(sustituye «Marcar como castellano», conservando su efecto: elegir `spa` = lo que hacía el
botón), selector por fila en subtítulos, payload con overrides ampliados +
`subtitle_languages`, «Buscar subtítulos» con los códigos elegidos. RED primero por test
(los tests L24/T10 existentes se actualizan al nuevo control manteniendo sus efectos).
Commit: `feat(mixer): language selectors for every audio row and subtitle row`.

T4 (S1-S4) Gates completos: backend 1642+RED/GREEN, frontend 790+, `tsc -b`, `eslint .`,
`npm run build`; ratchet `MAX_LEGACY_LOC` si sube (dueñado en el PR).

T5 Entrega: slices ≤400 líneas autorizadas, PR enlazando la doc, CI verde, merge, deploy
automático, verificación en prod con pareja real de ficheros.

## Log

L1 (2026-10-28, usuario): «perfecto ya funciona, ahora me gustaria que en las pistas de audio
y pistas de subtitulos podamos seleccionar el idioma y normalizar sus metadatas, ya que
muchos videos les ponen metadata de alguna pagina y no me gusta.»

L2 (decisiones Ask, mismo día): audio = «Selector en todas las pistas» (relaja L24: hoy sólo
`und`); subtítulos = «Selector por fila editable» (hoy sin control); metadata = «Limpiar todo
+ idiomas» (`-map_metadata -1` + `title=` = nombre de salida + `language=` por pista).

L3 (evidencia previa, cierre T7): la pareja real `ParaNorman.mkv × …XviD…HQCLUB.avi` devuelve
200 en prod tras el deploy de PR #248 (`80eee3c`); el 500 de Cotejar (UnicodeDecodeError en
ffprobe) está cerrado. Mapa de partida (explore): overrides sólo-und en
`routes_mixer.py:147-191`; `build_mux_command` sin ninguna flag `-metadata`
(`media_mixer.py:398-449`); panel de subtítulos sin controles (`MediaMixer.tsx:1166-1203`).

L4 (evidencia — corte de slice, rama `feat/idiomas-metadata`): slice 1 = `6db49c6` (T1:
144+31, 5 files) + `70f9191` (T2: 283+12, 2 files) = 468 líneas escritas > 400 ⇒ estrategia
«single-PR-with-disclosure» con el límite anotado aquí (patrón file-navigator F1, L3).
Slice 2 = T3 (FE) + T4; su frontera se anotará al commitearse. Riesgo aceptado en T2: un
mux de un solo archivo no construye plan de subtítulos (pre-existente en S6, sin regresión;
la petición sí valida 400).

L5 (evidencia — corte de slice 2): `873900d` (T3: 470+113, 6 files — dropdowns en audio y
subtítulos, payload con omisión de claves vacías, RED de 9 tests, y limpieza del CSS muerto
con clase local `.mixer-lang-select`) ⇒ acumulado 1051 líneas / 3 commits en la rama.
Cerrado single-PR-with-disclosure: el PR declara ambos cortes (L4/L5) y los gates de T4.
