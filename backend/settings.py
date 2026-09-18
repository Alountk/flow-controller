import json
import os
import stat
import logging
from pathlib import Path
from typing import Any

log = logging.getLogger("settings")

CONFIG_DIR = os.getenv("CONFIG_DIR", os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "config"))
SETTINGS_FILE = os.path.join(CONFIG_DIR, "settings.json")

DEFAULTS: dict[str, Any] = {
    "services": {
        "radarr": {"url": "http://localhost:7878", "api_key": ""},
        "sonarr": {"url": "http://localhost:8989", "api_key": ""},
        "amutorrent": {"url": "http://localhost:4000", "api_key": "", "user": "admin", "password": ""},
    },
    "security": {"api_key": "", "safe_mode": True},
    "developer": False,
    "paths": {
        "download_amule": "/mnt/storage-6tb/shared-downloads/amule",
        "download_torrent": "/mnt/storage/downloads/qbittorrent/completed",
        "allowed_roots": ["/mnt/storage", "/mnt/storage-6tb"],
    },
    "intervals": {
        "check": 15,
        "max_retries": 3,
        "retry_delay": 2,
        "request_timeout": 5,
        "import_timeout": 40,
    },
    "tracing": {"limit": 25},
    "server": {"port": 8000},
}

_env_to_settings: dict[str, tuple[str, ...]] = {
    "RADARR_URL": ("services", "radarr", "url"),
    "RADARR_API_KEY": ("services", "radarr", "api_key"),
    "SONARR_URL": ("services", "sonarr", "url"),
    "SONARR_API_KEY": ("services", "sonarr", "api_key"),
    "AMUTORRENT_URL": ("services", "amutorrent", "url"),
    "AMUTORRENT_API_KEY": ("services", "amutorrent", "api_key"),
    "AMUTORRENT_USER": ("services", "amutorrent", "user"),
    "AMUTORRENT_PASSWORD": ("services", "amutorrent", "password"),
    "API_KEY": ("security", "api_key"),
    "SAFE_MODE": ("security", "safe_mode"),
    "DEVELOPER": ("developer",),
    "FOLDER_DOWNLOAD_AMULE": ("paths", "download_amule"),
    "FOLDER_DOWNLOAD_TORRENT": ("paths", "download_torrent"),
    "CHECK_INTERVAL": ("intervals", "check"),
    "MAX_RETRIES": ("intervals", "max_retries"),
    "RETRY_DELAY": ("intervals", "retry_delay"),
    "REQUEST_TIMEOUT": ("intervals", "request_timeout"),
    "IMPORT_TIMEOUT": ("intervals", "import_timeout"),
    "TRACE_LIMIT": ("tracing", "limit"),
    "PORT": ("server", "port"),
}

_settings: dict[str, Any] = {}


def _deep_merge(base: dict, override: dict) -> dict:
    result = base.copy()
    for key, value in override.items():
        if key in result and isinstance(result[key], dict) and isinstance(value, dict):
            result[key] = _deep_merge(result[key], value)
        else:
            result[key] = value
    return result


def _set_nested(d: dict, keys: tuple[str, ...], value: Any) -> None:
    for key in keys[:-1]:
        d = d.setdefault(key, {})
    typed_value: Any = value
    if isinstance(DEFAULTS.get(keys[0], {}), dict):
        default_val = DEFAULTS
        for k in keys:
            if isinstance(default_val, dict) and k in default_val:
                default_val = default_val[k]
            else:
                default_val = None
                break
        if default_val is not None and not isinstance(value, type(default_val)):
            if isinstance(default_val, bool):
                typed_value = str(value).lower() in ("1", "true", "yes")
            elif isinstance(default_val, int):
                typed_value = int(value)
            elif isinstance(default_val, float):
                typed_value = float(value)
    d[keys[-1]] = typed_value


def _apply_env_overrides(data: dict) -> dict:
    result = _deep_merge(DEFAULTS, data)
    for env_key, path in _env_to_settings.items():
        env_val = os.getenv(env_key)
        if env_val is not None and env_val != "":
            _set_nested(result, path, env_val)
    return result


def load_settings() -> dict[str, Any]:
    global _settings
    file_data: dict[str, Any] = {}
    if os.path.isfile(SETTINGS_FILE):
        try:
            with open(SETTINGS_FILE, "r", encoding="utf-8") as f:
                file_data = json.load(f)
            log.info("Loaded settings from %s", SETTINGS_FILE)
        except Exception as exc:
            log.error("Failed to load settings from %s: %s", SETTINGS_FILE, exc)
    _settings = _apply_env_overrides(file_data)
    return _settings


def save_settings(data: dict[str, Any]) -> None:
    global _settings
    _settings = _deep_merge(DEFAULTS, data)
    os.makedirs(CONFIG_DIR, exist_ok=True)
    tmp = SETTINGS_FILE + ".tmp"
    with open(tmp, "w", encoding="utf-8") as f:
        json.dump(_settings, f, indent=2, ensure_ascii=False)
    os.replace(tmp, SETTINGS_FILE)
    try:
        os.chmod(SETTINGS_FILE, stat.S_IRUSR | stat.S_IWUSR)
    except OSError:
        pass
    log.info("Settings saved to %s", SETTINGS_FILE)


def get_settings() -> dict[str, Any]:
    if not _settings:
        load_settings()
    return _settings


def get_setting(*keys: str, default: Any = None) -> Any:
    val = _settings
    for key in keys:
        if isinstance(val, dict):
            val = val.get(key)
        else:
            return default
    return val if val is not None else default


def migrate_env_vars() -> bool:
    if os.path.isfile(SETTINGS_FILE):
        return False
    env_data: dict[str, Any] = {}
    for env_key, path in _env_to_settings.items():
        env_val = os.getenv(env_key)
        if env_val is not None and env_val != "":
            _set_nested(env_data, path, env_val)
    if env_data:
        save_settings(_deep_merge(DEFAULTS, env_data))
        log.info("Migrated env vars to %s", SETTINGS_FILE)
        return True
    save_settings(DEFAULTS)
    log.info("Created default settings at %s", SETTINGS_FILE)
    return True
