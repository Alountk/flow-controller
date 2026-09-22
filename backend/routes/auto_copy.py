"""Auto-copy sweep endpoint.

The sweep is an explicit POST on purpose: ``GET /api/trace`` is polled by the UI
every 15 seconds, and hooking the copy there would turn a read into a write on
the media library and make two open tabs two sweeps. Unattended operation is the
user's external timer (cron/systemd) calling this endpoint; there is deliberately
no background loop (design D1 rejected it).
"""

import logging

import aiohttp
from fastapi import APIRouter, Depends

from auto_copy_driver import sweep
from config import SAFE_MODE
from history import recent_auto_copy_log, store_available
from routes.status import verify_api_key

log = logging.getLogger("flow-controller")
router = APIRouter()


@router.get("/api/auto-copy/history")
async def get_auto_copy_history(limit: int = 20, _key: str = Depends(verify_api_key)):
    """The auto-copy decision-transition log, newest first.

    Read-only and behind the same key as every other data route. An unavailable
    store is an empty list WITH a reason, never a 500: the UI has to be able to
    tell "nothing has happened yet" from "the history could not be read", and
    only the second one is a fault worth showing.

    ``recent_auto_copy_log`` clamps the limit, so a negative query parameter
    cannot ask SQLite for "no limit".
    """
    try:
        items = recent_auto_copy_log(limit=limit)
        if not store_available():
            return {"items": [], "error": "el historial no está disponible"}
        return {"items": items}
    except Exception as exc:  # noqa: BLE001 — the route contract is JSON, not 500
        log.exception("auto-copy history: error inesperado: %s", exc)
        return {"items": [], "error": f"{type(exc).__name__}: {exc}"}


@router.post("/api/auto-copy/sweep")
async def run_auto_copy_sweep(_key: str = Depends(verify_api_key)):
    """Run ONE sweep and return its summary.

    Never 500s because a database or an arr was unavailable: the driver degrades
    and reports it in the summary, and this is the last resort so an unexpected
    error still comes back as a readable JSON body.
    """
    try:
        # A per-sweep session, like GET /api/trace: sweeps are infrequent and
        # this avoids depending on the lifespan having run.
        async with aiohttp.ClientSession() as session:
            return await sweep(session, safe_mode=SAFE_MODE)
    except Exception as exc:  # noqa: BLE001 — the route contract is JSON, not 500
        log.exception("auto-copy sweep: error inesperado: %s", exc)
        return {
            "ok": False,
            "running": False,
            "safe_mode": SAFE_MODE,
            "detail": "el barrido falló",
            "counts": {},
            "entries": [],
            "errors": [f"{type(exc).__name__}: {exc}"],
        }
