"""Health, status, trace, config, logs, debug routes."""

import asyncio
import time
import traceback

import aiohttp
from fastapi import APIRouter, Depends, Header, HTTPException

from config import (
    AMUTORRENT_INDEXER,
    API_KEY,
    DEVELOPER,
    all_services,
    configured_services,
    find_service,
)
from traces import build_traces
from clients import check_service, arr_headers
from state import status_cache

router = APIRouter()


# ── API key verification ─────────────────────────────────────────────────────

async def verify_api_key(x_api_key: str | None = Header(default=None)):
    if not API_KEY:
        return ""
    if x_api_key != API_KEY:
        raise HTTPException(status_code=401, detail="API key inválida")
    return x_api_key


# ── Health checker ────────────────────────────────────────────────────────────

async def check_all(session: aiohttp.ClientSession) -> None:
    status_cache["checking"] = True
    try:
        # Only probe what the user configured. Checking the rest would report a
        # service as down when it was simply never set up, and drag `flow` down
        # with it.
        services = configured_services()
        for service in all_services():
            if not service.get("configured"):
                status_cache[service["key"]] = "unconfigured:Sin configurar"

        if not services:
            status_cache["flow"] = "unconfigured"
            status_cache["updated_at"] = int(time.time())
            return

        results = await asyncio.gather(*(check_service(session, s) for s in services))
        flow_ok = True
        for service, (state, reason, meta) in zip(services, results):
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
    from config import CHECK_INTERVAL
    async with aiohttp.ClientSession() as session:
        while True:
            try:
                await check_all(session)
            except asyncio.CancelledError:
                raise
            except Exception as exc:  # noqa: BLE001
                status_cache["flow"] = f"error:{exc}"
            await asyncio.sleep(CHECK_INTERVAL)


# ── Routes ────────────────────────────────────────────────────────────────────

@router.get("/api/health")
async def health():
    return {"status": "ok"}


@router.get("/api/status")
async def get_status(_key: str = Depends(verify_api_key)):
    return status_cache


@router.get("/api/status/refresh")
async def refresh_status(_key: str = Depends(verify_api_key)):
    async with aiohttp.ClientSession() as session:
        await check_all(session)
    return status_cache


@router.get("/api/trace")
async def get_trace(_key: str = Depends(verify_api_key)):
    async with aiohttp.ClientSession() as session:
        traces = await build_traces(session)
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


@router.get("/api/config")
async def config():
    """Configuración pública para el arranque del frontend.

    NUNCA devuelve la API key: esta ruta es anónima por necesidad (el navegador
    la consulta antes de tener credenciales), y entregarla aquí permitía que
    cualquiera que alcanzara el puerto obtuviera la clave y, con ella, todas las
    credenciales vía /api/settings. Solo informa de si hace falta autenticarse.
    """
    return {"developer": DEVELOPER, "auth_required": bool(API_KEY)}


@router.get("/api/auth/check")
async def auth_check(_key: str = Depends(verify_api_key)):
    """Valida la clave introducida en el navegador. Protegida a propósito."""
    return {"ok": True}


@router.get("/api/logs")
async def get_logs(level: str = "all", _key: str = Depends(verify_api_key)):
    """Últimos logs del backend (WARNING+ por defecto)."""
    from state import _LOG_BUFFER
    entries = list(_LOG_BUFFER)
    if level == "all":
        return {"logs": entries}
    level = level.upper()
    return {"logs": [e for e in entries if e["level"] == level]}


@router.get("/api/debug/indexers")
async def debug_indexers(source: str = "radarr", _key: str = Depends(verify_api_key)):
    """Debug: respuesta cruda de Radarr/Sonarr indexers."""
    service = find_service(source, "arr")
    if not service:
        return {"error": f"Servicio desconocido: {source}"}
    try:
        headers = arr_headers(service["api_key"])
        async with aiohttp.ClientSession() as session:
            async with session.get(
                f"{service['url']}/api/v3/indexer",
                headers=headers,
                timeout=aiohttp.ClientTimeout(total=10),
            ) as resp:
                text = await resp.text()
                if resp.status != 200:
                    return {"status": resp.status, "body": text[:500], "url": service["url"]}
                data = await resp.json(content_type=None)
                return {"status": 200, "count": len(data), "raw": data, "url": service["url"]}
    except Exception as exc:
        return {"error": str(exc), "type": type(exc).__name__, "url": service.get("url", "?"), "traceback": traceback.format_exc()}
