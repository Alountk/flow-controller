"""The adapters delivery is handed, never the ones it imports.

The composition root — ``app.py`` — calls :func:`bind` before the routes are
imported. Delivery code imports from HERE, and ``tests_architecture.py`` will
not let ``interfaces/`` reach into ``infrastructure/`` to get around it. That is
the hexagonal rule applied to this app: the outermost ring may hold an adapter,
but only because someone put it in its hand.

Every function below is a thin delegate that resolves the real one **on every
call**. That is load-bearing, not stylistic: the suite patches
``infrastructure.arr_client.arr_command`` and friends, and a reference captured
at import would hand the route the unpatched original while the tests went on
passing against a copy. Same failure mode the module aliases used to have.

``credentials`` and ``history`` are bound as whole modules for the few places
that read a constant off one rather than calling a function.
"""

from __future__ import annotations

from types import ModuleType

#: Bound by the composition root. None until `bind` runs — a route reaching one
#: before that is a wiring bug, and says so rather than half-working.
_arr: ModuleType | None = None
_settings: ModuleType | None = None
history: ModuleType | None = None
credentials: ModuleType | None = None  # noqa: E302 - bound by bind()


def __getattr__(name: str):
    """Resolve anything else the adapters hold, live.

    Not everything on an adapter is a function. `settings_store.encryption_error`
    is a module-level STRING, and the generated delegate below turned it into
    one: the route then returned the callable, `jsonable_encoder` rendered it as
    `{}`, and React error #31 — "objects are not valid as a React child" — tore
    the dashboard down behind ErrorBoundary while every request stayed green.

    Anything not explicitly defined above resolves here instead, so a constant
    stays a constant. Raises AttributeError for names that exist nowhere, which
    is what `from ... import x` needs to fail honestly.
    """
    for slot in (_arr, _settings, history, credentials):
        if slot is not None and hasattr(slot, name):
            return getattr(slot, name)
    raise AttributeError(f"module {__name__!r} has no attribute {name!r}")


def bind(*, arr: ModuleType, settings: ModuleType, sqlite_history: ModuleType, credentials_module: ModuleType) -> None:
    """Hand delivery its adapters. Called once, by `app.py`, at startup."""
    global _arr, _settings, history, credentials
    _arr = arr
    _settings = settings
    history = sqlite_history
    credentials = credentials_module


def amu_torrent_categories(*args, **kwargs):
    """Delegate to the bound adapter. Resolved on every call — see the module docstring."""
    return getattr(_arr, "amu_torrent_categories")(*args, **kwargs)


def amutorrent_reload_shared_dirs(*args, **kwargs):
    """Delegate to the bound adapter. Resolved on every call — see the module docstring."""
    return getattr(_arr, "amutorrent_reload_shared_dirs")(*args, **kwargs)


def arr_add_movie(*args, **kwargs):
    """Delegate to the bound adapter. Resolved on every call — see the module docstring."""
    return getattr(_arr, "arr_add_movie")(*args, **kwargs)


def arr_add_series(*args, **kwargs):
    """Delegate to the bound adapter. Resolved on every call — see the module docstring."""
    return getattr(_arr, "arr_add_series")(*args, **kwargs)


def arr_cancel_command(*args, **kwargs):
    """Delegate to the bound adapter. Resolved on every call — see the module docstring."""
    return getattr(_arr, "arr_cancel_command")(*args, **kwargs)


def arr_categories_for(*args, **kwargs):
    """Delegate to the bound adapter. Resolved on every call — see the module docstring."""
    return getattr(_arr, "arr_categories_for")(*args, **kwargs)


def arr_episode_metadata(*args, **kwargs):
    """Delegate to the bound adapter. Resolved on every call — see the module docstring."""
    return getattr(_arr, "arr_episode_metadata")(*args, **kwargs)


def arr_fetch_releases(*args, **kwargs):
    """Delegate to the bound adapter. Resolved on every call — see the module docstring."""
    return getattr(_arr, "arr_fetch_releases")(*args, **kwargs)


def arr_grab_release(*args, **kwargs):
    """Delegate to the bound adapter. Resolved on every call — see the module docstring."""
    return getattr(_arr, "arr_grab_release")(*args, **kwargs)


def arr_headers(*args, **kwargs):
    """Delegate to the bound adapter. Resolved on every call — see the module docstring."""
    return getattr(_arr, "arr_headers")(*args, **kwargs)


def arr_indexers(*args, **kwargs):
    """Delegate to the bound adapter. Resolved on every call — see the module docstring."""
    return getattr(_arr, "arr_indexers")(*args, **kwargs)


def arr_movie_exists(*args, **kwargs):
    """Delegate to the bound adapter. Resolved on every call — see the module docstring."""
    return getattr(_arr, "arr_movie_exists")(*args, **kwargs)


def arr_movie_lookup(*args, **kwargs):
    """Delegate to the bound adapter. Resolved on every call — see the module docstring."""
    return getattr(_arr, "arr_movie_lookup")(*args, **kwargs)


def arr_movie_metadata(*args, **kwargs):
    """Delegate to the bound adapter. Resolved on every call — see the module docstring."""
    return getattr(_arr, "arr_movie_metadata")(*args, **kwargs)


def arr_root_folders(*args, **kwargs):
    """Delegate to the bound adapter. Resolved on every call — see the module docstring."""
    return getattr(_arr, "arr_root_folders")(*args, **kwargs)


def arr_search_episode(*args, **kwargs):
    """Delegate to the bound adapter. Resolved on every call — see the module docstring."""
    return getattr(_arr, "arr_search_episode")(*args, **kwargs)


def arr_search_missing_episodes(*args, **kwargs):
    """Delegate to the bound adapter. Resolved on every call — see the module docstring."""
    return getattr(_arr, "arr_search_missing_episodes")(*args, **kwargs)


def arr_search_missing_movies(*args, **kwargs):
    """Delegate to the bound adapter. Resolved on every call — see the module docstring."""
    return getattr(_arr, "arr_search_missing_movies")(*args, **kwargs)


def arr_search_movie(*args, **kwargs):
    """Delegate to the bound adapter. Resolved on every call — see the module docstring."""
    return getattr(_arr, "arr_search_movie")(*args, **kwargs)


def arr_series_episodes(*args, **kwargs):
    """Delegate to the bound adapter. Resolved on every call — see the module docstring."""
    return getattr(_arr, "arr_series_episodes")(*args, **kwargs)


def arr_series_exists(*args, **kwargs):
    """Delegate to the bound adapter. Resolved on every call — see the module docstring."""
    return getattr(_arr, "arr_series_exists")(*args, **kwargs)


def arr_series_lookup(*args, **kwargs):
    """Delegate to the bound adapter. Resolved on every call — see the module docstring."""
    return getattr(_arr, "arr_series_lookup")(*args, **kwargs)


def arr_series_metadata(*args, **kwargs):
    """Delegate to the bound adapter. Resolved on every call — see the module docstring."""
    return getattr(_arr, "arr_series_metadata")(*args, **kwargs)


def auth_required(*args, **kwargs):
    """Delegate to the bound adapter. Resolved on every call — see the module docstring."""
    return getattr(_settings, "auth_required")(*args, **kwargs)


def check_service(*args, **kwargs):
    """Delegate to the bound adapter. Resolved on every call — see the module docstring."""
    return getattr(_arr, "check_service")(*args, **kwargs)


def fetch_all_movies_detailed(*args, **kwargs):
    """Delegate to the bound adapter. Resolved on every call — see the module docstring."""
    return getattr(_arr, "fetch_all_movies_detailed")(*args, **kwargs)


def fetch_all_series_detailed(*args, **kwargs):
    """Delegate to the bound adapter. Resolved on every call — see the module docstring."""
    return getattr(_arr, "fetch_all_series_detailed")(*args, **kwargs)


def fetch_amu_torrents_by_category(*args, **kwargs):
    """Delegate to the bound adapter. Resolved on every call — see the module docstring."""
    return getattr(_arr, "fetch_amu_torrents_by_category")(*args, **kwargs)


def fetch_arr_queue(*args, **kwargs):
    """Delegate to the bound adapter. Resolved on every call — see the module docstring."""
    return getattr(_arr, "fetch_arr_queue")(*args, **kwargs)


def fetch_radarr_calendar(*args, **kwargs):
    """Delegate to the bound adapter. Resolved on every call — see the module docstring."""
    return getattr(_arr, "fetch_radarr_calendar")(*args, **kwargs)


def fetch_sonarr_calendar(*args, **kwargs):
    """Delegate to the bound adapter. Resolved on every call — see the module docstring."""
    return getattr(_arr, "fetch_sonarr_calendar")(*args, **kwargs)


def fetch_wanted_episodes(*args, **kwargs):
    """Delegate to the bound adapter. Resolved on every call — see the module docstring."""
    return getattr(_arr, "fetch_wanted_episodes")(*args, **kwargs)


def fetch_wanted_movies(*args, **kwargs):
    """Delegate to the bound adapter. Resolved on every call — see the module docstring."""
    return getattr(_arr, "fetch_wanted_movies")(*args, **kwargs)


def get_setting(*args, **kwargs):
    """Delegate to the bound adapter. Resolved on every call — see the module docstring."""
    return getattr(_settings, "get_setting")(*args, **kwargs)


def get_settings(*args, **kwargs):
    """Delegate to the bound adapter. Resolved on every call — see the module docstring."""
    return getattr(_settings, "get_settings")(*args, **kwargs)


def recent_auto_copy_log(*args, **kwargs):
    """Delegate to the bound adapter. Resolved on every call — see the module docstring."""
    return getattr(history, "recent_auto_copy_log")(*args, **kwargs)


def record_own_grab(*args, **kwargs):
    """Delegate to the bound adapter. Resolved on every call — see the module docstring."""
    return getattr(history, "record_own_grab")(*args, **kwargs)


def save_settings(*args, **kwargs):
    """Delegate to the bound adapter. Resolved on every call — see the module docstring."""
    return getattr(_settings, "save_settings")(*args, **kwargs)


def store_available(*args, **kwargs):
    """Delegate to the bound adapter. Resolved on every call — see the module docstring."""
    return getattr(history, "store_available")(*args, **kwargs)


def test_service_connection(*args, **kwargs):
    """Delegate to the bound adapter. Resolved on every call — see the module docstring."""
    return getattr(_arr, "test_service_connection")(*args, **kwargs)


