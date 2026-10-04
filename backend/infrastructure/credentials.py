"""Credential handling for the app's own API key.

Two different kinds of secret live in the configuration and they cannot be
treated the same way:

- **The app's own API key** is only ever *compared*, never sent anywhere, so it
  is stored as a hash. A leaked settings.json no longer reveals it.
- **Radarr/Sonarr/aMuTorrent keys and the aMuTorrent password** must be *sent*
  to those services, so they cannot be hashed. They are handled separately.

The hash is HMAC-SHA256 rather than a slow KDF on purpose. `verify_api_key`
runs on every request, and scrypt/bcrypt are deliberately expensive (tens of
milliseconds) to slow down guessing low-entropy passwords. This key is a long
random token, where brute force is already infeasible, so a fast hash is both
safe and free of per-request cost.
"""

import base64
import copy
import functools
import hashlib
import hmac
import logging
import os
import secrets

log = logging.getLogger("flow-controller")

#: Secrets are shown to the UI as this prefix plus their last characters. A
#: stored value carrying it is not a secret, it is the residue of a bug that
#: overwrote real credentials with their mask.
MASK_PREFIX = "****"

from cryptography.fernet import Fernet, InvalidToken

# Field paths inside the settings document.
PLAINTEXT_PATH = ("security", "api_key")
HASH_PATH = ("security", "api_key_hash")
SALT_PATH = ("security", "api_key_salt")
ENC_SALT_PATH = ("security", "encryption_salt")

# ── Secrets that must survive as-is ──────────────────────────────────────────
#
# These are sent to Radarr/Sonarr/aMuTorrent, so unlike the app's own key they
# cannot be hashed. They are encrypted at rest instead.

ENCRYPTED_SECRET_FIELDS = (
    ("services", "radarr", "api_key"),
    ("services", "sonarr", "api_key"),
    ("services", "amutorrent", "api_key"),
    ("services", "amutorrent", "password"),
)

#: Marks a value as ciphertext, so legacy plaintext can still be read.
ENCRYPTED_PREFIX = "enc:"

#: Name of the deployment variable holding the encryption secret. Deliberately
#: NOT written to the settings file: the whole point is that the file alone is
#: not enough to read the credentials.
SECRET_ENV_VAR = "FC_SECRET"


def encryption_secret() -> str:
    return os.getenv(SECRET_ENV_VAR, "")


def is_encrypted(value) -> bool:
    return isinstance(value, str) and value.startswith(ENCRYPTED_PREFIX)


@functools.lru_cache(maxsize=8)
def _fernet(secret: str, salt: str) -> Fernet:
    """Derive the encryption key from the deployment secret.

    PBKDF2 so a short or human-chosen secret still yields a proper key. Cached
    because derivation is deliberately slow and this runs on every load and
    save, not on every request.
    """
    derived = hashlib.pbkdf2_hmac("sha256", secret.encode("utf-8"), salt.encode("utf-8"), 200_000, dklen=32)
    return Fernet(base64.urlsafe_b64encode(derived))


def encrypt_secret(value: str, secret: str, salt: str) -> str:
    return ENCRYPTED_PREFIX + _fernet(secret, salt).encrypt(value.encode("utf-8")).decode("ascii")


def decrypt_secret(token: str, secret: str, salt: str) -> str | None:
    """The plaintext, or None when the secret does not match or data is damaged.

    None rather than an exception so callers must decide what to do; returning a
    placeholder would send a wrong credential to a service and look like an
    outage.
    """
    try:
        raw = token[len(ENCRYPTED_PREFIX):].encode("ascii")
        return _fernet(secret, salt).decrypt(raw).decode("utf-8")
    except (InvalidToken, ValueError, TypeError):
        return None


def ensure_encryption_salt(data: dict) -> str:
    """The salt the ciphertext is bound to, created on first use.

    It must exist before anything is encrypted, and it must stay stable: a new
    salt would make every previously written value unreadable.
    """
    salt = _get(data, ENC_SALT_PATH, "")
    if not salt:
        salt = new_salt()
        _set(data, ENC_SALT_PATH, salt)
    return salt


def prepare_for_use(data: dict, secret: str) -> list[str]:
    """Decrypt the stored secrets in place, so the app can send them.

    Returns the fields that could NOT be decrypted, as paths. Callers must treat
    a non-empty result as a loud failure: a wrong secret means the credentials
    are unreadable, and quietly continuing with empty values would look like
    every service being misconfigured.
    """
    if secret:
        ensure_encryption_salt(data)

    salt = _get(data, ENC_SALT_PATH, "")
    failures: list[str] = []

    for path in ENCRYPTED_SECRET_FIELDS:
        value = _get(data, path)
        if not is_encrypted(value):
            continue
        plain = decrypt_secret(value, secret, salt) if secret else None
        if plain is None:
            failures.append(".".join(path))
            # Never hand ciphertext to a service.
            _set(data, path, "")
        else:
            _set(data, path, plain)

    return failures


def prepare_for_storage(data: dict, secret: str) -> dict:
    """A copy ready to write, with the service secrets encrypted.

    Without a secret nothing is encrypted: the app still works with plaintext
    and says so at start-up, rather than refusing to run.
    """
    out = copy.deepcopy(data)
    if not secret:
        return out

    # Establish the salt here too: a save can happen before any load.
    salt = ensure_encryption_salt(out)

    for path in ENCRYPTED_SECRET_FIELDS:
        value = _get(out, path)
        if isinstance(value, str) and value and not is_encrypted(value):
            _set(out, path, encrypt_secret(value, secret, salt))

    return out


def new_salt() -> str:
    return secrets.token_hex(16)


def hash_api_key(api_key: str, salt: str) -> str:
    return hmac.new(salt.encode("utf-8"), api_key.encode("utf-8"), hashlib.sha256).hexdigest()


def verify_api_key(candidate: str, salt: str, expected_hash: str) -> bool:
    """Constant-time comparison, so a wrong key cannot be narrowed by timing."""
    if not candidate or not salt or not expected_hash:
        return False
    return hmac.compare_digest(hash_api_key(candidate, salt), expected_hash)


def looks_like_mask(value) -> bool:
    return isinstance(value, str) and value.startswith(MASK_PREFIX)


def _get(data: dict, path: tuple[str, ...], default=None):
    node = data
    for key in path:
        if not isinstance(node, dict):
            return default
        node = node.get(key)
        if node is None:
            return default
    return node


def _set(data: dict, path: tuple[str, ...], value) -> None:
    node = data
    for key in path[:-1]:
        node = node.setdefault(key, {})
    node[path[-1]] = value


def _pop(data: dict, path: tuple[str, ...]) -> None:
    node = data
    for key in path[:-1]:
        if not isinstance(node, dict) or key not in node:
            return
        node = node[key]
    if isinstance(node, dict):
        node.pop(path[-1], None)


def normalise_app_key(data: dict) -> bool:
    """Move a plaintext app key into its hash, and drop a corrupted one.

    Runs over the settings document in place. Returns True when something
    changed, so the caller can persist the cleaner form.

    Why the mask check exists: a bug once saved the *masked* form back over the
    real credentials, so a stored value like "****ABCD" is not a key anybody can
    type. Treating it as unset is what lets the user back in; keeping it would
    lock them out permanently.
    """
    changed = False

    plaintext = _get(data, PLAINTEXT_PATH)
    if isinstance(plaintext, str) and plaintext:
        if looks_like_mask(plaintext):
            log.warning(
                "security.api_key holds a mask (%s), left by a bug that overwrote "
                "the real key. Treating it as unset; set the key again.",
                plaintext,
            )
            _pop(data, PLAINTEXT_PATH)
            _pop(data, HASH_PATH)
            _pop(data, SALT_PATH)
            changed = True
        else:
            salt = _get(data, SALT_PATH) or new_salt()
            _set(data, SALT_PATH, salt)
            _set(data, HASH_PATH, hash_api_key(plaintext, salt))
            _pop(data, PLAINTEXT_PATH)
            changed = True

    # A hash without its salt cannot be verified; drop it so auth is simply off
    # rather than permanently failing.
    if _get(data, HASH_PATH) and not _get(data, SALT_PATH):
        log.warning("security.api_key_hash has no salt; treating the key as unset")
        _pop(data, HASH_PATH)
        changed = True

    return changed


def app_key_is_set(data: dict) -> bool:
    """Whether an API key has been configured."""
    return bool(_get(data, HASH_PATH))


def set_app_key(data: dict, api_key: str) -> None:
    """Hash a new key into the document, or clear it when given an empty one."""
    if api_key:
        salt = new_salt()
        _set(data, SALT_PATH, salt)
        _set(data, HASH_PATH, hash_api_key(api_key, salt))
    else:
        _pop(data, HASH_PATH)
        _pop(data, SALT_PATH)
    _pop(data, PLAINTEXT_PATH)
