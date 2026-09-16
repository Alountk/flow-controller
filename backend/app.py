import asyncio
import json
import time
from contextlib import asynccontextmanager

import aiohttp
from dotenv import load_dotenv
from fastapi import FastAPI
from fastapi.responses import FileResponse
from fastapi.staticfiles import StaticFiles

import os

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

# URL del indexador Torznab (puente ED2K) expuesto por aMuTorrent.
AMUTORRENT_INDEXER = os.getenv(
    "AMUTORRENT_INDEXER", f"{AMUTORRENT_URL}/indexer/amule/api"
)

# Modo seguro: si está activo, las acciones destructivas quedan bloqueadas
# en el backend (no basta con la confirmación de la UI).
SAFE_MODE = os.getenv("SAFE_MODE", "true").lower() in ("1", "true", "yes")

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
    task = asyncio.create_task(background_checker())
    try:
        yield
    finally:
        task.cancel()
        try:
            await task
        except asyncio.CancelledError:
            pass


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
    )
    # gather devuelve grabs (n), colas (n), download_clients (n).
    n = len(arr_services)
    grabs_by_service = dict(zip((s["key"] for s in arr_services), results[:n]))
    queues_by_service = dict(zip((s["key"] for s in arr_services), results[n:2*n]))
    dc_by_service = dict(zip((s["key"] for s in arr_services), results[2*n:3*n]))
    dc_hosts = {k: _dc_host_map(v) for k, v in dc_by_service.items()}

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

    else:
        return {"ok": False, "steps": [{"target": "?", "ok": False, "detail": f"acción desconocida: {action}"}]}

    return {"ok": all(s["ok"] for s in steps), "steps": steps}


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
async def run_action(action: str, payload: dict):
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

    async with aiohttp.ClientSession() as session:
        result = await _do_action(session, action, payload or {})

    return {
        "action": action,
        "label": meta["label"],
        "destructive": meta["destructive"],
        **result,
        "at": int(time.time()),
    }


# --- Frontend estático (React build) ---
if os.path.isdir(FRONTEND_DIST):
    assets_dir = os.path.join(FRONTEND_DIST, "assets")
    if os.path.isdir(assets_dir):
        app.mount("/assets", StaticFiles(directory=assets_dir), name="assets")


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
    candidate = os.path.normpath(os.path.join(FRONTEND_DIST, full_path))
    if FRONTEND_DIST in candidate and os.path.isfile(candidate):
        return FileResponse(candidate)
    return FileResponse(os.path.join(FRONTEND_DIST, "index.html"))
