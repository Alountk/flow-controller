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
from routes.status import verify_api_key

log = logging.getLogger("flow-controller")
router = APIRouter()


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
