"""Service credentials are encrypted at rest.

The Radarr/Sonarr/aMuTorrent keys and the aMuTorrent password must be SENT to
those services, so unlike the app's own key they cannot be hashed. They are
encrypted instead, with a key derived from the deployment secret.

The dangerous case is a secret that no longer matches: the credentials become
unreadable, and quietly substituting empty ones would show every service as
misconfigured — the wrong diagnosis, with no hint about the real cause.
"""

import json

import pytest

import credentials
import settings


SECRET = "un-secreto-de-despliegue"


@pytest.fixture
def cfg(tmp_path, monkeypatch):
    directory = tmp_path / "config"
    directory.mkdir()
    monkeypatch.setattr(settings, "CONFIG_DIR", str(directory))
    monkeypatch.setattr(settings, "SETTINGS_FILE", str(directory / "settings.json"))
    monkeypatch.setattr(settings, "_settings", {}, raising=False)
    monkeypatch.setattr(settings, "encryption_error", "", raising=False)
    monkeypatch.setenv(credentials.SECRET_ENV_VAR, SECRET)
    yield directory
    monkeypatch.setattr(settings, "_settings", {}, raising=False)


def _save(data: dict) -> None:
    assert settings.save_settings(data) is True


def _raw(cfg) -> str:
    return (cfg / "settings.json").read_text()


def _with_secrets() -> dict:
    return {
        "services": {
            "radarr": {"url": "http://r:7878", "api_key": "CLAVE-RADARR-1234"},
            "sonarr": {"url": "http://s:8989", "api_key": "CLAVE-SONARR-5678"},
            "amutorrent": {
                "url": "http://a:4000",
                "api_key": "CLAVE-AMU-9012",
                "user": "admin",
                "password": "PASSWORD-SECRETO",
            },
        },
        "security": {"api_key_hash": "h", "api_key_salt": "s", "safe_mode": True},
    }


class TestSecretsAreEncryptedOnDisk:
    def test_no_service_key_is_written_in_the_clear(self, cfg):
        _save(_with_secrets())

        raw = _raw(cfg)

        for secret in ("CLAVE-RADARR-1234", "CLAVE-SONARR-5678", "CLAVE-AMU-9012", "PASSWORD-SECRETO"):
            assert secret not in raw, f"{secret} was written in the clear"

    def test_the_values_are_ciphertext(self, cfg):
        _save(_with_secrets())

        stored = json.loads(_raw(cfg))

        assert credentials.is_encrypted(stored["services"]["radarr"]["api_key"])
        assert credentials.is_encrypted(stored["services"]["amutorrent"]["password"])

    def test_the_secret_itself_is_never_written(self, cfg):
        _save(_with_secrets())

        assert SECRET not in _raw(cfg)

    def test_the_urls_are_left_readable(self, cfg):
        """Only secrets are encrypted; the rest stays inspectable."""
        _save(_with_secrets())

        stored = json.loads(_raw(cfg))

        assert stored["services"]["radarr"]["url"] == "http://r:7878"


class TestRoundTrip:
    def test_the_app_still_gets_the_plaintext(self, cfg):
        _save(_with_secrets())

        settings.load_settings()

        assert settings.get_setting("services", "radarr", "api_key") == "CLAVE-RADARR-1234"
        assert settings.get_setting("services", "amutorrent", "password") == "PASSWORD-SECRETO"

    def test_an_existing_plaintext_file_is_migrated(self, cfg):
        (cfg / "settings.json").write_text(json.dumps(_with_secrets()))

        settings.load_settings()

        raw = _raw(cfg)
        assert "CLAVE-RADARR-1234" not in raw, "a legacy plaintext key was left in the file"
        assert settings.get_setting("services", "radarr", "api_key") == "CLAVE-RADARR-1234"


class TestWrongSecretFailsLoudly:
    def test_a_different_secret_is_reported(self, cfg, monkeypatch):
        _save(_with_secrets())

        monkeypatch.setenv(credentials.SECRET_ENV_VAR, "otro-secreto-distinto")
        settings.load_settings()

        assert settings.encryption_error, "a wrong secret must be reported, not swallowed"
        assert credentials.SECRET_ENV_VAR in settings.encryption_error

    def test_unreadable_credentials_are_not_sent_to_services(self, cfg, monkeypatch):
        """Empty is safer than ciphertext: ciphertext would be a nonsense key."""
        _save(_with_secrets())

        monkeypatch.setenv(credentials.SECRET_ENV_VAR, "otro-secreto-distinto")
        settings.load_settings()

        assert settings.get_setting("services", "radarr", "api_key") == ""

    def test_a_missing_secret_is_reported_too(self, cfg, monkeypatch):
        _save(_with_secrets())

        monkeypatch.delenv(credentials.SECRET_ENV_VAR, raising=False)
        settings.load_settings()

        assert settings.encryption_error

    def test_the_right_secret_reports_nothing(self, cfg):
        _save(_with_secrets())

        settings.load_settings()

        assert settings.encryption_error == ""


class TestWithoutASecret:
    def test_the_app_still_works_in_plaintext(self, cfg, monkeypatch):
        """Refusing to run would be worse than running unencrypted and saying so."""
        monkeypatch.delenv(credentials.SECRET_ENV_VAR, raising=False)

        _save(_with_secrets())
        settings.load_settings()

        assert settings.get_setting("services", "radarr", "api_key") == "CLAVE-RADARR-1234"
        assert "CLAVE-RADARR-1234" in _raw(cfg), "no secret means no encryption"
        assert settings.encryption_error == ""


class TestPrimitives:
    def test_encrypting_twice_gives_different_ciphertext(self):
        salt = credentials.new_salt()

        first = credentials.encrypt_secret("misma", SECRET, salt)
        second = credentials.encrypt_secret("misma", SECRET, salt)

        assert first != second, "Fernet must not be deterministic"

    def test_a_tampered_value_is_rejected(self):
        salt = credentials.new_salt()
        token = credentials.encrypt_secret("valor", SECRET, salt)
        tampered = token[:-4] + "AAAA"

        assert credentials.decrypt_secret(tampered, SECRET, salt) is None

    def test_a_wrong_salt_is_rejected(self):
        token = credentials.encrypt_secret("valor", SECRET, credentials.new_salt())

        assert credentials.decrypt_secret(token, SECRET, credentials.new_salt()) is None
