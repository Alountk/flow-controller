import asyncio
import json
import logging
import shutil
import time
import uuid
from contextlib import asynccontextmanager
from pathlib import Path

import aiohttp
from dotenv import load_dotenv
from fastapi import FastAPI, Header, HTTPException, Depends
from fastapi.responses import FileResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel

import os

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [%(levelname)s] %(message)s",
    datefmt="%H:%M:%S",
)
log = logging.getLogger("flow-controller")

load_dotenv()

RADARR_URL = os.getenv("RADARR_URL", "http://localhost:7878")
SONARR_URL = os.getenv("SONARR_URL", "http://localhost:8989")
AMUTORRENT_URL = os.getenv("AMUTORRENT_URL", "http://localhost:4000")

RADARR_API_KEY = os.getenv("RADARR_API_KEY", "")
SONARR_API_KEY = os.getenv("SONARR_API_KEY", "")
AMUTORRENT_API_KEY = os.getenv("AMUTORRENT_API_KEY", "")

# aMuTorrent: la API compatible con qBittorrent es de SOLO LECTURA (sus
# endpoints de escritura responden "Ok." pero no aplican cambios). El plano
# de control real es un WebSocket en /ws que exige una sesión de la web UI,
# obtenida con usuario + contraseña vía POST /api/auth/login.
AMUTORRENT_USER = os.getenv("AMUTORRENT_USER", "admin")
AMUTORRENT_PASSWORD = os.getenv("AMUTORRENT_PASSWORD", "")

# API key para proteger endpoints de acciones y tareas.
# Si está vacío, la autenticación se desactiva (solo para desarrollo local).
API_KEY = os.getenv("API_KEY", "")

BASE_DIR = os.path.dirname(os.path.abspath(__file__))
FRONTEND_DIST = os.path.normpath(os.path.join(BASE_DIR, "..", "frontend", "dist"))

# Intervalo entre ciclos de chequeo (segundos) e intervalo entre reintentos.
CHECK_INTERVAL = int(os.getenv("CHECK_INTERVAL", "15"))
MAX_RETRIES = int(os.getenv("MAX_RETRIES", "3"))
RETRY_DELAY = float(os.getenv("RETRY_DELAY", "2"))
REQUEST_TIMEOUT = float(os.getenv("REQUEST_TIMEOUT", "5"))

# Nº de eventos "grabbed" recientes a correlacionar por cada *arr.
TRACE_LIMIT = int(os.getenv("TRACE_LIMIT", "25"))

# Categoría que cada *arr espera en aMuTorrent (según su download client).
EXPECTED_CATEGORY = {"radarr": "radarr", "sonarr": "tv-sonarr"}


async def verify_api_key(x_api_key: str | None = Header(default=None)):
    """Dependency que verifica la API key en headers protegidos.
    Si API_KEY no está configurado, la verificación se desactiva."""
    if not API_KEY:
        return
    if x_api_key != API_KEY:
        raise HTTPException(status_code=401, detail="API key inválida")


class ActionRequest(BaseModel):
    """Modelo de request para POST /api/actions/{action}."""
    source: str = ""
    download_id: str = ""
    matched_hash: str = ""
    ids: dict = {}
    output_path: str = ""
    blocklist: bool | None = None
    delete_files: bool | None = None
    host: str = ""
    remote_path: str = ""
    local_path: str = ""


# URL del indexador Torznab (puente ED2K) expuesto por aMuTorrent.
AMUTORRENT_INDEXER = os.getenv(
    "AMUTORRENT_INDEXER", f"{AMUTORRENT_URL}/indexer/amule/api"
)

# Modo seguro: si está activo, las acciones destructivas quedan bloqueadas
# en el backend (no basta con la confirmación de la UI).
SAFE_MODE = os.getenv("SAFE_MODE", "true").lower() in ("1", "true", "yes")

# Modo desarrollador: habilita la pestaña de prototipos en el frontend.
DEVELOPER = os.getenv("DEVELOPER", "false").lower() in ("1", "true", "yes")

# Rutas de descarga en el host (para traducir save_path del contenedor)
FOLDER_DOWNLOAD_AMULE = os.getenv("FOLDER_DOWNLOAD_AMULE", "/mnt/storage-6tb/shared-downloads/amule")
FOLDER_DOWNLOAD_TORRENT = os.getenv("FOLDER_DOWNLOAD_TORRENT", "/mnt/storage/downloads/qbittorrent/completed")

# Catálogo de acciones ofrecidas por la UI. `destructive` marca las que
# alteran/eliminan datos; `scope` indica dónde se ejecuta.
ACTIONS: dict[str, dict] = {
    "fix_category": {
        "label": "Corregir categoría",
        "description": "Pone la categoría correcta en aMuTorrent y reintenta el import.",
        "destructive": False,
        "scope": "amutorrent+arr",
    },
    "retry_import": {
        "label": "Reintentar import",
        "description": "Fuerza a Radarr/Sonarr a reprocesar la descarga y traspasar el archivo.",
        "destructive": False,
        "scope": "arr",
    },
    "research": {
        "label": "Re-buscar",
        "description": "Lanza una búsqueda del episodio/película en Radarr/Sonarr.",
        "destructive": False,
        "scope": "arr",
    },
    "pause": {
        "label": "Pausar",
        "description": "Pausa la descarga en aMuTorrent.",
        "destructive": False,
        "scope": "amutorrent",
    },
    "resume": {
        "label": "Reanudar",
        "description": "Reanuda la descarga en aMuTorrent.",
        "destructive": False,
        "scope": "amutorrent",
    },
    "remove_queue": {
        "label": "Quitar de la cola",
        "description": "Elimina el item de la cola de Radarr/Sonarr (opcionalmente a la blocklist).",
        "destructive": True,
        "scope": "arr",
    },
    "delete_torrent": {
        "label": "Eliminar descarga",
        "description": "Elimina la descarga de aMuTorrent (opcionalmente con sus archivos).",
        "destructive": True,
        "scope": "amutorrent",
    },
    "fix_path_mapping": {
        "label": "Mapear ruta",
        "description": "Crea un remote path mapping en Radarr/Sonarr para que el *arr pueda ver los archivos del cliente de descargas y reintenta el import.",
        "destructive": False,
        "scope": "arr",
    },
    "copy_files": {
        "label": "Copiar archivos",
        "description": "Copia los archivos completados del cliente de descargas al directorio correcto del *arr y reintenta el import.",
        "destructive": False,
        "scope": "arr",
    },
}

PAUSED_STATES = {"pausedDL", "pausedUP", "stoppedDL", "stoppedUP"}


def _service_by_key(key: str) -> dict | None:
    for service in SERVICES:
        if service["key"] == key:
            return service
    return None

# aMuTorrent expone una API compatible con qBittorrent (puerto 4000),
# mientras que Radarr/Sonarr usan la API *arr (/api/v3).
SERVICES = [
    {"key": "radarr", "kind": "arr", "url": RADARR_URL, "api_key": RADARR_API_KEY},
    {"key": "sonarr", "kind": "arr", "url": SONARR_URL, "api_key": SONARR_API_KEY},
    {"key": "amutorrent", "kind": "qbit", "url": AMUTORRENT_URL, "api_key": AMUTORRENT_API_KEY},
]

# Caché compartida: el endpoint responde al instante; un loop en background la refresca.
status_cache: dict = {
    "radarr": "unknown",
    "sonarr": "unknown",
    "amutorrent": "unknown",
    "flow": "unknown",
    "updated_at": 0,
    "checking": False,
}

# Estado de tareas en background (copy_files con progreso).
_tasks: dict[str, dict] = {}

# TTL para tareas completadas en _tasks (segundos). Se limpian tras 10 minutos.
_TASK_TTL = 600


# Sesión HTTP compartida para requests (se crea en lifespan, se cierra al apagar).
_http_session: aiohttp.ClientSession | None = None


def _cleanup_tasks():
    """Elimina tareas finalizadas que superan el TTL."""
    now = time.time()
    expired = [
        tid for tid, t in _tasks.items()
        if t.get("status") not in ("running", "importing")
        and now - t.get("created_at", 0) > _TASK_TTL
    ]
    for tid in expired:
        del _tasks[tid]

# Agrupación de estados qBittorrent en categorías legibles.
QBIT_DOWNLOADING = {
    "downloading", "forcedDL", "metaDL", "allocating",
    "checkingDL", "stalledDL", "queuedDL",
}
QBIT_COMPLETED = {
    "uploading", "pausedUP", "stalledUP", "forcedUP",
    "queuedUP", "stoppedUP", "checkingUP",
}


def _arr_headers(api_key: str) -> dict:
    headers = {"accept": "application/json"}
    if api_key:
        headers["X-Api-Key"] = api_key
    return headers


def _qbit_headers(api_key: str) -> dict:
    headers = {"accept": "application/json"}
    if api_key:
        headers["Authorization"] = f"Bearer {api_key}"
    return headers


async def _check_arr(session: aiohttp.ClientSession, service: dict) -> tuple[str, str, dict]:
    """Health-check de Radarr/Sonarr: GET /api/v3/system/status."""
    url = service["url"]
    headers = _arr_headers(service["api_key"])
    endpoint = f"{url}/api/v3/system/status"

    last_error = "sin respuesta"
    for attempt in range(1, MAX_RETRIES + 1):
        try:
            timeout = aiohttp.ClientTimeout(total=REQUEST_TIMEOUT)
            async with session.get(endpoint, headers=headers, timeout=timeout) as resp:
                if resp.status in (200, 401, 301, 302):
                    return "online", f"Conexión exitosa (intento {attempt})", {}
                last_error = f"HTTP {resp.status}"
        except asyncio.TimeoutError:
            last_error = "Timeout"
        except aiohttp.ClientError as exc:
            last_error = type(exc).__name__

        if attempt < MAX_RETRIES:
            await asyncio.sleep(RETRY_DELAY)

    return "offline", f"Fallaron {MAX_RETRIES} intentos ({last_error})", {}


async def _fetch_qbit_meta(session: aiohttp.ClientSession, service: dict) -> dict:
    """Obtiene versión y estadísticas de descargas de aMuTorrent (API qBittorrent)."""
    headers = _qbit_headers(service["api_key"])
    timeout = aiohttp.ClientTimeout(total=REQUEST_TIMEOUT)
    meta: dict = {}

    try:
        async with session.get(f"{service['url']}/api/v2/app/version", headers=headers, timeout=timeout) as resp:
            if resp.status == 200:
                meta["version"] = (await resp.text()).strip()
    except (asyncio.TimeoutError, aiohttp.ClientError):
        pass

    try:
        async with session.get(f"{service['url']}/api/v2/torrents/info", headers=headers, timeout=timeout) as resp:
            if resp.status == 200:
                torrents = await resp.json(content_type=None)
                downloading = sum(1 for t in torrents if t.get("state") in QBIT_DOWNLOADING)
                completed = sum(1 for t in torrents if t.get("state") in QBIT_COMPLETED)
                errored = sum(1 for t in torrents if t.get("state") == "error")
                meta["torrents"] = {
                    "total": len(torrents),
                    "downloading": downloading,
                    "completed": completed,
                    "errors": errored,
                }
    except (asyncio.TimeoutError, aiohttp.ClientError):
        pass

    return meta


async def _check_qbit(session: aiohttp.ClientSession, service: dict) -> tuple[str, str, dict]:
    """Health-check de aMuTorrent vía API compatible qBittorrent."""
    url = service["url"]
    headers = _qbit_headers(service["api_key"])
    endpoint = f"{url}/api/v2/app/version"

    last_error = "sin respuesta"
    for attempt in range(1, MAX_RETRIES + 1):
        try:
            timeout = aiohttp.ClientTimeout(total=REQUEST_TIMEOUT)
            async with session.get(endpoint, headers=headers, timeout=timeout) as resp:
                if resp.status == 200:
                    meta = await _fetch_qbit_meta(session, service)
                    return "online", f"Conexión exitosa (intento {attempt})", meta
                last_error = f"HTTP {resp.status}"
        except asyncio.TimeoutError:
            last_error = "Timeout"
        except aiohttp.ClientError as exc:
            last_error = type(exc).__name__

        if attempt < MAX_RETRIES:
            await asyncio.sleep(RETRY_DELAY)

    return "offline", f"Fallaron {MAX_RETRIES} intentos ({last_error})", {}


async def check_service(session: aiohttp.ClientSession, service: dict) -> tuple[str, str, dict]:
    """Despacha el chequeo según el tipo de API del servicio."""
    if service["kind"] == "qbit":
        return await _check_qbit(session, service)
    return await _check_arr(session, service)


async def check_all(session: aiohttp.ClientSession) -> None:
    """Ejecuta la comprobación de todos los servicios y actualiza la caché."""
    status_cache["checking"] = True
    try:
        results = await asyncio.gather(*(check_service(session, s) for s in SERVICES))
        flow_ok = True
        for service, (state, reason, meta) in zip(SERVICES, results):
            status_cache[service["key"]] = f"{state}:{reason}"
            if meta:
                status_cache[f"{service['key']}_meta"] = meta
            if state != "online":
                flow_ok = False
        status_cache["flow"] = "running" if flow_ok else "stopped"
        status_cache["updated_at"] = int(time.time())
    finally:
        status_cache["checking"] = False


async def background_checker() -> None:
    """Loop perpetuo que refresca la caché sin bloquear el event loop."""
    async with aiohttp.ClientSession() as session:
        while True:
            try:
                await check_all(session)
            except asyncio.CancelledError:
                raise
            except Exception as exc:  # noqa: BLE001
                status_cache["flow"] = f"error:{exc}"
            await asyncio.sleep(CHECK_INTERVAL)


@asynccontextmanager
async def lifespan(_app: FastAPI):
    global _http_session
    _http_session = aiohttp.ClientSession()
    task = asyncio.create_task(background_checker())
    try:
        yield
    finally:
        task.cancel()
        try:
            await task
        except asyncio.CancelledError:
            pass
        await _http_session.close()


app = FastAPI(lifespan=lifespan)


@app.get("/api/status")
async def get_status():
    """Devuelve la caché al instante. No bloquea esperando a los servicios."""
    return status_cache


@app.get("/api/status/refresh")
async def refresh_status():
    """Fuerza un chequeo inmediato (síncrono) y devuelve el resultado fresco."""
    async with aiohttp.ClientSession() as session:
        await check_all(session)
    return status_cache


# --- Trazabilidad del flujo (Radarr/Sonarr → aMuTorrent) ---

async def _fetch_arr_all_series(session: aiohttp.ClientSession, service: dict) -> dict[int, str]:
    """Devuelve {series_id: path} de todas las series de Sonarr."""
    headers = _arr_headers(service["api_key"])
    try:
        async with session.get(
            f"{service['url']}/api/v3/series",
            headers=headers,
            timeout=aiohttp.ClientTimeout(total=REQUEST_TIMEOUT * 2),
        ) as resp:
            if resp.status != 200:
                return {}
            data = await resp.json(content_type=None)
            return {s["id"]: s.get("path", "") for s in data if "id" in s}
    except (asyncio.TimeoutError, aiohttp.ClientError):
        return {}


async def _fetch_arr_all_movies(session: aiohttp.ClientSession, service: dict) -> dict[int, str]:
    """Devuelve {movie_id: path} de todas las películas de Radarr."""
    headers = _arr_headers(service["api_key"])
    try:
        async with session.get(
            f"{service['url']}/api/v3/movie",
            headers=headers,
            timeout=aiohttp.ClientTimeout(total=REQUEST_TIMEOUT * 2),
        ) as resp:
            if resp.status != 200:
                return {}
            data = await resp.json(content_type=None)
            return {m["id"]: m.get("path", "") for m in data if "id" in m}
    except (asyncio.TimeoutError, aiohttp.ClientError):
        return {}


async def _fetch_arr_grabbed(session: aiohttp.ClientSession, service: dict, limit: int) -> list[dict]:
    """Últimos eventos 'grabbed' de un *arr (eventType=1)."""
    headers = _arr_headers(service["api_key"])
    url = (
        f"{service['url']}/api/v3/history"
        f"?pageSize={limit}&sortKey=date&sortDirection=descending&eventType=1"
    )
    timeout = aiohttp.ClientTimeout(total=REQUEST_TIMEOUT * 2)
    try:
        async with session.get(url, headers=headers, timeout=timeout) as resp:
            if resp.status != 200:
                return []
            data = await resp.json(content_type=None)
            return data.get("records", [])
    except (asyncio.TimeoutError, aiohttp.ClientError):
        return []


async def _fetch_arr_queue(session: aiohttp.ClientSession, service: dict) -> list[dict]:
    """Cola actual de un *arr, con estado de import y mensajes."""
    headers = _arr_headers(service["api_key"])
    url = f"{service['url']}/api/v3/queue?pageSize=200&includeUnknownSeriesItems=true&includeUnknownMovieItems=true"
    timeout = aiohttp.ClientTimeout(total=REQUEST_TIMEOUT * 2)
    try:
        async with session.get(url, headers=headers, timeout=timeout) as resp:
            if resp.status != 200:
                return []
            data = await resp.json(content_type=None)
            return data.get("records", [])
    except (asyncio.TimeoutError, aiohttp.ClientError):
        return []


async def _arr_download_clients(session: aiohttp.ClientSession, service: dict) -> list[dict]:
    """Descarga la lista de download clients de un *arr (Radarr/Sonarr)."""
    headers = _arr_headers(service["api_key"])
    url = f"{service['url']}/api/v3/downloadclient"
    try:
        async with session.get(url, headers=headers, timeout=aiohttp.ClientTimeout(total=REQUEST_TIMEOUT)) as resp:
            if resp.status != 200:
                return []
            return await resp.json(content_type=None)
    except (asyncio.TimeoutError, aiohttp.ClientError):
        return []


def _dc_host_map(clients: list[dict]) -> dict[str, str]:
    """Construye un dict {nombre_dc: host} a partir de la lista de download clients."""
    result: dict[str, str] = {}
    for dc in clients:
        name = dc.get("name", "")
        fields = {f["name"]: f.get("value") for f in dc.get("fields", []) if isinstance(f, dict)}
        host = fields.get("host")
        if name and host:
            result[name] = str(host)
    return result


async def _fetch_qbit_torrents(session: aiohttp.ClientSession) -> list[dict]:
    """Todos los torrents conocidos por aMuTorrent (API qBittorrent)."""
    headers = _qbit_headers(AMUTORRENT_API_KEY)
    timeout = aiohttp.ClientTimeout(total=REQUEST_TIMEOUT * 3)
    try:
        async with session.get(
            f"{AMUTORRENT_URL}/api/v2/torrents/info", headers=headers, timeout=timeout
        ) as resp:
            if resp.status != 200:
                return []
            return await resp.json(content_type=None)
    except (asyncio.TimeoutError, aiohttp.ClientError):
        return []


def _normalize_hash(value: str) -> str:
    """Normaliza un downloadId: minúsculas y sin el relleno ED2K de ceros."""
    return (value or "").strip().lower()


def _hash_matches(download_id: str, amu_hashes: set[str]) -> str | None:
    """Correlaciona un downloadId de *arr con un hash de aMuTorrent.

    aMuTorrent traduce los hashes ED2K a infohashes BitTorrent, así que la
    coincidencia puede ser exacta o por prefijo (los ED2K acaban en ceros).
    """
    did = _normalize_hash(download_id)
    if not did:
        return None
    if did in amu_hashes:
        return did
    core = did.rstrip("0")
    if core and core in amu_hashes:
        return core
    for h in amu_hashes:
        if h.startswith(core) or did.startswith(h):
            return h
    return None


def _derive_stage(grabbed: dict, torrent: dict | None, queue_item: dict | None) -> str:
    """Deduce en qué fase del flujo está una descarga."""
    if queue_item:
        state = queue_item.get("trackedDownloadState")
        status = queue_item.get("trackedDownloadStatus")
        if state == "importPending" or status == "warning":
            return "import_blocked"
        if state == "importing":
            return "importing"
        if state in ("failed", "downloadFailed"):
            return "failed"
    if torrent is None:
        return "sent"
    if torrent.get("state") == "error":
        return "failed"
    if torrent.get("progress", 0) >= 1:
        return "downloaded"
    return "downloading"


async def _build_traces(session: aiohttp.ClientSession) -> list[dict]:
    """Correlaciona grabs de Radarr/Sonarr con torrents de aMuTorrent y su cola."""
    arr_services = [s for s in SERVICES if s["kind"] == "arr"]

    results = await asyncio.gather(
        *(_fetch_arr_grabbed(session, s, TRACE_LIMIT) for s in arr_services),
        *(_fetch_arr_queue(session, s) for s in arr_services),
        *(_arr_download_clients(session, s) for s in arr_services),
        *(_fetch_arr_all_series(session, s) for s in arr_services if s["key"] == "sonarr"),
        *(_fetch_arr_all_movies(session, s) for s in arr_services if s["key"] == "radarr"),
    )
    # gather devuelve grabs (n), colas (n), download_clients (n), [series], [movies]
    n = len(arr_services)
    grabs_by_service = dict(zip((s["key"] for s in arr_services), results[:n]))
    queues_by_service = dict(zip((s["key"] for s in arr_services), results[n:2*n]))
    dc_by_service = dict(zip((s["key"] for s in arr_services), results[2*n:3*n]))
    dc_hosts = {k: _dc_host_map(v) for k, v in dc_by_service.items()}

    # Lookup de paths: series_id → path, movie_id → path
    paths_by_id: dict[str, dict[int, str]] = {}
    idx = 3 * n
    for s in arr_services:
        if s["key"] == "sonarr":
            paths_by_id["sonarr"] = results[idx] if idx < len(results) else {}
            idx += 1
    for s in arr_services:
        if s["key"] == "radarr":
            paths_by_id["radarr"] = results[idx] if idx < len(results) else {}
            idx += 1

    torrents = await _fetch_qbit_torrents(session)
    amu_hashes = {_normalize_hash(t.get("hash", "")) for t in torrents}
    torrents_by_hash = {_normalize_hash(t.get("hash", "")): t for t in torrents}

    traces: list[dict] = []
    for service in arr_services:
        key = service["key"]
        queue_by_download = {}
        for item in queues_by_service.get(key, []):
            did = _normalize_hash(item.get("downloadId", ""))
            if did:
                queue_by_download[did] = item

        for record in grabs_by_service.get(key, []):
            data = record.get("data") or {}
            download_id = record.get("downloadId", "")
            norm = _normalize_hash(download_id)
            matched = _hash_matches(download_id, amu_hashes)
            torrent = torrents_by_hash.get(matched) if matched else None
            queue_item = queue_by_download.get(norm) or (
                queue_by_download.get(_normalize_hash(matched)) if matched else None
            )

            expected_cat = EXPECTED_CATEGORY.get(key)
            actual_cat = torrent.get("category") if torrent else None
            category_ok = (
                actual_cat == expected_cat if actual_cat is not None else None
            )

            messages: list[str] = []
            if queue_item:
                for sm in queue_item.get("statusMessages", []):
                    messages.extend(sm.get("messages", []))

            traces.append(
                {
                    "source": key,
                    "title": record.get("sourceTitle") or record.get("title") or "",
                    "date": record.get("date"),
                    "indexer": data.get("indexer"),
                    "download_client": queue_item.get("downloadClient") if queue_item else None,
                    "download_client_host": dc_hosts.get(key, {}).get(
                        queue_item.get("downloadClient", "") if queue_item else "", ""
                    ),
                    "download_id": download_id,
                    "matched_hash": matched,
                    "stage": _derive_stage(record, torrent, queue_item),
                    "torrent": {
                        "state": torrent.get("state"),
                        "progress": round(torrent.get("progress", 0) * 100, 1),
                        "category": actual_cat,
                        "save_path": torrent.get("save_path"),
                        "current_path": _resolve_current_path(
                            torrent.get("save_path", ""),
                            queue_item.get("downloadClient") if queue_item else None,
                        ) if torrent.get("save_path") else None,
                        "content_path": (
                            _resolve_current_path(
                                torrent.get("save_path", ""),
                                queue_item.get("downloadClient") if queue_item else None,
                            ) + "/" + torrent.get("name", "")
                        ) if torrent.get("save_path") and torrent.get("name") else None,
                        "size": torrent.get("size"),
                    } if torrent else None,
                    "expected_category": expected_cat,
                    "category_ok": category_ok,
                    "paused": bool(
                        torrent and torrent.get("state") in PAUSED_STATES
                    ),
                    "ids": {
                        "queue_id": queue_item.get("id") if queue_item else None,
                        "episode_id": record.get("episodeId"),
                        "movie_id": record.get("movieId"),
                        "series_id": record.get("seriesId"),
                    },
                    "destination": (
                        paths_by_id.get(key, {}).get(record.get("seriesId"))
                        if key == "sonarr"
                        else paths_by_id.get(key, {}).get(record.get("movieId"))
                        if key == "radarr"
                        else None
                    ),
                    "queue": {
                        "state": queue_item.get("trackedDownloadState"),
                        "status": queue_item.get("trackedDownloadStatus"),
                        "output_path": queue_item.get("outputPath"),
                        "messages": messages,
                    } if queue_item else None,
                }
            )

    traces.sort(key=lambda t: t.get("date") or "", reverse=True)
    return traces


@app.get("/api/trace")
async def get_trace():
    """Trazabilidad: grabs de Radarr/Sonarr → descarga en aMuTorrent → import."""
    async with aiohttp.ClientSession() as session:
        traces = await _build_traces(session)

    summary = {
        "downloading": sum(1 for t in traces if t["stage"] == "downloading"),
        "downloaded": sum(1 for t in traces if t["stage"] == "downloaded"),
        "import_blocked": sum(1 for t in traces if t["stage"] == "import_blocked"),
        "failed": sum(1 for t in traces if t["stage"] == "failed"),
        "sent": sum(1 for t in traces if t["stage"] == "sent"),
        "category_mismatches": sum(
            1 for t in traces if t.get("category_ok") is False
        ),
    }

    return {
        "traces": traces,
        "summary": summary,
        "indexer": AMUTORRENT_INDEXER,
        "updated_at": int(time.time()),
    }


# --- Acciones de control ---

async def _arr_command(
    session: aiohttp.ClientSession, service: dict, body: dict
) -> dict:
    """Envía un command a un *arr. Devuelve {ok, detail}."""
    headers = _arr_headers(service["api_key"])
    headers["Content-Type"] = "application/json"
    timeout = aiohttp.ClientTimeout(total=REQUEST_TIMEOUT * 2)
    try:
        async with session.post(
            f"{service['url']}/api/v3/command", headers=headers, json=body, timeout=timeout
        ) as resp:
            text = await resp.text()
            if resp.status in (200, 201):
                return {"ok": True, "detail": f"Comando '{body.get('name')}' encolado"}
            return {"ok": False, "detail": f"HTTP {resp.status}: {text[:200]}"}
    except (asyncio.TimeoutError, aiohttp.ClientError) as exc:
        return {"ok": False, "detail": f"{type(exc).__name__}: {exc}"}


async def _qbit_post(
    session: aiohttp.ClientSession, path: str, data: dict
) -> dict:
    """POST autenticado contra la API qBittorrent de aMuTorrent.

    NOTA: esta API es de solo lectura en aMuTorrent; los endpoints de
    escritura responden "Ok." sin aplicar el cambio. Se usa únicamente para
    lecturas o como comprobación. Para mutaciones reales, usar `_amu_ws`.
    """
    headers = _qbit_headers(AMUTORRENT_API_KEY)
    timeout = aiohttp.ClientTimeout(total=REQUEST_TIMEOUT * 2)
    try:
        async with session.post(
            f"{AMUTORRENT_URL}{path}", headers=headers, data=data, timeout=timeout
        ) as resp:
            if resp.status == 200:
                return {"ok": True, "detail": f"{path} OK"}
            return {"ok": False, "detail": f"HTTP {resp.status}"}
    except (asyncio.TimeoutError, aiohttp.ClientError) as exc:
        return {"ok": False, "detail": f"{type(exc).__name__}: {exc}"}


# aMuTorrent: eventos que confirman cada acción enviada por el WebSocket.
_AMU_WS_COMPLETE = {
    "batchPause": "batch-pause-complete",
    "batchResume": "batch-resume-complete",
    "batchStop": "batch-stop-complete",
    "batchDelete": "batch-delete-complete",
    "batchSetFileCategory": "batch-category-changed",
}


async def _amu_ws_login(session: aiohttp.ClientSession) -> tuple[bool, str]:
    """Inicia sesión en la web UI de aMuTorrent. La cookie de sesión queda en
    el cookie jar de `session`, que es lo que autentica el WebSocket /ws."""
    if not AMUTORRENT_PASSWORD:
        return False, "faltan credenciales (AMUTORRENT_PASSWORD)"
    try:
        async with session.post(
            f"{AMUTORRENT_URL}/api/auth/login",
            json={
                "username": AMUTORRENT_USER,
                "password": AMUTORRENT_PASSWORD,
                "rememberMe": True,
            },
            headers={"Referer": AMUTORRENT_URL},
            timeout=aiohttp.ClientTimeout(total=REQUEST_TIMEOUT * 2),
        ) as resp:
            data = await resp.json(content_type=None)
            if data.get("success"):
                return True, "sesión iniciada"
            return False, data.get("message") or f"HTTP {resp.status}"
    except (asyncio.TimeoutError, aiohttp.ClientError) as exc:
        return False, f"{type(exc).__name__}: {exc}"


def _amu_ws_url() -> str:
    """Deriva la URL del WebSocket a partir de AMUTORRENT_URL."""
    base = AMUTORRENT_URL.rstrip("/")
    if base.startswith("https://"):
        return "wss://" + base[len("https://"):] + "/ws"
    if base.startswith("http://"):
        return "ws://" + base[len("http://"):] + "/ws"
    return base + "/ws"


async def _amu_ws(
    action: str,
    payload: dict,
    *,
    timeout: float = 15.0,
) -> dict:
    """Ejecuta una acción en aMuTorrent por su WebSocket de control.

    aMuTorrent no aplica las mutaciones por su API qBittorrent; el plano de
    control real es `ws://<host>:<port>/ws`, autenticado con una sesión de la
    web UI. Envía `{action, ...payload}` y espera el evento de confirmación
    (`<action>-complete`) o un `error`.
    """
    expect = _AMU_WS_COMPLETE.get(action)
    if expect is None:
        return {"ok": False, "detail": f"acción WS desconocida: {action}"}

    jar = aiohttp.CookieJar(unsafe=True)
    async with aiohttp.ClientSession(cookie_jar=jar) as session:
        ok, detail = await _amu_ws_login(session)
        if not ok:
            return {"ok": False, "detail": f"login aMuTorrent: {detail}"}

        try:
            async with session.ws_connect(
                _amu_ws_url(),
                headers={"Referer": AMUTORRENT_URL},
                timeout=aiohttp.ClientTimeout(total=timeout),
                heartbeat=None,
            ) as ws:
                await ws.send_json({"action": action, **payload})
                deadline = time.monotonic() + timeout
                while True:
                    remaining = deadline - time.monotonic()
                    if remaining <= 0:
                        return {"ok": False, "detail": "sin confirmación (timeout)"}
                    msg = await ws.receive(timeout=remaining)
                    if msg.type == aiohttp.WSMsgType.TEXT:
                        try:
                            event = json.loads(msg.data)
                        except ValueError:
                            continue
                        etype = event.get("type")
                        if etype == "error":
                            return {
                                "ok": False,
                                "detail": event.get("message") or "error de aMuTorrent",
                            }
                        if etype == expect:
                            results = event.get("results")
                            if isinstance(results, list) and results:
                                failed = [r for r in results if not r.get("success")]
                                if failed:
                                    why = failed[0].get("error") or "rechazado"
                                    return {
                                        "ok": False,
                                        "detail": f"{len(failed)}/{len(results)} fallaron: {why}",
                                    }
                            return {"ok": True, "detail": "aplicado vía WebSocket"}
                    elif msg.type in (
                        aiohttp.WSMsgType.CLOSED,
                        aiohttp.WSMsgType.CLOSE,
                        aiohttp.WSMsgType.ERROR,
                    ):
                        return {"ok": False, "detail": f"WebSocket cerrado ({msg.data})"}
        except (asyncio.TimeoutError, aiohttp.ClientError) as exc:
            return {"ok": False, "detail": f"{type(exc).__name__}: {exc}"}


# ---- Path translation helpers ------------------------------------------------

# Mapeo de volúmenes Docker conocidos: container_path → host_path.
# qBittorrent-novpn monta /mnt/storage:/data, así que /data/X → /mnt/storage/X.
_VOLUME_MAP = [
    ("/downloads/incoming/", "/mnt/storage-6tb/shared-downloads/amule/"),
    ("/downloads/", "/mnt/storage-6tb/shared-downloads/"),
    ("/data/", "/mnt/storage/"),
    ("/data-6tb/", "/mnt/storage-6tb/"),
]

# Mapeo de cliente de descarga → carpeta base en el host.
# Usado para resolver save_path del contenedor a la ruta real del host.
_DOWNLOAD_CLIENT_PATHS: dict[str, str] = {
    "amule": FOLDER_DOWNLOAD_AMULE,
    "amutorrent": FOLDER_DOWNLOAD_AMULE,
    "qbittorrent": FOLDER_DOWNLOAD_TORRENT,
    "qbit": FOLDER_DOWNLOAD_TORRENT,
}


def _host_path(container_path: str) -> str:
    """Traduce una ruta vista desde un contenedor a la ruta real del host.

    Aplica el mapeo de volúmenes Docker conocido.  Si no hay coincidencia,
    devuelve la ruta tal cual (asumiendo que ya es una ruta de host).
    """
    for prefix, replacement in _VOLUME_MAP:
        if container_path.startswith(prefix):
            return replacement + container_path[len(prefix):]
    return container_path


def _resolve_current_path(save_path: str, download_client: str | None) -> str:
    """Resuelve la ruta real del host a partir del save_path del contenedor.

    Primero intenta por el nombre del download_client (si se conoce).
    Si no, intenta por el patrón del save_path (/downloads/incoming = aMule).
    Como último recurso, usa el mapeo genérico de volúmenes.
    """
    if save_path:
        # 1. Por download_client conocido
        if download_client:
            client_lower = download_client.lower()
            for key, host_folder in _DOWNLOAD_CLIENT_PATHS.items():
                if key in client_lower:
                    log.info("resolve_path: client='%s' match='%s' → %s", download_client, key, host_folder)
                    return host_folder
        # 2. Por patrón del save_path
        if save_path.startswith("/downloads/incoming"):
            log.info("resolve_path: pattern match '/downloads/incoming' → %s", FOLDER_DOWNLOAD_AMULE)
            return FOLDER_DOWNLOAD_AMULE
        if save_path.startswith("/downloads"):
            log.info("resolve_path: pattern match '/downloads' → %s", FOLDER_DOWNLOAD_TORRENT)
            return FOLDER_DOWNLOAD_TORRENT
    result = _host_path(save_path) if save_path else ""
    log.info("resolve_path: fallback '%s' → '%s'", save_path, result)
    return result


async def _arr_series_root_folder(
    session: aiohttp.ClientSession, service: dict, series_id: int
) -> str:
    """Devuelve el path (root folder) de una serie en Sonarr."""
    headers = _arr_headers(service["api_key"])
    try:
        async with session.get(
            f"{service['url']}/api/v3/series/{series_id}",
            headers=headers,
            timeout=aiohttp.ClientTimeout(total=REQUEST_TIMEOUT),
        ) as resp:
            if resp.status != 200:
                return ""
            data = await resp.json(content_type=None)
            return data.get("path", "")
    except (asyncio.TimeoutError, aiohttp.ClientError):
        return ""


async def _arr_episode_season(
    session: aiohttp.ClientSession, service: dict, episode_id: int
) -> int | None:
    """Devuelve el seasonNumber de un episodio en Sonarr, o None si no se encuentra."""
    headers = _arr_headers(service["api_key"])
    try:
        async with session.get(
            f"{service['url']}/api/v3/episode/{episode_id}",
            headers=headers,
            timeout=aiohttp.ClientTimeout(total=REQUEST_TIMEOUT),
        ) as resp:
            if resp.status != 200:
                return None
            data = await resp.json(content_type=None)
            return data.get("seasonNumber")
    except (asyncio.TimeoutError, aiohttp.ClientError):
        return None


async def _arr_movie_root_folder(
    session: aiohttp.ClientSession, service: dict, movie_id: int
) -> str:
    """Devuelve el path (root folder) de una película en Radarr."""
    headers = _arr_headers(service["api_key"])
    try:
        async with session.get(
            f"{service['url']}/api/v3/movie/{movie_id}",
            headers=headers,
            timeout=aiohttp.ClientTimeout(total=REQUEST_TIMEOUT),
        ) as resp:
            if resp.status != 200:
                return ""
            data = await resp.json(content_type=None)
            return data.get("path", "")
    except (asyncio.TimeoutError, aiohttp.ClientError):
        return ""


async def _arr_import_status(
    session: aiohttp.ClientSession, service: dict, *, series_id: int | None = None, movie_id: int | None = None, season_number: int | None = None
) -> dict:
    """Verifica el estado de import y renombrado de un episodio/película.

    Devuelve {has_file, needs_rename, file_path, detail}.
    """
    result = {"has_file": False, "needs_rename": None, "file_path": "", "detail": ""}
    headers = _arr_headers(service["api_key"])

    if movie_id:
        # Radarr: comprobar hasFile
        try:
            async with session.get(
                f"{service['url']}/api/v3/movie/{movie_id}",
                headers=headers,
                timeout=aiohttp.ClientTimeout(total=REQUEST_TIMEOUT),
            ) as resp:
                if resp.status == 200:
                    data = await resp.json(content_type=None)
                    result["has_file"] = data.get("hasFile", False)
        except (asyncio.TimeoutError, aiohttp.ClientError):
            result["detail"] = "error consultando movie"

        # Radarr: comprobar rename
        if result["has_file"]:
            try:
                async with session.get(
                    f"{service['url']}/api/v3/rename",
                    params={"movieId": movie_id},
                    headers=headers,
                    timeout=aiohttp.ClientTimeout(total=REQUEST_TIMEOUT),
                ) as resp:
                    if resp.status == 200:
                        renames = await resp.json(content_type=None)
                        result["needs_rename"] = len(renames) > 0
                        if renames:
                            result["file_path"] = renames[0].get("existingPath", "")
                            result["detail"] = f"renombrado pendiente: {renames[0].get('existingPath', '')} → {renames[0].get('newPath', '')}"
                        else:
                            result["detail"] = "importado y renombrado correctamente"
            except (asyncio.TimeoutError, aiohttp.ClientError):
                result["detail"] = "error consultando rename"

    elif series_id:
        # Sonarr: comprobar hasFile vía episode
        # Necesitamos el episode_id, pero solo tenemos series_id
        # Consultamos la serie para ver si tiene archivos en la temporada
        if season_number is not None:
            try:
                async with session.get(
                    f"{service['url']}/api/v3/episode",
                    params={"seriesId": series_id, "seasonNumber": season_number},
                    headers=headers,
                    timeout=aiohttp.ClientTimeout(total=REQUEST_TIMEOUT),
                ) as resp:
                    if resp.status == 200:
                        episodes = await resp.json(content_type=None)
                        if episodes:
                            result["has_file"] = episodes[0].get("hasFile", False)
            except (asyncio.TimeoutError, aiohttp.ClientError):
                result["detail"] = "error consultando episodes"

        # Sonarr: comprobar rename
        if result["has_file"] and season_number is not None:
            try:
                async with session.get(
                    f"{service['url']}/api/v3/rename",
                    params={"seriesId": series_id, "seasonNumber": season_number},
                    headers=headers,
                    timeout=aiohttp.ClientTimeout(total=REQUEST_TIMEOUT),
                ) as resp:
                    if resp.status == 200:
                        renames = await resp.json(content_type=None)
                        result["needs_rename"] = len(renames) > 0
                        if renames:
                            result["file_path"] = renames[0].get("existingPath", "")
                            result["detail"] = f"renombrado pendiente: {renames[0].get('existingPath', '')} → {renames[0].get('newPath', '')}"
                        else:
                            result["detail"] = "importado y renombrado correctamente"
            except (asyncio.TimeoutError, aiohttp.ClientError):
                result["detail"] = "error consultando rename"

    return result


COPY_CHUNK_SIZE = 1024 * 1024  # 1 MB


class CopyCancelled(Exception):
    """Excepción lanzada cuando el usuario cancela una copia."""


def _copy_file_chunked(src: Path, dst: Path, task_id: str | None = None, total_bytes: int = 0, copied_bytes: int = 0) -> int:
    """Copia un archivo de forma atómica (temp + rename), comprobando cancelación."""
    import tempfile
    written = 0
    tmp_path = None
    try:
        # Escribir a un archivo temporal en el mismo directorio que dst
        with tempfile.NamedTemporaryFile(dir=dst.parent, delete=False, prefix=".copy_") as fdst:
            tmp_path = fdst.name
            with open(src, 'rb') as fsrc:
                while True:
                    if task_id and task_id in _tasks and _tasks[task_id].get("cancelled"):
                        raise CopyCancelled(f"cancelado durante copia de {src.name}")
                    chunk = fsrc.read(COPY_CHUNK_SIZE)
                    if not chunk:
                        break
                    fdst.write(chunk)
                    written += len(chunk)
                    if task_id and task_id in _tasks:
                        _tasks[task_id].update({
                            "copied_bytes": copied_bytes + written,
                            "total_bytes": total_bytes,
                        })
        # Rename atómico al destino final
        os.rename(tmp_path, str(dst))
        tmp_path = None
    except Exception:
        if tmp_path and os.path.exists(tmp_path):
            os.unlink(tmp_path)
        raise
    return written


def _copy_files_to_root(output_path: str, root_folder: str, *, is_host_path: bool = False, task_id: str | None = None) -> dict:
    """Copia archivos desde output_path al root_folder.

    ``output_path`` es la ruta completa al archivo (o directorio) reportada
    por el cliente de descargas.  ``root_folder`` es el directorio de la
    librería del *arr (ej. /mnt/storage-6tb/shared-media/shows/Serie/).

    Si ``is_host_path`` es True, la ruta ya está traducida al host y no se
    aplica _host_path() de nuevo.

    Si ``task_id`` se proporciona, actualiza el progreso en _tasks y
    comprueba cancelación entre chunks.

    Devuelve {ok, detail, files_copied}.
    """
    src = Path(output_path if is_host_path else _host_path(output_path))
    dst_dir = Path(root_folder)
    log.info("copy_files: src=%s  dst=%s  is_host_path=%s", src, dst_dir, is_host_path)

    def _update_task(copied_bytes: int, total_bytes: int, files_done: int, files_total: int):
        if task_id and task_id in _tasks:
            _tasks[task_id].update({
                "copied_bytes": copied_bytes,
                "total_bytes": total_bytes,
                "files_done": files_done,
                "files_total": files_total,
            })

    def _is_cancelled() -> bool:
        return bool(task_id and task_id in _tasks and _tasks[task_id].get("cancelled"))

    if not src.exists():
        log.error("copy_files: fuente no encontrada: %s", src)
        if task_id and task_id in _tasks:
            _tasks[task_id].update({"status": "error", "detail": f"fuente no encontrada: {src}"})
        return {"ok": False, "detail": f"fuente no encontrada: {src}"}

    dst_dir.mkdir(parents=True, exist_ok=True)

    if src.is_file():
        total = src.stat().st_size
        dst = dst_dir / src.name
        _update_task(0, total, 0, 1)
        _copy_file_chunked(src, dst, task_id, total, 0)
        _update_task(total, total, 1, 1)
        return {"ok": True, "detail": f"copiado: {src.name} → {dst_dir}", "files_copied": 1}

    if src.is_dir():
        files = [f for f in src.iterdir() if f.is_file()]
        total_bytes = sum(f.stat().st_size for f in files)
        copied_bytes = 0
        count = 0
        _update_task(0, total_bytes, 0, len(files))
        for item in files:
            if _is_cancelled():
                return {"ok": False, "detail": f"cancelado por el usuario ({count}/{len(files)} archivos copiados)", "files_copied": count}
            dst = dst_dir / item.name
            written = _copy_file_chunked(item, dst, task_id, total_bytes, copied_bytes)
            copied_bytes += written
            count += 1
            _update_task(copied_bytes, total_bytes, count, len(files))
        return {"ok": True, "detail": f"copiados {count} archivos a {dst_dir}", "files_copied": count}

    return {"ok": False, "detail": f"fuente no es archivo ni directorio: {src}"}


async def _amu_ws_find_instance(
    matched_hash: str,
    *,
    timeout: float = 10.0,
) -> tuple[str, str]:
    """Consulta el WS para determinar la instancia y cliente que gestiona un hash.

    Devuelve ``(client_type, instance_id)`` o ``("", "")`` si no se encuentra.
    aMuTorrent almacena hashes ED2K sin los ceros finales del hash de 40 hex,
    así que se busca tanto la coincidencia exacta como por prefijo.
    """
    jar = aiohttp.CookieJar(unsafe=True)
    async with aiohttp.ClientSession(cookie_jar=jar) as session:
        ok, _ = await _amu_ws_login(session)
        if not ok:
            return "", ""
        try:
            async with session.ws_connect(
                _amu_ws_url(),
                headers={"Referer": AMUTORRENT_URL},
                timeout=aiohttp.ClientTimeout(total=timeout),
            ) as ws:
                await asyncio.wait_for(ws.receive(), timeout=5)  # connected
                await ws.send_json({"action": "subscribe", "channel": "items"})
                deadline = time.monotonic() + timeout
                h_lower = matched_hash.lower()
                h_prefix = h_lower[:32]  # sin ceros de padding ED2K
                while time.monotonic() < deadline:
                    msg = await ws.receive(timeout=min(5, deadline - time.monotonic()))
                    if msg.type != aiohttp.WSMsgType.TEXT:
                        continue
                    try:
                        ev = json.loads(msg.data)
                    except ValueError:
                        continue
                    if ev.get("type") != "batch-update":
                        continue
                    items = ev.get("data", {}).get("items", [])
                    for item in items:
                        ih = item.get("hash", "").lower()
                        if ih == h_lower or ih == h_prefix:
                            client = item.get("client", "amule")
                            inst = item.get("instanceId", "")
                            return client, inst
                return "", ""
        except Exception:
            return "", ""


def _amu_ws_items(matched_hash: str, *, client: str = "amule", instance_id: str | None = None, name: str | None = None) -> list[dict]:
    """Construye la lista `items` que esperan las acciones batch del WS.

    aMuTorrent identifica cada archivo por su hash + instancia del cliente.
    Los hashes ED2K de 40 hex terminados en ``00000000`` se almacenan internamente
    sin ese padding de 8 ceros; el WS espera la versión truncada de 32 hex.
    Los infohash de BitTorrent de 32 hex se usan tal cual.
    """
    h = matched_hash.lower()
    if len(h) == 40 and h.endswith("00000000"):
        h = h[:32]
    item: dict = {"fileHash": h, "clientType": client}
    if instance_id:
        item["instanceId"] = instance_id
    if name:
        item["fileName"] = name
    return [item]


async def _arr_delete_queue(
    session: aiohttp.ClientSession, service: dict, queue_id: int, blocklist: bool
) -> dict:
    """Elimina (y opcionalmente bloquea) un item de la cola de un *arr."""
    headers = _arr_headers(service["api_key"])
    url = (
        f"{service['url']}/api/v3/queue/{queue_id}"
        f"?removeFromClient=true&blocklist={'true' if blocklist else 'false'}"
    )
    timeout = aiohttp.ClientTimeout(total=REQUEST_TIMEOUT * 2)
    try:
        async with session.delete(url, headers=headers, timeout=timeout) as resp:
            if resp.status in (200, 204):
                return {"ok": True, "detail": "Item eliminado de la cola"}
            return {"ok": False, "detail": f"HTTP {resp.status}"}
    except (asyncio.TimeoutError, aiohttp.ClientError) as exc:
        return {"ok": False, "detail": f"{type(exc).__name__}: {exc}"}


async def _arr_remote_paths(session: aiohttp.ClientSession, service: dict) -> list[dict]:
    """Lista los remote path mappings configurados en un *arr."""
    headers = _arr_headers(service["api_key"])
    timeout = aiohttp.ClientTimeout(total=REQUEST_TIMEOUT * 2)
    try:
        async with session.get(
            f"{service['url']}/api/v3/remotepathmapping",
            headers=headers,
            timeout=timeout,
        ) as resp:
            if resp.status != 200:
                return []
            return await resp.json(content_type=None) or []
    except (asyncio.TimeoutError, aiohttp.ClientError, ValueError):
        return []


async def _arr_add_remote_path(
    session: aiohttp.ClientSession,
    service: dict,
    host: str,
    remote_path: str,
    local_path: str,
) -> dict:
    """Crea un remote path mapping: traduce la ruta que reporta el cliente de
    descargas (remote) a la ruta que el *arr ve dentro de su contenedor (local).
    Es la corrección del error 'this directory does not appear to exist inside
    the container'."""
    headers = _arr_headers(service["api_key"])
    headers["Content-Type"] = "application/json"
    body = {"host": host, "remotePath": remote_path, "localPath": local_path}
    timeout = aiohttp.ClientTimeout(total=REQUEST_TIMEOUT * 2)
    try:
        async with session.post(
            f"{service['url']}/api/v3/remotepathmapping",
            headers=headers,
            json=body,
            timeout=timeout,
        ) as resp:
            text = await resp.text()
            if resp.status in (200, 201):
                return {"ok": True, "detail": f"mapeo creado: {remote_path} → {local_path}"}
            return {"ok": False, "detail": f"HTTP {resp.status}: {text[:200]}"}
    except (asyncio.TimeoutError, aiohttp.ClientError) as exc:
        return {"ok": False, "detail": f"{type(exc).__name__}: {exc}"}


async def _run_copy_background(task_id: str, src_path: str, dst_root: str, service: dict, source: str, ids: dict | None = None):
    """Ejecuta la copia de archivos en background y actualiza el estado de la tarea."""
    ids = ids or {}
    try:
        _tasks[task_id]["detail"] = "copiando archivos..."
        result = await asyncio.to_thread(
            _copy_files_to_root, src_path, dst_root, is_host_path=True, task_id=task_id
        )
        if _tasks[task_id].get("cancelled"):
            _tasks[task_id].update({
                "status": "cancelled",
                "detail": result.get("detail", "cancelado"),
                "files_copied": result.get("files_copied", 0),
            })
            return
        _tasks[task_id].update({
            "status": "done" if result["ok"] else "error",
            "detail": result.get("detail", ""),
            "files_copied": result.get("files_copied", 0),
        })
        # Reintentar import después de copiar
        if result["ok"]:
            _tasks[task_id]["detail"] = "importando..."
            _tasks[task_id]["status"] = "importing"
            async with aiohttp.ClientSession() as session:
                await _arr_command(session, service, {"name": "ProcessMonitoredDownloads"})
            # Verificar import y renombrado
            await _verify_import(task_id, service, source, ids)
    except CopyCancelled:
        _tasks[task_id].update({
            "status": "cancelled",
            "detail": _tasks[task_id].get("detail", "cancelado por el usuario"),
            "files_copied": _tasks[task_id].get("files_done", 0),
        })
    except Exception as exc:
        log.exception("copy_files: error en background task %s", task_id)
        _tasks[task_id].update({"status": "error", "detail": f"{type(exc).__name__}: {exc}"})


IMPORT_POLL_INTERVAL = 5  # segundos entre polls de verificación de import
IMPORT_POLL_TIMEOUT = int(os.getenv("IMPORT_TIMEOUT", "40"))  # timeout máximo en segundos


async def _verify_import(task_id: str, service: dict, source: str, ids: dict):
    """Poll hasFile + rename para verificar que el import fue exitoso."""
    start = time.time()
    async with aiohttp.ClientSession() as session:
        while time.time() - start < IMPORT_POLL_TIMEOUT:
            if _tasks[task_id].get("cancelled"):
                return

            # Determinar parámetros de consulta
            kwargs: dict = {}
            if source == "radarr" and ids.get("movie_id"):
                kwargs["movie_id"] = ids["movie_id"]
            elif source == "sonarr" and ids.get("series_id"):
                kwargs["series_id"] = ids["series_id"]
                # Necesitamos el seasonNumber, lo sacamos del task dst_path o del episode
                if ids.get("episode_id"):
                    season = await _arr_episode_season(session, service, ids["episode_id"])
                    if season is not None:
                        kwargs["season_number"] = season

            if not kwargs:
                _tasks[task_id].update({"status": "done", "detail": "copia completada (sin verificación)"})
                return

            status = await _arr_import_status(session, service, **kwargs)

            if not status["has_file"]:
                elapsed = int(time.time() - start)
                _tasks[task_id]["detail"] = f"esperando import... ({elapsed}s)"
                await asyncio.sleep(IMPORT_POLL_INTERVAL)
                continue

            # hasFile = true: el archivo fue importado
            if status["needs_rename"] is False:
                _tasks[task_id].update({
                    "status": "imported",
                    "detail": "importado y renombrado correctamente",
                })
                return
            elif status["needs_rename"] is True:
                _tasks[task_id].update({
                    "status": "renamed_needed",
                    "detail": status.get("detail", "importado — necesita renombrado manual"),
                })
                return
            else:
                # No se pudo verificar rename, pero hasFile es true
                _tasks[task_id].update({
                    "status": "imported",
                    "detail": status.get("detail", "importado correctamente"),
                })
                return

    # Timeout
    _tasks[task_id].update({
        "status": "import_timeout",
        "detail": f"timeout después de {IMPORT_POLL_TIMEOUT}s — verifica manualmente",
    })


async def _do_action(
    session: aiohttp.ClientSession, action: str, payload: dict
) -> dict:
    """Ejecuta una acción y devuelve {ok, steps:[...]}, donde cada paso es
    {target, ok, detail}."""
    source = payload.get("source")
    service = _service_by_key(source) if source else None
    download_id = payload.get("download_id") or ""
    matched_hash = payload.get("matched_hash")
    ids = payload.get("ids") or {}
    queue_id = ids.get("queue_id")
    steps: list[dict] = []

    if action == "retry_import":
        if not service:
            return {"ok": False, "steps": [{"target": "arr", "ok": False, "detail": "servicio desconocido"}]}
        steps.append({"target": source, **await _arr_command(session, service, {"name": "ProcessMonitoredDownloads"})})

    elif action == "research":
        if not service:
            return {"ok": False, "steps": [{"target": "arr", "ok": False, "detail": "servicio desconocido"}]}
        # Sonarr usa EpisodeSearch; Radarr usa MoviesSearch.
        if source == "sonarr" and ids.get("episode_id"):
            body = {"name": "EpisodeSearch", "episodeIds": [ids["episode_id"]]}
        elif source == "radarr" and ids.get("movie_id"):
            body = {"name": "MoviesSearch", "movieIds": [ids["movie_id"]]}
        else:
            return {"ok": False, "steps": [{"target": source, "ok": False, "detail": "faltan IDs de episodio/película"}]}
        steps.append({"target": source, **await _arr_command(session, service, body)})

    elif action == "fix_category":
        if not matched_hash:
            return {"ok": False, "steps": [{"target": "amutorrent", "ok": False, "detail": "sin hash correlacionado"}]}
        category = EXPECTED_CATEGORY.get(source)
        if not category:
            return {"ok": False, "steps": [{"target": "amutorrent", "ok": False, "detail": "categoría esperada desconocida"}]}
        client, inst = await _amu_ws_find_instance(matched_hash)
        steps.append({
            "target": "amutorrent",
            **await _amu_ws(
                "batchSetFileCategory",
                {
                    "items": _amu_ws_items(matched_hash, client=client or "qbittorrent", instance_id=inst),
                    "categoryName": category,
                    "moveFiles": False,
                },
            ),
        })
        if service:
            steps.append({
                "target": source,
                **await _arr_command(session, service, {"name": "ProcessMonitoredDownloads"}),
            })

    elif action in ("pause", "resume"):
        if not matched_hash:
            return {"ok": False, "steps": [{"target": "amutorrent", "ok": False, "detail": "sin hash correlacionado"}]}
        ws_action = "batchPause" if action == "pause" else "batchResume"
        client, inst = await _amu_ws_find_instance(matched_hash)
        steps.append({
            "target": "amutorrent",
            **await _amu_ws(ws_action, {"items": _amu_ws_items(matched_hash, client=client or "amule", instance_id=inst)}),
        })

    elif action == "remove_queue":
        if not service or not queue_id:
            return {"ok": False, "steps": [{"target": "arr", "ok": False, "detail": "sin queue_id"}]}
        blocklist = bool(payload.get("blocklist"))
        steps.append({
            "target": source,
            **await _arr_delete_queue(session, service, int(queue_id), blocklist),
        })

    elif action == "delete_torrent":
        if not matched_hash:
            return {"ok": False, "steps": [{"target": "amutorrent", "ok": False, "detail": "sin hash correlacionado"}]}
        delete_files = bool(payload.get("delete_files"))
        client, inst = await _amu_ws_find_instance(matched_hash)
        steps.append({
            "target": "amutorrent",
            **await _amu_ws(
                "batchDelete",
                {
                    "items": _amu_ws_items(matched_hash, client=client or "amule", instance_id=inst),
                    "deleteFiles": delete_files,
                    "source": "downloads",
                },
            ),
        })

    elif action == "fix_path_mapping":
        if not service:
            return {"ok": False, "steps": [{"target": "arr", "ok": False, "detail": "servicio desconocido"}]}
        host = payload.get("host") or ""
        remote_path = payload.get("remote_path") or ""
        local_path = payload.get("local_path") or ""
        if not (host and remote_path):
            return {
                "ok": False,
                "steps": [
                    {
                        "target": source,
                        "ok": False,
                        "detail": "faltan host/remote_path para el mapeo",
                    }
                ],
            }
        # Auto-derivación: qBittorrent-novpn tiene /mnt/storage:/data, así que
        # /data/X → /mnt/storage/X.  Si el *arr ya tiene /mnt/storage:/mnt/storage,
        # esa ruta es accesible directamente.
        if not local_path and remote_path.startswith("/data/"):
            local_path = "/mnt/storage/" + remote_path[len("/data/"):]
        elif not local_path:
            local_path = remote_path
        # Evita duplicados: si ya existe el mismo mapeo, no lo vuelve a crear.
        existing = await _arr_remote_paths(session, service)
        # Normaliza trailing slashes para la comparación.
        rp = remote_path.rstrip("/")
        lp = local_path.rstrip("/")
        dup = next(
            (
                m for m in existing
                if m.get("host") == host
                and m.get("remotePath", "").rstrip("/") == rp
                and m.get("localPath", "").rstrip("/") == lp
            ),
            None,
        )
        if dup:
            steps.append({"target": source, "ok": True, "detail": "el mapeo ya existe"})
        else:
            steps.append({
                "target": source,
                **await _arr_add_remote_path(session, service, host, remote_path, local_path),
            })
        # Tras el mapeo, reintenta el import para que el *arr reencuentre el archivo.
        steps.append({
            "target": source,
            **await _arr_command(session, service, {"name": "ProcessMonitoredDownloads"}),
        })

    elif action == "copy_files":
        log.info("action=copy_files source=%s ids=%s", source, ids)
        if not service:
            return {"ok": False, "steps": [{"target": "arr", "ok": False, "detail": "servicio desconocido"}]}
        output_path = payload.get("output_path") or ""
        if not output_path:
            log.warning("copy_files: sin output_path en payload")
            return {"ok": False, "steps": [{"target": source, "ok": False, "detail": "sin output_path"}]}
        # Obtener la root folder del *arr
        if source == "sonarr" and ids.get("series_id"):
            root = await _arr_series_root_folder(session, service, ids["series_id"])
            # Para Sonarr, añadir carpeta de temporada (Season X)
            if root and ids.get("episode_id"):
                season_num = await _arr_episode_season(session, service, ids["episode_id"])
                if season_num is not None:
                    root = str(Path(root) / f"Season {season_num}")
                    log.info("copy_files: season folder → %s", root)
        elif source == "radarr" and ids.get("movie_id"):
            root = await _arr_movie_root_folder(session, service, ids["movie_id"])
        else:
            root = ""
        log.info("copy_files: output_path=%s  root=%s", output_path, root)
        if not root:
            log.error("copy_files: no se pudo obtener root folder para %s (series_id=%s, movie_id=%s)", source, ids.get("series_id"), ids.get("movie_id"))
            return {"ok": False, "steps": [{"target": source, "ok": False, "detail": "no se pudo obtener la carpeta raíz de la librería"}]}
        # Calcular destino y lanzar copia en background
        _src_path = Path(output_path)
        dst_path = str(Path(root) / _src_path.name)
        task_id = str(uuid.uuid4())
        _tasks[task_id] = {
            "status": "running",
            "created_at": time.time(),
            "src_path": output_path,
            "dst_path": dst_path,
            "copied_bytes": 0,
            "total_bytes": 0,
            "files_done": 0,
            "files_total": 0,
            "detail": "preparando copia...",
        }
        # Lanzar la copia en background
        asyncio.create_task(_run_copy_background(task_id, output_path, root, service, source, ids))
        return {"ok": True, "needs_polling": True, "task_id": task_id, "src_path": output_path, "dst_path": dst_path}

    else:
        return {"ok": False, "steps": [{"target": "?", "ok": False, "detail": f"acción desconocida: {action}"}]}

    return {"ok": all(s["ok"] for s in steps), "steps": steps}


@app.get("/api/health")
async def health():
    """Health check endpoint para Docker/Kubernetes."""
    return {"status": "ok"}


@app.get("/api/actions")
async def list_actions():
    """Catálogo de acciones disponibles y si el modo seguro está activo."""
    return {
        "actions": [
            {"key": k, **v} for k, v in ACTIONS.items()
        ],
        "safe_mode": SAFE_MODE,
        "available": sorted(ACTIONS.keys()),
    }


@app.post("/api/actions/{action}")
async def run_action(action: str, req: ActionRequest, _key: str = Depends(verify_api_key)):
    """Ejecuta una acción sobre una descarga concreta."""
    if action not in ACTIONS:
        return {"ok": False, "error": f"acción desconocida: {action}"}

    meta = ACTIONS[action]
    if SAFE_MODE and meta["destructive"]:
        return {
            "ok": False,
            "error": (
                f"'{meta['label']}' es destructiva y el modo seguro está activo "
                "(SAFE_MODE=true). Desactívalo en backend/.env para habilitarla."
            ),
            "safe_mode": True,
        }

    payload = req.model_dump()
    result = await _do_action(_http_session, action, payload)

    return {
        "action": action,
        "label": meta["label"],
        "destructive": meta["destructive"],
        **result,
        "at": int(time.time()),
    }


# --- Tasks (progreso de copy_files en background) ---
@app.get("/api/tasks/{task_id}")
async def get_task(task_id: str, _key: str = Depends(verify_api_key)):
    """Estado de una tarea en background (copy_files con progreso)."""
    _cleanup_tasks()
    task = _tasks.get(task_id)
    if not task:
        return {"ok": False, "error": "tarea no encontrada"}
    return {"ok": True, **task}


@app.post("/api/tasks/{task_id}/cancel")
async def cancel_task(task_id: str, _key: str = Depends(verify_api_key)):
    """Cancela una tarea en background (copy_files)."""
    task = _tasks.get(task_id)
    if not task:
        return {"ok": False, "error": "tarea no encontrada"}
    if task.get("status") not in ("running", None):
        return {"ok": False, "error": f"tarea ya en estado: {task['status']}"}
    task["cancelled"] = True
    task["detail"] = "cancelación solicitada..."
    log.info("copy_files: cancelación solicitada para task %s", task_id)
    return {"ok": True}


# --- Config (Developer mode) ---
@app.get("/api/config")
async def config():
    return {"developer": DEVELOPER}


# --- Prototypes listing ---
PROTOTYPES_DIR = os.path.normpath(os.path.join(BASE_DIR, "..", "prototypes"))


@app.get("/api/prototypes")
async def list_prototypes():
    if not os.path.isdir(PROTOTYPES_DIR):
        return []
    files = sorted(
        f for f in os.listdir(PROTOTYPES_DIR) if f.endswith(".html")
    )
    return [
        {"name": f.removesuffix(".html"), "file": f}
        for f in files
    ]


# --- Frontend estático (React build) ---
if os.path.isdir(FRONTEND_DIST):
    assets_dir = os.path.join(FRONTEND_DIST, "assets")
    if os.path.isdir(assets_dir):
        app.mount("/assets", StaticFiles(directory=assets_dir), name="assets")

if os.path.isdir(PROTOTYPES_DIR):
    app.mount("/prototypes", StaticFiles(directory=PROTOTYPES_DIR), name="prototypes")


@app.get("/")
async def root():
    index = os.path.join(FRONTEND_DIST, "index.html")
    if os.path.isfile(index):
        return FileResponse(index)
    return {"detail": "Frontend no compilado. Ejecuta: cd frontend && npm run build"}


@app.get("/{full_path:path}")
async def spa_fallback(full_path: str):
    """Fallback SPA: sirve archivos del build o index.html."""
    if full_path.startswith("api/"):
        return {"detail": "Not Found"}
    if full_path.startswith("prototypes/"):
        return {"detail": "Not Found"}
    candidate = os.path.normpath(os.path.join(FRONTEND_DIST, full_path))
    if candidate.startswith(FRONTEND_DIST) and os.path.isfile(candidate):
        return FileResponse(candidate)
    return FileResponse(os.path.join(FRONTEND_DIST, "index.html"))
