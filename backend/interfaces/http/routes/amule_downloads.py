"""Descargas de aMule en vivo y control por fichero (pagina-descargas S2/S3).

La cola la sirve `amule_downloads()` como filas S2 (schema del doc, orden del
core sin reordenar) y el control va por `POST /api/amule/downloads/{action}`.
Contrato de la casa del predecesor `amule_actions.py`: HTTP 200 siempre que el
pedido tenga forma, veredicto honesto en `{ok, detail}` y jamás la contraseña
EC en la respuesta. Los servicios entran por `application.gateways` (la suite
los parchea en ESTE módulo, patrón `amule_shares`), y los fallos se traducen
con el mismo `Tipo: mensaje` + aseo de secretos de `routes/settings.py::
_probe_amule_ec` sin importar `infrastructure` (`tests_architecture`). Las
acciones son SYNC (una conexión EC por llamada) y viajan `asyncio.to_thread`,
el precedente `indexers._search_amule`.
"""

import asyncio

from fastapi import APIRouter, Depends, HTTPException

from application.gateways import (
    amule_categories,
    amule_delete,
    amule_downloads,
    amule_pause,
    amule_resume,
    amule_set_category,
    amule_set_priority,
)
from interfaces.http.deps import verify_api_key
import config

router = APIRouter()

#: S3: sólo estas acciones controlan una descarga de la cola.
_ACTIONS = ("pause", "resume", "delete", "priority", "category")

#: `delete` es destructiva: mismo guardián y mensaje que `routes/actions.py::run_action`.
_SAFE_MODE_BLOCKED = (
    "'Eliminar descarga' es destructiva y el modo seguro está activo "
    "(SAFE_MODE=true). Desactívalo en backend/.env para habilitarla."
)


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


def _require_int(body: dict | None, field: str, message: str) -> int:
    """El entero `field` del body, o el 422 en español (un bool NO vale)."""
    value = (body or {}).get(field)
    if isinstance(value, bool) or not isinstance(value, int):
        raise HTTPException(422, message)
    return value


def _optional_bool(body: dict | None, field: str) -> bool:
    """El booleano opcional `field`; presente y no booleano ⇒ 422 en español."""
    value = (body or {}).get(field, False)
    if not isinstance(value, bool):
        raise HTTPException(422, f"«{field}» debe ser verdadero o falso")
    return value


@router.get("/api/amule/downloads")
async def list_amule_downloads(_key: str = Depends(verify_api_key)):
    """La cola de descargas tal cual la sirve el servicio, sin reordenar (S2)."""
    try:
        downloads = await asyncio.to_thread(amule_downloads)
    except Exception as exc:  # noqa: BLE001 — la negativa «no configurado» + errores EC tipados
        return _failure(exc)
    return {"ok": True, "downloads": downloads, "detail": f"{len(downloads)} descargas en la lista"}


@router.post("/api/amule/downloads/{action}")
async def control_amule_download(
    action: str, body: dict | None = None, _key: str = Depends(verify_api_key)
):
    """Control por fichero (S3): pause/resume/delete/priority/category por hash.

    `priority` acepta el valor crudo de `EC_TAG_PARTFILE_PRIO` (PrioString de
    amuleweb: 0=Baja..6=Release) y `category` el índice de la categoría.
    """
    if action not in _ACTIONS:
        return {"ok": False, "detail": f"acción desconocida: {action}"}
    file_hash = _require_text(body, "file_hash", "falta el hash del fichero («file_hash»)")
    if action == "priority":
        priority = _require_int(body, "priority", "falta la prioridad («priority»)")
    if action == "category":
        category = _require_int(body, "category", "falta la categoría («category»)")
    if action == "delete":
        delete_files = _optional_bool(body, "delete_files")
        if config.SAFE_MODE:
            return {"ok": False, "detail": _SAFE_MODE_BLOCKED, "safe_mode": True}
    try:
        if action == "pause":
            await asyncio.to_thread(amule_pause, file_hash)
            detail = f"Descarga pausada: {file_hash}"
        elif action == "resume":
            await asyncio.to_thread(amule_resume, file_hash)
            detail = f"Descarga reanudada: {file_hash}"
        elif action == "delete":
            await asyncio.to_thread(amule_delete, file_hash, delete_files)
            detail = f"Descarga eliminada: {file_hash}"
        elif action == "priority":
            await asyncio.to_thread(amule_set_priority, file_hash, priority)
            detail = f"Prioridad {priority} aplicada a {file_hash}"
        else:  # category
            await asyncio.to_thread(amule_set_category, file_hash, category)
            detail = f"Categoría {category} aplicada a {file_hash}"
    except Exception as exc:  # noqa: BLE001 — la negativa «no configurado» + errores EC tipados
        return _failure(exc)
    return {"ok": True, "detail": detail}


@router.get("/api/amule/categories")
async def list_amule_categories(_key: str = Depends(verify_api_key)):
    """Categorías de aMule como `{título: índice}` para el selector (S3)."""
    try:
        categories = await asyncio.to_thread(amule_categories)
    except Exception as exc:  # noqa: BLE001 — la negativa «no configurado» + errores EC tipados
        return _failure(exc)
    return {"ok": True, "categories": categories}
