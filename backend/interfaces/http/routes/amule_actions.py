"""Acciones de control de aMule por EC (S3/S4): servidores y enlaces.

Contrato de la casa del predecesor `POST /api/amule/test`: HTTP 200 siempre
que el pedido tenga forma, veredicto honesto en `{ok, detail}` y jamás la
contraseña EC en la respuesta. Los servicios entran por
`application.gateways` (la suite los parchea en ESTE módulo, patrón
`amule_shares`), y los fallos se traducen con el mismo `Tipo: mensaje` +
aseo de secretos de `routes/settings.py::_probe_amule_ec`: así es como las
rutas manejan las excepciones EC tipadas sin importar `infrastructure`
(`tests_architecture`). Las acciones son SYNC (una conexión EC por llamada)
y viajan `asyncio.to_thread`, el precedente `indexers._search_amule`.
"""

import asyncio

from fastapi import APIRouter, Depends, HTTPException

from application.gateways import (
    amule_add_ed2k,
    amule_server_add,
    amule_server_connect,
    amule_server_remove,
    amule_servers,
)
from interfaces.http.deps import verify_api_key
import config

router = APIRouter()

#: S4: sólo estos esquemas llegan a la cola — igual que `amulecmd add`.
_SCHEMES = ("ed2k://", "magnet:")


def _scrub(detail: str) -> str:
    """La contraseña EC configurada nunca sale en un detalle.

    Réplica exacta del aseo de `routes/settings.py::_probe_amule_ec`: la
    contraseña USADA se elimina del texto vaya donde vaya.
    """
    password = config.AMULE_EC_PASSWORD
    return detail.replace(password, "****") if password else detail


def _failure(exc: Exception) -> dict:
    """`{ok: false, detail}` para todo fallo operativo — nunca un 500.

    El `Tipo: mensaje` de `_probe_amule_ec`/`indexers._skip_reason`: la única
    vía para las excepciones EC tipadas sin poder importarlas desde aquí.
    """
    return {"ok": False, "detail": _scrub(f"{type(exc).__name__}: {exc}")}


def _require_text(body: dict | None, field: str, message: str) -> str:
    """El string `field` del body, o el 422 en español que nombra su ausencia."""
    value = (body or {}).get(field)
    if not isinstance(value, str) or not value.strip():
        raise HTTPException(422, message)
    return value


@router.get("/api/amule/servers")
async def list_amule_servers(_key: str = Depends(verify_api_key)):
    """El listado de servidores tal cual lo devuelve el servicio (S3)."""
    try:
        servers = await asyncio.to_thread(amule_servers)
    except Exception as exc:  # noqa: BLE001 — la negativa «no configurado» + errores EC tipados
        return _failure(exc)
    return {"ok": True, "servers": servers, "detail": f"{len(servers)} servidores en la lista"}


@router.post("/api/amule/servers/add")
async def add_amule_server(body: dict | None = None, _key: str = Depends(verify_api_key)):
    """Añade un servidor: «address» verbatim al core, «name» opcional (S3)."""
    address = _require_text(
        body, "address", "falta la dirección del servidor («address»: «ip:puerto»)"
    )
    name = (body or {}).get("name")
    name = name if isinstance(name, str) else ""
    try:
        await asyncio.to_thread(amule_server_add, address, name)
    except Exception as exc:  # noqa: BLE001 — la negativa «no configurado» + errores EC tipados
        return _failure(exc)
    return {"ok": True, "detail": f"Servidor añadido: {address}"}


@router.post("/api/amule/servers/remove")
async def remove_amule_server(body: dict | None = None, _key: str = Depends(verify_api_key)):
    """Quita un servidor «host:puerto» (S3) — la resolución vive en el servicio."""
    address = _require_text(
        body, "address", "falta la dirección del servidor («address»: «ip:puerto»)"
    )
    try:
        await asyncio.to_thread(amule_server_remove, address)
    except Exception as exc:  # noqa: BLE001 — la negativa «no configurado» + errores EC tipados
        return _failure(exc)
    return {"ok": True, "detail": f"Servidor eliminado: {address}"}


@router.post("/api/amule/servers/connect")
async def connect_amule_server(body: dict | None = None, _key: str = Depends(verify_api_key)):
    """Pide al core conectar con «host:puerto» (S3)."""
    address = _require_text(
        body, "address", "falta la dirección del servidor («address»: «ip:puerto»)"
    )
    try:
        await asyncio.to_thread(amule_server_connect, address)
    except Exception as exc:  # noqa: BLE001 — la negativa «no configurado» + errores EC tipados
        return _failure(exc)
    return {"ok": True, "detail": f"Solicitada la conexión al servidor: {address}"}


@router.post("/api/amule/links")
async def add_amule_link(body: dict | None = None, _key: str = Depends(verify_api_key)):
    """Encola un enlace ed2k:// o magnet: (S4) — otro esquema ni se intenta."""
    link = _require_text(body, "link", "falta el enlace («link»)")
    if not link.startswith(_SCHEMES):
        scheme = link.split(":", 1)[0] or "sin esquema"
        return {
            "ok": False,
            "detail": f"enlace no admitido: se espera ed2k:// o magnet: (recibido «{scheme}»)",
        }
    try:
        await asyncio.to_thread(amule_add_ed2k, link)
    except Exception as exc:  # noqa: BLE001 — la negativa «no configurado» + errores EC tipados
        return _failure(exc)
    return {"ok": True, "detail": "Enlace encolado en aMule"}
