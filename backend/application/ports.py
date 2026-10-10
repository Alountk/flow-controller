"""The contracts the application layer speaks through.

A port is what a use case needs, expressed so that the need is the only thing it
knows. Everything that actually happens — a filesystem, an HTTP client, a
database — lives behind one of these in `infrastructure`, and the composition
root is the only place that knows which implementation met which port.

Nothing here imports anything. That is the point: a use case that only knows
this module can be tested without a disk, a network or a Radarr.

The ports arrive one at a time, beside the use case that needs them. This one
came first because it was already almost a port — a copy that reports progress
and can be interrupted is a contract in every shape but the type.
"""

from __future__ import annotations

from pathlib import Path
from typing import Awaitable, Callable, Iterable, Protocol, runtime_checkable


class CopyCancelled(Exception):
    """The operator stopped a copy before it finished.

    An outcome, not a fault: nothing is wrong, someone changed their mind. It
    is raised from inside the transfer and caught where the work is coordinated,
    so a cancelled copy cleans its temporary file and leaves no half-written
    destination behind.
    """


@runtime_checkable
class FileStorage(Protocol):
    """Bytes from one place to another, with the operator in control.

    Progress and cancellation are parameters rather than imports on purpose:
    this is the whole reason a copy can run without a task manager attached,
    which is what makes it testable and what keeps `infrastructure` from
    knowing that the app tracks tasks at all.
    """

    def copy_file(
        self,
        src: Path,
        dst: Path,
        *,
        is_cancelled: Callable[[], bool] | None = None,
        on_progress: Callable[[int], None] | None = None,
    ) -> int:
        """Put `src` at `dst` and return the number of bytes written.

        `dst` must not already exist as a directory. On any failure the
        destination is left untouched: a half-copied file is written under a
        temporary name and only renamed into place once it is complete, so an
        interrupted copy cannot be mistaken for a finished one.

        `on_progress` receives the bytes written so far by this call, and is
        called after each chunk — never with the total across several files,
        because a transfer has no idea whether it is one of many.

        Raises `CopyCancelled` when `is_cancelled` turns true mid-stream. The
        temporary file is removed before it propagates.
        """
        ...


# ── The auto-copy sweep ───────────────────────────────────────────────────────
#
# These are named from what the sweep needs, not from the module that happens to
# provide them today. `OwnGrabStore` is one port and not six because the six
# methods are one cohesive record of "what did we ask for, and what became of
# it" — splitting them would leak the shape of a table into a use case that
# only cares that the question has an answer.
#
# The one-shot collaborators are callables rather than protocols on purpose: a
# single function is the honest type for a single question. A Protocol with one
# `__call__` would be ceremony, and it would hide that these arrive as plain
# functions the composition root can bind to anything.


#: Build the traces the sweep judges — one per live download.
TraceLoader = Callable[..., Awaitable[list[dict]]]


#: Does the arr already hold this item? `None` on any doubt — never "no file".
ArrProbe = Callable[..., Awaitable[bool | None]]


#: Root folders the arr manages for a source; ``[]`` whenever unknown.
ArrRoots = Callable[..., Awaitable[list[str]]]


#: Run a named action (`copy_files`, …) and report what happened.
ActionDispatcher = Callable[..., Awaitable[dict]]


@runtime_checkable
class OwnGrabStore(Protocol):
    """What this app asked for, and what became of it.

    Six questions, one record. The sweep reads it to decide whether a download
    is ours, and writes it so a later sweep does not repeat itself.
    """

    def list_own_grabs(self, since: float, *, limit: int = 500) -> list[dict]:
        ...

    def is_auto_copy_handled(self, key: str) -> bool:
        """Whether an earlier sweep already claimed this one."""

    def mark_auto_copy(
        self, key: str, *, source: str, title: str | None, decision: str, reason: str | None = None
    ) -> None:
        """Record an outcome. Claiming happens BEFORE acting, never after."""

    def note_auto_copy_seen(self, key: str, stage: str, *, seen_at: float | None = None) -> float:
        """Return the instant this stage was first observed.

        The trace's only timestamp is the grab instant, which predates the
        download: deriving the grace window from it would start the clock
        before completion and race the arr. So the app keeps its own.
        """

    def latest_auto_copy_decisions(self) -> dict[str, str]:
        """Last logged outcome per key, read once for the whole sweep."""

    def log_auto_copy_decision(
        self, key: str, *, source: str, title: str | None, decision: str, reason: str | None = None
    ) -> None:
        """Append to the "why not" log. History, not state: blocks nothing."""


#: Judge one trace and return its summary line.
TraceHandler = Callable[..., Awaitable[dict]]


# ── The adapters `application.gateways` binds ────────────────────────────────
#
# These four are the slots `app.py` hands to `gateways.bind`. They are typed at
# PRESENCE level — each member is the exact name delivery already calls through
# a gateway delegate, declared `*args/**kwargs` because the delegates pass
# through verbatim and a transcribed signature would be a claim nothing checks
# while mypy is not configured. What the shape buys is the bind-time gate: a
# module bound into the wrong slot is rejected by `isinstance` the moment the
# composition root runs, instead of exploding on the first request that reaches
# for a name the adapter never had.
#
# Data members (a constant such as `encryption_error`) are declared with their
# real type on purpose: a constant must stay a constant all the way to the
# response — see `tests_gateways.py` for what wrapping one in a callable cost.


@runtime_checkable
class ArrClient(Protocol):
    """Everything the arr/qBittorrent/amule adapter answers for delivery.

    One port, not thirty-six: the members are one cohesive family of
    "ask the media services", and splitting them would make `bind` take three
    modules that always arrive together.
    """

    def amu_torrent_categories(self, *args, **kwargs): ...
    def amutorrent_add_download(self, *args, **kwargs): ...
    def amutorrent_reload_shared_dirs(self, *args, **kwargs): ...
    def amutorrent_search_link(self, *args, **kwargs): ...
    def direct_link_identity(self, *args, **kwargs): ...
    def arr_add_movie(self, *args, **kwargs): ...
    def arr_add_series(self, *args, **kwargs): ...
    def arr_cancel_command(self, *args, **kwargs): ...
    def arr_categories_for(self, *args, **kwargs): ...
    def arr_episode_metadata(self, *args, **kwargs): ...
    def arr_fetch_releases(self, *args, **kwargs): ...
    def arr_grab_release(self, *args, **kwargs): ...
    def arr_headers(self, *args, **kwargs): ...
    def arr_indexers(self, *args, **kwargs): ...
    def arr_movie_exists(self, *args, **kwargs): ...
    def arr_movie_lookup(self, *args, **kwargs): ...
    def arr_movie_metadata(self, *args, **kwargs): ...
    def arr_root_folders(self, *args, **kwargs): ...
    def arr_search_episode(self, *args, **kwargs): ...
    def arr_search_missing_episodes(self, *args, **kwargs): ...
    def arr_search_missing_movies(self, *args, **kwargs): ...
    def arr_search_movie(self, *args, **kwargs): ...
    def arr_series_episodes(self, *args, **kwargs): ...
    def arr_series_exists(self, *args, **kwargs): ...
    def arr_series_lookup(self, *args, **kwargs): ...
    def arr_series_metadata(self, *args, **kwargs): ...
    def check_service(self, *args, **kwargs): ...
    def fetch_all_movies_detailed(self, *args, **kwargs): ...
    def fetch_all_series_detailed(self, *args, **kwargs): ...
    def fetch_amu_torrents_by_category(self, *args, **kwargs): ...
    def fetch_arr_grabbed(self, *args, **kwargs): ...
    def fetch_arr_queue(self, *args, **kwargs): ...
    def fetch_radarr_calendar(self, *args, **kwargs): ...
    def fetch_sonarr_calendar(self, *args, **kwargs): ...
    def fetch_wanted_episodes(self, *args, **kwargs): ...
    def fetch_wanted_movies(self, *args, **kwargs): ...
    def test_service_connection(self, *args, **kwargs): ...


@runtime_checkable
class SettingsStore(Protocol):
    """Settings persistence — plus the one constant delivery reads live."""

    def auth_required(self, *args, **kwargs): ...
    def get_settings(self, *args, **kwargs): ...
    def get_setting(self, *args, **kwargs): ...
    def save_settings(self, *args, **kwargs): ...

    #: Live module-level string: set when decryption fails, cleared when it
    #: works. Read per request by `/api/config`, so it is a type, not a call.
    encryption_error: str


@runtime_checkable
class HistoryStore(Protocol):
    """The durable record: operations, downloads, and our own grabs.

    The members are what reaches this adapter THROUGH `gateways` — routes
    reading pages, marks and logs. The sweep's record-keeping travels as
    `OwnGrabStore` above and is injected by the driver, not bound here.
    """

    def record_operation(self, *args, **kwargs): ...
    def recent_operations(self, *args, **kwargs): ...
    def remember_downloads(self, *args, **kwargs): ...
    def prune_downloads(self, *args, **kwargs): ...
    #: The own-grab registry in full — F-07 provenance reads it whole to cross
    #: it with the arr queue/history; the sweep's projection travels as
    #: `OwnGrabStore` above instead.
    def list_own_grabs(self, *args, **kwargs): ...
    def own_grabs_latest_rows(self, *args, **kwargs): ...
    def own_grabs_latest_map(self, *args, **kwargs): ...
    def own_grabs_for(self, *args, **kwargs): ...
    def recent_auto_copy_log(self, *args, **kwargs): ...
    def record_own_grab(self, *args, **kwargs): ...
    def store_available(self, *args, **kwargs): ...
    #: C-02: one row per acknowledged blocked-import incident. The blocked
    #: stage is derived from the arr on every poll, so the only durable half
    #: of "limpiar" is this record — the route filters against it.
    def acknowledge_blocked(self, *args, **kwargs): ...
    def blocked_acks(self, *args, **kwargs): ...


@runtime_checkable
class CredentialsStore(Protocol):
    """The API-key material delivery is allowed to touch."""

    def verify_api_key(self, *args, **kwargs): ...
    def set_app_key(self, *args, **kwargs): ...
    def app_key_is_set(self, *args, **kwargs): ...

    #: The mask Settings shows where the key sits — a constant, not a call.
    MASK_PREFIX: str


# ── The probes behind the thin routes ────────────────────────────────────────


class DiskUsage(Protocol):
    """What `shutil.disk_usage` answers — three numbers, read as attributes."""

    total: int
    used: int
    free: int


@runtime_checkable
class SystemProbe(Protocol):
    """Filesystem facts for the storage report: questions, not decisions.

    Unlike the gateway ports above, this one is consumed directly by a use case
    (`disk_report`), so it carries real signatures — the same reason `FileStorage`
    does. What each member does with the path is the adapter's business; the use
    case only needs the answer.
    """

    def disk_usage(self, path: str) -> DiskUsage:
        """Bytes on the filesystem that CONTAINS `path` — may raise OSError."""

    def exists(self, path: str) -> bool:
        ...

    def ismount(self, path: str) -> bool:
        ...


#: Enumerate a directory tree the way the scanner scores it — `os.walk`'s shape,
#: injected so the walk is an adapter and not a route's syscall. A single
#: function is the honest type here (see the callable ports above).
ScanWalk = Callable[[str], Iterable[tuple[str, list[str], list[str]]]]


def port_members(port: type) -> set[str]:
    """Every member a runtime_checkable port pins: methods and data attributes.

    One source for the bind-time presence check in `application.gateways` and
    for the tests that build stand-ins — a port edited in one place stays
    honest in both.
    """
    return {n for n in vars(port) if not n.startswith("_")} | set(
        getattr(port, "__annotations__", {})
    )
