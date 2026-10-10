"""Active downloads, joined across Radarr/Sonarr and the download client.

The join itself — and since F-06(e) the snapshot behind it — lives in
``application.use_cases.downloads_cache``: this handler asks for THE
snapshot, it does not fan out upstream per request. See that module for why
the two sources are joined by ``downloadId`` <-> ``hash`` and how failures
are reported per source.
"""

from fastapi import APIRouter, Depends

from application.use_cases import downloads_cache
from interfaces.http.deps import verify_api_key

router = APIRouter()


@router.get("/api/downloads")
async def get_downloads(_key: str = Depends(verify_api_key)):
    """Descargas activas, con progreso unido desde el cliente de descargas."""
    return await downloads_cache.get_downloads()
