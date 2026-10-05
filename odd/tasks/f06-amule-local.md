# F-06 — Estudio: implementación local de aMule

**Estado**: estudio cerrado · **Inicio**: 2026-10-05 · **Resultado**: recomendación con evidencia
**Alcance**: solo estudio. Sin PR de código, sin estimación de horas falsa.

---

## 1. El problema, medido

Las llamadas cruzadas van a **`111.111.111.111:4000`** (aMuTorrent). Contadas sobre el código
tal como está, por **pestaña abierta**:

| endpoint | intervalo | llamadas upstream por petición | /min |
|---|---|---|---|
| **`/api/downloads`** | **4 s** activo · 20 s inactivo | **4** (2 aMule + `fetch_arr_queue` × 2 arrs) | **60 activo** |
| `/api/trace` | 15 s | 1, **con caché de 10 s** → ~6 | ~6 |
| `/api/status` | 5 s | **0** — `background_checker` lo mantiene | **0** |

> **`/api/downloads` es el único de los tres sin caché** y es el que más golpea: sondeo cada 4 s
> con un patrón que los otros dos ya siguen.

Con `N` pestañas abiertas el coste se multiplica: **60 × N llamadas/min a un host remoto.**

---

## 2. Lo que F-06 ya resolvía (no se rehace)

- **Nunca hablamos con aMule**: hablamos con **aMuTorrent** por el puerto 4000 (índice Torznab
  + API compatible con qBittorrent + WebSocket).
- Las **cuatro opciones** y la pregunta del emplazamiento ya están en `BACKLOG.md` → F-06.
- **La cuestión de licencia sigue abierta**: proyecto **MIT**, aMule **GPL**.

---

## 3. Evidencia nueva de este estudio

### 3.1 No existe biblioteca Python que reutilizar

Comprobado con `pip index versions` y la API JSON de PyPI (Context7 no indexa nada de ED2K/Kad):

| paquete | qué es | ¿sirve? |
|---|---|---|
| `pymule` 0.2.0 | **McMule: cálculo de electrodinámica cuántica de orden superior** — coincidencia de nombre, nada que ver con aMule | ✗ |
| `ed2k` 0.0.2.2 | calculadora de **hashes** ED2K. MIT · Production/Stable · última publicación 2025-07 | ✗ **no transfiere nada** |
| `amule`, `ed2kpy`, `ed2k-python`, `aMuleWeb`, `mldonkey` | **no existen en PyPI** | ✗ |
| `libtorrent` 2.1.1 | maduro (BitTorrent) | contraste |

> Confirma lo que F-06 ya sospechaba: **no hay nada bajo qué apoyarse** para (a) ni para (c).

### 3.2 El patrón de solución **ya está en el repo y testeado**

- `background_checker` — tarea infinita en el lifespan, `check_all()` cada `CHECK_INTERVAL` (15 s),
  escribe `status_cache`. **`GET /api/status` devuelve ese caché sin tocar a nadie.**
- `_trace_cache` con `_TRACE_TTL = 10.0` en `routes/status.py`, con su test `tests_trace_cache.py`
  y el comentario que ya lo dice: *«What bounds a bad cache is the TTL itself: at most 10 s of
  staleness.»*

---

## 4. Las cinco opciones

| | Qué aporta | Coste | ¿Resuelve *llamadas cruzadas*? | ¿Da control de *emplazamiento*? |
|---|---|---|---|---|
| **(a) Motor propio** (ED2K + Kad) | todo | Muy alto · **sin biblioteca** (3.1) · sin biblioteca | ✓✓ | ✓✓ |
| **(b) Controlar aMule vía EC** | añadir/listar/pausar/**fijar directorio** | Medio · licencia GPL (3.3) | ✓ (local, TCP) | **parcial** |
| **(c) Cliente API-first** | transferencia por API | Medio-alto · **no existe en Python** (3.1) | ✓ | **no** (cliente ajeno) |
| **(d) Mantener aMuTorrent** | status quo | Bajo | ✗ | ✗ |
| **(e) Espelho local** ← **nuevo** | un solo sondeo en segundo plano; `/api/downloads` se sirve de memoria como ya hace `/api/status` | **Bajo** · patrón existente y testeado (3.2) | ✓✓ | ✗ |

---

## 5. ⚠️ Las dos metas del encargo **no son la misma pregunta**

El encargo dice *«implementación local de amule, para ahorrarnos todas las llamadas cruzadas»*,
pero F-06 se motiva por **el control de dónde cae el fichero**. Tienen respuestas distintas:

| Meta | Respuesta |
|---|---|
| **Ahorrar llamadas cruzadas** (lo que has pedido) | **(e)** — directo, barato, sin licencia, sin protocolo |
| **Control del emplazamiento** (la motivación de F-06: eliminar escaneo/colocación) | solo **(a)** o **(b)** — (e) no lo da |

---

## 6. Recomendación

1. **(e) primero.** Resuelve lo que has pedido, usa el patrón que ya existe (`background_checker`
   + `status_cache` + TTL, con test), y **no toca protocolo ni licencia**. Baja `/api/downloads`
   de 60/min por pestaña a un sondeo compartido.
2. **(b) después**, solo si además quieres fijar el directorio de descarga. **Resolver la
   cuestión GPL primero** — el proyecto es MIT.
3. **(a) y (c): no.** Sin biblioteca (3.1) y con coste alto, y (c) además **no existe** en Python.

### Por qué (e) no es "cachear para esconder"

(e) no elimina las llamadas: las reduce a **un sondeo por intervalo compartido**. Eso es
exactamente *«ahorrarnos las llamadas cruzadas»*. Si lo que querías era **eliminar el servicio
remoto**, eso es (a) o (b) y es otro proyecto.

---

## 7. Sin decidir

- **(e):** intervalo y TTL del sondeo de descargas (proponer ~3 s con TTL, medir).
- **(b):** la licencia GPL — *comprobar la versión exacta antes de tocar nada*.
