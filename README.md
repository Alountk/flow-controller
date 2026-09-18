# Flow Controller

Panel de control para el flujo de descargas **Radarr → aMuTorrent → Sonarr**.
Detecta dónde se rompe el pipeline y ofrece acciones de remediación directas
desde la UI (corregir categorías, mapear rutas, reintentar imports, etc.).

## Stack

- **Backend**: Python 3.12 / FastAPI / aiohttp (async)
- **Frontend**: React 19 / TypeScript / Vite
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

## API

| Endpoint | Método | Descripción |
|----------|--------|-------------|
| `/api/status` | GET | Estado de todos los servicios |
| `/api/status/refresh` | GET | Fuerza re-chequeo de servicios |
| `/api/trace` | GET | Trazabilidad: correla grabs ↔ torrents ↔ cola |
| `/api/actions` | GET | Catálogo de acciones disponibles |
| `/api/actions/{action}` | POST | Ejecuta una acción sobre una descarga |

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
├── backend/
│   ├── config.py           # Environment variables, constants, action catalog
│   ├── clients.py          # API clients: Radarr, Sonarr, aMuTorrent (WS + REST)
│   ├── traces.py           # Trace building: path resolution, stage derivation
│   ├── copy_engine.py      # File copy with progress, cancellation, import verification
│   ├── app.py              # FastAPI app, lifespan, routes, static files
│   ├── tests.py            # 36 tests (unit + API endpoint)
│   ├── requirements.txt
│   ├── .env.example
│   └── run_local.sh
└── frontend/
    └── src/
        ├── App.tsx
        ├── types.ts
        ├── api/actions.ts
        ├── components/
        │   ├── ErrorBoundary.tsx
        │   ├── PipelineVisual.tsx
        │   ├── ServiceNode.tsx
        │   ├── TraceView.tsx
        │   └── TraceActions.tsx
        └── hooks/usePolling.ts
```

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

## Licencia

MIT
