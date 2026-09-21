"""The app's API key is stored hashed, never in the clear.

A leaked settings.json used to hand over the key that unlocks the app. The key
is only ever compared, so it can be hashed — unlike the Radarr/Sonarr/aMuTorrent
credentials, which must be sent to those services and therefore cannot be.
"""

import credentials


def test_a_key_is_never_stored_in_the_clear():
    data = {"security": {"api_key": "CLAVE-SECRETA-ABCD"}}

    credentials.normalise_app_key(data)

    assert "api_key" not in data["security"], "the plaintext key must not survive"
    assert data["security"]["api_key_hash"]
    assert data["security"]["api_key_salt"]


def test_the_hash_verifies_the_right_key_only():
    data = {"security": {"api_key": "CLAVE-SECRETA-ABCD"}}
    credentials.normalise_app_key(data)

    salt = data["security"]["api_key_salt"]
    hashed = data["security"]["api_key_hash"]

    assert credentials.verify_api_key("CLAVE-SECRETA-ABCD", salt, hashed) is True
    assert credentials.verify_api_key("otra-cosa", salt, hashed) is False
    assert credentials.verify_api_key("", salt, hashed) is False


def test_the_same_key_hashes_differently_on_each_install():
    """A per-install salt stops one leaked hash from matching another install."""
    first = {"security": {"api_key": "misma-clave"}}
    second = {"security": {"api_key": "misma-clave"}}

    credentials.normalise_app_key(first)
    credentials.normalise_app_key(second)

    assert first["security"]["api_key_salt"] != second["security"]["api_key_salt"]
    assert first["security"]["api_key_hash"] != second["security"]["api_key_hash"]


def test_normalising_twice_does_not_rehash():
    """Rehashing on every load would invalidate the key each time."""
    data = {"security": {"api_key": "CLAVE"}}
    credentials.normalise_app_key(data)
    before = dict(data["security"])

    changed = credentials.normalise_app_key(data)

    assert changed is False
    assert data["security"] == before


def test_an_existing_hash_is_left_alone():
    data = {"security": {"api_key_hash": "h", "api_key_salt": "s"}}

    assert credentials.normalise_app_key(data) is False
    assert data["security"]["api_key_hash"] == "h"


def test_a_hash_without_its_salt_is_dropped():
    """It could never verify, so keeping it would fail every request forever."""
    data = {"security": {"api_key_hash": "h", "api_key_salt": ""}}

    assert credentials.normalise_app_key(data) is True
    assert credentials.app_key_is_set(data) is False


class TestMaskCorruptionIsRepaired:
    """A bug once saved the masked form over the real credentials.

    A stored "****ABCD" is not a key anybody can type, so keeping it locks the
    user out of the app permanently — and the page that would fix it is behind
    that same key.
    """

    def test_a_masked_key_is_treated_as_unset(self):
        data = {"security": {"api_key": "****ABCD"}}

        changed = credentials.normalise_app_key(data)

        assert changed is True
        assert credentials.app_key_is_set(data) is False
        assert "api_key" not in data["security"]

    def test_a_mask_also_clears_a_stale_hash(self):
        data = {"security": {"api_key": "****ABCD", "api_key_hash": "h", "api_key_salt": "s"}}

        credentials.normalise_app_key(data)

        assert credentials.app_key_is_set(data) is False

    def test_a_real_key_is_not_mistaken_for_a_mask(self):
        data = {"security": {"api_key": "CLAVE-****-ABCD"}}
        # Only the FIRST characters decide; a key merely containing asterisks is
        # a real key.
        credentials.normalise_app_key(data)
        assert credentials.app_key_is_set(data)


class TestSetAppKey:
    def test_a_new_key_is_hashed(self):
        data = {"security": {}}

        credentials.set_app_key(data, "nueva-clave")

        assert "api_key" not in data["security"]
        assert credentials.app_key_is_set(data) is True

    def test_an_empty_key_clears_authentication(self):
        data = {"security": {"api_key": "algo"}}
        credentials.normalise_app_key(data)

        credentials.set_app_key(data, "")

        assert credentials.app_key_is_set(data) is False

    def test_replacing_the_key_invalidates_the_old_one(self):
        data = {"security": {"api_key": "vieja"}}
        credentials.normalise_app_key(data)
        salt, hashed = data["security"]["api_key_salt"], data["security"]["api_key_hash"]

        credentials.set_app_key(data, "nueva")

        assert credentials.verify_api_key("vieja", salt, hashed) is True  # the old hash
        assert credentials.verify_api_key(
            "vieja", data["security"]["api_key_salt"], data["security"]["api_key_hash"]
        ) is False
        assert credentials.verify_api_key(
            "nueva", data["security"]["api_key_salt"], data["security"]["api_key_hash"]
        ) is True
