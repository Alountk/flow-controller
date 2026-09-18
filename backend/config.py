import os

from dotenv import load_dotenv
from settings import load_settings, get_setting, migrate_env_vars

load_dotenv()
migrate_env_vars()
load_settings()

RADARR_URL = get_setting("services", "radarr", "url", default="http://localhost:7878")
SONARR_URL = get_setting("services", "sonarr", "url", default="http://localhost:8989")
AMUTORRENT_URL = get_setting("services", "amutorrent", "url", default="http://localhost:4000")

RADARR_API_KEY = get_setting("services", "radarr", "api_key", default="")
SONARR_API_KEY = get_setting("services", "sonarr", "api_key", default="")
AMUTORRENT_API_KEY = get_setting("services", "amutorrent", "api_key", default="")

AMUTORRENT_USER = get_setting("services", "amutorrent", "user", default="admin")
AMUTORRENT_PASSWORD = get_setting("services", "amutorrent", "password", default="")

API_KEY = get_setting("security", "api_key", default="")

BASE_DIR = os.path.dirname(os.path.abspath(__file__))
FRONTEND_DIST = os.path.normpath(os.path.join(BASE_DIR, "..", "frontend", "dist"))

CHECK_INTERVAL = int(get_setting("intervals", "check", default=15))
MAX_RETRIES = int(get_setting("intervals", "max_retries", default=3))
RETRY_DELAY = float(get_setting("intervals", "retry_delay", default=2))
REQUEST_TIMEOUT = float(get_setting("intervals", "request_timeout", default=5))

TRACE_LIMIT = int(get_setting("tracing", "limit", default=25))

EXPECTED_CATEGORY = {"radarr": "radarr", "sonarr": "tv-sonarr"}

AMUTORRENT_INDEXER = os.getenv(
    "AMUTORRENT_INDEXER", f"{AMUTORRENT_URL}/indexer/amule/api"
)

SAFE_MODE = get_setting("security", "safe_mode", default=True)
DEVELOPER = get_setting("developer", default=False)

FOLDER_DOWNLOAD_AMULE = get_setting("paths", "download_amule", default="/mnt/storage-6tb/shared-downloads/amule")
FOLDER_DOWNLOAD_TORRENT = get_setting("paths", "download_torrent", default="/mnt/storage/downloads/qbittorrent/completed")

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

SERVICES = [
    {"key": "radarr", "kind": "arr", "url": RADARR_URL, "api_key": RADARR_API_KEY},
    {"key": "sonarr", "kind": "arr", "url": SONARR_URL, "api_key": SONARR_API_KEY},
    {"key": "amutorrent", "kind": "qbit", "url": AMUTORRENT_URL, "api_key": AMUTORRENT_API_KEY},
]

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

_DOWNLOAD_CLIENT_PATHS: dict[str, str] = {
    "amule": FOLDER_DOWNLOAD_AMULE,
    "amutorrent": FOLDER_DOWNLOAD_AMULE,
    "qbittorrent": FOLDER_DOWNLOAD_TORRENT,
    "qbit": FOLDER_DOWNLOAD_TORRENT,
}

IMPORT_POLL_INTERVAL = 5
IMPORT_POLL_TIMEOUT = int(get_setting("intervals", "import_timeout", default=40))

_TASK_TTL = 600
