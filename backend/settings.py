import json
import os
import stat
import logging
import credentials
from typing import Any

log = logging.getLogger("settings")

#: Non-empty when the stored credentials could not be decrypted (wrong FC_SECRET).
encryption_error: str = ""

CONFIG_DIR = os.getenv("CONFIG_DIR", "/app/config")
SETTINGS_FILE = os.path.join(CONFIG_DIR, "settings.json")

DEFAULTS: dict[str, Any] = {
    "services": {
        "radarr": {"url": "http://localhost:7878", "api_key": ""},
        "sonarr": {"url": "http://localhost:8989", "api_key": ""},
        "amutorrent": {"url": "http://localhost:4000", "api_key": "", "user": "admin", "password": ""},
    },
    "security": {"api_key_hash": "", "api_key_salt": "", "safe_mode": True},
    "developer": False,
    "paths": {
        "download_amule": "/mnt/storage-6tb/shared-downloads/amule",
        "download_torrent": "/mnt/storage/downloads/qbittorrent/completed",
        "output_mixed": "/mnt/storage/mixed",
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
    "FOLDER_OUTPUT_MIXED": ("paths", "output_mixed"),
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


def _env_fills_gaps(data: dict) -> dict:
    """Apply environment values only where the settings file has none.

    This is the middle ground between two broken extremes. Overriding on every
    load made the Settings UI useless (an env var silently beat it); ignoring
    the environment entirely removed any way back in when the key was lost.
    Filling gaps keeps edits authoritative while letting a deployment variable
    (and a Portainer secret) act as a recovery path.
    """
    result = _deep_merge(DEFAULTS, data)
    for env_key, path in _env_to_settings.items():
        env_val = os.getenv(env_key)
        if env_val is None or env_val == "":
            continue
        current = result
        for key in path[:-1]:
            current = current.setdefault(key, {})
        existing = current.get(path[-1])
        if existing in (None, "", [], {}):
            _set_nested(result, path, env_val)
    return result


def _env_seed() -> dict:
    """Settings values found in the environment, if any."""
    env_data: dict[str, Any] = {}
    for env_key, path in _env_to_settings.items():
        env_val = os.getenv(env_key)
        if env_val is not None and env_val != "":
            _set_nested(env_data, path, env_val)
    return env_data


def load_settings() -> dict[str, Any]:
    """Read the settings file. It is the single source of truth.

    There is deliberately NO environment override here. One used to be applied
    on every load, which meant an env var silently beat anything saved from the
    Settings UI — so editing a URL or API key appeared to do nothing. The
    environment now only seeds the file once, on first run (see
    ``migrate_env_vars``).
    """
    global _settings

    if os.path.isfile(SETTINGS_FILE):
        file_data: dict[str, Any] = {}
        try:
            with open(SETTINGS_FILE, "r", encoding="utf-8") as f:
                file_data = json.load(f)
            log.info("Loaded settings from %s", SETTINGS_FILE)
        except Exception as exc:
            log.error("Failed to load settings from %s: %s", SETTINGS_FILE, exc)
        _settings = _env_fills_gaps(file_data)
        # Migrate a plaintext app key (or clear one corrupted by the mask bug)
        # before anything reads it.
        key_changed = credentials.normalise_app_key(_settings)

        secret = credentials.encryption_secret()
        failures = credentials.prepare_for_use(_settings, secret)
        _set_encryption_error(failures, secret)

        # Re-save when a plaintext app key was migrated or a service secret is
        # still in the clear, so the file ends up fully protected.
        if key_changed or (secret and _has_plaintext_secret(_settings)):
            save_settings(_settings)
    elif not _settings:
        # No file and nothing seeded in memory: pure defaults.
        _settings = _deep_merge(DEFAULTS, {})
    # Otherwise migrate_env_vars already built the settings in memory and could
    # not persist them (read-only config directory); keep them rather than
    # clobbering with DEFAULTS.

    return _settings


def _set_encryption_error(failures: list[str], secret: str) -> None:
    """Record, loudly, when credentials cannot be read back.

    Silently returning empty credentials would show every service as
    unconfigured, which is exactly the wrong diagnosis.
    """
    global encryption_error
    if failures:
        encryption_error = (
            f"{credentials.SECRET_ENV_VAR} no coincide con el usado para cifrar: "
            f"no se pudieron leer {', '.join(failures)}. Restaura el valor anterior "
            f"o vuelve a introducir esas credenciales."
        )
        log.error(encryption_error)
    elif not secret and _has_plaintext_secret(get_settings()):
        encryption_error = ""
        log.warning(
            "%s no está definida: las credenciales se guardan SIN cifrar. "
            "Defínela para protegerlas.",
            credentials.SECRET_ENV_VAR,
        )
    else:
        encryption_error = ""


def _has_plaintext_secret(data: dict) -> bool:
    for path in credentials.ENCRYPTED_SECRET_FIELDS:
        node = data
        for key in path:
            node = node.get(key, {}) if isinstance(node, dict) else {}
        if isinstance(node, str) and node and not credentials.is_encrypted(node):
            return True
    return False


def save_settings(data: dict[str, Any]) -> bool:
    global _settings
    _settings = _deep_merge(DEFAULTS, data)
    # Never persist the app key in the clear: hash it on the way out.
    credentials.normalise_app_key(_settings)
    # The file gets ciphertext; memory keeps the plaintext the app must send.
    secret = credentials.encryption_secret()
    if secret:
        # Keep the salt in memory too, so it does not change between saves.
        credentials.ensure_encryption_salt(_settings)
    try:
        os.makedirs(CONFIG_DIR, exist_ok=True)
        tmp = SETTINGS_FILE + ".tmp"
        with open(tmp, "w", encoding="utf-8") as f:
            json.dump(credentials.prepare_for_storage(_settings, secret), f, indent=2, ensure_ascii=False)
        os.replace(tmp, SETTINGS_FILE)
        try:
            os.chmod(SETTINGS_FILE, stat.S_IRUSR | stat.S_IWUSR)
        except OSError:
            pass
        log.info("Settings saved to %s", SETTINGS_FILE)
        return True
    except OSError as exc:
        log.warning("Cannot write settings to %s: %s (using in-memory only)", SETTINGS_FILE, exc)
        return False


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
    """Seed settings.json from the environment, on FIRST run only.

    This is a bootstrap, not a runtime override: once the file exists the
    environment is ignored and the file decides. Deployment variables are
    therefore an initial value, never an authority.
    """
    if os.path.isfile(SETTINGS_FILE):
        return False
    env_data = _env_seed()
    merged = _deep_merge(DEFAULTS, env_data) if env_data else DEFAULTS
    saved = save_settings(merged)
    if saved:
        log.info("Migrated env vars to %s", SETTINGS_FILE)
    else:
        log.info("Using in-memory settings (config directory not writable)")
    return True
