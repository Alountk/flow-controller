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
git clone https://github.com/TU_USUARIO/flow-controller.git
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
│   ├── app.py              # FastAPI: status, trace, actions, WS client
│   ├── requirements.txt
│   ├── .env.example        # template de variables de entorno
│   └── run_local.sh
└── frontend/
    └── src/
        ├── App.tsx
        ├── types.ts
        ├── api/actions.ts
        ├── components/
        │   ├── PipelineVisual.tsx   # vista visual del pipeline
        │   ├── ServiceNode.tsx      # nodo de servicio
        │   ├── TraceView.tsx        # lista de trazas
        │   └── TraceActions.tsx     # botones de acción por traza
        └── hooks/usePolling.ts
```

## Licencia

MIT
