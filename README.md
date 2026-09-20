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
# 1. Tests backend
cd backend && python -m pytest tests.py tests_mixer.py tests_mixer_api.py -q

# 2. Build frontend
cd frontend && npm run build

# 3. Docker build + start
docker compose build && docker compose up -d

# 4. Health check (esperar ~15s, puerto 8000)
curl http://localhost:8000/api/status

# 5. Solo si todo OK → push
git push origin main
```

### CI Pipeline (GitHub Actions)

El workflow `.github/workflows/ci.yml` ejecuta automáticamente:

1. **Backend tests** — pytest con todos los suites
2. **Frontend build** — TypeScript + Vite
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
| 1 | Eliminar dead code (`clients.py:868` except duplicado) | ⬜ | `backend/clients.py` |
| 2 | Health check en Dockerfile | ✅ | `Dockerfile` |
| 3 | Límites de recursos (RAM/CPU) en docker-compose | ⬜ | `docker-compose.yml` |
| 4 | Fix API key expuesta en `/api/config` | ⬜ | `app.py` + frontend |

### 🟡 Medianas (1-3 días)

| # | Mejora | Estado | Archivos |
|---|--------|--------|----------|
| 5 | Split `app.py` en módulos de rutas | ✅ | `app.py` → `routes/*.py` |
| 6 | Unificar TaskManager (3 sistemas idénticos) | ⬜ | Nuevo `task_manager.py` |
| 7 | Extraer post-move import a servicio compartido | ⬜ | Nuevo `import_service.py` |
| 8 | CSS Modules o Tailwind (66KB monolítico) | ⬜ | Frontend |
| 9 | Tests de componentes React (0 actualmente) | ⬜ | `frontend/src/**/*.test.tsx` |

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

---

## Licencia

MIT
