# Flow Controller

Panel de control para el flujo de descargas **Radarr → aMuTorrent → Sonarr**.
Detecta dónde se rompe el pipeline y ofrece acciones de remediación directas
desde la UI (corregir categorías, mapear rutas, reintentar imports, etc.).

**Version**: 1.3.0 (ver `VERSION`)

## Stack

- **Backend**: Python 3.11 / FastAPI / aiohttp (async)
- **Frontend**: React 19 / TypeScript / Vite 7 / @tanstack/react-query
- **Control aMuTorrent**: WebSocket nativo (`ws://host:4000/ws`)

## Requisitos

- Python 3.10+
- Node.js 18+
- Radarr, Sonarr y aMuTorrent corriendo y accesibles

## Instalación

```bash
git clone https://github.com/Alountk/flow-controller.git
cd flow-controller
```

### Backend

```bash
cd backend
cp .env.example .env        # rellenar con tus URLs y API keys
pip install -r requirements.txt
./run_local.sh               # http://localhost:8000
```

### Frontend (desarrollo)

```bash
cd frontend
npm install
npm run dev                  # http://localhost:5173 (proxy a :8000)
```

### Producción

```bash
cd frontend && npm run build   # genera dist/
# FastAPI sirve dist/ automáticamente en /
cd ../backend && ./run_local.sh
```

### Docker

```bash
docker compose up -d --build
```

## Workflow de verificación (ANTES de cada push)

**NUNCA hacer push sin verificar que el sistema arranca.** Pasos obligatorios:

```bash
# 1. Tests backend (incluye linters estáticos pyflakes + vulture)
cd backend && pip install -r requirements-dev.txt && python -m pytest -q

# 2. Build frontend
cd frontend && npm run build

# 3. Docker build + start
docker compose build && docker compose up -d

# 4. Health check (esperar ~15s, puerto 8000)
curl http://localhost:8000/api/status

# 5. Solo si todo OK → push
git push origin main
```

**Nota:** `python -m pytest` descubre automáticamente todos los módulos `tests*.py`
(config en `backend/pytest.ini`), así que un archivo de tests nuevo no puede quedar
fuera de CI por olvido. Los tests de rutas (`tests_routes.py`) mockean únicamente
el transporte HTTP, de modo que el cuerpo real de cada endpoint se ejecuta.
El backend se mantiene **100% limpio de pyflakes y vulture** (`tests_static.py`);
cualquier hallazgo falla la suite:

- **pyflakes** — nombres indefinidos (crash en runtime) e imports/variables sin usar.
- **vulture** — funciones, clases, métodos y atributos muertos. Config en
  `backend/pyproject.toml`; las excepciones intencionales van en
  `backend/vulture_whitelist.py`, **cada una con su motivo escrito**.
  `vulture` necesita `ignore_decorators` para no marcar todos los handlers de
  FastAPI (se registran por decorador, no por llamada).

### CI Pipeline (GitHub Actions)

El workflow `.github/workflows/ci.yml` ejecuta automáticamente:

1. **Backend tests** — pytest con todos los suites (descubrimiento automático) + linters (pyflakes + vulture)
2. **Frontend tests + build** — Vitest + TypeScript + Vite
3. **Docker verify** — Build imagen, arrancar contenedor, health check en `/api/status` (puerto 8000)
4. **Docker push** — Solo si todo pasa y es push a `main`

**Si el health check falla, el pipeline para y NO crea la imagen Docker.**

## Variables de entorno

Copia `backend/.env.example` a `backend/.env` y rellena:

| Variable | Descripción |
|----------|-------------|
| `RADARR_URL` | URL de Radarr (ej. `http://192.168.1.10:7878`) |
| `RADARR_API_KEY` | API key de Radarr |
| `SONARR_URL` | URL de Sonarr |
| `SONARR_API_KEY` | API key de Sonarr |
| `AMUTORRENT_URL` | URL de aMuTorrent (API qBittorrent-compatible) |
| `AMUTORRENT_API_KEY` | API key de aMuTorrent |
| `AMUTORRENT_USER` | Usuario de la web UI de aMuTorrent |
| `AMUTORRENT_PASSWORD` | Contraseña de la web UI (requerida para WebSocket) |
| `SAFE_MODE` | `true` para bloquear acciones destructivas |
| `FOLDER_OUTPUT_MIXED` | Ruta de salida para archivos mixeados (default: `/mnt/storage/mixed`) |

## API

| Endpoint | Método | Descripción |
|----------|--------|-------------|
| `/api/status` | GET | Estado de todos los servicios |
| `/api/status/refresh` | GET | Fuerza re-chequeo de servicios |
| `/api/trace` | GET | Trazabilidad: correla grabs ↔ torrents ↔ cola |
| `/api/actions` | GET | Catálogo de acciones disponibles |
| `/api/actions/{action}` | POST | Ejecuta una acción sobre una descarga |
| `/api/calendar` | GET | Calendario de próximos episodios/películas |
| `/api/calendar/releases` | POST | Busca releases disponibles para un item |
| `/api/calendar/indexers` | GET | Lista de indexadores configurados |
| `/api/calendar/grab` | POST | Descarga un release específico |
| `/api/calendar/grab-batch` | POST | Descarga múltiples releases en lote |
| `/api/wanted` | GET | Contenido faltante (wanted/missing) |
| `/api/wanted/scan` | POST | Escanea carpeta buscando contenido desubicado |
| `/api/disk` | GET | Uso de disco en volúmenes |
| `/api/settings` | GET/POST | Configuración persistente |
| `/api/mixer/probe` | POST | Analiza dos archivos de video (pistas, compatibilidad) |
| `/api/mixer/mux` | POST | Mezcla pistas de audio seleccionadas |
| `/api/mixer/tasks` | GET | Lista todas las tareas de mixer |
| `/api/mixer/tasks/{id}` | GET | Estado de una tarea de mixer |
| `/api/mixer/tasks/{id}/cancel` | POST | Cancelar tarea |
| `/api/mixer/tasks/{id}/pause` | POST | Pausar tarea |
| `/api/mixer/tasks/{id}/resume` | POST | Reanudar tarea |

### Acciones disponibles

| Acción | Descripción |
|--------|-------------|
| `fix_category` | Pone la categoría correcta en aMuTorrent y reintenta el import |
| `fix_path_mapping` | Crea un remote path mapping en Radarr/Sonarr |
| `copy_files` | Copia archivos del cliente de descargas al directorio correcto del *arr |
| `retry_import` | Fuerza a Radarr/Sonarr a reprocesar la descarga |
| `research` | Lanza una búsqueda del episodio/película |
| `pause` | Pausa la descarga en aMuTorrent |
| `resume` | Reanuda la descarga en aMuTorrent |
| `remove_queue` | Elimina el item de la cola del *arr |
| `delete_torrent` | Elimina la descarga de aMuTorrent |

## Arquitectura

```
flow-controller/
├── VERSION                    # Semantic version
├── backend/
│   ├── config.py              # Environment variables, constants, action catalog
│   ├── settings.py            # Persistent JSON config (settings.json)
│   ├── clients.py             # API clients: Radarr, Sonarr, aMuTorrent (WS + REST)
│   ├── traces.py              # Trace building: path resolution, stage derivation
│   ├── copy_engine.py         # File copy with progress, cancellation, import verification
│   ├── app.py                 # FastAPI app, lifespan, routes, static files
│   ├── tests.py               # 59 tests (unit + API endpoint)
│   ├── requirements.txt
│   ├── .env.example
│   └── run_local.sh
├── scripts/
│   ├── verify.sh              # Pre-push verification (TypeScript build + backend tests)
│   └── test-calendar-grab.sh  # Playwright headless test for calendar flow
└── frontend/
    └── src/
        ├── App.tsx
        ├── types.ts
        ├── api/
        │   ├── auth.ts
        │   ├── calendar.ts    # Calendar API: search, releases, grab
        │   ├── wanted.ts      # Wanted/missing content API
        │   └── files.ts       # File manager API
        ├── components/
        │   ├── CalendarModal.tsx    # Calendar search/download modal
        │   ├── MissingContent.tsx   # Wanted/missing content viewer
        │   ├── DiskSpace.tsx        # Disk usage visualization
        │   ├── Settings.tsx         # Persistent settings UI
        │   └── ...
        └── hooks/usePolling.ts
```

## Postmortem: Calendar Flow — Bugs encontrados y corregidos (v1.2.0)

### 1. Release filter por indexador nunca funcionaba
**Error:** Usuario selecciona un indexador específico → 0 resultados aunque hay releases totales.

**Causa:** El dropdown usaba `String(idx.id)` como value, pero `r.indexer` contenía el nombre (`"Torznab"`). El filtro comparaba `"1" === "Torznab"` — nunca matcheaba.

**Fix:** Resolver el ID a nombre antes de filtrar: `indexers.find(i => String(i.id) === selectedIndexer)?.name`

### 2. Releases de AMULE/aMuleTorrent nunca aparecían
**Error:** En Sonarr se ven releases de AMULE, pero en nuestro flow nunca salen.

**Causa:** Usábamos `GET /api/v3/release` que solo devuelve releases **cacheadas** (RSS). Radarr necesita `POST /api/v3/release/search` para lanzar búsqueda real en TODOS los indexadores.

**Fix:** Cambiar a `POST /api/v3/release/search` con `movieIds: [id]`.

### 3. Grab devolvía 405 Method Not Allowed
**Error:** Al hacer click en "Descargar", Radarr respondía 405.

**Causa:** Usábamos `POST /api/v3/release/pick` (endpoint inexistente) y solo mandábamos `{guid}`. Radarr necesita `POST /api/v3/release` con `{guid, indexerId, movieId}`.

**Fix:** Cambiar endpoint y añadir campos requeridos.

### 4. IndexerId siempre era 0
**Error:** `"IndexerId must be greater than 0"` al hacer grab.

**Causa:** La respuesta de Radarr (`POST /api/v3/release/search`) devuelve `indexer` (nombre) pero NO `indexerId`. Nosotros pasábamos 0.

**Fix:** Después de buscar releases, llamar a `arr_indexers` y construir mapa `nombre → id` para enriquecer cada release.

### 5. Error 500 en `/api/wanted/scan`
**Error:** `TypeError: expected string or bytes-like object, got 'dict'` en `_normalize_title`.

**Causa:** `alternateTitles` de Sonarr devuelve `[{title: "...", sceneSeasonNumber: ...}]` no strings. El código hacía `all_titles.append(alt)` con un dict.

**Fix:** Extraer `t.get("title") if isinstance(t, dict) else t` en los 3 puntos donde se procesa `altTitles`.

### 6. ScanModal perdió estilos — carpetas se ven como botones nativos
**Error:** En el modal de "En carpeta" (Contenido Faltante), las subcarpetas se renderizan con borde, fondo y estilo de botón HTML nativo, no como lista navegable limpia. Los chips de idioma también cambiaron de checkboxes a botones.

**Causa:** En el commit `b846400` (infinite scroll), al editar `MissingContent.tsx` se reescribió el JSX interno de `ScanModal` sin verificar el CSS existente. Se sustituyeron:
- `<div className="scan-path-list">` + `<div className="scan-folder-item">` por `<button className="scan-folder-item">`
- `<label className="scan-lang-check"><input type="checkbox">` por `<button className="scan-lang-chip">`
- Clases CSS nuevas sin definición: `.scan-browse-section`, `.scan-folder-list`, `.scan-lang-chip`

Los botones nativos heredan `border`, `background-color` y `outline` del navegador, rompiendo la apariencia visual.

**Fix:** Restaurar el JSX original de `ScanModal` alineado con el CSS preexistente (líneas 1608–1850 de `styles.css`):
- Carpetas: `<div className="scan-path-list">` con `<div className="scan-folder-item" onClick=...>`
- Idiomas: `<div className="scan-lang-list">` con `<label className="scan-lang-check"><input type="checkbox">`
- Botón de escaneo: `<button className="action-btn search-all">`
- Resultados: `<div className="scan-match">` con `.scan-match-file`, `.scan-match-path`, `.scan-match-score`

**Lección:** Al refactorizar un componente, verificar que las clases CSS usadas en el JSX existan en el stylesheet. Los `<button>` nativos siempre necesitan reset explícito (`border: none`, `background: transparent`) si se usan como elementos de lista.

## Postmortem: Errores recurrentes de TypeScript build

### TS2367: Comparación con tipos incompatibles
**Causa:** Cuando se usa `useState<Tab>('movies')`, TypeScript infiere el tipo como el literal `'movies'`, no la unión completa `'movies' | 'episodes'`. Comparaciones como `tab === 'episodes'` fallan.

**Solución:** Tipar explícitamente el genérico: `useState<'movies' | 'episodes'>('movies')`.

**Ejemplo:**
```tsx
// ❌ Error
const [tab, setTab] = useState('movies')
tab === 'episodes' // TS2367

// ✅ Correcto
const [tab, setTab] = useState<'movies' | 'episodes'>('movies')
tab === 'episodes' // OK
```

### TS2322: Tipos de parámetros incompatibles entre módulos
**Causa:** Dos archivos definen el mismo tipo `Page` con valores diferentes. Si un hook (`usePageRoute`) retorna un tipo `Page` que no incluye un valor nuevo (`'config'`), el componente que lo consume no puede asignarlo al tipo `Page` del Sidebar.

**Solución:** Mantener una sola definición de `Page` (en `Sidebar.tsx`) e importarla en todos los módulos. Actualizar todos los tipos cuando se agrega un valor.

### TS2352: Casting de interfaces a `Record<string, unknown>`
**Causa:** TypeScript no permite casting directo de una interfaz a `Record<string, unknown>` porque la interfaz no tiene index signature.

**Solución:** Usar doble casting: `as unknown as Record<string, unknown>`.

### ModuleNotFoundError en Docker
**Causa:** El Dockerfile copia archivos backend uno por uno (`COPY backend/app.py .`). Si se agrega un módulo nuevo (`settings.py`) sin agregarlo al Dockerfile, el contenedor no lo encuentra.

**Solución:** Agregar `COPY backend/settings.py .` al Dockerfile. Considerar cambiar a `COPY backend/ .` para evitar este problema en el futuro.

## Backlog de mejoras

### ⚡ Cortas (1-2 horas)

| # | Mejora | Estado | Archivos |
|---|--------|--------|----------|
| 1 | Eliminar dead code (`clients.py:868` except duplicado) | ✅ | `backend/clients.py` |
| 2 | Health check en Dockerfile | ✅ | `Dockerfile` |
| 3 | Límites de recursos (RAM/CPU) en docker-compose | ✅ | `docker-compose.yml` |
| 4 | Fix API key expuesta en `/api/config` | ✅ | Cadena cerrada: `/api/config` ya no entrega la clave y las 21 rutas de datos exigen auth |

### 🟡 Medianas (1-3 días)

| # | Mejora | Estado | Archivos |
|---|--------|--------|----------|
| 5 | Split `app.py` en módulos de rutas | ✅ | `app.py` → `routes/*.py` |
| 6 | Unificar TaskManager (3 sistemas idénticos) | ✅ | `task_manager.py` + integración completa |
| 7 | Extraer post-move import a servicio compartido | ✅ | `backend/import_service.py` |
| 8 | CSS Modules o Tailwind (66KB monolítico) | ✅ | Modularizado por componente (`components/*.css` + `styles/global.css`) |
| 9 | Tests de componentes React (0 actualmente) | ✅ | `frontend/src/__tests__/*.test.tsx` (39 tests) |
| 19 | **Filtrar los faltantes** (títulos alternativos + filtro de resultados) | ✅ | `clients.py`, `MissingContent.tsx`, `utils/scanResults.ts` |
| 20 | **Filtros en los resultados de los indexadores** | ✅ | `ReleaseSearchModal.tsx`, `utils/releaseFilters.ts`, `utils/selection.ts` |
| 21 | **Feedback de descargas en la cola de operaciones** | ✅ | `routes/downloads.py`, `hooks/useDownloads.ts`, `QueueSidebar.tsx` |
| 23 | **Persistencia del historial de operaciones (SQLite)** | ✅ | `backend/history.py` + `routes/files.py` |
| 22 | **Filtro de texto en faltantes** | ✅ | `routes/wanted.py`, `MissingContent.tsx`, `hooks/useDebouncedValue.ts` |

### 🔵 Largas (1-2 semanas)

| # | Mejora | Estado | Archivos |
|---|--------|--------|----------|
| 10 | Diseño responsive (móvil/tablet) | ⬜ | Frontend |
| 11 | Dark mode | ⬜ | Frontend |
| 12 | E2E tests con Playwright | ⬜ | Nuevo `e2e/` |
| 13 | Rate limiting middleware | ⬜ | Middleware FastAPI |
| 14 | Request ID tracking para debugging | ⬜ | Middleware FastAPI |

### 🟣 Superfluas (2-4 semanas)

| # | Mejora | Estado | Archivos |
|---|--------|--------|----------|
| 15 | Dependency injection con FastAPI `Depends()` | ⬜ | Backend |
| 16 | Documentación OpenAPI formal | ⬜ | FastAPI auto-genera |
| 17 | UI para operaciones por lotes | ⬜ | Frontend |
| 18 | WebSocket para progreso en tiempo real | ⬜ | Backend + Frontend |

### 🔎 #19 — Filtrar los faltantes

Arrancó de un hallazgo: el filtrado por idioma **existía en la UI y el backend lo ignoraba por
completo** — checkboxes que bloqueaban el botón de escaneo mientras `routes/wanted.py` no leía
`req.local_path` en ningún punto. Al verificarlo contra la API real apareció además un bug mayor.

**Hecho ✅**

1. **Los títulos alternativos ya se usan.** `clients.py` leía `altTitles`, pero Radarr devuelve
   `alternateTitles` — el campo estaba siempre vacío, así que el escaneo solo comparaba contra el
   título principal. Un archivo llamado `Ton Nom (2016).mkv` era invisible. Sonarr ya usaba el
   nombre correcto.
2. **Filtro manual en los resultados del escaneo** (`utils/scanResults.ts`). Sustituye al selector
   de idiomas, que prometía algo que el backend nunca hizo.
3. **"Seleccionar todo" solo afecta a lo visible**, nunca a lo oculto por el filtro.

**Aparcado (probablemente no se haga)**

- **Etiquetar cada título con su idioma vía TMDB.** Es viable: tenemos `tmdbId` y TMDB expone
  `GET /3/movie/{id}/translations` con `iso_639_1` + `data.title`. **Pero no merece la pena**:
  los títulos alternativos **ya se usan todos**, así que esto añadiría *precisión* (poder excluir
  idiomas), no *cobertura* — no encontraría ningún archivo que no encuentre ya. A cambio exige
  API key de TMDB, salida a internet desde el contenedor y una llamada por película (con caché
  obligatoria). Solo tendría sentido si aparecen falsos positivos por títulos cortos.
- **Filtro de idioma en el listado.** La misma trampa: el listado está paginado (50 por página,
  1981 episodios) y Radarr/Sonarr no ofrecen búsqueda por texto ni por idioma, así que un filtro
  en cliente solo miraría lo ya cargado. En el **escaneo** sí es honesto porque devuelve todos los
  resultados de una vez.

> **Ojo:** `pyflakes` no detecta funciones ni clases muertas — solo imports y variables locales.
> Este caso lo demuestra, y por eso el proyecto usa **vulture** además de pyflakes.

### 🌐 #20 — Filtros en los resultados de los indexadores

La búsqueda en indexadores devuelve **todo de una vez**, agrupado por indexador y sin filtro.
Medido en vivo: **403 releases** para una sola película. Con scroll, eso no es una lista, es
una aguja en un pajar.

**Hecho ✅** — barra de filtros combinables (AND entre ejes, OR dentro de cada multiselección):

| Filtro | Datos reales medidos |
| --- | --- |
| Texto libre (título) | — |
| Calidad (multiselección) | Bluray-1080p 59 · WEBDL-1080p 56 · WEBDL-720p 45 · SDTV 28 |
| Idioma (multiselección) | English 223 · Italian+English 31 · Unknown 31 · Spanish 26 |
| Seeders mínimos | mediana **1**; 35 releases con 0 |

Detalles que importan:

- **Aquí el filtro de idioma sí es posible**, al contrario que en los faltantes: los releases
  traen `languages` etiquetado. Además **0 releases traen la lista vacía** (siempre hay al menos
  `Unknown`), así que el filtro nunca oculta nada por falta de datos.
- Las opciones de calidad e idioma se calculan del conjunto **completo**, no del filtrado, para
  que no desaparezcan mientras filtras.
- **"Seleccionar todo" solo afecta a lo visible**, y los grupos de indexador vacíos no se pintan.
- **No se duplica el filtro de indexador**: el desplegable "Indexador:" del paso inicial ya
  filtra por indexador.

La regla de "seleccionar todo solo sobre lo visible" vive en **una única implementación**
compartida (`utils/selection.ts`), usada por el escaneo y por los indexadores: dos copias son
dos ocasiones de divergir, y la divergencia es silenciosa.

---

### 🔤 #22 — Filtro de texto en faltantes

**Hecho ✅** — input a la derecha de "Faltantes / Todas", en las dos pestañas.

El filtro es **en servidor**, y eso no es un detalle de implementación: el listado está paginado
(50 por página, 1981 episodios), así que filtrar en el navegador solo vería lo ya cargado y diría
"sin resultados" mientras hay coincidencias sin descargar. El backend trae todo, filtra y pagina
las coincidencias, así que **`total` refleja el conjunto filtrado**.

Medido en vivo:

| Petición | Resultado |
| --- | --- |
| `/api/wanted?source=radarr` | total=94 |
| `...&q=the` | **total=90** ← sobre los 94, no sobre los 5 cargados |
| `/api/wanted/all?q=the` | **total=332** de 908 |
| `/api/wanted/series/all?q=rick` | total=1 |

Detalles:

- **Sin filtro nada cambia**: se sigue pidiendo una página al arr (cero regresión de coste).
- **Con filtro** se pide todo de una vez: verificado que `pageSize=2000` devuelve los 95
  largometrajes y los 1981 episodios en una sola petición.
- **Caché de 60 s** del listado completo: sin ella, cada tecla redescargaría ~1,3 MB.
- **Debounce de 350 ms** en el input.
- Ignora mayúsculas y acentos, y busca también en títulos alternativos y sinopsis.

> **Bug cazado por la verificación en vivo, no por los tests:** los endpoints `/all` paginan
> **dentro del cliente**, antes de que la ruta los vea. La primera versión filtraba esa página ya
> recortada, así que `q='your'` devolvía 0 aunque "Your Name." estuviera en la biblioteca, y
> `q='the'` devolvía 1 en vez de 332. Los tests de ruta no podían verlo porque el recorte ocurre
> en el cliente: hizo falta un test que usara el **cliente real** contra un transporte HTTP falso.

### 💾 #23 — Persistencia del historial de operaciones

**Hecho ✅** — SQLite, en `CONFIG_DIR/history.db` junto a `settings.json` y `logs.json`.

Antes: las últimas 50 operaciones vivían **solo en memoria** y la UI mostraba 10; un reinicio
borraba todo. Para una app cuyo trabajo es detectar dónde se rompe el pipeline, no recordar qué
pasó ayer era justo lo contrario de lo que debe hacer.

**Por qué SQLite:** está en la stdlib, es un fichero, da consultas y transacciones reales y no
necesita ningún servicio. Las escrituras son raras (unas pocas por operación), así que el API
síncrono de `sqlite3` se usa desde `asyncio.to_thread`. Modo **WAL** para que las lecturas no
esperen a las escrituras.

**Qué se persiste y cuándo** — tres puntos, no cada actualización de progreso:

| Momento | Para qué |
| --- | --- |
| Al **encolar** | Es el caso que importa: 5 copias encoladas y un reinicio antes de que corran |
| Al **empezar** | Deja rastro de que llegó a arrancar |
| Al **terminar** | Resultado final: `done` / `failed` / `cancelled` + `import_status` |

**Recuperación al arrancar:** una copia no sobrevive al proceso que la copiaba, así que dejar
una operación en `running` para siempre sería mentira. Al iniciar se marcan como
`failed (interrumpida por reinicio)`.

**Verificado en vivo:** encolé una operación que falló, **reinicié el servidor** y
`/api/files/queue/status` la devolvió desde la base de datos con la cola en memoria vacía.
Y sembrando una fila en `running`, el arranque la reconoció:
`Marked 1 interrupted operation(s) as failed`.

**Robustez:** si la base de datos no está disponible, se registra un aviso y **la app sigue
copiando archivos** — el historial es un registro, no un requisito. Un test lo cubre.

**Preparado para el futuro:** el esquema usa `PRAGMA user_version`, así que una tabla `users`
(el Paso 3, si algún día se quieren cuentas) se añade con una migración, sin rehacer nada.

**Detalle que destapó un test:** al pasar un diccionario parcial, los campos ausentes
**borraban datos** con `NULL`. Ahora la actualización usa `COALESCE`, así que un llamador
futuro no puede destruir el `movie_id` que enlaza la operación con su entrada de biblioteca.

### ⬇️ #21 — Feedback de descargas en la cola de operaciones

**Hecho ✅** — panel de descargas en el sidebar, dividido **en vertical** (operaciones 2/3 arriba,
descargas 1/3 abajo).

**Por qué en vertical y no en horizontal:** el sidebar mide ~280 px, así que un tercio serían
~90 px, insuficiente para títulos reales como
`Transformers El ultimo caballero (2017).BDrip 2160p x265 10Bit DV HDR DUAL ac3-eac3.(.HispaShare.).mkv`
junto con progreso, velocidad y ETA.

**Unión de dos fuentes** por `downloadId` ↔ `hash` (con `normalize_hash`, el mismo que ya usaba
la trazabilidad). Cada fuente aporta lo que la otra no tiene:

| Radarr/Sonarr | aMuTorrent |
| --- | --- |
| `trackedDownloadState`, `statusMessages`, `timeleft`, `sizeleft` | `dlspeed`, `eta`, `num_seeds` |

**Control de coste** (el hallazgo que decidió el diseño):

| Enfoque | Torrents | Payload |
| --- | --- | --- |
| `/torrents/info` sin filtro | 813 | **1097 KB** |
| Filtrado por categoría | **1** | **1.4 KB** |

Comprobado que `hashes=` y `filter=` **se ignoran** y `category=` sí funciona. Y las categorías
reales incluyen **`radarr-ru`** y **`tv-sonarr-ru`**, así que el filtro cubre la base y sus
variantes con guion — filtrar solo las base perdería las descargas rusas. **Con la cola vacía no
se consulta a aMuTorrent**: en reposo el coste es cero.

**Verificado en vivo** con una descarga real:

```json
{"title": "Transformers El ultimo caballero (2017).BDrip 2160p...",
 "problem": true, "tracked_state": "importBlocked", "tracked_status": "warning",
 "messages": ["Failed to import movie"],
 "progress": 88.6, "speed": 4680957, "eta_seconds": 483, "seeders": 1, "matched": true}
```

Ese caso — descarga terminada e **import bloqueado** — es justo lo que la app existe para
detectar, y hasta ahora no se veía en ningún sitio.

**Degradación y errores:** si el cliente de descargas falla, se sigue mostrando el progreso de
Radarr, se marca "Sin datos del cliente de descargas" y **se dice cuál falló y por qué**; nunca
se presenta como "sin descargas".

#### Qué se quiere

Al añadir una descarga desde un indexador, no hay ninguna señal de por dónde va.
Idea inicial: dividir la zona de la cola de operaciones en **2/3 cola de operaciones** y
**1/3 descargas**.

#### Estudio de APIs (medido en vivo)

**Fuentes disponibles**

| Fuente | Endpoint | Qué aporta |
| --- | --- | --- |
| Radarr/Sonarr | `GET /api/v3/queue` | `status`, `trackedDownloadState`, `size`/`sizeleft`, `timeleft`, `estimatedCompletionTime`, `statusMessages`, `downloadId`, `downloadClient`, `indexer` |
| aMuTorrent | `GET /api/v2/torrents/info` | `progress`, **`dlspeed`**, **`eta`**, `num_seeds`, `state`, `hash` |
| aMuTorrent | `GET /api/v2/torrents/properties?hash=` | `dl_speed`, `dl_speed_avg`, `eta`, `peers` — solo para UN torrent |

**Clave de unión:** `downloadId` de Radarr ↔ `hash` de aMuTorrent. Ya existe `normalize_hash`
en `traces.py`, y `build_traces` ya hace este join para la vista de trazabilidad.

**El hallazgo que condiciona el diseño:** `GET /api/v2/torrents/info` sin filtro devuelve
**1097 KB / 813 torrents**. Un poll cada 3 s serían ~20 MB/min. Comprobado qué filtros funcionan:

| Parámetro | Resultado |
| --- | --- |
| `hashes=` | **ignorado** (813) |
| `filter=downloading` | **ignorado** (813) |
| `category=radarr` | **funciona** (1) |

Ojo con las categorías reales del servidor: existen **`radarr-ru`** y **`tv-sonarr-ru`** además
de `radarr` / `tv-sonarr` / `sonarr`. Un filtro que solo cubra las no-RU perdería descargas.

`GET /api/v2/sync/maindata` (el endpoint incremental de qBittorrent) devuelve **401** con la API
key; requeriría sesión de login como la que ya usa `amu_ws_login`.

El **WebSocket** de aMuTorrent es de **comandos** (enviar acción y esperar `*_complete`), no un
stream de progreso. No sirve para push de descargas tal cual.

#### Diseño recomendado

1. **Endpoint nuevo y ligero** `GET /api/downloads` — NO reutilizar `/api/trace`, que carga
   historial de grabs, todas las películas y todas las series (medido ~1 s). El nuevo solo
   consulta las dos colas y aMuTorrent.
2. **Filtrar aMuTorrent por categoría** para evitar el megabyte. Y **si la cola está vacía, no
   llamar a aMuTorrent**: en reposo el coste es cero.
3. **Polling dinámico**, como ya hace `QueueSidebar`: 3-5 s con descargas activas, 15-30 s en reposo.
4. **Errores explícitos por fuente** (lección de `/api/wanted` y del grab): si aMuTorrent cae,
   mostrar la descarga con el progreso de Radarr y marcar velocidad/ETA como no disponibles. Si
   cae Radarr, decirlo — **nunca** un fallo de red debe parecer "no hay descargas".
5. **Destacar `importBlocked` / `warning` / `failed`**: es el propósito de la app y ahora mismo
   hay un caso real en el servidor (`Transformers ... 2160p`, `importBlocked` con `warning`).

#### Punto a decidir

Partir el sidebar **en horizontal (2/3 + 1/3)** es dudoso: la barra mide ~260 px, y los títulos
reales son muy largos (`Transformers El ultimo caballero (2017).BDrip 2160p x265 10Bit DV HDR
DUAL ac3-eac3.(.HispaShare.).mkv`). Un tercio serían ~90 px, insuficiente para título + progreso
+ velocidad + ETA. Alternativas: **dividir en vertical** (descargas arriba, operaciones abajo,
mismo ancho) o ensanchar la barra.

---

## Licencia

MIT
