"""Flow Controller — Main application entry point.

Routes are organized in routes/*.py modules.
Shared state lives in state.py.
Pydantic models live in models.py.
"""

import asyncio
import logging
import os

import aiohttp
from fastapi import FastAPI
from fastapi.responses import FileResponse
from fastapi.staticfiles import StaticFiles

from config import FRONTEND_DIST
from state import buf_handler, _load_log_file
from routes.status import router as status_router, background_checker
from routes.wanted import router as wanted_router
from routes.calendar import router as calendar_router
from routes.files import router as files_router
from routes.actions import router as actions_router
from routes.settings import router as settings_router, PROTOTYPES_DIR
from routes_mixer import router as mixer_router

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [%(levelname)s] %(message)s",
    datefmt="%H:%M:%S",
)
log = logging.getLogger("flow-controller")

# Attach log buffer handler
log.addHandler(buf_handler)

# Load persisted logs into buffer on startup
for entry in _load_log_file():
    from state import _LOG_BUFFER
    _LOG_BUFFER.append(entry)


# ── Lifespan ──────────────────────────────────────────────────────────────────

_http_session: aiohttp.ClientSession | None = None


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

# ── Include routers ───────────────────────────────────────────────────────────

app.include_router(status_router)
app.include_router(wanted_router)
app.include_router(calendar_router)
app.include_router(files_router)
app.include_router(actions_router)
app.include_router(settings_router)
app.include_router(mixer_router)


# ── Static files + SPA fallback ───────────────────────────────────────────────

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
    if full_path.startswith("api/"):
        return {"detail": "Not Found"}
    if full_path.startswith("prototypes/"):
        return {"detail": "Not Found"}
    candidate = os.path.normpath(os.path.join(FRONTEND_DIST, full_path))
    if candidate.startswith(FRONTEND_DIST) and os.path.isfile(candidate):
        return FileResponse(candidate)
    return FileResponse(os.path.join(FRONTEND_DIST, "index.html"))
