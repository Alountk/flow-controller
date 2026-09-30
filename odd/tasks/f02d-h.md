# F-02d…h — Las cinco mitigaciones que quedan

## Objetivo
Cerrar la serie F-02a…h del `BACKLOG.md` (issue **RAU-130**). A y B ya están en `main`
(PR #81); C en `main` (PR #82). Faltan **d, e, f, g, h**.

## Por qué en cuatro PRs y no en uno
Estimación de líneas autoradas (código + tests + nota en BACKLOG):

| PR | Contenido | Est. |
|----|-----------|------|
| **A** | F-02d + F-02e | ~240 |
| B | F-02g | ~135 |
| C | F-02f | ~150 |
| D | F-02h | ~300 |

A+B juntos rozarían 400 sin margen para correcciones de revisión, y F-02h solo ya ronda 300.
Los cinco son **independientes** (ninguno requiere otro); los conflictos son solo de fichero.

## Decisiones tomadas (no preguntadas, y por qué)

- **F-02d — TTL de 10 s, no subir el intervalo del frontend.** Un TTL compartido hace que el
  coste dependa de la *ventana*, no del número de pestañas: 1 fan-out / 10 s con 1 pestaña o
  con 5. Subir el intervalo solo ayuda a una pestaña y cambia la UX.
- **F-02d — no se especializa el resultado vacío.** `build_traces` devuelve `[]` tanto en un
  pipeline en calma como en un fallo de red; no se pueden distinguir. Lo que acota un mal
  caché es el propio TTL (máx. 10 s de obsolescencia), y por eso va por debajo del sondeo de
  15 s. Queda anotado: lo correcto a largo plazo sería una señal de fallo en el retorno.
- **F-02e — doble señal en el guard, no una sola.** Solo `consumer_active` deja la cola
  bloqueada si el consumidor muere sin despejarla; solo `task.done()` pierde el wakeup cuando
  el consumidor va a salir y aún no ha terminado. Las dos, **bajo `queue_lock`**, cubren los
  dos sentidos.
- **Fuera de alcance y anotado, no olvidado:** la colisión de `op.id` (mismo milisegundo →
  una sola fila de historial) y el contador de pendientes (el tope de 50 solo poda los
  terminados, nunca rechaza un `add`).

## Checklist
- [x] T1 — Documento (este).
- [x] T2 — **RED** de F-02d y F-02e.
- [x] T3 — F-02d: `_TRACE_TTL` + `_trace_cache` en `routes/status.py`.
- [x] T4 — F-02e: `state.consumer_active` + `_ensure_consumer()` + clear bajo lock.
- [x] T5 — Verificación completa.
- [x] T6 — Docs (`BACKLOG.md`).
- [x] T7 — **PR #83** (`a0273f5`, merge `9da08e9`) → F-02d/e en `main`.
- [x] T8 — F-02g en la rama `perf/append-only-log`: `os.open(O_APPEND)` + `_trim_log_file()`
      amortizado (1 reescritura por 512 KiB, no una por WARNING), con `_LOG_BYTES`
      inicializado desde el tamaño real del fichero.
- [ ] T9 — F-02f (PR C).
- [ ] T10 — F-02h (PR D) — **necesita decisión del usuario** (ver abajo).

## Decisión pendiente de F-02h (no la tomo yo solo)
`config.SERVICES` y otros ~10 constantes se congelan en el import. Hay dos vías:

- **Tier 1 (barato):** `config.rebuild()` que muta los contenedores *in situ* → los 28
  `from config import SERVICES` los ven sin tocar ni un llamador. Deja `safe_mode`,
  `paths.*`, `intervals.*` y `tracing.limit` igual de muertos.
- **Tier 2 (completo):** convertir ~15 sitios de 8 módulos a `config.X` en tiempo de llamada.
  Arregla también que **la UI dice "guardado" para `safe_mode` y es un no-op** (no está en
  `RESTART_REQUIRED_FIELDS`, así que ni siquiera avisa).

Y aparte: `routes/files.py:25`, `routes/wanted.py:428` y `routes_mixer.py:46` **ignoran por
completo** `paths.allowed_roots` con una copia dura de `["/mnt/storage", "/mnt/storage-6tb"]`
— es decir, la raíz que el usuario ponga en Configuración no valida nada en el explorador de
ficheros. Arreglarlo es un cambio de comportamiento.

## Evidencia de A (F-02d + F-02e)

- **RED**: `assert 2 == 1` (el segundo sondeo volvió a pagar las 9 llamadas),
  `ImportError: _TRACE_TTL`, `AttributeError: no attribute '_ensure_consumer'`,
  `a drained consumer left the flag set`.
- **Tres fallos tras el primer GREEN, todos míos salvo uno:**
  1. El test de expiración heredaba la caché del test anterior → `_cold()` al principio.
  2. El test de "tres ensures" contaba `started` antes de que la tarea programada llegara a
     correr → `await asyncio.sleep(0)`.
  3. **Uno era del código**: el guard decía `task is None or not task.done()` y se negaba a
     arrancar cuando la bandera estaba puesta y **no había tarea** — justo el estado que hay
     que reparar. Corregido a `task is not None and not task.done()`.
- **GREEN**: `pytest -q` → **576 passed** (era 570) · `tests_static` 8 · pyflakes limpio ·
  frontend typecheck ✅, **225 tests**, eslint **0/80**.
- Runtime: **N/A** — sin arr ni descargas reales; la caché y el guard se demuestran por
  conteo de llamadas y por pertenencia al lock, no por cronometrar.

## Siguiente paso
Push + PR de F-02g; después T9 (F-02f).

## Evidencia de F-02g (T8)

- **RED (3)**: `persist read the whole file to append one line` — hacían falta **dos**
  registros, porque el primero no lee (el fichero aún no existe) y el test pasaba por el motivo
  equivocado —, `the file was rewritten 3 times for 3 records` y
  `no attribute _LOG_FILE_MAX_BYTES`.
- **Test propio corregido tras el GREEN**: asertaba `_LOG_BYTES <= MAX_BYTES`, imposible con un
  trim por número de líneas. Lo que importa es que el contador se **reajuste** al recortar; si
  no, se recorta en cada escritura y volvemos al problema de origen.
- **GREEN**: `pytest -q` → **580 passed** (era 576) · `tests_static` 8 · pyflakes limpio ·
  frontend typecheck ✅, **225 tests**, eslint **0/80**.
