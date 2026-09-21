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

import hashlib
import hmac
import logging
import secrets

log = logging.getLogger("flow-controller")

#: Secrets are shown to the UI as this prefix plus their last characters. A
#: stored value carrying it is not a secret, it is the residue of a bug that
#: overwrote real credentials with their mask.
MASK_PREFIX = "****"

# Field paths inside the settings document.
PLAINTEXT_PATH = ("security", "api_key")
HASH_PATH = ("security", "api_key_hash")
SALT_PATH = ("security", "api_key_salt")


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
