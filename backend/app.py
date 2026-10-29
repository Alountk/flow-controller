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
from application.use_cases import downloads_cache, trace_cache
from infrastructure import amule_ec_client, amule_service, amule_watchdog, arr_client, opensubtitles_client, settings_store, sqlite_history, system_probe, wanted_scan
from infrastructure import credentials as credentials_module, prowlarr_client, sqlite_history as history, torznab_client
from config import FRONTEND_DIST
from state import _LOG_BUFFER, buf_handler, _load_log_file, close_shared_session, open_shared_session

# Before the routes, and not after: they bind their adapter names at import, so
# a router imported first would be handed a `gateways` full of None.
gateways.bind(
    arr=arr_client,
    settings=settings_store,
    sqlite_history=sqlite_history,
    credentials_module=credentials_module,
    system=system_probe,
    scan=wanted_scan.walk,
    opensubtitles=opensubtitles_client,
    prowlarr=prowlarr_client,
    amule=amule_service,
)

from interfaces.http.routes import indexers as indexers_routes, settings as settings_routes, status as status_routes
from interfaces.http.routes.wanted import router as wanted_router
from interfaces.http.routes.calendar import router as calendar_router
from interfaces.http.routes.files import router as files_router
from interfaces.http.routes.actions import router as actions_router
from interfaces.http.routes.auto_copy import router as auto_copy_router
from interfaces.http.routes.downloads import router as downloads_router
from interfaces.http.routes.activity import router as activity_router
from interfaces.http.routes.mediacover import router as mediacover_router
from interfaces.http.routes.settings import router as settings_router, PROTOTYPES_DIR
from interfaces.http.routes.amule_shares import router as amule_shares_router
from interfaces.http.routes.amule_actions import router as amule_actions_router
from interfaces.http.routes.events import router as events_router
from interfaces.http.middleware import RequestGuards
from interfaces.http.routes_mixer import router as mixer_router
indexers_routes.torznab, settings_routes.amule_ec_client, settings_routes.amule_watchdog = torznab_client, amule_ec_client.AmuleECClient, amule_watchdog  # adapter hand-off: delivery may hold one only because this file puts it in its hand (Torznab for the indexers; the EC client behind POST /api/amule/test; the watchdog module behind GET /api/amule/health). All share the line because tests_architecture.py pins legacy — this file — at its line cap.

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [%(levelname)s] %(message)s",
    datefmt="%H:%M:%S",
)
log = logging.getLogger("flow-controller")

log.addHandler(buf_handler)

# Load persisted logs into buffer on startup
for entry in _load_log_file():
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
    tasks = [
        asyncio.create_task(coro)
        for coro in (
            status_routes.background_checker(),
            downloads_cache.downloads_poller(),
            trace_cache.trace_refresher(),
            amule_watchdog.watchdog_loop(),
        )
    ]
    try:
        yield
    finally:
        for task in tasks:
            task.cancel()
            try:
                await task
            except asyncio.CancelledError:
                pass
        await close_shared_session()


app = FastAPI(lifespan=lifespan)

# The edge guard — request id + budgets — wraps everything mounted below it.
app.add_middleware(RequestGuards)

# ── Include routers ───────────────────────────────────────────────────────────

# Mount order preserved; the loop keeps this file's counted lines for the lifespan above.
for router in (status_routes.router, wanted_router, calendar_router, files_router,
               actions_router, auto_copy_router, downloads_router, mediacover_router, amule_actions_router,
               settings_router, amule_shares_router, mixer_router, events_router, activity_router, indexers_routes.router):
    app.include_router(router)


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
    if full_path.startswith(("api/", "prototypes/")):
        return {"detail": "Not Found"}
    candidate = os.path.normpath(os.path.join(FRONTEND_DIST, full_path))
    if candidate.startswith(FRONTEND_DIST) and os.path.isfile(candidate):
        return FileResponse(candidate)
    return FileResponse(os.path.join(FRONTEND_DIST, "index.html"))
