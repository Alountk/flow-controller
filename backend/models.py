"""Pydantic request/response models."""

from pydantic import BaseModel


class ActionRequest(BaseModel):
    source: str = ""
    download_id: str = ""
    matched_hash: str = ""
    ids: dict = {}
    output_path: str = ""
    blocklist: bool | None = None
    delete_files: bool | None = None
    host: str = ""
    remote_path: str = ""
    local_path: str = ""


class CalendarSearchRequest(BaseModel):
    source: str  # "radarr" or "sonarr"
    type: str  # "movie" or "episode"
    id: int  # Radarr movie ID or Sonarr episode ID


class CalendarAddRequest(BaseModel):
    source: str  # "radarr" or "sonarr"
    type: str  # "movie" or "episode"
    title: str
    year: int | None = None


class CalendarReleasesRequest(BaseModel):
    source: str  # "radarr" or "sonarr"
    type: str  # "movie" or "episode"
    id: int  # Radarr movie ID or Sonarr episode ID


class CalendarGrabRequest(BaseModel):
    source: str  # "radarr" or "sonarr"
    guid: str
    indexerId: int = 0
    movieId: int = 0
    episodeId: int = 0
    # Chosen destination folder; None/absent means the arr's library.
    destination: str | None = None


class CalendarGrabBatchRequest(BaseModel):
    source: str  # "radarr" or "sonarr"
    guids: list[str]
    indexerIds: list[int] = []
    movieId: int = 0
    episodeId: int = 0
    # One destination for the whole batch: the UI groups rows by destination and
    # issues one call per group. None/absent means the arr's library.
    destination: str | None = None
