"""Tests for `infrastructure.docker_client` — the Docker seam (amule-watchdog T1).

No real Docker anywhere: an in-process stub (`socketserver` + `http.server` over
a throwaway unix socket) answers `GET /containers/json` and the one fixed
restart shape, and records every request line so the tests can also prove no
other endpoint is ever touched (S8). The typed failures — socket absent,
empty/ambiguous detection, engine HTTP error, gone container, invalid response,
timeout — are the fail-closed contract the watchdog builds on (S4).
"""

from __future__ import annotations

import http.server
import json
import os
import re
import shutil
import socketserver
import tempfile
import threading
import time

import pytest

from infrastructure import settings_store
from infrastructure.docker_client import (
    CONNECT_TIMEOUT_S,
    DEFAULT_RESTART_STOP_TIMEOUT_S,
    DOCKER_SOCKET_PATH,
    READ_TIMEOUT_S,
    DockerClient,
    DockerConnectionError,
    DockerContainerGoneError,
    DockerEngineError,
    DockerProtocolError,
    DockerResolutionError,
    DockerTimeoutError,
)

# The restart may only ever be this shape: POST /containers/{id}/restart?t=<secs>
RESTART_SHAPE = re.compile(r"^POST /containers/[A-Za-z0-9_.-]{1,128}/restart\?t=\d+$")


# --- In-process Docker Engine stub over a unix socket -----------------------


class _StubHandler(http.server.BaseHTTPRequestHandler):
    def _dispatch(self) -> None:
        stub = self.server.stub
        stub.requests.append(f"{self.command} {self.path}")
        status, body = stub.responder(self.command, self.path)
        payload = body.encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(payload)))
        self.end_headers()
        self.wfile.write(payload)

    do_GET = do_POST = _dispatch

    def log_message(self, *args) -> None:
        pass  # keep pytest output readable


class _StubServer(socketserver.ThreadingMixIn, socketserver.UnixStreamServer):
    daemon_threads = True

    def handle_error(self, request, client_address) -> None:
        pass  # a timed-out client abandons the socket mid-response; noise, not a failure


class DockerStub:
    """Recording Engine API stand-in; `responder(method, path) -> (status, body)`."""

    def __init__(self, socket_path: str, server: _StubServer) -> None:
        self.socket_path = socket_path
        self.requests: list[str] = []
        self.responder = lambda method, path: (200, "[]")
        server.stub = self


@pytest.fixture
def docker_stub():
    base = tempfile.mkdtemp(prefix="dc-")
    if len(os.path.join(base, "d.sock")) > 90:
        # AF_UNIX paths cap near 104 bytes; a deep system temp dir can eat most of it.
        shutil.rmtree(base, ignore_errors=True)
        base = tempfile.mkdtemp(prefix="dc-", dir="/tmp")
    server = _StubServer(os.path.join(base, "d.sock"), _StubHandler)
    stub = DockerStub(server.server_address, server)
    thread = threading.Thread(
        target=server.serve_forever, kwargs={"poll_interval": 0.02}, daemon=True
    )
    thread.start()
    try:
        yield stub
    finally:
        server.shutdown()
        server.server_close()
        thread.join(timeout=2)
        shutil.rmtree(base, ignore_errors=True)


@pytest.fixture
def hermetic_settings(monkeypatch):
    # `get_setting` reads settings_store._settings; pinning it keeps a real
    # settings.json on the developer machine out of these tests.
    monkeypatch.setattr(settings_store, "_settings", {"services": {"amule": {}}})
    monkeypatch.delenv("AMULE_CONTAINER", raising=False)


def make_client(stub: DockerStub) -> DockerClient:
    return DockerClient(socket_path=stub.socket_path, connect_timeout_s=1.0, read_timeout_s=1.0)


def container(cid: str, name: str, image: str) -> dict:
    return {"Id": cid, "Names": [f"/{name}"], "Image": image, "State": "running"}


def json_body(containers: list[dict]):
    return (200, json.dumps(containers))


# --- (a) socket missing → fail-closed reason --------------------------------


def test_socket_absent_fails_closed_with_reason(hermetic_settings, tmp_path):
    missing = tmp_path / "absent.sock"
    client = DockerClient(socket_path=str(missing))

    with pytest.raises(DockerConnectionError) as excinfo:
        client.resolve_container()

    assert "absent.sock" in excinfo.value.reason


# --- (b) AMULE_CONTAINER set → that name, fixed restart shape ---------------


def test_env_container_name_resolves_and_restarts_fixed_shape(
    hermetic_settings, monkeypatch, docker_stub
):
    monkeypatch.setenv("AMULE_CONTAINER", "amule-prod")

    def responder(method, path):
        if method == "GET":
            return json_body(
                [
                    container("id-b", "amule-backup", "amule:latest"),
                    container("id-prod", "amule-prod", "amule:latest"),
                ]
            )
        return (204, "")

    docker_stub.responder = responder
    client = make_client(docker_stub)

    ref = client.resolve_container()
    client.restart_container(ref.id)

    # The restart carries the engine Id (never the raw configured name).
    assert ref.id == "id-prod"
    assert RESTART_SHAPE.fullmatch(docker_stub.requests[1])
    assert docker_stub.requests == [
        "GET /containers/json",
        f"POST /containers/id-prod/restart?t={DEFAULT_RESTART_STOP_TIMEOUT_S}",
    ]


# --- (c) unique /amule/i match when env absent ------------------------------


def test_unique_amule_match_without_env(hermetic_settings, docker_stub):
    def responder(method, path):
        if method == "GET":
            return json_body(
                [
                    container("id-qb", "qbittorrent", "linuxserver/qbittorrent"),
                    container("id-am", "amule-hp", "linuxserver/amule:latest"),
                ]
            )
        return (204, "")

    docker_stub.responder = responder
    client = make_client(docker_stub)

    ref = client.resolve_container()
    client.restart_container(ref.id, stop_timeout_s=30)

    assert ref.id == "id-am"
    assert docker_stub.requests == [
        "GET /containers/json",
        "POST /containers/id-am/restart?t=30",
    ]


# --- (d) ambiguous and empty → typed error, no restart attempted ------------


def test_two_matches_is_fail_closed_with_no_restart(hermetic_settings, docker_stub):
    docker_stub.responder = lambda m, p: json_body(
        [
            container("id-1", "amule-main", "amule/amule:latest"),
            container("id-2", "amule-spare", "linuxserver/amule"),
        ]
    )
    client = make_client(docker_stub)

    with pytest.raises(DockerResolutionError) as excinfo:
        client.resolve_container()

    reason = excinfo.value.reason
    assert "ambiguous" in reason
    assert "amule-main" in reason and "amule-spare" in reason
    assert docker_stub.requests == ["GET /containers/json"]


def test_zero_matches_is_fail_closed_with_no_restart(hermetic_settings, docker_stub):
    docker_stub.responder = lambda m, p: json_body(
        [container("id-qb", "qbittorrent", "linuxserver/qbittorrent")]
    )
    client = make_client(docker_stub)

    with pytest.raises(DockerResolutionError) as excinfo:
        client.resolve_container()

    assert "no running container" in excinfo.value.reason
    assert docker_stub.requests == ["GET /containers/json"]


# --- (e) engine HTTP 500 → typed failure with status in reason --------------


def test_engine_http_error_reports_status_in_reason(hermetic_settings, docker_stub):
    def responder(method, path):
        if method == "GET":
            return json_body([container("id-am", "amule-hp", "amule:latest")])
        return (500, json.dumps({"message": "boom"}))

    docker_stub.responder = responder
    client = make_client(docker_stub)
    ref = client.resolve_container()

    with pytest.raises(DockerEngineError) as excinfo:
        client.restart_container(ref.id)

    assert excinfo.value.status == 500
    assert "500" in excinfo.value.reason and "boom" in excinfo.value.reason


# --- Triangulation: the corners that protect the contract -------------------


def test_name_match_alone_is_not_enough(hermetic_settings, docker_stub):
    docker_stub.responder = lambda m, p: json_body(
        [container("id-x", "amule", "ubuntu:24.04")]
    )
    client = make_client(docker_stub)

    with pytest.raises(DockerResolutionError):
        client.resolve_container()

    assert docker_stub.requests == ["GET /containers/json"]


def test_missing_named_container_fails_closed(hermetic_settings, monkeypatch, docker_stub):
    monkeypatch.setenv("AMULE_CONTAINER", "ghost")
    docker_stub.responder = lambda m, p: json_body(
        [container("id-am", "amule-hp", "amule:latest")]
    )
    client = make_client(docker_stub)

    with pytest.raises(DockerResolutionError) as excinfo:
        client.resolve_container()

    assert "ghost" in excinfo.value.reason
    assert docker_stub.requests == ["GET /containers/json"]


def test_gone_container_on_restart_is_typed(hermetic_settings, docker_stub):
    def responder(method, path):
        if method == "GET":
            return json_body([container("id-am", "amule-hp", "amule:latest")])
        return (404, json.dumps({"message": "No such container"}))

    docker_stub.responder = responder
    client = make_client(docker_stub)
    ref = client.resolve_container()

    with pytest.raises(DockerContainerGoneError) as excinfo:
        client.restart_container(ref.id)

    assert isinstance(excinfo.value, DockerEngineError)
    assert "404" in excinfo.value.reason


def test_invalid_engine_body_is_protocol_error(hermetic_settings, docker_stub):
    docker_stub.responder = lambda m, p: (200, "esto no es json")
    client = make_client(docker_stub)

    with pytest.raises(DockerProtocolError):
        client.resolve_container()


def test_settings_container_name_wins_over_env(hermetic_settings, monkeypatch, docker_stub):
    monkeypatch.setattr(
        settings_store,
        "_settings",
        {"services": {"amule": {"container": "from-settings"}}},
    )
    monkeypatch.setenv("AMULE_CONTAINER", "from-env")
    docker_stub.responder = lambda m, p: json_body(
        [
            container("id-env", "from-env", "amule:latest"),
            container("id-set", "from-settings", "amule:latest"),
        ]
    )
    client = make_client(docker_stub)

    assert client.resolve_container().id == "id-set"


def test_restart_arguments_enforce_fixed_shape(hermetic_settings, docker_stub):
    client = make_client(docker_stub)

    with pytest.raises(ValueError):
        client.restart_container("bad/id?x=1")
    with pytest.raises(ValueError):
        client.restart_container("id-ok", stop_timeout_s=-1)

    assert docker_stub.requests == []


def test_read_timeout_is_typed(hermetic_settings, docker_stub):
    def responder(method, path):
        time.sleep(0.6)
        return json_body([])

    docker_stub.responder = responder
    client = DockerClient(
        socket_path=docker_stub.socket_path, connect_timeout_s=1.0, read_timeout_s=0.15
    )

    with pytest.raises(DockerTimeoutError):
        client.resolve_container()


def test_default_socket_and_short_timeouts():
    assert DOCKER_SOCKET_PATH == "/var/run/docker.sock"
    assert 0 < CONNECT_TIMEOUT_S <= 2.0
    assert 0 < READ_TIMEOUT_S <= 10.0
