"""Contract for the `prowlarr` service (S6/T1), mirroring the `radarr` precedent.

How a service URL/API key reaches the app — ONE mechanism, already in place for
`radarr`, and this feature adds nothing new to it:

- `config.py` runs `load_dotenv()`, so shell-exported variables (`source
  .env.local` style) land in ``os.environ`` — `load_dotenv` never reads
  `.env.local` by itself;
- `settings_store._env_to_settings` maps `PROWLARR_URL`/`PROWLARR_API_KEY` onto
  `services.prowlarr.url`/`services.prowlarr.api_key`;
- the environment is a bootstrap, never an authority: `migrate_env_vars()`
  seeds `settings.json` on FIRST run only and `_env_fills_gaps` recovers empty
  values on load; once the file has a value, it wins (`load_settings`).

The defaults are empty strings on purpose: with nothing configured the service
reads as unconfigured, `find_service("prowlarr", ...)` returns `None` and the
app never calls it — the same safe absence `service_is_configured` describes,
whose radarr precedent also defaults `api_key` to `""`.

Every value below is a dummy written inline; no real key belongs in this file.
"""

import json

import pytest

import config
from infrastructure import settings_store as settings


def _file(cfg) -> dict:
    return json.loads((cfg / "settings.json").read_text())


@pytest.fixture
def cfg(tmp_path, monkeypatch):
    """Point the settings module at a throwaway config directory.

    Same fixture as `tests_settings.py`: nothing here may touch the real
    settings.json.
    """
    directory = tmp_path / "config"
    directory.mkdir()
    monkeypatch.setattr(settings, "CONFIG_DIR", str(directory))
    monkeypatch.setattr(settings, "SETTINGS_FILE", str(directory / "settings.json"))
    monkeypatch.setattr(settings, "_settings", {}, raising=False)
    yield directory
    monkeypatch.setattr(settings, "_settings", {}, raising=False)


@pytest.fixture
def live(tmp_path, monkeypatch):
    """Settings in memory only, with every derived constant restored after.

    Same contract as `tests_settings_live.py`: `config.rebuild()` refreshes the
    module names in place, so a test can configure a service exactly the way a
    save would, without any file being read or written.
    """
    directory = tmp_path / "config"
    directory.mkdir()
    monkeypatch.setattr(settings, "CONFIG_DIR", str(directory))
    monkeypatch.setattr(settings, "SETTINGS_FILE", str(directory / "settings.json"))
    before = settings._settings
    monkeypatch.setattr(settings, "_settings", {})
    yield
    settings._settings = before
    config.rebuild()


def _set(**path_values) -> None:
    """Write a nested value like `services.prowlarr.url` straight into memory."""
    for dotted, value in path_values.items():
        keys = dotted.split(".")
        node = settings._settings
        for key in keys[:-1]:
            node = node.setdefault(key, {})
        node[keys[-1]] = value
    config.rebuild()


class TestProwlarrIsExposedLikeRadarr:
    """(a) Same shape and access pattern as the radarr precedent."""

    def test_a_configured_prowlarr_has_the_same_shape_as_radarr(self, live):
        _set(
            **{
                "services.radarr.url": "http://radarr.test:7878",
                "services.radarr.api_key": "test-radarr-key",
                "services.prowlarr.url": "http://prowlarr.test:9696",
                "services.prowlarr.api_key": "test-prowlarr-key",
            }
        )

        radarr = config.find_service("radarr", "arr")
        prowlarr = next(
            (s for s in config.all_services() if s["key"] == "prowlarr"), None
        )

        assert radarr is not None, "radarr no aparece: el patrón de referencia cambió"
        assert prowlarr is not None, "no hay servicio prowlarr en config.all_services()"
        assert set(prowlarr) == set(radarr), (
            "la forma del servicio prowlarr no coincide con la de radarr"
        )
        assert prowlarr["url"] == "http://prowlarr.test:9696"
        assert prowlarr["api_key"] == "test-prowlarr-key"
        assert prowlarr["configured"] is True
        assert config.find_service("prowlarr", "prowlarr") == prowlarr

    def test_a_saved_prowlarr_is_visible_without_a_restart(self, live):
        """Mirror of `tests_settings_live.test_a_saved_service_is_visible_without_a_restart`."""
        _set(
            **{
                "services.prowlarr.url": "http://prowlarr.test:9696",
                "services.prowlarr.api_key": "test-prowlarr-key",
            }
        )

        service = config.find_service("prowlarr", "prowlarr")
        assert service is not None, "prowlarr configurado no es usable vía find_service"

        _set(**{"services.prowlarr.url": "http://new-host:9696"})

        assert config.find_service("prowlarr", "prowlarr")["url"] == "http://new-host:9696", (
            "SERVICES se reconstruyó en otra lista, o el valor no se releó al rebuild"
        )

    def test_prowlarr_is_not_swept_into_the_arr_loops(self, live):
        """The `kind == "arr"` loops call /api/v3 on every match.

        `traces.build_traces`, `wanted.get_wanted` and `files` root folders all
        iterate `configured_services("arr")` (or `kind == "arr"`) and ask each
        service for queue/history/library endpoints. Prowlarr answers a
        different API, so it must stay out of that family the moment it is
        configured — S5: los demás usos no cambian.
        """
        _set(
            **{
                "services.prowlarr.url": "http://prowlarr.test:9696",
                "services.prowlarr.api_key": "test-prowlarr-key",
            }
        )

        assert config.configured_services("arr") == [], (
            "prowlarr entró en la familia 'arr' y será llamado con endpoints /api/v3"
        )


class TestProwlarrEnvironmentMirrorsRadarr:
    """(b) `PROWLARR_URL`/`PROWLARR_API_KEY` behave exactly like RADARR's pair."""

    def test_a_fresh_install_takes_the_environment_values(self, cfg, monkeypatch):
        monkeypatch.setenv("PROWLARR_URL", "http://seed:9696")
        monkeypatch.setenv("PROWLARR_API_KEY", "seeded-prowlarr-key")

        assert settings.migrate_env_vars() is True
        settings.load_settings()

        assert settings.get_setting("services", "prowlarr", "url") == "http://seed:9696"
        assert (
            settings.get_setting("services", "prowlarr", "api_key")
            == "seeded-prowlarr-key"
        )
        # And it is persisted, so the environment is not needed again.
        assert _file(cfg)["services"]["prowlarr"]["url"] == "http://seed:9696"

    def test_the_environment_no_longer_overrides_the_file(self, cfg, monkeypatch):
        """The bug radarr already guards: an env var silently beating the UI."""
        (cfg / "settings.json").write_text(
            json.dumps(
                {
                    "services": {
                        "prowlarr": {
                            "url": "http://from-ui:9696",
                            "api_key": "from-ui-prowlarr-key",
                        }
                    }
                }
            )
        )
        monkeypatch.setenv("PROWLARR_URL", "http://from-env:9696")
        monkeypatch.setenv("PROWLARR_API_KEY", "from-env-prowlarr-key")

        settings.load_settings()

        assert settings.get_setting("services", "prowlarr", "url") == "http://from-ui:9696"
        assert (
            settings.get_setting("services", "prowlarr", "api_key")
            == "from-ui-prowlarr-key"
        )

    def test_the_environment_fills_a_gap_the_file_left_empty(self, cfg, monkeypatch):
        """Recovery path, same as `_env_fills_gaps` gives radarr."""
        (cfg / "settings.json").write_text(
            json.dumps({"services": {"prowlarr": {"url": "", "api_key": ""}}})
        )
        monkeypatch.setenv("PROWLARR_URL", "http://recovery:9696")

        settings.load_settings()

        assert settings.get_setting("services", "prowlarr", "url") == "http://recovery:9696"


class TestProwlarrDefaultsAreSafe:
    """(c) Absent configuration must never make the service callable."""

    def test_absent_settings_read_as_empty_strings(self, cfg, monkeypatch):
        monkeypatch.delenv("PROWLARR_URL", raising=False)
        monkeypatch.delenv("PROWLARR_API_KEY", raising=False)

        settings.migrate_env_vars()
        settings.load_settings()

        assert settings.get_setting("services", "prowlarr", "url") == ""
        assert settings.get_setting("services", "prowlarr", "api_key") == ""

    def test_an_unconfigured_prowlarr_is_never_exposed_as_usable(self, live):
        assert config.find_service("prowlarr", "prowlarr") is None
        assert all(s["key"] != "prowlarr" for s in config.configured_services())
        reason = config.service_unavailable_reason("prowlarr", "prowlarr")
        assert "no está configurado" in reason, (
            f"una prowlarr ausente debe leerse como no configurada, no como {reason!r}"
        )
