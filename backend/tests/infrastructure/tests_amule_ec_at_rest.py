"""T2 hardening (S2): `services.amule.ec_password` cifrado en reposo.

El mismo mecanismo que las claves de servicio: el campo vive en
`credentials.ENCRYPTED_SECRET_FIELDS`. El fichero guarda ciphertext `enc:…`;
en memoria queda el texto plano que la app tiene que enviar — lo descifra
`load_settings → prepare_for_use`, igual que la contraseña de aMuTorrent que
después consume `arr_client` vía `config` — y las respuestas HTTP sólo muestran
la máscara. Las pruebas usan un secreto falso; jamás .env.local ni secretos
reales.

Degradación documentada (paridad con sus hermanos):
- SIN `FC_SECRET`: se guarda en claro y se avisa (`encryption_error == ""`).
- `FC_SECRET` equivocado/rotado: los valores ilegibles quedan VACÍOS en
  memoria (jamás ciphertext a ningún servicio), y `encryption_error` lo dice.
"""

import json

import pytest

import config
from app import app
from fastapi.testclient import TestClient
from infrastructure import credentials as credentials
from infrastructure import settings_store as settings
from interfaces.http.routes import settings as settings_route

client = TestClient(app, raise_server_exceptions=False)

SECRET = "EC-SECRETO-FALSO-4242"
MASKED = "****" + SECRET[-4:]


class _Recorder:
    """AmuleECClient mínimo: registra lo que el probe le pasa al ctor."""

    instances: list["_Recorder"] = []

    def __init__(self, host, port, password, **kwargs):
        self.host = host
        self.port = port
        self.password = password
        self.closed = False
        _Recorder.instances.append(self)

    def connect(self):
        return "0.4.9"

    def close(self):
        self.closed = True


@pytest.fixture
def cfg(tmp_path, monkeypatch):
    """Settings store aislado en tmp, con FC_SECRET de mentira."""
    directory = tmp_path / "config"
    directory.mkdir()
    monkeypatch.setattr(settings, "CONFIG_DIR", str(directory))
    monkeypatch.setattr(settings, "SETTINGS_FILE", str(directory / "settings.json"))
    monkeypatch.setattr(settings, "encryption_error", "", raising=False)
    monkeypatch.setenv(credentials.SECRET_ENV_VAR, SECRET)
    before = settings._settings
    settings._settings = {}
    yield directory
    settings._settings = before
    config.rebuild()


@pytest.fixture
def probe(monkeypatch):
    _Recorder.instances = []
    monkeypatch.setattr(settings_route, "amule_ec_client", _Recorder)


def _save(data: dict) -> None:
    assert settings.save_settings(data) is True


def _raw(cfg) -> str:
    return (cfg / "settings.json").read_text()


def _with_amule() -> dict:
    return {
        "services": {
            "amule": {
                "url": "http://amule.test:8080",
                "ec_port": "4712",
                "ec_password": SECRET,
            },
        },
        "security": {"safe_mode": True},
    }


# ── (a) en el fichero va ciphertext, jamás el secreto en claro ───────────────


def test_the_password_is_written_as_ciphertext_not_in_the_clear(cfg):
    _save(_with_amule())

    raw = _raw(cfg)
    stored = json.loads(raw)

    assert SECRET not in raw, "la contraseña EC se escribió en el fichero en claro"
    assert credentials.is_encrypted(stored["services"]["amule"]["ec_password"]), (
        "ec_password debe guardar ciphertext `enc:` como sus campos hermanos"
    )


def test_the_store_level_view_never_shows_the_clear_secret(cfg):
    _save(_with_amule())
    settings.load_settings()

    stored_view = credentials.prepare_for_storage(settings.get_settings(), SECRET)

    assert SECRET not in json.dumps(stored_view), "la vista de guardado llevaba el secreto en claro"


# ── (b) las respuestas siguen devolviendo SÓLO la máscara ────────────────────


def test_the_settings_response_shows_only_the_mask(cfg):
    _save(_with_amule())
    settings.load_settings()

    resp = client.get("/api/settings")

    assert resp.status_code == 200, resp.text
    assert SECRET not in resp.text
    assert "enc:" not in resp.text, "ni siquiera el ciphertext debe asomar"
    assert resp.json()["services"]["amule"]["ec_password"] == MASKED


# ── (d) el probe recibe el valor descifrado, por el mismo camino que aMuTorrent ─


def test_the_probe_receives_the_decrypted_password(cfg, probe):
    _save(_with_amule())
    settings.load_settings()
    config.rebuild()

    # El mismo camino que arr_client con AMUTORRENT_PASSWORD: memoria ya
    # descifrada por prepare_for_use, leída en el momento de la llamada.
    assert settings.get_setting("services", "amule", "ec_password") == SECRET

    resp = client.post("/api/amule/test")

    assert resp.json() == {"ok": True, "detail": "0.4.9"}
    (recorded,) = _Recorder.instances
    assert recorded.password == SECRET, "el probe debe recibir el texto plano, no el ciphertext"
    assert (recorded.host, recorded.port) == ("amule.test", 4712)
    assert recorded.closed
    assert SECRET not in resp.text


# ── (c) el round-trip enmascarado sobrevive al ciphertext sin doble cifrar ────


def test_the_masked_form_round_trips_over_the_ciphertext(cfg, probe):
    _save(_with_amule())
    settings.load_settings()
    config.rebuild()

    form = client.get("/api/settings").json()
    posted = client.post("/api/settings", json=form)
    assert SECRET not in posted.text

    settings.load_settings()
    assert settings.get_setting("services", "amule", "ec_password") == SECRET
    assert SECRET not in _raw(cfg), "el round-trip dejó el secreto en claro en el fichero"
    stored = json.loads(_raw(cfg))
    assert credentials.is_encrypted(stored["services"]["amule"]["ec_password"])


def test_a_legacy_plaintext_file_is_migrated_on_load(cfg):
    """Un fichero escrito antes del cifrado se re-guarda cifrado al cargar."""
    (cfg / "settings.json").write_text(json.dumps(_with_amule()))

    settings.load_settings()

    assert SECRET not in _raw(cfg), "un fichero legado en claro se re-guarda cifrado"
    assert settings.get_setting("services", "amule", "ec_password") == SECRET


def test_an_already_encrypted_value_is_never_encrypted_twice(cfg):
    _save(_with_amule())
    dumped = json.loads(_raw(cfg))

    settings.save_settings(dumped)
    settings.load_settings()

    assert settings.get_setting("services", "amule", "ec_password") == SECRET, (
        "un valor ya cifrado volvió a cifrarse y quedó ilegible"
    )
    assert SECRET not in _raw(cfg)


# ── (e) degradación como los hermanos: sin secreto y con secreto rotado ──────


def test_without_fc_secret_the_app_still_works_and_says_so(cfg, monkeypatch):
    monkeypatch.delenv(credentials.SECRET_ENV_VAR, raising=False)

    _save(_with_amule())
    settings.load_settings()

    assert settings.get_setting("services", "amule", "ec_password") == SECRET
    assert SECRET in _raw(cfg), "sin FC_SECRET no hay cifrado — igual que los campos hermanos"
    assert settings.encryption_error == ""


def test_a_rotated_secret_degrades_like_the_siblings(cfg, probe, monkeypatch):
    _save(_with_amule())
    monkeypatch.setenv(credentials.SECRET_ENV_VAR, "otro-secreto-rotado")
    settings.load_settings()
    config.rebuild()

    assert settings.encryption_error, "un secreto ilegible se reporta alto, no se traga"
    assert credentials.SECRET_ENV_VAR in settings.encryption_error
    assert settings.get_setting("services", "amule", "ec_password") == "", (
        "un valor ilegible debe quedar vacío: jamás ciphertext a un servicio"
    )

    resp = client.post("/api/amule/test")

    assert resp.json() == {
        "ok": False,
        "detail": config.service_unavailable_reason("amule", "amule"),
    }
    assert _Recorder.instances == [], "con secreto roto no se abre ninguna conexión a aMule"
    assert SECRET not in resp.text
    assert "enc:" not in resp.text
