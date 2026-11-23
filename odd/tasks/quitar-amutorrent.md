# Quitar aMuTorrent
Objetivo: eliminar todo uso de aMuTorrent; aMule solo por su API directa (EC). Rama por PR. Runner: pytest (backend), vitest (frontend).

## Specs
- S1: "quiero quitarlo todo, nuestra comunicacion ya sera por la api directa de amule."
- S2: La lista de descargas (downloads_cache) y las trazas (traces.fetch_qbit_torrents) leen de la API directa de aMule.
- S3: Recargar carpetas compartidas: si EC no lo soporta, se acepta perder la función ("si").
- S4: Borrar ramas, config, ajustes, UI, compose, README y tests de aMuTorrent; settings.json antiguo con `services.amutorrent` no debe romper.

## Tasks
- T1 (S2) PR 1: traces y downloads_cache sin aMuTorrent (adaptador desde EC + completados en disco) — inline — hecho (PR pendiente de merge)
- T2 (S3) PR 2: recarga de carpetas compartidas — inline — pendiente
- T3 (S4) PR 3: borrar lo viejo — inline — pendiente

## Log
- L1: "verifica que no estemos utilizando nada del amutorrent." → "quiero quitarlo todo, nuestra comunicacion ya sera por la api directa de amule." → "si" (plan en 3 PRs).
