"""Flow Controller — the composition root.

Everything below is wiring: it decides which adapter meets which port, hands
delivery what it is allowed to touch, and mounts the result. No decision of
consequence is made here, and none should be added — a rule with an exception
in `app.py` is a rule nobody can check.

The layers, and the one direction that matters::

    domain  <-  application  <-  infrastructure
                      ^
                      |
                  interfaces          (delivery; may hold an adapter only
                                       because THIS file put it in its hand)

`tests_architecture.py` enforces that direction over the real imports. Shared
state lives in `state.py`; Pydantic models live in `models.py`.
"""

import asyncio
import logging
import os

from fastapi import FastAPI
from fastapi.responses import FileResponse
from fastapi.staticfiles import StaticFiles

from application import gateways
from infrastructure import credentials as credentials_module
from infrastructure import arr_client
from infrastructure import settings_store
from infrastructure import sqlite_history
from infrastructure import sqlite_history as history
from config import FRONTEND_DIST
from state import buf_handler, _load_log_file, close_shared_session, open_shared_session

# Before the routes, and not after: they bind their adapter names at import, so
# a router imported first would be handed a `gateways` full of None.
gateways.bind(
    arr=arr_client,
    settings=settings_store,
    sqlite_history=sqlite_history,
    credentials_module=credentials_module,
)

from interfaces.http.routes.status import router as status_router, background_checker
from interfaces.http.routes.wanted import router as wanted_router
from interfaces.http.routes.calendar import router as calendar_router
from interfaces.http.routes.files import router as files_router
from interfaces.http.routes.actions import router as actions_router
from interfaces.http.routes.auto_copy import router as auto_copy_router
from interfaces.http.routes.downloads import router as downloads_router
from interfaces.http.routes.mediacover import router as mediacover_router
from interfaces.http.routes.settings import router as settings_router, PROTOTYPES_DIR
from interfaces.http.routes_mixer import router as mixer_router

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
#
# The shared HTTP session lives in `state.http_session()`, not here: routes must
# be able to reach it without importing this module, which they cannot do
# without an import cycle. The lifespan only opens it and closes it, and that
# open/close is the switch — with no lifespan running (every test) each scope
# gets a private session instead.

async def lifespan(_app: FastAPI):
    # Open the durable history before serving, and record honestly that any
    # operation still marked running did not survive the previous process.
    history.init_db()
    history.mark_interrupted()

    open_shared_session()
    task = asyncio.create_task(background_checker())
    try:
        yield
    finally:
        task.cancel()
        try:
            await task
        except asyncio.CancelledError:
            pass
        await close_shared_session()


app = FastAPI(lifespan=lifespan)

# ── Include routers ───────────────────────────────────────────────────────────

app.include_router(status_router)
app.include_router(wanted_router)
app.include_router(calendar_router)
app.include_router(files_router)
app.include_router(actions_router)
app.include_router(auto_copy_router)
app.include_router(downloads_router)
app.include_router(mediacover_router)
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
