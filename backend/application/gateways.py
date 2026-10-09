"""The adapters delivery is handed, never the ones it imports.

The composition root — ``app.py`` — calls :func:`bind` before the routes are
imported. Delivery code imports from HERE, and ``tests_architecture.py`` will
not let ``interfaces/`` reach into ``infrastructure/`` to get around it. That is
the hexagonal rule applied to this app: the outermost ring may hold an adapter,
but only because someone put it in its hand.

The slots are declared, typed attributes — one per port in
``application.ports`` — and ``bind`` validates each adapter against its port
before storing it. A binding that misses a member therefore fails while
``app.py`` is still importing, with the slot and the missing names in the
message, instead of on the first request that reaches for them. Names resolve
statically to a declared delegate or not at all: there is no dynamic module
hook left to defer a mistake until runtime.

Every function below is a thin delegate, and it resolves the member **on every
call**. That is load-bearing, not stylistic: the suite patches
``infrastructure.arr_client.arr_command`` and friends, and a reference captured
at import would hand the route the unpatched original while the tests went on
passing against a copy. Same failure mode the module aliases used to have.

``settings``, ``history`` and ``credentials`` are also bound as whole modules
for the few places that read a constant off one rather than calling a function
(`settings_store.encryption_error` is the reason: a constant wrapped into a
callable is how React error #31 tore the dashboard down — see
``tests_gateways.py``). ``_arr`` stays private because nothing but the
delegates below ever touches it.
"""

from __future__ import annotations

from application.ports import (
    ArrClient,
    CredentialsStore,
    HistoryStore,
    ScanWalk,
    SettingsStore,
    SystemProbe,
    port_members,
)

#: Bound by the composition root. None until `bind` runs — a route reaching one
#: before that is a wiring bug, and says so rather than half-working.
_arr: ArrClient | None = None
settings: SettingsStore | None = None
history: HistoryStore | None = None
credentials: CredentialsStore | None = None
system: SystemProbe | None = None
scan: ScanWalk | None = None


def _require(adapter: object, port: type, slot: str) -> None:
    """Reject a binding that does not satisfy its port — here, at composition."""
    if isinstance(adapter, port):
        return
    missing = sorted(name for name in port_members(port) if not hasattr(adapter, name))
    raise TypeError(
        f"gateways.bind({slot}=...) does not satisfy {port.__name__}; "
        f"missing: {', '.join(missing)}"
    )


def bind(
    *,
    arr: ArrClient,
    settings: SettingsStore,
    sqlite_history: HistoryStore,
    credentials_module: CredentialsStore,
    system: SystemProbe,
    scan: ScanWalk,
) -> None:
    """Hand delivery its adapters. Called once, by `app.py`, at startup.

    Each argument is checked against its port before anything is stored, so a
    module bound into the wrong slot fails here — during import — rather than
    on the first request. The `globals().update` exists because the `settings`
    parameter shadows the module attribute it is about to set; `scan` is
    validated as a plain callable because a one-function port is a callable.
    """
    _require(arr, ArrClient, "arr")
    _require(settings, SettingsStore, "settings")
    _require(sqlite_history, HistoryStore, "sqlite_history")
    _require(credentials_module, CredentialsStore, "credentials_module")
    _require(system, SystemProbe, "system")
    if not callable(scan):
        raise TypeError(f"gateways.bind(scan=...) must be callable, got {type(scan).__name__}")
    globals().update(
        _arr=arr,
        settings=settings,
        history=sqlite_history,
        credentials=credentials_module,
        system=system,
        scan=scan,
    )


def amu_torrent_categories(*args, **kwargs):
    """Delegate to the bound adapter. Resolved on every call — see the module docstring."""
    return _arr.amu_torrent_categories(*args, **kwargs)


def amutorrent_add_download(*args, **kwargs):
    """Delegate to the bound adapter. Resolved on every call — see the module docstring."""
    return _arr.amutorrent_add_download(*args, **kwargs)


def amutorrent_reload_shared_dirs(*args, **kwargs):
    """Delegate to the bound adapter. Resolved on every call — see the module docstring."""
    return _arr.amutorrent_reload_shared_dirs(*args, **kwargs)


def amutorrent_search_link(*args, **kwargs):
    """Delegate to the bound adapter. Resolved on every call — see the module docstring."""
    return _arr.amutorrent_search_link(*args, **kwargs)


def direct_link_identity(*args, **kwargs):
    """Delegate to the bound adapter. Resolved on every call — see the module docstring."""
    return _arr.direct_link_identity(*args, **kwargs)


def arr_add_movie(*args, **kwargs):
    """Delegate to the bound adapter. Resolved on every call — see the module docstring."""
    return _arr.arr_add_movie(*args, **kwargs)


def arr_add_series(*args, **kwargs):
    """Delegate to the bound adapter. Resolved on every call — see the module docstring."""
    return _arr.arr_add_series(*args, **kwargs)


def arr_cancel_command(*args, **kwargs):
    """Delegate to the bound adapter. Resolved on every call — see the module docstring."""
    return _arr.arr_cancel_command(*args, **kwargs)


def arr_categories_for(*args, **kwargs):
    """Delegate to the bound adapter. Resolved on every call — see the module docstring."""
    return _arr.arr_categories_for(*args, **kwargs)


def arr_episode_metadata(*args, **kwargs):
    """Delegate to the bound adapter. Resolved on every call — see the module docstring."""
    return _arr.arr_episode_metadata(*args, **kwargs)


def arr_fetch_releases(*args, **kwargs):
    """Delegate to the bound adapter. Resolved on every call — see the module docstring."""
    return _arr.arr_fetch_releases(*args, **kwargs)


def arr_grab_release(*args, **kwargs):
    """Delegate to the bound adapter. Resolved on every call — see the module docstring."""
    return _arr.arr_grab_release(*args, **kwargs)


def arr_headers(*args, **kwargs):
    """Delegate to the bound adapter. Resolved on every call — see the module docstring."""
    return _arr.arr_headers(*args, **kwargs)


def arr_indexers(*args, **kwargs):
    """Delegate to the bound adapter. Resolved on every call — see the module docstring."""
    return _arr.arr_indexers(*args, **kwargs)


def arr_movie_exists(*args, **kwargs):
    """Delegate to the bound adapter. Resolved on every call — see the module docstring."""
    return _arr.arr_movie_exists(*args, **kwargs)


def arr_movie_lookup(*args, **kwargs):
    """Delegate to the bound adapter. Resolved on every call — see the module docstring."""
    return _arr.arr_movie_lookup(*args, **kwargs)


def arr_movie_metadata(*args, **kwargs):
    """Delegate to the bound adapter. Resolved on every call — see the module docstring."""
    return _arr.arr_movie_metadata(*args, **kwargs)


def arr_root_folders(*args, **kwargs):
    """Delegate to the bound adapter. Resolved on every call — see the module docstring."""
    return _arr.arr_root_folders(*args, **kwargs)


def arr_search_episode(*args, **kwargs):
    """Delegate to the bound adapter. Resolved on every call — see the module docstring."""
    return _arr.arr_search_episode(*args, **kwargs)


def arr_search_missing_episodes(*args, **kwargs):
    """Delegate to the bound adapter. Resolved on every call — see the module docstring."""
    return _arr.arr_search_missing_episodes(*args, **kwargs)


def arr_search_missing_movies(*args, **kwargs):
    """Delegate to the bound adapter. Resolved on every call — see the module docstring."""
    return _arr.arr_search_missing_movies(*args, **kwargs)


def arr_search_movie(*args, **kwargs):
    """Delegate to the bound adapter. Resolved on every call — see the module docstring."""
    return _arr.arr_search_movie(*args, **kwargs)


def arr_series_episodes(*args, **kwargs):
    """Delegate to the bound adapter. Resolved on every call — see the module docstring."""
    return _arr.arr_series_episodes(*args, **kwargs)


def arr_series_exists(*args, **kwargs):
    """Delegate to the bound adapter. Resolved on every call — see the module docstring."""
    return _arr.arr_series_exists(*args, **kwargs)


def arr_series_lookup(*args, **kwargs):
    """Delegate to the bound adapter. Resolved on every call — see the module docstring."""
    return _arr.arr_series_lookup(*args, **kwargs)


def arr_series_metadata(*args, **kwargs):
    """Delegate to the bound adapter. Resolved on every call — see the module docstring."""
    return _arr.arr_series_metadata(*args, **kwargs)


def auth_required(*args, **kwargs):
    """Delegate to the bound adapter. Resolved on every call — see the module docstring."""
    return settings.auth_required(*args, **kwargs)


def check_service(*args, **kwargs):
    """Delegate to the bound adapter. Resolved on every call — see the module docstring."""
    return _arr.check_service(*args, **kwargs)


def fetch_all_movies_detailed(*args, **kwargs):
    """Delegate to the bound adapter. Resolved on every call — see the module docstring."""
    return _arr.fetch_all_movies_detailed(*args, **kwargs)


def fetch_all_series_detailed(*args, **kwargs):
    """Delegate to the bound adapter. Resolved on every call — see the module docstring."""
    return _arr.fetch_all_series_detailed(*args, **kwargs)


def fetch_amu_torrents_by_category(*args, **kwargs):
    """Delegate to the bound adapter. Resolved on every call — see the module docstring."""
    return _arr.fetch_amu_torrents_by_category(*args, **kwargs)


def fetch_arr_grabbed(*args, **kwargs):
    """Delegate to the bound adapter. Resolved on every call — see the module docstring."""
    return _arr.fetch_arr_grabbed(*args, **kwargs)


def fetch_arr_queue(*args, **kwargs):
    """Delegate to the bound adapter. Resolved on every call — see the module docstring."""
    return _arr.fetch_arr_queue(*args, **kwargs)


def fetch_radarr_calendar(*args, **kwargs):
    """Delegate to the bound adapter. Resolved on every call — see the module docstring."""
    return _arr.fetch_radarr_calendar(*args, **kwargs)


def fetch_sonarr_calendar(*args, **kwargs):
    """Delegate to the bound adapter. Resolved on every call — see the module docstring."""
    return _arr.fetch_sonarr_calendar(*args, **kwargs)


def fetch_wanted_episodes(*args, **kwargs):
    """Delegate to the bound adapter. Resolved on every call — see the module docstring."""
    return _arr.fetch_wanted_episodes(*args, **kwargs)


def fetch_wanted_movies(*args, **kwargs):
    """Delegate to the bound adapter. Resolved on every call — see the module docstring."""
    return _arr.fetch_wanted_movies(*args, **kwargs)


def get_setting(*args, **kwargs):
    """Delegate to the bound adapter. Resolved on every call — see the module docstring."""
    return settings.get_setting(*args, **kwargs)


def get_settings(*args, **kwargs):
    """Delegate to the bound adapter. Resolved on every call — see the module docstring."""
    return settings.get_settings(*args, **kwargs)


def list_own_grabs(*args, **kwargs):
    """Delegate to the bound adapter. Resolved on every call — see the module docstring."""
    return history.list_own_grabs(*args, **kwargs)


def recent_auto_copy_log(*args, **kwargs):
    """Delegate to the bound adapter. Resolved on every call — see the module docstring."""
    return history.recent_auto_copy_log(*args, **kwargs)


def record_own_grab(*args, **kwargs):
    """Delegate to the bound adapter. Resolved on every call — see the module docstring."""
    return history.record_own_grab(*args, **kwargs)


def save_settings(*args, **kwargs):
    """Delegate to the bound adapter. Resolved on every call — see the module docstring."""
    return settings.save_settings(*args, **kwargs)


def store_available(*args, **kwargs):
    """Delegate to the bound adapter. Resolved on every call — see the module docstring."""
    return history.store_available(*args, **kwargs)


def test_service_connection(*args, **kwargs):
    """Delegate to the bound adapter. Resolved on every call — see the module docstring."""
    return _arr.test_service_connection(*args, **kwargs)
