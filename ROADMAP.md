# Flow Controller — Roadmap

Control del flujo de descargas **Radarr → AmuTorrent → Sonarr**, con detección
visual de dónde se corta el flujo.

## Estado actual

- [x] **Fase 0 — Estabilizar base**
  - Frontend migrado a React + TypeScript + Vite
  - Polling sin solapamiento (`usePolling`)
  - Backend async puro (`aiohttp`, sin `subprocess` bloqueante)
  - Caché de estado + loop de chequeo en background
- [x] **Fase 1 — MVP visual**
  - Landing *Pipeline Visual* con nodos y conectores
  - Nodo/conector roto resaltado en rojo
  - Estado global del flujo

## Próximas fases

### Fase 2 — Diagnóstico del flujo
- [ ] Endpoint `/api/flow` con el mapa de dependencias
- [ ] Detección automática del punto de corte
- [ ] Historial de transiciones de estado

### Fase 3 — Acciones de control
- [ ] Reiniciar servicio vía Portainer API
- [ ] Re-disparar descarga en Radarr/Sonarr (`/api/v3/command`)
- [ ] Ejecutar búsqueda manual en AmuTorrent

### Fase 4 — Operación
- [ ] Métricas (uptime, tiempo de respuesta, tasa de éxito)
- [ ] Notificaciones (Telegram/email) al cortarse el flujo
- [ ] Autenticación de la UI

### Fase 5 — Producción
- [x] Build multi-stage (frontend compilado + backend)
- [ ] Integración con el stack de Portainer existente
- [ ] Healthchecks y reinicio automático

## Trazabilidad del flujo

El endpoint `/api/trace` correlaciona, por cada descarga, los tres saltos del
flujo usando el `downloadId` de *arr y el `hash` de aMuTorrent:

| Fase | Fuente | Campos |
|------|--------|--------|
| Grab | `*/api/v3/history?eventType=1` | `sourceTitle`, `indexer`, `downloadId` |
| Descarga | `:4000/api/v2/torrents/info` | `state`, `progress`, `category`, `save_path` |
| Import | `*/api/v3/queue` | `trackedDownloadState`, `outputPath`, mensajes |

Cada traza se clasifica en una fase (`downloading`, `downloaded`,
`import_blocked`, `importing`, `sent`, `failed`) y se marca si la **categoría**
de la descarga coincide con la esperada (`radarr` / `tv-sonarr`). La UI
(`TraceView.tsx`) muestra resumen, filtros por fase y detalle expandible.

## Integración con aMuTorrent

aMuTorrent expone **dos APIs** para la integración con *arr:

1. **Indexador Torznab** (puente ED2K/amule): `:4000/indexer/amule/api`, con la
   API key como query param `?apikey=<key>` (NO Bearer).
2. **Cliente de descarga qBittorrent**: `:4000/api/v2/...`, con
   `Authorization: Bearer <API_KEY>`.

aMuTorrent **no** usa la API `/api/v3` de *arr. Endpoints verificados:

aMuTorrent **no** usa la API `/api/v3` de *arr. Expone una **API compatible con
qBittorrent** en el puerto `4000`. Verificado contra el servidor real:

| Endpoint | Método | Auth | Estado |
|----------|--------|------|--------|
| `/api/v2/app/version` | GET | `Authorization: Bearer <API_KEY>` | ✅ health-check |
| `/api/v2/torrents/info` | GET | Bearer | ✅ lista de descargas |
| `/api/v2/app/preferences` | GET | Bearer | ✅ |
| `/indexer/amule/api?t=caps` | GET | `?apikey=<API_KEY>` | ✅ indexador Torznab |
| `/api/v2/transfer/info` | GET | — | ❌ 401 (no implementado) |
| `/api/v2/sync/maindata` | GET | — | ❌ 401 (no implementado) |

> **Nota:** el indexador Torznab devuelve items con `enclosure url = magnet:?xt=urn:btih:...`
> y el `downloadId` resultante es un hash ED2K (16 bytes + relleno de ceros),
> que aMuTorrent traduce a su propio infohash de 16 bytes.

El backend usa `kind: "arr"` (Radarr/Sonarr → `/api/v3/system/status` con
`X-Api-Key`) y `kind: "qbit"` (aMuTorrent → `/api/v2/app/version` con Bearer).
Además extrae metadatos de aMuTorrent (versión y contadores de torrents).

> Referencia completa en `external-assets/INTEGRATIONS.MD`.

## Arquitectura

```
flow-controller/
├── Dockerfile              # build multi-stage (frontend + backend)
├── docker-compose.yml      # despliegue en servidor
├── backend/
│   ├── app.py              # FastAPI: /api/status, /api/status/refresh, /api/trace
│   ├── requirements.txt
│   ├── .env                # URLs + API keys (NO versionar)
│   └── run_local.sh        # dev con --reload
└── frontend/
    ├── src/
    │   ├── App.tsx
    │   ├── hooks/usePolling.ts      # polling sin solapamiento
    │   ├── components/
    │   │   ├── PipelineVisual.tsx
    │   │   ├── ServiceNode.tsx
    │   │   ├── Connector.tsx
    │   │   └── TraceView.tsx        # trazabilidad del flujo
    │   └── types.ts
    └── dist/               # build servido por FastAPI
```

## Desarrollo

```bash
# Backend (puerto 8000, con reload)
cd backend && ./run_local.sh

# Frontend (puerto 5173, HMR, proxy /api -> 8000)
cd frontend && npm install && npm run dev

# Producción
cd frontend && npm run build     # genera dist/
# FastAPI sirve dist/ automáticamente en /

# Docker
docker compose up -d --build
```
