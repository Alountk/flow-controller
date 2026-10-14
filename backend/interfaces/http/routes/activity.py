"""Dashboard activity route (Stitch 01, section 3).

The composition lives in the use case; this handler only parses the bound
and asks for it.
"""

from fastapi import APIRouter, Depends, Query

from application.use_cases import activity
from interfaces.http.deps import verify_api_key

router = APIRouter()


@router.get("/api/activity")
async def get_activity(
    limit: int = Query(10, ge=1, le=50),
    _key: str = Depends(verify_api_key),
):
    """Actividad reciente: operaciones copy/move + descargas activas."""
    return await activity.get_activity(limit)
