"""Settings precedence: the file is the single source of truth.

A runtime environment override used to be applied on every load, so an env var
silently beat anything saved from the Settings UI — editing a URL or API key
appeared to do nothing. The environment now only seeds the file on first run.
"""

import json
from unittest.mock import patch

import pytest

import settings


@pytest.fixture
def cfg(tmp_path, monkeypatch):
    """Point the module at a throwaway config directory."""
    directory = tmp_path / "config"
    directory.mkdir()
    monkeypatch.setattr(settings, "CONFIG_DIR", str(directory))
    monkeypatch.setattr(settings, "SETTINGS_FILE", str(directory / "settings.json"))
    monkeypatch.setattr(settings, "_settings", {}, raising=False)
    yield directory
    monkeypatch.setattr(settings, "_settings", {}, raising=False)


def _file(cfg) -> dict:
    return json.loads((cfg / "settings.json").read_text())


class TestFirstRunSeedsFromEnvironment:
    def test_a_fresh_install_takes_the_environment_values(self, cfg, monkeypatch):
        monkeypatch.setenv("RADARR_URL", "http://seed:7878")
        monkeypatch.setenv("RADARR_API_KEY", "seeded-key")

        assert settings.migrate_env_vars() is True
        settings.load_settings()

        assert settings.get_setting("services", "radarr", "url") == "http://seed:7878"
        assert settings.get_setting("services", "radarr", "api_key") == "seeded-key"
        # And it is persisted, so the environment is not needed again.
        assert _file(cfg)["services"]["radarr"]["url"] == "http://seed:7878"

    def test_empty_environment_falls_back_to_defaults(self, cfg, monkeypatch):
        for key in ("RADARR_URL", "RADARR_API_KEY", "SONARR_URL", "AMUTORRENT_URL"):
            monkeypatch.delenv(key, raising=False)

        settings.migrate_env_vars()
        settings.load_settings()

        assert settings.get_setting("services", "radarr", "url") == "http://localhost:7878"

    def test_migration_does_not_run_again_once_the_file_exists(self, cfg):
        (cfg / "settings.json").write_text(json.dumps({"developer": True}))

        assert settings.migrate_env_vars() is False


class TestTheFileWinsAfterwards:
    def test_the_environment_no_longer_overrides_the_file(self, cfg, monkeypatch):
        """The bug: an env var silently beat the Settings UI."""
        (cfg / "settings.json").write_text(
            json.dumps({"services": {"radarr": {"url": "http://from-ui:7878", "api_key": "from-ui"}}})
        )
        monkeypatch.setenv("RADARR_URL", "http://from-env:7878")
        monkeypatch.setenv("RADARR_API_KEY", "from-env")

        settings.load_settings()

        assert settings.get_setting("services", "radarr", "url") == "http://from-ui:7878"
        assert settings.get_setting("services", "radarr", "api_key") == "from-ui"

    def test_other_env_keys_are_not_overridden_either(self, cfg, monkeypatch):
        (cfg / "settings.json").write_text(json.dumps({"security": {"safe_mode": False}}))
        monkeypatch.setenv("SAFE_MODE", "true")

        settings.load_settings()

        assert settings.get_setting("security", "safe_mode") is False

    def test_missing_keys_still_fall_back_to_defaults(self, cfg):
        (cfg / "settings.json").write_text(json.dumps({"services": {"radarr": {"url": "http://x:1"}}}))

        settings.load_settings()

        # Not in the file, so the default applies.
        assert settings.get_setting("intervals", "check") == 15


class TestUnwritableConfigDirectory:
    def test_seeded_values_survive_when_they_cannot_be_persisted(self, cfg, monkeypatch):
        """A read-only config directory must not silently drop the seed."""
        monkeypatch.setenv("RADARR_URL", "http://seed:7878")

        with patch.object(settings, "save_settings", side_effect=lambda data: _seed_only(settings, data)):
            settings.migrate_env_vars()
        settings.load_settings()

        assert settings.get_setting("services", "radarr", "url") == "http://seed:7878"


def _seed_only(module, data: dict) -> bool:
    """Stand-in for save_settings when the file cannot be written."""
    module._settings = settings._deep_merge(settings.DEFAULTS, data)
    return False
