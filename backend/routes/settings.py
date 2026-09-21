"""Settings and prototypes routes."""

import copy
import os

import aiohttp
from fastapi import APIRouter, Depends

from config import BASE_DIR
from settings import get_settings, save_settings
from clients import test_service_connection
from config import SERVICES, configured_services
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


#: A stored secret is shown to the UI as this prefix plus its last characters.
#: Anything still carrying the prefix means the user did not change it.
MASK_PREFIX = "****"


def _is_mask(value) -> bool:
    return isinstance(value, str) and value.startswith(MASK_PREFIX)


def _restore_masked_secrets(incoming: dict, current: dict) -> dict:
    """Keep the stored secret for every field the UI left masked.

    Secrets are sent to the UI masked, and the form posts them back unchanged.
    Saving that verbatim replaced every real credential with its mask —
    "****ABCD" — destroying the Radarr, Sonarr and aMuTorrent keys and the
    aMuTorrent password, and locking the user out of the app entirely.

    An empty value is NOT a mask: clearing a field still clears it.
    """
    merged = copy.deepcopy(incoming)

    for svc in ("radarr", "sonarr", "amutorrent"):
        incoming_key = merged.get("services", {}).get(svc, {}).get("api_key")
        if _is_mask(incoming_key):
            stored = current.get("services", {}).get(svc, {}).get("api_key", "")
            merged.setdefault("services", {}).setdefault(svc, {})["api_key"] = stored

    incoming_pw = merged.get("services", {}).get("amutorrent", {}).get("password")
    if _is_mask(incoming_pw):
        stored_pw = current.get("services", {}).get("amutorrent", {}).get("password", "")
        merged.setdefault("services", {}).setdefault("amutorrent", {})["password"] = stored_pw

    if _is_mask(merged.get("security", {}).get("api_key")):
        merged.setdefault("security", {})["api_key"] = (
            current.get("security", {}).get("api_key", "")
        )

    return merged


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
    # Unmask before persisting: the form posts the secrets back as they were
    # shown, and saving those verbatim destroyed them.
    save_settings(_restore_masked_secrets(body, get_settings()))
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


@router.get("/api/services/test")
async def test_services(service: str = "", _key: str = Depends(verify_api_key)):
    """Prueba las conexiones configuradas y explica qué falla en cada una.

    Existe sobre todo para la migración a proxy inverso: cuando los servicios
    dejen de estar en localhost, esto dice si siguen siendo alcanzables y con
    qué URL se está intentando.
    """
    targets = [s for s in SERVICES if not service or s["key"] == service]
    results = []
    async with aiohttp.ClientSession() as session:
        for target in targets:
            results.append(await test_service_connection(session, target))
    return {"results": results, "ok": all(r["ok"] for r in results)}


@router.get("/api/services")
async def list_services(_key: str = Depends(verify_api_key)):
    """Qué servicios están utilizables, sin salir a la red.

    Existe para que la interfaz no muestre ni llame a un servicio que el usuario
    no ha configurado. Deliberadamente NO sondea: para eso está
    /api/services/test. Distinto de "configurado pero caído", que sí se muestra.
    """
    return {
        "services": [
            {
                "key": s["key"],
                "kind": s["kind"],
                "url": s["url"],
                "configured": bool(s.get("configured")),
            }
            for s in SERVICES
        ],
        "configured": [s["key"] for s in configured_services()],
    }
