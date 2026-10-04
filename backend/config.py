import os

from dotenv import load_dotenv
from settings import load_settings, get_setting, migrate_env_vars
from domain import quality as _quality_rules

load_dotenv()
migrate_env_vars()
load_settings()

# The app key is stored hashed, never in the clear. Whether one is configured
# is read live from settings (see settings.auth_required), so setting it takes
# effect without a restart.

BASE_DIR = os.path.dirname(os.path.abspath(__file__))
FRONTEND_DIST = os.path.normpath(os.path.join(BASE_DIR, "..", "frontend", "dist"))

EXPECTED_CATEGORY = {"radarr": "radarr", "sonarr": "tv-sonarr"}

#: Containers shared with whoever did `from config import SERVICES`: they bind
#: the *object*, not its contents, so `rebuild()` refills them **in place** and
#: every holder sees the new data with no call-site change. Scalars cannot work
#: that way — see `rebuild()` and the readers that ask for `config.X` at call
#: time instead of binding it.
SERVICES: list[dict] = []
#: Filesystem roots the app is allowed to write to, read from the configured
#: `paths.allowed_roots` (settings.py owns the default). This is the ONE
#: authority for the list: routes validate against it instead of each carrying
#: its own hardcoded copy, and the release-destination combo sources its
#: non-arr options from the same value.
ALLOWED_ROOTS: list[str] = []
#: Folder a 4K release is routed to when nobody picked one by hand. Empty means
#: "not configured", which must read as today's behaviour (the arr's library),
#: never as a request to write to "".
PATH_4K: str = ""
#: Same deal as `PATH_4K`: empty means "not configured", which reads as
#: "do not route 3D anywhere in particular".
PATH_3D: str = ""
_DOWNLOAD_CLIENT_PATHS: dict[str, str] = {}

ACTIONS: dict[str, dict] = {
    "fix_category": {
        "label": "Corregir categoría",
        "description": "Pone la categoría correcta en aMuTorrent y reintenta el import.",
        "destructive": False,
        "scope": "amutorrent+arr",
    },
    "retry_import": {
        "label": "Reintentar import",
        "description": "Fuerza a Radarr/Sonarr a reprocesar la descarga y traspasar el archivo.",
        "destructive": False,
        "scope": "arr",
    },
    "research": {
        "label": "Re-buscar",
        "description": "Lanza una búsqueda del episodio/película en Radarr/Sonarr.",
        "destructive": False,
        "scope": "arr",
    },
    "pause": {
        "label": "Pausar",
        "description": "Pausa la descarga en aMuTorrent.",
        "destructive": False,
        "scope": "amutorrent",
    },
    "resume": {
        "label": "Reanudar",
        "description": "Reanuda la descarga en aMuTorrent.",
        "destructive": False,
        "scope": "amutorrent",
    },
    "remove_queue": {
        "label": "Quitar de la cola",
        "description": "Elimina el item de la cola de Radarr/Sonarr (opcionalmente a la blocklist).",
        "destructive": True,
        "scope": "arr",
    },
    "delete_torrent": {
        "label": "Eliminar descarga",
        "description": "Elimina la descarga de aMuTorrent (opcionalmente con sus archivos).",
        "destructive": True,
        "scope": "amutorrent",
    },
    "fix_path_mapping": {
        "label": "Mapear ruta",
        "description": "Crea un remote path mapping en Radarr/Sonarr para que el *arr pueda ver los archivos del cliente de descargas y reintenta el import.",
        "destructive": False,
        "scope": "arr",
    },
    "copy_files": {
        "label": "Copiar archivos",
        "description": "Copia los archivos completados del cliente de descargas al directorio correcto del *arr y reintenta el import.",
        "destructive": False,
        "scope": "arr",
    },
}

PAUSED_STATES = {"pausedDL", "pausedUP", "stoppedDL", "stoppedUP"}

QBIT_DOWNLOADING = {
    "downloading", "forcedDL", "metaDL", "allocating",
    "checkingDL", "stalledDL", "queuedDL",
}
QBIT_COMPLETED = {
    "uploading", "pausedUP", "stalledUP", "forcedUP",
    "queuedUP", "stoppedUP", "checkingUP",
}

def service_is_configured(url: str, api_key: str) -> bool:
    """A service is usable only when it has both a URL and its API key.

    Without this, an unconfigured service is indistinguishable from a broken
    one: the app calls it, gets an auth error and shows a failure the user
    cannot act on, for a service they never set up.
    """
    return bool(url) and bool(api_key)


def path_is_allowed(path: str) -> bool:
    """Whether ``path`` is a non-empty absolute path inside an allowed root.

    The roots come from the configured ``paths.allowed_roots`` (see
    ``ALLOWED_ROOTS``), so there is a single authority instead of a hardcoded
    copy per route. Both the path and the roots are resolved before comparing
    (symlinks, ``..``), and a match must land on a path-separator boundary —
    otherwise ``/mnt/storage-6tb-evil`` would pass as ``/mnt/storage-6tb``.

    A relative or empty path is rejected: a destination is only ever a concrete
    absolute folder, and ``""`` must read as invalid rather than as the default.
    """
    if not path or not os.path.isabs(path):
        return False
    resolved = os.path.realpath(path)
    for root in ALLOWED_ROOTS:
        resolved_root = os.path.realpath(root)
        if resolved == resolved_root or resolved.startswith(resolved_root + os.sep):
            return True
    return False


def destination_for_quality(quality: str, *, is3d: bool = False) -> str | None:
    """Folder a release should land in; None means the arr's library.

    The rule is pure and lives in ``domain.quality``, with the reasoning (3D
    outranks the resolution, the match is on the quality's suffix, an
    unconfigured folder means the arr's library and the caller's explicit
    destination still wins). This wrapper only supplies the configured folders
    and reads them at call time, so a test can reconfigure them without the
    rule knowing anything about a deployment.
    """
    return _quality_rules.destination_for_quality(
        quality, is3d=is3d, path_4k=PATH_4K, path_3d=PATH_3D
    )


def rebuild() -> None:
    """Re-read every settings-backed value. Called at import and after a save.

    Two mechanisms, because the two kinds of value behave differently:

    - **Containers** (`SERVICES`, `ALLOWED_ROOTS`, `_DOWNLOAD_CLIENT_PATHS`)
      are refilled **in place**. A module that did `from config import
      SERVICES` holds the same list, so it sees the new contents with no
      call-site change.
    - **Scalars** (`SAFE_MODE`, `TRACE_LIMIT`, the intervals, the folders) are
      immutable: `from config import SAFE_MODE` binds the value itself and no
      rebinding here reaches it. Every reader of a value the UI promises is
      restart-free therefore asks for `config.X` *at call time*; this refreshes
      only our own name.

    Without this, saving a service URL changed `settings.json` and nothing
    else: `find_service` kept returning the old one until the container
    restarted, right after the UI said it had been saved.
    """
    global RADARR_URL, SONARR_URL, AMUTORRENT_URL
    global RADARR_API_KEY, SONARR_API_KEY, AMUTORRENT_API_KEY
    global AMUTORRENT_USER, AMUTORRENT_PASSWORD
    global CHECK_INTERVAL, MAX_RETRIES, RETRY_DELAY, REQUEST_TIMEOUT
    global IMPORT_POLL_TIMEOUT, TRACE_LIMIT
    global SAFE_MODE, DEVELOPER
    global FOLDER_DOWNLOAD_AMULE, FOLDER_DOWNLOAD_TORRENT
    global RETENTION_AMULE_DAYS
    global PATH_4K
    global PATH_3D

    RADARR_URL = get_setting("services", "radarr", "url", default="http://localhost:7878")
    SONARR_URL = get_setting("services", "sonarr", "url", default="http://localhost:7878")
    AMUTORRENT_URL = get_setting("services", "amutorrent", "url", default="http://localhost:4000")

    RADARR_API_KEY = get_setting("services", "radarr", "api_key", default="")
    SONARR_API_KEY = get_setting("services", "sonarr", "api_key", default="")
    AMUTORRENT_API_KEY = get_setting("services", "amutorrent", "api_key", default="")

    AMUTORRENT_USER = get_setting("services", "amutorrent", "user", default="admin")
    AMUTORRENT_PASSWORD = get_setting("services", "amutorrent", "password", default="")

    CHECK_INTERVAL = int(get_setting("intervals", "check", default=15))
    MAX_RETRIES = int(get_setting("intervals", "max_retries", default=3))
    RETRY_DELAY = float(get_setting("intervals", "retry_delay", default=2))
    REQUEST_TIMEOUT = float(get_setting("intervals", "request_timeout", default=5))
    IMPORT_POLL_TIMEOUT = int(get_setting("intervals", "import_timeout", default=40))

    TRACE_LIMIT = int(get_setting("tracing", "limit", default=25))
    RETENTION_AMULE_DAYS = int(get_setting("retention", "amule_days", default=7))

    SAFE_MODE = get_setting("security", "safe_mode", default=True)
    DEVELOPER = get_setting("developer", default=False)

    FOLDER_DOWNLOAD_AMULE = get_setting(
        "paths", "download_amule", default="/mnt/storage-6tb/shared-downloads/amule"
    )
    FOLDER_DOWNLOAD_TORRENT = get_setting(
        "paths", "download_torrent", default="/mnt/storage/downloads/qbittorrent/completed"
    )

    # In place on purpose: rebinding the NAME would never reach a module that
    # did `from config import ALLOWED_ROOTS`.
    ALLOWED_ROOTS[:] = get_setting("paths", "allowed_roots", default=[])
    PATH_4K = str(get_setting("paths", "path_4k", default="") or "").strip()
    PATH_3D = str(get_setting("paths", "path_3d", default="") or "").strip()
    # The routing folders have to be reachable, not merely named. `copy_engine`
    # validates `dest_root` against `path_is_allowed`, so a folder missing from
    # the allowlist would be grabbed, downloaded and then REFUSED at copy time —
    # the worst possible moment to find out. Naming it here is the operator
    # saying "this is where those files go", which is the same authority
    # `allowed_roots` records, one entry earlier.
    for routed in (PATH_4K, PATH_3D):
        if routed and routed not in ALLOWED_ROOTS:
            ALLOWED_ROOTS.append(routed)
    _DOWNLOAD_CLIENT_PATHS.clear()
    _DOWNLOAD_CLIENT_PATHS.update({
        "amule": FOLDER_DOWNLOAD_AMULE,
        "amutorrent": FOLDER_DOWNLOAD_AMULE,
        "qbittorrent": FOLDER_DOWNLOAD_TORRENT,
        "qbit": FOLDER_DOWNLOAD_TORRENT,
    })

    # Also in place: every route and driver holds this exact list.
    SERVICES[:] = [
        {
            "key": "radarr",
            "kind": "arr",
            "url": RADARR_URL,
            "api_key": RADARR_API_KEY,
            "configured": service_is_configured(RADARR_URL, RADARR_API_KEY),
        },
        {
            "key": "sonarr",
            "kind": "arr",
            "url": SONARR_URL,
            "api_key": SONARR_API_KEY,
            "configured": service_is_configured(SONARR_URL, SONARR_API_KEY),
        },
        {
            "key": "amutorrent",
            "kind": "qbit",
            "url": AMUTORRENT_URL,
            "api_key": AMUTORRENT_API_KEY,
            "configured": service_is_configured(AMUTORRENT_URL, AMUTORRENT_API_KEY),
        },
    ]


rebuild()

#: Derived from the URL, so only once `rebuild()` has run.
AMUTORRENT_INDEXER = os.getenv(
    "AMUTORRENT_INDEXER", f"{AMUTORRENT_URL}/indexer/amule/api"
)


def all_services() -> list[dict]:
    """Every service, configured or not.

    Read through a function so a caller always sees the current list rather
    than a copy captured at import time.
    """
    return SERVICES


def configured_services(kind: str | None = None) -> list[dict]:
    """Only the services that can actually be called."""
    return [
        s for s in SERVICES
        if s.get("configured") and (kind is None or s["kind"] == kind)
    ]


def find_service(key: str, kind: str | None = None) -> dict | None:
    """A service by key, but only when it is usable.

    Returns None for an unconfigured service on purpose: calling it would only
    produce an auth error for something the user never set up.
    """
    return next(
        (
            s for s in SERVICES
            if s["key"] == key and s.get("configured")
            and (kind is None or s["kind"] == kind)
        ),
        None,
    )


def service_unavailable_reason(key: str, kind: str | None = None) -> str:
    """Why a service cannot be used, phrased for the API response."""
    known = any(
        s["key"] == key and (kind is None or s["kind"] == kind) for s in SERVICES
    )
    if not known:
        return f"servicio desconocido: {key}"
    return f"{key} no está configurado (faltan la URL o la API key)"

_AMU_WS_COMPLETE = {
    "batchPause": "batch-pause-complete",
    "batchResume": "batch-resume-complete",
    "batchStop": "batch-stop-complete",
    "batchDelete": "batch-delete-complete",
    "batchSetFileCategory": "batch-category-changed",
}

_VOLUME_MAP = [
    ("/downloads/incoming/", "/mnt/storage-6tb/shared-downloads/amule/"),
    ("/downloads/", "/mnt/storage-6tb/shared-downloads/"),
    ("/data/", "/mnt/storage/"),
    ("/data-6tb/", "/mnt/storage-6tb/"),
]

IMPORT_POLL_INTERVAL = 5

_TASK_TTL = 600
