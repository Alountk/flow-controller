# alternativa-indexadores — «Buscar y descargar alternativa» sobre NUESTROS indexadores

Feature: el flujo de alternativa del Media Mixer busca en los indexadores agregados al
proyecto (registro Torznab + aMule EC) en vez de los indexadores de Radarr/Sonarr.
Rama `feat/alternativa-indexadores`. Baseline: backend **1588** / frontend **754** (89) /
`tsc -b` 0 / `eslint` 0 / ratchet `MAX_LEGACY_LOC = 3408`.

## Specs

**S1 — Checklist de indexadores al abrir el flujo** (verbatim L1): «cuando le dan a
buiscar y descargar alternativa, salga la lista de indexadores que han agregado, amule ec,
y con un check tu selecciones donde quieres buscarlo». El modal de alternativa abre con un
checklist: una casilla por cada fila del registro (`GET /api/indexers`) más una casilla
«aMule (EC)»; las filas **deshabilitadas se muestran pero no son marcables** (un indexador
deshabilitado jamás se consulta); la selección determina dónde se busca.

**S2 — Título por defecto** (verbatim L1): «Luego por defecto deberiamos coger el titulo de
la pelicula(eso podriamos cotejar el nombre de un archivo y si no encuentra nada ponerlo
manual o luego implementar una busqueda de titulos tal vez conectando con alguna api, creo
que tenemos conexion con imdb o alguna parecida)». Input de título **precargado** con el
título que el lookup ya deriva del nombre del archivo y **siempre editable** a mano
(«si no encuentra nada ponerlo manual»). La búsqueda de títulos por API (IMDb u otra) queda
fuera: el usuario la pospuso («o luego implementar») y en el repo no existe conexión IMDb
directa (el lookup de Radarr/TMDb ya aporta `original_title`/`alternate_titles` para los
chips de «Búsqueda en idioma»).

**S3 — Búsqueda con ese título** (verbatim L1): «y con ese titulo que busque en los
indexadores encontrados». Con el título del input y la selección del checklist, el modal
consulta `POST /api/indexers/search` con `sources` + los ids seleccionados del registro;
las `skipped` de la respuesta se muestran (honestidad por fuente, contrato T4/S4).

**S4 — Selección de archivo y descarga** (verbatim L1): «después de esto seleccionar que
archivo descarga y lanzar el descargador». Cada fila de resultado ofrece «Descargar» →
`POST /api/indexers/download` (`link ?? guid`), y el modal **muestra el `detail`** devuelto
(aceptación o rechazo, 200 `{ok, detail}` en ambas direcciones, contrato T5/S5).

**S5 — Post-descarga manual** (decisión ask L2, «Manual (MVP mínimo)»): «Lanza la descarga
y te muestra el estado; tú colocas el fichero con el selector cuando termine. Sin vigilar
aMule/aMuTorrent.» El modal informa del resultado de la descarga lanzada; **no** se crea
espera ni auto-colocación. Se retira del flujo alternativo la maquinaria `altWait`
(polling `alternativeStatus`, banners «Descargando…/Dejar de esperar», auto-colocación) que
sólo se alimentaba del grab arr de este modal — sus tests se retiran/recolocan con
contabilidad en el Log. El endpoint backend `GET /api/mixer/alternatives/status` **se
conserva** (contrato probado, sin consumidor frontend tras esta feature).

**S6 — Sin gate de biblioteca** (decisión ask L3, «Quitarlo»): «El título sale del nombre
del archivo y se busca directamente en tus indexadores; sirve para cualquier archivo, esté
o no en Radarr.» El modal de alternativa **abre aunque `movie` sea `null`** (`movieId` 0);
se retira el aviso «… no está en la librería — añádela primero en Radarr» **sólo del flujo
alternativo** — el flujo S7 «Buscar en el indexador» (grab arr) conserva su gate y sus
tests. El 502 del lookup cuando Radarr está inaccesible/no configurado **se mantiene**
(no es el gate retirado: es otra máquina caída; contrato `tests_mixer_api` intacto).

**S7 — El modal se sustituye** (decisión ask L4, «Sustituirla»): «El modal pasa a: checklist
de indexadores → título precargado editable → resultados de tu búsqueda → descargar. La
lista de releases de Radarr desaparece de ese modal.» La lista de releases de Radarr y sus
maquinarias (jobs de búsqueda arr, filtros, chips 3D, botones de destino) desaparecen del
**modal de alternativa**; «Búsqueda en idioma» (Prowlarr) **se mantiene** dentro del nuevo
modal (condición explícita de la pregunta decidida).

**S8 — Idiomas de audio preservados** (verbatim del usuario en `mixer-redesign.md` L28):
«el modal recibe los idiomas de audio del otro archivo» — el nuevo modal recibe
`audio_languages` del lookup y los muestra (chips informativos), preservando el contrato
S10/L28.

## Tasks

| ID | Specs | Ruta | Commit |
|----|-------|------|--------|
| T1 | (doc) | parent | c1 doc |
| T2 | S3 | worker — backend: `indexer_ids` en `POST /api/indexers/search` + RED tests | c2 |
| T3 | S1,S2,S3,S4,S7,S8 | worker — frontend: componente `AlternativeModal` (checklist → título → resultados → descargar + Búsqueda en idioma) + RED tests | c3 |
| T4 | S5,S6,S7 | parent/worker — MediaMixer: montar nuevo modal, quitar gate de biblioteca y `altWait`; limpieza de `ReleaseSearchModal` (`alternativeMode`/`languageSearch`/`onGrabStarted`) + rework de tests contabilizado | c4 |
| T5 | todos | parent — gate completo + README + docs + PR + cierre | c5 |

Superficies permitidas por tarea (heading `## Allowed edit surfaces` en el handoff):

- T2: `backend/interfaces/http/routes/indexers.py` · `backend/tests/interfaces/routes/tests_indexers_search.py`
- T3: `frontend/src/features/alternative/**` · `frontend/src/__tests__/features/alternative/**` · `frontend/src/shared/api/indexers.ts`
- T4: `frontend/src/pages/MediaMixer.tsx` · `frontend/src/pages/MediaMixer.css` · `frontend/src/features/release-search/ReleaseSearchModal.tsx` · `frontend/src/shared/api/mixer.ts` · `frontend/src/__tests__/pages/mixerRedesign.test.tsx` · `frontend/src/__tests__/features/release-search/**`

## Log

**L1 — Petición original (verbatim):** «ok, quiero hacer el cambio de busqueda de los
buscadores mediante los indexadores agregados a mi proyecto en vez de los indexadores
utilizados a traves de radarr/sonarr y quiero hacer la primera implementacion donde tiene
sentido en la parte de media mixer. El flow deberia ser que cuando le dan a buiscar y
descargar alternativa, salga la lista de indexadores que han agregado, amule ec, y con un
check tu selecciones donde quieres buscarlo. Luego por defecto deberiamos coger el titulo de
la pelicula(eso podriamos cotejar el nombre de un archivo y si no encuentra nada ponerlo
manual o luego implementar una busqueda de titulos tal vez conectando con alguna api, creo
que tenemos conexion con imdb o alguna parecida) y con ese titulo que busque en los
indexadores encontrados, después de esto seleccionar que archivo descarga y lanzar el
descargador. Tengo dudas sobre esta ultima parte, ya que con amule el mismo se encarga de
eso, pero creo que con nuestros indexadores no tenemos implementada la conexion con
qbittorrent, no?»

**L2 — Decisión ask (post-descarga):** «Manual (MVP mínimo)» — «Lanza la descarga y te
muestra el estado; tú colocas el fichero con el selector cuando termine. Sin vigilar
aMule/aMuTorrent.»

**L3 — Decisión ask (gate biblioteca):** «Quitarlo» — «El título sale del nombre del archivo
y se busca directamente en tus indexadores; sirve para cualquier archivo, esté o no en
Radarr.»

**L4 — Decisión ask (alcance modal):** «Sustituirla» — «El modal pasa a: checklist de
indexadores → título precargado editable → resultados de tu búsqueda → descargar. La lista de
releases de Radarr desaparece de ese modal.» (La pregunta acotaba que «Búsqueda en idioma»
con Prowlarr se mantiene → se mantiene.)

**L5 — Respuesta a la duda de qBittorrent (evidencia):** la conexión SÍ existe y ya se usó:
`POST /api/indexers/download` (`backend/interfaces/http/routes/indexers.py:629`) despacha
`ed2k://`→EC directo, hash32→EC, `magnet:`/`http(s)`→`amutorrent_add_download`
(`backend/infrastructure/arr_client.py:995`, `POST {AMUTORRENT_URL}/api/v2/torrents/add`,
API compatible con qBittorrent, categoría `flow`). El único cliente torrent configurado es
aMuTorrent (`config.py:286`, `kind:"qbit"`); **no** hay un qBittorrent independiente
conectado. El gap real de esta feature no es el descargador: es la selección por indexador
individual en la búsqueda y la UI del flujo.

**L6 — Decisiones de diseño del padre (registradas, no del usuario):** (a) checklist con
**todas las casillas marcadas por defecto** (espejo del default «todas las fuentes» de la
búsqueda unificada de Settings); (b) **Prowlarr NO aparece en el checklist** — el usuario
enumeró «los indexadores que han agregado, amule ec» y Prowlarr queda sólo en «Búsqueda en
idioma» (amendable si lo pide); (c) **sin auto-búsqueda al abrir**: botón «Buscar» explícito
(principio del repo «the operator initiates, always»); (d) **no existe diseño Stitch**
aprobado para este modal → se sigue el patrón de modales del repo (cromos de
`ReleaseSearchModal`, filas de `IndexadoresSection`), CSS propio con prefijo, sin inline
styles; cualquier desviación visual se reporta; (e) `indexer_ids` no-lista o no-enteros →
400 español; ids que no casan con ninguna fila habilitada → `skipped` honesto (no 400: la
borrada concurrente de un indexador no debe romper la búsqueda); (f) el backend de
`/api/mixer/alternatives/lookup` no cambia ( sólo se retira el gate en el frontend, S6).

**L7 — T1:** feature doc creado (este fichero) + espejo Engram `odd/alternativa-indexadores/tasks`.

**L8 — T2 completado (worker `mvn2j07u-1-6ofk`):** `indexer_ids` opcional en
`POST /api/indexers/search`: validación (no lista/bool/float/str/≤0 → 400 español
«id de indexador no válido: «{v}»»), intersección con filas habilitadas, intersección
vacía → skipped honesto «ningún indexador de los seleccionados está habilitado» (nunca 400,
nunca silencioso), `absent/null/[]` byte-idéntico al default. RED observado (6 fallos),
9 tests nuevos, **backend 1597** (1588+9). Mensajes elegidos aquí: T3/README deben reflejarlos.

**L9 — T3 completado (workers `mvn2j07w-2-b4u8` + continue `mvn2yxs2-3-k9ht`):**
`AlternativeModal.tsx` + `AlternativeModal.css` + 16 tests (RED observado: import del
componente inexistente), `searchIndexers(query, sources, indexerIds?)` con body legacy
byte-idéntico. **frontend 770/90, tsc 0, eslint 0.** Libertades visuales (L6d, reportadas):
cromos `scan-modal` reetiquetados con prefijo `alt-modal-`, copy nuevo («Dónde buscar»,
«Fuentes omitidas», «Descargado ✓», «Sin enlace», «deshabilitado»), fallo total como
aviso «Error: …»; `lang-search-*` se estiliza desde `ReleaseSearchModal.css` (no duplicado).
Superficie T4 ampliada con `MediaMixer.css` (huérfanos del banner `mixer-alt-wait`).

**L10 — Commits y corte de slice (estrategia de entrega: PR único con divulgación):**
`e9e16a4` doc T1 · `d425091` backend T2 (404 líneas → **corte de slice aquí**: a partir de
este commit el PR excede ~400 líneas autoras y se declara en el cuerpo del PR) · `585aadf`
frontend T3 (1587 líneas autoras acumuladas en 3 commits al cerrar T3). T4 y T5 siguen en
la misma rama/PR.

**L11 — T4 completado (worker `mvn342st-4-dtym`) + limpieza parent:** `altModal` monta
`AlternativeModal` (S7), gate de biblioteca fuera del alternativo (S6 — `movieId: 0`, el
aviso «añádela primero» SOLO se retira del alternativo; el S7 `lookupMut` lo conserva),
maquinaria `altWait`/polling/auto-place/banners `onGrabStarted` eliminada (S5 — backend
`/alternatives/status` intacto, `alternativeStatus`+tipo borrados de `mixer.ts` sin otros
importadores), props `alternativeMode`/`languageSearch`/`onGrabStarted` fuera de
`ReleaseSearchModal`. Contabilidad de tests: 770 → **754/89** = 770 − 19 (7 altWait→S5/S6/S7
recolocados en 3 nuevos, 9 de `alternativeMode.test.tsx`→S7 obsoletos/duplicados con 2
migraciones marcadas, 3 `onGrabStarted`→S5/S7) + 3 nuevos; `languageSearchSection` 13 y
ingero S7 6 intactos en comportamiento. RED observado (3 fallos). Parent: reglas CSS
huérfanas `.release-download*` de `ReleaseSearchModal.css` eliminadas (único consumidor =
rama `alternativeMode`), README `indexers/search` documenta `indexer_ids`. Gate parent:
backend **1597** / frontend **754/89** / tsc 0 / eslint 0.

**L12 — CIERRE:** gate final parent (1597 / 754-89 / tsc 0 / eslint 0 / `npm run build` OK),
assessor `reviewDue:false` (riesgo medio, RDD off → self-verification, sin verificador
independiente), **PR #233** con divulgación de tamaño (2665 líneas/4 commits, corte L10),
CI verde (backend-tests, frontend-build, e2e 2m23s, docker-verify; docker-push → deploy
automático por webhook Portainer) y **merge `d51b6bc`** (`--merge --delete-branch`).
Risk del PR: **item 3** (contratos compartidos `indexers/search`+`ReleaseSearchModal` —
verificados con los 29 tests preexistentes de search y los pins diferenciales de los
otros mounts). Tareas T1–T5 completadas; feature CERRADA.
