"""Action execution and task status routes."""

import logging
import time

from fastapi import APIRouter, Depends

from config import ACTIONS, SAFE_MODE
from copy_engine import copy_tasks, cleanup_tasks, do_action
from models import ActionRequest
from routes.status import verify_api_key
from state import http_session

log = logging.getLogger("flow-controller")
router = APIRouter()


@router.get("/api/actions")
async def list_actions(_key: str = Depends(verify_api_key)):
    return {
        "actions": [
            {"key": k, **v} for k, v in ACTIONS.items()
        ],
        "safe_mode": SAFE_MODE,
        "available": sorted(ACTIONS.keys()),
    }


@router.post("/api/actions/{action}")
async def run_action(action: str, req: ActionRequest, _key: str = Depends(verify_api_key)):
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
    # One session per action, as every other route module in this app does. The
    # alternative — reusing the lifespan's session — is not reachable from here:
    # it lives in app.py, and importing the app from a route is a layering
    # violation. A session fetched from anywhere else can also be None before
    # the lifespan runs (tests, embedded use), which turns each arr call into an
    # AttributeError 500 instead of a classified failure.
    async with http_session() as session:
        result = await do_action(session, action, payload)

    return {
        "action": action,
        "label": meta["label"],
        "destructive": meta["destructive"],
        **result,
        "at": int(time.time()),
    }


@router.get("/api/tasks/{task_id}")
async def get_task(task_id: str, _key: str = Depends(verify_api_key)):
    cleanup_tasks()
    task = copy_tasks.get(task_id)
    if not task:
        return {"ok": False, "error": "tarea no encontrada"}
    return {"ok": True, **task}


@router.post("/api/tasks/{task_id}/cancel")
async def cancel_task(task_id: str, _key: str = Depends(verify_api_key)):
    return copy_tasks.cancel(task_id)
