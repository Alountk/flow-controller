"""The login door: who gets a session, who keeps one, and who is kept out."""

from unittest.mock import patch

import pytest
from fastapi.testclient import TestClient

from app import app
from application import gateways
from infrastructure.auth_store import AuthStore
from interfaces.http import deps as deps_module

PASSWORD = "correct horse"
PROTECTED = "/api/auth/check"  # any verify_api_key route would do


@pytest.fixture
def store(tmp_path):
    s = AuthStore(tmp_path / "auth.db")
    with patch.object(gateways, "login", s):
        yield s


@pytest.fixture
def client(store):
    return TestClient(app)


def _login(client, password=PASSWORD, username="raul"):
    return client.post("/api/auth/login", json={"username": username, "password": password})


class TestOpenInstallStaysOpen:
    def test_without_a_user_or_key_the_data_routes_answer(self, client):
        assert client.get(PROTECTED).status_code == 200

    def test_me_says_no_auth_is_required(self, client):
        body = client.get("/api/auth/me").json()

        assert body == {"authenticated": True, "auth_required": False, "has_user": False}


class TestFirstRunRegister:
    def test_the_first_user_is_created_logged_in_and_the_app_closes(self, client):
        resp = client.post("/api/auth/register", json={"username": "raul", "password": PASSWORD})

        assert resp.status_code == 200
        assert client.get(PROTECTED).status_code == 200  # the cookie it just got
        assert TestClient(app).get(PROTECTED).status_code == 401  # a stranger

    def test_a_second_user_is_refused_and_the_first_still_logs_in(self, client):
        client.post("/api/auth/register", json={"username": "raul", "password": PASSWORD})

        again = TestClient(app).post(
            "/api/auth/register", json={"username": "intruder", "password": "intruder pass"}
        )

        assert again.status_code == 409
        assert _login(TestClient(app)).status_code == 200

    @pytest.mark.parametrize("username,password", [("raul", "short"), ("  ", "long enough pw")])
    def test_a_weak_user_is_a_400_and_nothing_closes(self, client, username, password):
        resp = client.post("/api/auth/register", json={"username": username, "password": password})

        assert resp.status_code == 400
        assert client.get(PROTECTED).status_code == 200


class TestExistingInstallWithAKey:
    """An install that already has an API key migrates by proving it owns it."""

    @pytest.fixture(autouse=True)
    def _key_is_set(self):
        with patch("infrastructure.settings_store.auth_required", return_value=True), patch.object(
            deps_module, "credentials"
        ) as creds:
            creds.verify_api_key.side_effect = lambda key, salt, stored: key == "the-key"
            yield

    def test_register_without_the_key_is_refused(self, client, store):
        resp = client.post("/api/auth/register", json={"username": "raul", "password": PASSWORD})

        assert resp.status_code == 401
        assert store.has_user() is False

    def test_register_with_the_key_creates_the_user(self, client, store):
        resp = client.post(
            "/api/auth/register",
            json={"username": "raul", "password": PASSWORD},
            headers={"X-Api-Key": "the-key"},
        )

        assert resp.status_code == 200
        assert store.has_user() is True

    def test_the_key_keeps_working_for_scripts_after_the_user_exists(self, client, store):
        store.create_user("raul", PASSWORD)

        assert TestClient(app).get(PROTECTED, headers={"X-Api-Key": "the-key"}).status_code == 200
        assert TestClient(app).get(PROTECTED, headers={"X-Api-Key": "wrong"}).status_code == 401
        assert TestClient(app).get(PROTECTED).status_code == 401


class TestLogin:
    @pytest.fixture(autouse=True)
    def _user(self, store):
        store.create_user("raul", PASSWORD)

    def test_a_wrong_password_is_a_401_with_no_cookie(self, client):
        resp = _login(client, password="wrong horse!!")

        assert resp.status_code == 401
        assert "fc_session" not in resp.headers.get("set-cookie", "")

    def test_the_right_login_sets_an_httponly_strict_cookie_that_opens_the_app(self, client):
        resp = _login(client)

        cookie = resp.headers["set-cookie"].lower()
        assert resp.status_code == 200
        assert "fc_session=" in cookie and "httponly" in cookie and "samesite=strict" in cookie
        assert "secure" not in cookie
        assert client.get(PROTECTED).status_code == 200

    def test_the_cookie_is_secure_behind_an_https_proxy(self, client):
        resp = client.post(
            "/api/auth/login",
            json={"username": "raul", "password": PASSWORD},
            headers={"X-Forwarded-Proto": "https"},
        )

        assert "secure" in resp.headers["set-cookie"].lower()

    def test_logout_closes_the_session_server_side(self, client):
        _login(client)
        token = client.cookies.get("fc_session")

        client.post("/api/auth/logout")

        stolen = TestClient(app)
        stolen.cookies.set("fc_session", token)
        assert stolen.get(PROTECTED).status_code == 401

    def test_me_reports_the_session_without_spending_the_failure_budget(self, client):
        before = [TestClient(app).get("/api/auth/me") for _ in range(15)]
        assert all(r.status_code == 200 and r.json()["authenticated"] is False for r in before)

        _login(client)
        assert client.get("/api/auth/me").json()["authenticated"] is True

    def test_guessing_is_throttled_by_the_failure_budget(self, client):
        codes = [_login(client, password=f"guess number {i}").status_code for i in range(12)]

        assert codes[:10] == [401] * 10
        assert 429 in codes[10:]


class TestCrossSiteWrites:
    @pytest.fixture(autouse=True)
    def _user(self, store):
        store.create_user("raul", PASSWORD)

    def test_a_cookie_write_from_another_origin_is_refused(self, client):
        _login(client)

        resp = client.post("/api/files/mkdir", json={"remote_path": ""},
                           headers={"Origin": "https://evil.example"})

        assert resp.status_code == 403

    def test_a_cookie_write_from_the_same_origin_gets_through_the_edge(self, client):
        _login(client)

        resp = client.post("/api/files/mkdir", json={"remote_path": ""},
                           headers={"Origin": "http://testserver"})

        assert resp.status_code != 403


class _BrokenStore:
    def has_user(self):
        raise OSError("auth.db is unreadable")

    def session_valid(self, token):
        raise OSError("auth.db is unreadable")

    def verify_login(self, username, password):
        import sqlite3

        raise sqlite3.DatabaseError("file is not a database")


class TestAnUnreadableStoreFailsClosed:
    """A locked, corrupt or unreadable auth.db must never open a gated install."""

    @pytest.fixture(autouse=True)
    def _broken(self):
        with patch.object(gateways, "login", _BrokenStore()):
            yield

    def test_data_routes_stay_closed(self):
        resp = TestClient(app).get(PROTECTED)

        assert resp.status_code == 401

    def test_me_reports_that_auth_is_required(self):
        body = TestClient(app).get("/api/auth/me").json()

        assert body["auth_required"] is True and body["authenticated"] is False

    def test_a_login_attempt_is_a_503_not_a_500(self):
        resp = _login(TestClient(app))

        assert resp.status_code == 503


class TestTheUnauthorizedText:
    def test_a_login_only_install_says_not_authenticated(self, client, store):
        store.create_user("raul", PASSWORD)

        assert TestClient(app).get(PROTECTED).json()["detail"] == "No autenticado"

    def test_an_install_with_a_key_keeps_the_text_clients_match_on(self, client, store):
        store.create_user("raul", PASSWORD)
        with patch("infrastructure.settings_store.auth_required", return_value=True), patch.object(
            deps_module, "credentials"
        ) as creds:
            creds.verify_api_key.return_value = False
            no_header = TestClient(app).get(PROTECTED)
            wrong_key = TestClient(app).get(PROTECTED, headers={"X-Api-Key": "nope"})

        assert no_header.json()["detail"] == "API key inválida"
        assert wrong_key.json()["detail"] == "API key inválida"
