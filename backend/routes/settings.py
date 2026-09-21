"""Settings and prototypes routes."""

import copy
import os

from fastapi import APIRouter, Depends

from config import BASE_DIR
from settings import get_settings, save_settings
from routes.status import verify_api_key

router = APIRouter()

RESTART_REQUIRED_FIELDS = {
    "services.radarr.url", "services.radarr.api_key",
    "services.sonarr.url", "services.sonarr.api_key",
    "services.amutorrent.url", "services.amutorrent.api_key",
    "services.amutorrent.user", "services.amutorrent.password",
    "security.api_key", "server.port",
}

PROTOTYPES_DIR = os.path.normpath(os.path.join(BASE_DIR, "..", "prototypes"))


def _mask_secrets(data: dict) -> dict:
    masked = copy.deepcopy(data)
    for svc in ("radarr", "sonarr", "amutorrent"):
        key = masked.get("services", {}).get(svc, {}).get("api_key", "")
        if key:
            masked["services"][svc]["api_key"] = "****" + key[-4:] if len(key) > 4 else "****"
    ak = masked.get("security", {}).get("api_key", "")
    if ak:
        masked["security"]["api_key"] = "****" + ak[-4:] if len(ak) > 4 else "****"
    pw = masked.get("services", {}).get("amutorrent", {}).get("password", "")
    if pw:
        masked["services"]["amutorrent"]["password"] = "****"
    return masked


@router.get("/api/settings")
async def get_settings_endpoint(_key: str = Depends(verify_api_key)):
    return _mask_secrets(get_settings())


@router.post("/api/settings")
async def save_settings_endpoint(body: dict, _key: str = Depends(verify_api_key)):
    save_settings(body)
    restart_needed = []
    def _check(data: dict, prefix: str = "") -> None:
        for k, v in data.items():
            path = f"{prefix}.{k}" if prefix else k
            if isinstance(v, dict):
                _check(v, path)
            elif path in RESTART_REQUIRED_FIELDS:
                restart_needed.append(path)
    _check(body)
    return {"ok": True, "restart_required": restart_needed}


@router.get("/api/prototypes")
async def list_prototypes(_key: str = Depends(verify_api_key)):
    if not os.path.isdir(PROTOTYPES_DIR):
        return []
    files = sorted(
        f for f in os.listdir(PROTOTYPES_DIR) if f.endswith(".html")
    )
    return [
        {"name": f.removesuffix(".html"), "file": f}
        for f in files
    ]
