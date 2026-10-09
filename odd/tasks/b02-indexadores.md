# Bug B-02 — El listado de indexadores desaparece

## Objetivo
Que "Buscar" muestre siempre los indexadores de Radarr/Sonarr, distinguiendo con claridad
entre *"no hay ninguno configurado"* y *"no he podido preguntar"*, y que una lista ya pedida
para una fuente no se vuelva a pedir a los pocos minutos.

## Por qué
Reporte original del usuario: *"cuando abres el buscar hay veces que no conseguimos el listado
de indexadores, incluso ya habiéndolo utilizado antes. Deberíamos definir que hay dos tipos de
indexadores, los de Radarr y Sonarr, cada uno sirve para una cosa… si entro una vez a buscar
los indexadores de Radarr no tiene sentido que a los pocos minutos vuelva a entrar y tenga que
pedirlos de nuevo."*

## Causa raíz (verificada)
El error se traga en **tres capas**, y las tres devuelven exactamente lo mismo que "no hay
ninguno":

1. `backend/clients.py:766` (HTTP != 200) y `:787` (timeout/red) → `return []`.
2. `backend/routes/calendar.py:346-348` (`find_service` falla) y `:351` → `{"indexers": []}`,
   sin ningún campo de error.
3. `frontend/src/components/ReleaseSearchModal.tsx:97-102` → `useEffect` suelto,
   **sin react-query**, con `.catch(() => {})`.

Además no hay caché por fuente: el fetch se repite en cada apertura del modal, y
`routes/calendar.py:194` vuelve a llamar a `arr_indexers` en **cada** búsqueda de releases
solo para mapear nombre → id.

## Alcance
- ✅ `arr_indexers` expone el fallo con `arr_failure` (mismo patrón ya usado por `fetch_wanted_movies`).
- ✅ Ruta `/api/calendar/indexers` devuelve `indexers` + `error_kind` + `error`.
- ✅ Caché backend **300 s por `source`** que **nunca cachea un fallo** (patrón de `wanted.py:197-199`).
- ✅ `calendar_releases` reutiliza esa caché en vez de re-preguntar.
- ✅ Frontend: react-query con `queryKey: ['indexers', source]` → caché **separada por fuente**,
  que es justo lo que pidió. `staleTime` 5 min, `retry: 1`.
- ✅ UI: si falla, se dice **por qué** y hay botón de reintentar; si va bien y no hay ninguno,
  se dice que no hay ninguno.
- ❌ Fuera de alcance: partir la ruta en `/api/indexers/radarr` + `/api/indexers/sonarr` — es
  cosmético; la separación real es la clave de caché por fuente.
- ❌ Fuera de alcance: `debug_indexers` (`routes/status.py:171`) es una herramienta de
  diagnóstico y se queda como está.

## Checklist
- [x] T1 — Documento (este).
- [x] T2 — **RED** backend: el contrato actual afirma el bug
      (`tests.py:768-772 test_unknown_source_returns_empty`). Reescribirlo + tests de
      timeout y de caché (acerto: fallo no cacheado).
- [x] T3 — `clients.arr_indexers` devuelve el fallo.
- [x] T4 — `routes/calendar.py`: helper con caché por fuente + ruta + `calendar_releases`.
- [x] T5 — **RED** frontend: un fetch fallido debe mostrar el motivo (hoy no muestra nada).
- [x] T6 — `ReleaseSearchModal` con react-query + UI de error/reintento + CSS.
- [x] T7 — Envolver los renders existentes en `QueryProvider`
      (`ReleaseSearchModal.test.tsx`, `grabErrorFeedback.test.tsx`).
- [x] T8 — Docs (hechos con el commit; tildar al cerrar) (`BACKLOG.md`, `README.md`) → B-02 ✅ + trazabilidad. (Cerrado: BACKLOG B-02 ✅ entregado.)
- [x] T9 — Commit + push + PR; RAU-126 → Done tras el merge. (Cerrado: B-02 ✅ en BACKLOG.)

## Contratos que cambian (avisado)
- `arr_indexers` pasa de `list[dict]` a `dict` con `indexers` + `error_kind`/`error`.
  Solo tiene **2 llamadores reales** (`calendar.py:194` y `:350`) y 1 test que la parchea.
- `tests.py:768` (`test_unknown_source_returns_empty`) **deja de ser cierto**: un servicio
  desconocido ahora también informa. Se reescribe para afirmar el contrato nuevo.
- `ReleaseSearchModal` pasa a necesitar `QueryProvider`; los dos tests que lo renderizan
  se envuelven.

## Criterios de aceptación
- Timeout de Radarr → la UI dice *"radarr: no respondió a tiempo"* + reintentar, **no** una
  lista vacía silenciosa.
- Dos aperturas seguidas del modal para la misma fuente → **un solo** viaje a la red en el
  cliente; el backend responde de su caché.
- Fallo primero, éxito después → el fallo **no** se queda pegado en la caché (prueba explícita).
- `cd backend && python -m pytest -q` y `cd frontend && npm test` en verde; `npm run typecheck`
  y `npm run lint` limpios.

## Verificación
```bash
cd backend && python -m pytest -q
cd backend && python -m pytest tests_static.py -q
cd frontend && npm run typecheck && npm run lint && npm test
```
Runtime en vivo: **N/A** — no hay Radarr/Sonarr accesibles desde esta sesión; los fallos se
simulan con `AsyncMock`/stubs de `fetch`.

## Rollback
Un commit; toca `backend/clients.py`, `backend/routes/calendar.py`, `backend/tests.py`,
`frontend/src/components/ReleaseSearchModal.tsx`, `CalendarModal.css`, dos ficheros de test
y las filas B-02 de `BACKLOG.md`/`README.md`.

## Progreso
- [x] T1-T7
- [x] T8-T9 (cerrados: BACKLOG B-02 ✅)

## Siguiente paso
T8/T9: commit, push, PR.

## Evidencia
- RED backend: 7 fallos — `ImportError: _indexers_cache` (4) y
  `TypeError: list indices must be integers or slices, not str` (2, el contrato viejo) + el
  caso de servicio desconocido.
- RED frontend: `Unable to find role="alert"` (el error seguía tragado) y el test de caché.
- GREEN: backend **560 passed** (+5) + `tests_static` 8 · frontend typecheck/lint/build ✅,
  **225 tests** (+2, `indexerList.test.tsx`).
- Tarda ~1 s en pintar el motivo porque `retry: 1` da un intento extra antes de rendirse —
  el test lo sube a 5 s de timeout.
