# Stitch port 04 — Líneas de resumen en las tarjetas de serie

## Objetivo
La lista izquierda de Series (vista Biblioteca/Todas) debe mostrar las líneas de
resumen del diseño 04: recuento de episodios+temporadas y línea de completitud.
Honestidad: solo datos del payload (regla del handoff).

## Delta actual → diseño
- **Actual**: fila con título/año/pill/chips + `extra = "{episode_file_count}/{episode_count} episodios"`
  (`CatalogListings.tsx:230-236`, igual en card fallback `:268-272`).
- **Diseño 04**: bajo la fila — "N episodios en M temporadas" + "Faltan N episodios
  para completar la serie" / "Todos los episodios descargados" (con chip MONITORIZADA
  ya hecho en #190).

## Alcance
- [ ] T1 (frontend): línea de completitud derivada — `missing = episode_count −
      episode_file_count`: >0 → `Faltan N episodios para completar la serie` (tono
      warn/bad); 0 → `Todos los episodios descargados` (tono ok); `episode_count==0`
      o ausente → no renderizar. Ambas ramas (SectionRow + card fallback).
- [ ] T2 (frontend): `· N temporadas` en la línea extra cuando el payload traiga
      `season_count` (campo OPCIONAL — si no está, la línea queda como hoy).
- [ ] T3 (backend): serializar `season_count` desde Sonarr `statistics.seasonCount`
      en `backend/infrastructure/arr_client.py` bloque `:1597-1611` (junto a
      `episode_count`/`episode_file_count`). Opcional en el tipo
      `frontend/src/shared/types.ts` (`AllSeries`). Tests backend del mapper.

Restricciones: NO tocar MissingListings (son filas por episodio), ni filtros,
ni la interacción de la fila. `season_count` opcional ⇒ cero cambios en los ~10
stubs `AllSeries` de tests. Estructura `.sec-row-name/.sec-row-year` intacta
(e2e `flow-faltantes.spec.ts:54` la pinna).

Ruta: delegated direct (writer) — 3 tareas en frontend+backend.
TDD: RED primero (fila con completitud + mapper season_count).

## Checks
- desde `frontend/`: `./node_modules/.bin/vitest run`,
  `./node_modules/.bin/tsc -b --noEmit`, `./node_modules/.bin/eslint src/`
- desde `backend/`: `../.venv/bin/python -m pytest` (o el path del venv verificado)
- e2e de CI es GATE

## Estrategia de delivery
- ask-on-risk. Forecast <400 líneas → 1 PR.

## Progress
- 2026-10-11: doc creada, rama `feat/series-summary-lines` desde main (1a0b4bd).
