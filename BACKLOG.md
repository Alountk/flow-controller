# Backlog

Estado: `main` = `8cd4dce`. Documento vivo — el detalle largo vive en `README.md`
(## Backlog de mejoras) y en `ROADMAP.md`.

Todo lo de este documento está creado en **Linear**, proyecto **`flow-controller`** (equipo
`RAU`), en estado `Backlog`:

| ID | Linear | ID | Linear |
|----|--------|----|--------|
| B-04 | RAU-124 | C-01 | RAU-131 |
| B-03 | RAU-125 | C-02 | RAU-132 |
| B-02 | RAU-126 | C-03 | RAU-133 |
| B-01 | RAU-127 | C-04 | RAU-134 |
| F-01 | RAU-128 | C-05 | RAU-135 |
| F-03 | RAU-129 | C-06 | RAU-136 |
| F-02 | RAU-130 | C-07 | RAU-137 |
| C-08 | RAU-138 |  |  |

---

## 🔴 Bugs abiertos

| ID | Bug | Severidad | Evidencia | Estado |
|----|-----|-----------|-----------|--------|
| **B-04** | `POST /api/actions/*` devuelve **500**: `routes/actions.py:46` hace `from state import _http_session` y `state.py` no define ese símbolo (vive en `app.py:48`). Ninguna acción de la UI funciona. | **Alta** | Verificado en runtime con Python. `tests.py:422` solo publica una acción *desconocida*, por eso la suite está en verde. | ✅ |
| **B-03** | El escaneo encola la operación como `move` → `routes/files.py:219` `os.rename`, y en EXDEV copia **y borra el origen** (`:226`). Rompe el hardlink con el que aMule/qBittorrent siguen compartiendo el archivo. Debería copiar (idealmente `os.link`, como ya hace `copy_engine.copy_file_chunked`). | **Alta** | `MissingContent.tsx:126` → `queueAdd('move', …)` | ✅ |
| **B-02** | "Buscar" a veces no muestra el listado de indexadores: el error se traga en **tres capas** y devuelve `[]`, indistinguible de "no hay indexadores". Además no hay caché ni clave por `source`. | Media | `clients.py:766,787` → `[]`; `routes/calendar.py:343-351` sin campo `error`; `ReleaseSearchModal.tsx:96-102` `.catch(() => {})` | ⬜ |
| **B-01** | Al pasar a naranja, la barra izquierda de la card se queda roja. **Dos causas distintas**: (a) `MissingContent.css:187-191` pinta `border-color: var(--warn)` y luego `border-left-color: var(--bad)` en la *misma* regla, con guarda solo para `.status-ok`; (b) `clients.py:1001,1049` comprueba `os.path.isdir` con la **ruta cruda del arr** sin pasar por `host_path()`, así que una película sana se clasifica `status-error`. | Media | Verificado en disco ambas | ⬜ |

**B-04 resuelto** — rama `fix/actions-session-import`: la sesión ahora se abre por petición
  en `routes/actions.py` (igual que el resto de rutas), y el global muerto de `app.py` se eliminó
  porque nunca lo leía nadie. Regresión cubierta por
  `tests.py::TestRunActionValidation::test_a_valid_action_reaches_do_action`, que hoy da 500
  si alguien reintroduce el import roto.

**B-03 resuelto** — rama `fix/scan-places-without-destroying`. El escaneo ahora encola
  **`copy`** en vez de `move`, y la rama de copia de la cola pasó por `_place_file`:
  **enlace duro primero** (instantáneo, cero bytes extra, el origen sigue sembrando), creación
  del directorio destino, guarda `samefile` para no vaciar un inodo compartido y copia atómica
  por temporal. `move` sigue existiendo y sigue siendo un movimiento honesto — es el botón del
  FileManager. Tests: `TestConsumeQueuePlacesWithoutDestroying` (2; RED observada: directorio
  destino inexistente y `b'' == b'payload'`) y `scanFolderNav.test.tsx` (RED:
  `expected 'move' to be 'copy'`).

**Decisión de diseño pendiente en B-01:** en *Faltantes* la barra roja sobre fondo naranja es
**intencional** (comentario en `MissingContent.css:182-186`: "el rojo sigue diciendo que no hay
archivo, el naranja que ya se pidió"). Hay que confirmar en qué pestaña se ve el fallo:
si la badge dice `✗ Ruta no encontrada` en una película que sí tiene archivo → causa (b);
si dice `✗ Sin archivo` en *Faltantes* → es el diseño y hay que decidir si se cambia.

---

## 🟢 Features

### F-01 — Upgrade de calidad desde la biblioteca (4K / 3D) + destino + renombrado · **Grande**

Pedida: acceso a las películas ya agregadas en Radarr, descargar en formato de más calidad
(4K) o 3D, escoger el destino y renombrar el archivo una vez copiado.

**Lo que ya existe** (no reimplementar):

| Pieza | Dónde |
|-------|-------|
| Búsqueda de releases (`POST /api/v3/release`) con calidad expuesta al cliente | `clients.py:1312-1373`, `routes/calendar.py:177-202` |
| Filtros combinables (texto / calidad / idioma / seeders) | `utils/releaseFilters.ts` |
| Selector de destino por grab | `GET /api/calendar/destinations`, `own_grabs.destination` → `dest_root` |
| Copia hardlink-first | `copy_engine.copy_file_chunked` (`os.link` primero, `:49`) |
| Renombrado manual | `POST /api/files/rename`, `FileManager.tsx` |
| Biblioteca completa con pósteres | pestaña "Todas", `GET /api/wanted/all` |

**Los huecos (etapas):**

1. **Entrada para películas con archivo.** El modal es un callejón sin salida:
   `ReleaseSearchModal.tsx:349` solo pinta "✓ Ya tiene archivo descargado" y no ofrece buscar;
   `Calendar.tsx:94` ni siquiera deja abrirlo. Sin esto no hay upgrade.
2. **Eje "resolución" + presets 4K.** `releaseFilters.ts` solo compara la calidad *exacta*;
   no hay 2160p/1080p/720p ni noción de "4K". Como `quality` ya llega al cliente, **esto no
   toca backend**.
3. **Detección de 3D.** Cero ocurrencias de 3D/HSBS/HTAB/SBS en todo el repo. *Decisión:*
   parsear el título (frágil) · confiar en los flags del indexador · etiquetado manual.
4. **Acotar la búsqueda en servidor (opcional).** `arr_fetch_releases` solo manda
   `movieId`/`episodeId`; Radarr acepta `quality` y `minimumSeeders` y hoy no se usan. La
   búsqueda puede tardar hasta **240 s** (`clients.py:1322`).
5. **Destino en upgrades.** ⚠️ `auto_copy.py:100` hace *SKIP* cuando `arr_has_file` es
   `True`, que en una película con archivo **siempre lo es** → el destino que elijas hoy es
   un no-op. Hay que decidir: upgrade dentro de la biblioteca (Radarr reemplaza y renombra él)
   o copia a carpeta externa (fuera del control de Radarr).
6. **Renombrado tras la copia.** Hoy solo se *detecta*: `clients.py:576` lee
   `GET /api/v3/rename` y reporta `renamed_needed`, pero **nadie ejecuta nunca el rename**.
   Falta un paso tras `run_copy_background` (`copy_engine.py:179`).

**Decisiones de producto que dependen del usuario:**
- ¿El 4K **sustituye** al archivo existente en la biblioteca o **convive** junto a él?
- Si conviven, ¿qué pasa con el fichero viejo (conservar / borrar / archivar)?
- ¿Pre-chequear el perfil de calidad de Radarr y avisar si no permite 2160p, o dejar que
  Radarr devuelva su 400?
- ¿Destino único por lote (hoy) o destino por release?

### F-02 — Estudio: ¿el backend nos vale o necesitamos Go/Rust? · **Veredicto: NO reescribir**

**A favor de quedarse (evidencia, no opinión):**

| Hecho | Fuente |
|-------|--------|
| El coste dominante es **esperar a Radarr/Sonarr/aMuTorrent por LAN** (timeout 5 s, 3 reintentos). Go/Rust espera igual de despacio. | `config.py` `REQUEST_TIMEOUT` |
| Carga real ≈ **80-110 req/min de una pestaña**, I/O-bound, sin saturación CPU | `/api/trace` + `/api/downloads` |
| ~**524 tests** + capa de dominio no trivial (mapeo contenedor→host, settings cifrados, política de auto-copy, 6 migraciones SQLite) → reescribir es re-derivar la parte más arriesgada y con menos valor | `backend/tests*.py` |
| Un rewrite no arregla ninguna de las latencias que notamos | — |

**Lo que un rewrite SÍ compraría:** sin GIL sobre parseos de ~1 MB × ~15/min, y sobre todo
**eliminar la clase de bug "me olvidé de offload"**, que hoy tiene 11 sitios.

**Mitigaciones baratas (F-02a … F-02h), ordenadas por valor/esfuerzo:**

| ID | Mitigación | Gravedad |
|----|-----------|----------|
| F-02a | `await asyncio.to_thread(...)` en `routes/files.py:109,122,138,140` y `routes_mixer.py:83-84` (`subprocess.run(ffprobe)` puede parar el loop hasta **60 s**) | Crítica |
| F-02b | Offload del `os.walk` + scoring O(ficheros×títulos) en `routes/wanted.py:554-581` | Alta |
| F-02c | Una sola `ClientSession` compartida + `TCPConnector(limit=…, limit_per_host=…)`: hoy hay **30 construcciones por request** y keep-alive cero | Alta |
| F-02d | TTL corto (5-10 s) en `/api/trace` o en `fetch_qbit_torrents` → baja el fan-out 3-6× | Media |
| F-02e | Single-flight en el consumidor de la cola de ficheros (`routes/files.py:320`): hoy N adds → N copias concurrentes | Media |
| F-02f | Mover ~10 llamadas síncronas a sqlite detrás de `to_thread` (están en la ruta caliente de `/api/wanted`) | Media |
| F-02g | Log append-only en vez de leer y reescribir `logs.json` completo en cada WARNING (`state.py:28-40`) | Baja |
| F-02h | `config.SERVICES` se congelta en el import: tras guardar settings hay que reconstruirlo (relacionado con F-03) | Baja |

### F-03 — Wizard de primera puesta en marcha (tipo Overseerr / aMuleTorrent) · **Mediana**

**Ya existe** una pantalla de setup (`SetupPage.tsx` + `GET/POST /api/setup`), pero no es una
ruta, no valida paso a paso y **descarta el `restart_required`** (`SetupPage.tsx:62`), así que
el usuario nunca se entera de que hay que reiniciar.

**Los 9 pasos que la configuración real implica:**

1. Bienvenida + detección de estado · 2. Secreto `FC_SECRET` (solo verificable, es env-only) ·
3. Radarr (URL + API key → `GET /api/services/test`) · 4. Sonarr · 5. aMuTorrent ·
6. Rutas y raíces permitidas · 7. Clave de API de la app (opcional, no reinicia) ·
8. Avanzado (intervalos, `tracing.limit`, `safe_mode`, `developer`, `port`) ·
9. Revisar y guardar → mostrar `restart_required`.

**Huecos:** no hay endpoint que valide existencia/escritura de rutas · `needs_setup` puede
quedarse colgado (usa `config.SERVICES`, congelado en el import) · `RESTART_REQUIRED_FIELDS`
(`routes/settings.py:18-24`) no incluye `safe_mode`, `developer`, `intervals.*`, `paths.*`,
así que la UI miente al decir "guardado sin reiniciar".

---

## 🔵 Recomendaciones y reglas del ciclo

C-01…C-07 son mías; **C-08 es tuya** («siempre hardlink») y ya está aplicada.

| ID | Feature | Por qué, con evidencia |
|----|---------|------------------------|
| **C-01** | **Aviso de import bloqueado** (webhook/Telegram/email) | La app *existe* para detectar que el flujo se corta, y hoy solo te enteras si miras la pantalla. El ROADMAP ya lo tenía en Fase 4. |
| **C-02** | **Gestor de import bloqueado**: reintentar / limpiar en un clic | Hay un caso real documentado en producción (`Transformers … 2160p`, `importBlocked`). Hoy solo se *ve*, no se actúa. |
| **C-03** | **E2E con Playwright** | B-01 y B-02 son exactamente el tipo de fallo que ni el CSS ni los tests unitarios cazan. Ya estaba en el backlog (#12) — subirle prioridad. |
| **C-04** | **Upgrades automáticos programados** 1080p → 4K | Extensión natural de F-01: en vez de pedirlo a mano, una cola de upgrade por perfil de calidad. |
| **C-05** | **Rate limiting + Request ID** | Ya en el backlog (#13/#14). Ahora que hay auth por API key, una key filtrada sin límite es un agujero. |
| **C-06** | **Responsive + dark mode** | Ya en el backlog (#10/#11). Ninguna prueba visual. |
| **C-07** | **Ajuste de `IMPORT_TIMEOUT` desde la UI** | Lo que ya estaba pendiente en este documento: el backend lo soporta (`intervals.import_timeout`), falta el control en la pestaña *Configuración*. Ojo: `intervals.*` **no** está en `RESTART_REQUIRED_FIELDS` pero `background_checker` lo lee en import (`status.py:79`). |
| **C-08** | **Regla «siempre hardlink»** — nada rompe la semilla | Un cliente de descargas comparte la **ruta**, no el inodo: renombrar o mover borra la entrada sembrada aunque los datos sobrevivan. Aplicada a la cola (move), a `rename`, al endpoint muerto `/api/files/move` (fuera) y a `copytree` (ahora enlace duro por fichero). **Pendiente:** `importMode: "Move"` en `clients.py:1465,1474`, a probar contra el ajuste de hardlinks de Radarr. | ✅ |

**Descartadas (con motivo):** *WebSockets para progreso* — la cola ya usa polling adaptativo
(3-5 s activo / 15-30 s en reposo) y el WebSocket de aMuTorrent es de comandos, no de
progreso (verificado). *DI con `Depends()`* — refactor sin efecto observable.

---

## 🗄️ Completado (histórico)

Ver `README.md` → *Backlog de mejoras* para las tablas cerradas (#1-#24).

---

## Orden propuesto

`B-02` + `B-01` → `F-02a..h` → `F-03` → `C-03` → `F-01` → `C-01/C-02`
