# Feature: Búsqueda por idioma en la alternativa (Prowlarr)

Fecha: 2026-10-21 · Estado: en diseño · Prerequisito: URL + API key de Prowlarr (usuario).
Diagnóstico previo (datos reales): Radarr pide FR/EN/ES (perfil 7 `language=Spanish`) y nunca `alternateTitles`; repro viva: Arthur 43 releases / 0 cirílicos, Bolt 203 / 1.

## Specs

- S1 (petición original, verbatim): «quiero profundizar en el buscar y descargar alternativa, cuando lo pulsamos sale el modal con la misma implementacion que cuando busco desde peliculas y series. Creo que aqui deberia ser algo diferente o bien deberiamos adaptar un poco esto, porque te explico.»
- S2 (premisa de idioma, verbatim): «Normalmente buscamos los titulos en los indexadores por ingles o castellano, pero creo que cuando buscamos en otro idiomas deberiamos buscarlos en ese idioma en los indexadores porque si no no saldran»
- S3 (casos concretos, verbatim): «Arthur and the Invisibles (2006), Bolt (2008) los idiomas en rusos no estany tengo indexadores donde puedo encontrarlos.»
- S4 (decisión usuario 2026-10-21): «Chips de idioma + input» — el modal muestra chips con el título original + alternativos conocidos (con su idioma) que rellenan un input editable; el usuario puede añadir a mano el título en el idioma que quiera (p. ej. «Артур и минимоны») cuando TMDB no lo tenga.
- S5 (decisión usuario): «Sólo en alternativa» — la sección nueva vive únicamente en el flujo de «Buscar y descargar alternativa»; Películas/Series y los demás usos de ReleaseSearchModal no cambian.
- S6 (decisión usuario): «Prowlarr + término por idioma» — servicio `prowlarr` nuevo en el backend (URL + API key) y búsqueda de texto vía `GET /api/v1/search` de Prowlarr con el término en el idioma elegido.
- S7 (descarga, decisión técnica): la alta de un resultado Prowlarr reutiliza el alta directa ya existente en qBittorrent (`amutorrent_add_download`: magnet o URL de .torrent); no pasa por Radarr.

## Tasks

- T1 · S6 · config: servicio `prowlarr` (sección services + override env `PROWLARR_URL`/`PROWLARR_API_KEY` + defaults) con tests de contrato. Commit: pendiente.
- T2 · S6/S7 · backend: `prowlarr_search()` en infrastructure + endpoint `POST /api/mixer/alternatives/language-search` (query, language, movieId) → releases normalizados (título, indexador, tamaño, seeders, magnet/downloadUrl). TDD RED primero. Commit: pendiente.
- T3 · S4/S5 · frontend: sección «Búsqueda en idioma» en el modal de alternativa: chips desde `originalTitle`/`alternateTitles` (nuevos en `AlternativeLookupResponse`) + input editable + lista de resultados. TDD RED primero. Commit: pendiente.
- T4 · S7 · frontend+backend: alta vía `amutorrent_add_download` desde la lista nueva + estado de espera/feedback. Commit: pendiente.
- T5 · todas · suites: 1293 backend / 660 frontend verdes, `tsc -b`, eslint, ratchet `MAX_LEGACY_LOC`; differential de los tests del modal compartido (S5 garantiza que no cambian). Commit: pendiente.
- T6 · todas · PR único en rama de feature + review RDD + HANDOFF + Engram. Commit: pendiente.

## Log

- L1 (2026-10-21, usuario): «va perfecto. ahora quiero profundizar en el buscar y descargar alternativa, cuando lo pulsamos sale el modal con la misma implementacion que cuando busco desde peliculas y series. Creo que aqui deberia ser algo diferente o bien deberiamos adaptar un poco esto, porque te explico. Normalmente buscamos los titulos en los indexadores por ingles o castellano, pero creo que cuando buscamos en otro idiomas deberiamos buscarlos en ese idioma en los indexadores porque si no no saldran»
- L2 (2026-10-21, usuario): «Arthur and the Invisibles (2006), Bolt (2008) los idiomas en rusos no estany tengo indexadores donde puedo encontrarlos.»
- L3 (2026-10-21, diagnóstico): FAQ de Radarr: búsqueda por ID y, si no hay resultados, fallback de texto con Original + English + Translated según `language` del perfil (= Spanish); `alternateTitles` nunca se buscan (issue Radarr #11443). Repro viva contra su Radarr: Arthur 43 releases / 0 cirílicos (131 s), Bolt 203 / 1 (29 s; la única cirílica empieza por «Bolt» en latín). Perfiles 1-7: casi todos `Spanish`. Probe directo Torznab del indexador Knaben(Prowlarr) → 401 desde este Mac (pendiente de revalidar con la API key de Prowlarr).
- L4 (2026-10-21, usuario, decisiones): «Chips de idioma + input» · «Sólo en alternativa» · «Prowlarr + término por idioma».
