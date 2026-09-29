# F-02a-c — Saca el bloqueo del event loop

## Objetivo
Ningún trabajo bloqueante (subprocess, filesystem sin acotar, CPU) se ejecuta sobre el event
loop de asyncio. Tres mitigaciones concretas de la lista F-02a..h del `BACKLOG.md`.

## Por qué
El estudio de arquitectura (F-02, "no reescribir en Go/Rust") concluyó que el cuello de botella
real no es la CPU sino **trabajo bloqueante ejecutándose en el loop**: mientras un handler
`async` hace `subprocess.run` o un `os.walk` con scoring, **todas** las demás peticiones
esperan. Es la clase de bug que un rewrite en Go/Rust habría eliminado de pasada, y es
barata de eliminar aquí.

## Alcance (los tres IDs críticos)
- ✅ **F-02a** — `routes_mixer.py` (2 `subprocess.run(ffprobe, timeout=30)` por petición, peor
  caso 60 s en el loop) y `routes/files.py` (`file_rename` `os.rename`, `file_delete`
  `rmtree`/`unlink`, `file_copy` `copytree`/`copy2` — operaciones sin cota sobre rutas de
  usuario en `/mnt/storage*`).
- ✅ **F-02b** — `routes/wanted.py::_scan_for_movies_inner`: `os.walk` × cada fichero de vídeo
  × **cada título** con `difflib.SequenceMatcher` → O(ficheros × títulos). Complejo de
  millones de `ratio()` en el loop.
- ✅ **F-02c** — sesión compartida: **30 construcciones de `aiohttp.ClientSession()`, todas
  por petición, cero `TCPConnector` en todo el backend.** Cada tick de sondeo paga TCP a la
  vez, sin keep-alive y sin techo de fan-out.

## Fuera de alcance (documentado, no olvidado)
- `file_browse` (`iterdir` + 2 `stat` por entrada sobre el mount de red) — HIGH, pero no
  estaba en F-02a publicada. **No se toca aquí.**
- `clients.py:1001,1049` (`isdir` por película/serie) → **F-02** aparte; además ahí está la
  causa (b) de B-01.
- sqlite síncrono fuera de `to_thread` → **F-02f**.
- `state.py` reescribe `logs.json` entero por WARNING → **F-02g**.
- TTL de `/api/trace` → **F-02d**; single-flight de la cola → **F-02e**;
  `config.SERVICES` congelado en el import → **F-02h**.

## Estrategia de entrega (decidida ANTES de escribir)
Tres mitigaciones independientes, pero **F-02c toca los mismos ficheros que a y b**
(`routes/files.py`, `routes/wanted.py`), así que se separa para no arrastrar conflictos:

| Entrega | Contenido | Base |
|---|---|---|
| **PR 1** | F-02a + F-02b (dos commits) | `main` |
| **PR 2** | F-02c | `main` tras PR 1 |

Si el conjunto pasa de ~400 líneas autoradas se pregunta antes de seguir (regla
`ask-on-risk`), no se recortan tests para entrar en el número.

## Checklist
- [x] T1 — Documento (este).
- [x] T2 — **RED**: tests que discriminan *en qué hilo* corre el código. Técnica: parchear el
      objetivo con un `side_effect` que llama a `asyncio.get_running_loop()` — dentro del loop
      resuelve (❌ bloqueando), en un worker de `to_thread` lanza `RuntimeError` (✅).
      Cobertura: probe, rename, delete, copy, scan.
- [x] T3 — F-02a: `asyncio.to_thread` en los 5 sitios.
- [x] T4 — F-02b: extraer la fase de walk+scoring a una función síncrona `_score_target` y
      `await asyncio.to_thread(...)`. Las fases 1-2 (HTTP al arr) **no** pueden entrar al
      hilo.
- [x] T5 — **Un solo commit para a+b**, no dos. Desviación de lo escrito arriba, y por qué:
      `tests_offloop.py` comparte el helper `_ran_on_the_event_loop()` entre sus 5 tests, y
      partirlo en dos ficheros duplicaría ese helper — exactamente la "dos copias que
      divergen" que este repo rechaza. Es el mismo defecto con el mismo patrón. F-02c sigue
      aparte: es otra mecánica (sesiones/connector) y toca otros ficheros.
- [x] T6 — Verificación completa (backend + frontend, aunque el frontend no cambia).
- [x] T7 — Docs: filas F-02a/b del `BACKLOG.md`.
- [ ] T8 — PR 1 → merge; RAU-130 no se cierra (quedan d..h).
- [ ] T9 — F-02c (PR 2).

## Riesgos / qué no debe romperse
- `tests_mixer_api.py` parchea `routes_mixer.probe_file` — con `to_thread(probe_file, …)` el
  nombre se resuelve en tiempo de ejecución desde los globals del módulo, así que el patch
  sigue funcionando.
- `tests_wanted_scan.py` llama a `_scan_for_movies_inner` con `asyncio.run` — `to_thread`
  funciona bajo cualquier loop.
- La respuesta del escaneo (`ok/matches/scanned_files/item_title/detail`) **no cambia**:
  `MissingContent.tsx` y `scanFolderNav.test.tsx` dependen de esa forma.
- `_validate_path` lanza `HTTPException` → tiene que seguir en el lado async (ya lo está).

## Criterios de aceptación
- Cada una de las 5 operaciones reporta `on_loop = False` en su test.
- `cd backend && python -m pytest -q` y `tests_static.py` en verde.
- Frontend sin cambios → typecheck/lint/test igual que antes.

## Verificación
```bash
cd backend && python -m pytest -q
cd backend && python -m pytest tests_static.py -q
cd frontend && npm run typecheck && npm run lint && npm test
```
Runtime en vivo: **N/A** — sin montajes de red ni ficheros reales en esta sesión; el coste
del loop se demuestra por pertenencia al hilo, no por cronometrar.

## Rollback
Un commit por mitigación (`perf(a)`, `perf(b)`), cada uno con su conjunto cerrado.

## Progreso
- [x] T1-T7
- [ ] T8-T9

## Siguiente paso
T8: push + PR; después T9 (F-02c).

## Evidencia
- **RED (5/5)**: cada test fallaba con `assert True is False` — ffprobe, rename, rmtree,
  copy2 y el scoring del escaneo corrían en el event loop.
- **GREEN**: `pytest -q` → **565 passed** (era 560) · `tests_static` 8 · `pyflakes` limpio
  en los 4 ficheros tocados · frontend typecheck ✅, eslint **0 problemas / 80 ficheros**,
  **225 tests** (sin cambios: no se tocó frontend).
- Presupuesto: **366 líneas autoradas** (< 400) → un solo PR, no hizo falta preguntar.
