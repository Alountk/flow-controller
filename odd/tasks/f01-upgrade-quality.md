# F-01 — Upgrade de calidad: destinos que conviven (4K / 3D / 1080p)

## Objetivo

Poder descargar una versión de **más calidad** (4K) o **3D** de una película que **ya tiene
archivo** en la biblioteca, y que el fichero nuevo aterrice en **su propia carpeta** sin tocar
el 1080p existente.

## Decisiones ya tomadas (no reabrir)

| Decisión | Elección |
|---|---|
| ¿El 4K **sustituye** o **convive**? | **Conviven.** Cero upgrade de Radarr, cero reemplazo |
| ¿Destino por release o por lote? | **Por release**, derivado automáticamente |
| ¿Cómo se detecta un 3D? | **Opción 4**: por el título, con corrección manual que **sobrescribe** lo detectado |
| Dónde se registran | `BACKLOG.md` (commits `5c377f9`, `c426345`) + comentarios en RAU-128 |

## El bloqueo (por lo que F-01 no funciona hoy)

`auto_copy.decide_copy` devuelve **SKIP** cuando `arr_has_file is True`
(`auto_copy.py:100`), y el destino solo se aplica **después** de esa decisión
(`auto_copy_driver.py:351` → `:434`). Para una película que **ya tiene archivo** — que es
*siempre* el caso en "conviven" — el destino **nunca llega a disco**.

Es un **bug latente ya shipped**: el selector "destino por selección" existe, guarda
`own_grabs.destination`, y es un no-op.

## Reparto en PRs (decidido en `c426345`)

| PR | Contenido | Estado |
|----|-----------|--------|
| **A** | Abrir el `SKIP` de `decide_copy` para destinos ajenos a la biblioteca | ✅ **PR #101** (`42d1acb`) — 626 tests |
| **B** | Destino por calidad: `paths.path_4k` / `paths.path_3d` + detección de 4K | ⬜ siguiente |
| **C** | Detección de 3D (título + corrección manual) | ⬜ |

---

## Tareas — PR A

### T1 — `decide_copy` entiende "destino explícito" 🔴
- [x] Añadir `has_destination: bool = False` a `decide_copy`.
- [x] El guard `arr_has_file is True → SKIP` solo aplica **cuando no hay destino explícito**.
- [x] **RED** en `tests_auto_copy.py`: con `arr_has_file=True` y `has_destination=True`,
      la traza en `downloaded` **no** debe hacer SKIP por "el arr ya tiene el fichero".

### T2 — `_grace_gate` no miente cuando hay destino 🔴
- [x] Con `has_destination=True`, tras vencer la ventana de gracia → **COPY** con razón
      que diga **el destino queda fuera de la biblioteca** (hoy diría "el arr no lo
      importó", que sería **falso** si `arr_has_file` es `True`).
- [x] `arr_has_file is None` (sonda caída) **tampoco** bloquea con destino: la ventana de
      gracia protege de **racing** al arr, no de duplicados.
- [x] **Sin destino**: comportamiento **idéntico al de hoy**, sin una sola rama nueva.

### T3 — el driver pasa el destino a la política 🔴
- [x] Subir `find_own_grab` de `_dispatch` a `_handle_trace` (hoy se consulta tarde).
- [x] Pasar `has_destination` a `decide_copy`.
- [x] **RED** en `tests_auto_copy_driver.py`: una traza con `arr_has_file=True` **y**
      `own_grab(destination=...)` debe terminar en `COPY`, no en `SKIP`.

### T4 — ⚠️ **Solo si el destino NO es raíz del arr** 🟠 (seguridad)
`GET /api/calendar/destinations` ofrece **las raíces de Radarr primero**
(`routes/calendar.py:414`). Si abrimos el guard sin más, elegir `/movies` copiaría el fichero
**en plano en la raíz** (el engine escribe `dest_root` "tal cual", sin subcarpeta — ver
`tests_copy_engine.py::test_copies_to_the_foreign_root`) → regresión sobre el estado actual,
donde eso simplemente no ocurre.

- [x] Resolver las raíces del arr **una vez por sweep** (`arr_root_folders`), solo si algún
      `own_grab` lleva destino. Caché por sweep: el sweep ya hace más llamadas que ésta.
- [x] **Fail-closed**: si las raíces no se pueden obtener → el gate **no se abre**. Hoy es
      exactamente lo que pasa, así que no hay cambio de comportamiento.
- [x] `_handle_trace` solo habilita `has_destination` si el destino está **fuera de todas**
      las raíces.

**Por qué fail-closed:** abrir a ciegas introduciría una regresión que hoy no existe.
Cerrarlo cuando no podemos demostrar que es ajeno deja el comportamiento **idéntico al de
ahora**.

## Criterios de aceptación

- [x] Una película **con archivo** + destino elegido → el fichero **llega** al destino.
- [x] Sin destino → comportamiento **byte a byte igual** al de hoy (los tests viejos no se tocan).
- [x] Destino = raíz del arr, o raíces no comprobables → **sigue sin pasar nada** (fail-closed).
- [x] Ventana de gracia: **sigue esperando** el mismo tiempo; solo cambia la **razón**.

## Checks

```
cd backend && python -m pytest tests_auto_copy.py tests_auto_copy_driver.py -q
cd backend && python -m pytest -q          # suite completa
cd backend && python -m pytest tests_static.py -q   # 8 + pyflakes + vulture
```

## Riesgos

- 🟠 **T4 es obligatorio, no opcional.** Es lo que separa "arreglar el no-op" de
  "permitir volcar ficheros en la raíz de la biblioteca".
- 🟠 Los tests de la política de auto-copy están **muy** afilados (D2/D3). Cualquier cambio
  de razón o de orden de reglas rompe tests que documentan una decisión deliberada.
- ⬜ PR B depende de este: si el gate no se abre, el destino por calidad es un no-op.
