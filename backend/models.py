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
    title: str = ""  # the item's title — the query over our own sources (S1)


class CalendarGrabRequest(BaseModel):
    source: str  # "radarr" or "sonarr"
    guid: str
    link: str = ""  # the row's built link; the grab target is `link or guid` (S2)
    indexerId: int = 0
    movieId: int = 0
    episodeId: int = 0
    # Chosen destination folder; None/absent means the arr's library.
    destination: str | None = None
    # Radarr's quality name for this release (``Bluray-2160p``). Only read when
    # no destination was chosen: it routes, it does not override a decision.
    quality: str = ""
    # Whether the release is 3D, resolved by the caller — the client owns the
    # title heuristic AND the human correction that overrides it, so it sends
    # one answer rather than both inputs.
    is3d: bool = False


class CalendarGrabBatchRequest(BaseModel):
    source: str  # "radarr" or "sonarr"
    guids: list[str]
    links: list[str] = []  # aligned by index with `guids`; a missing entry falls back to its guid (S2)
    indexerIds: list[int] = []
    movieId: int = 0
    episodeId: int = 0
    # One destination for the whole batch: the UI groups rows by destination and
    # issues one call per group. None/absent means the arr's library.
    destination: str | None = None
    # One quality for the batch, for the same reason: the UI groups rows by
    # destination, and the derived destination is what puts a batch in a group.
    quality: str = ""
    is3d: bool = False
