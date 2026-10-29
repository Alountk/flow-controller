"""Servicio de servidores de aMule (T2/S3): una conexión por operación y
direcciones «host:puerto» que el core pueda usar.

El core sólo admite binario en `EC_TAG_SERVER` (resuelve con
`GetServerByIPTCP`), así que remove/connect resuelven nombres AQUÍ
(`socket.getaddrinfo`) y todo lo inutilizable sube como `ValueError` en
español nombrando el fallo. ADD viaja verbatim: el core parsea «ip:puerto»
por su cuenta. Ningún test abre red real.
"""

from __future__ import annotations

import socket

import pytest

import config
from infrastructure import amule_service
from infrastructure.amule_ec_client import (
    EC_OP_SERVER_LIST,
    EC_TAGTYPE_UINT8,
    EC_TAGTYPE_UINT32,
    EC_TAG_SERVER,
    EC_TAG_SERVER_FAILED,
    EC_TAG_SERVER_NAME,
    EC_TAG_SERVER_USERS,
    ECTag,
    AmuleECClient,
    AmuleECProtocolError,
    encode_ipv4_tag,
)


class FakeClient:
    """Sustituto de AmuleECClient: registra operaciones, sin red."""

    instances: list["FakeClient"] = []
    rows = [{"name": "MiServer", "address": "1.2.3.4:4662", "failed": False}]

    def __init__(self, host, port, password, **kwargs):
        self.calls: list[tuple] = []
        self.closed = False
        FakeClient.instances.append(self)

    def __enter__(self):
        self.connect()
        return self

    def __exit__(self, *_exc):
        self.close()
        return False

    def connect(self):
        self.calls.append(("connect",))

    def close(self):
        self.closed = True

    def server_list(self):
        self.calls.append(("server_list",))
        return list(FakeClient.rows)

    def server_add(self, address, name=""):
        self.calls.append(("server_add", address, name))

    def server_remove(self, ipv4, port):
        self.calls.append(("server_remove", ipv4, port))

    def server_connect(self, ipv4, port):
        self.calls.append(("server_connect", ipv4, port))


@pytest.fixture(autouse=True)
def _fresh_fakes(monkeypatch):
    FakeClient.instances.clear()
    monkeypatch.setattr(amule_service, "AmuleECClient", FakeClient)
    monkeypatch.setattr(config, "AMULE_URL", "tcp://amule.test:4711")
    monkeypatch.setattr(config, "AMULE_EC_PORT", "9999")
    monkeypatch.setattr(config, "AMULE_EC_PASSWORD", "deadbeefdeadbeefdeadbeefdeadbeef")
    yield


# ── Una conexión por operación (el patrón de amule_search/amule_add_ed2k) ────


def test_servers_lists_the_core_rows_in_one_closed_connection():
    assert amule_service.amule_servers() == FakeClient.rows
    assert len(FakeClient.instances) == 1
    client = FakeClient.instances[0]
    assert ("server_list",) in client.calls
    assert client.closed


def test_add_forwards_the_address_verbatim():
    """ADD no parsea nada: «MiServidor:4662» viaja tal cual al core."""
    amule_service.amule_server_add("MiServidor:4662", "MiServer")
    assert FakeClient.instances[0].calls[-1] == ("server_add", "MiServidor:4662", "MiServer")


def test_remove_splits_on_the_last_colon():
    amule_service.amule_server_remove("1.2.3.4:4662")
    assert FakeClient.instances[0].calls[-1] == ("server_remove", "1.2.3.4", 4662)


def test_connect_resolves_a_hostname_before_building_the_ipv4_tag(monkeypatch):
    monkeypatch.setattr(amule_service.socket, "getaddrinfo", _resolving("9.9.9.9"))
    amule_service.amule_server_connect("servidor.tld:4662")
    assert FakeClient.instances[0].calls[-1] == ("server_connect", "9.9.9.9", 4662)


def _resolving(ip: str):
    def fake(host, port, family=0, type=0, proto=0, flags=0):
        return [(socket.AF_INET, socket.SOCK_STREAM, 6, "", (ip, 0))]

    return fake


# ── Direcciones inutilizables: ValueError en español, sin llegar al cliente ──


@pytest.mark.parametrize(
    "address, fragment",
    [
        ("1.2.3.4", "puerto"),  # sin puerto
        ("1.2.3.4:", "puerto"),  # puerto vacío
        ("1.2.3.4:abc", "puerto"),  # puerto no numérico
        ("1.2.3.4:0", "rango"),  # puerto 0
        ("1.2.3.4:70000", "rango"),  # puerto fuera de rango
    ],
)
def test_malformed_addresses_raise_value_error_naming_the_problem(address, fragment):
    with pytest.raises(ValueError) as excinfo:
        amule_service.amule_server_remove(address)
    message = str(excinfo.value)
    assert "dirección inválida" in message
    assert fragment in message
    assert not FakeClient.instances  # ni se abre la conexión


def test_an_unresolvable_host_names_the_host(monkeypatch):
    def failing(*args, **kwargs):
        raise socket.gaierror("name or service not known")

    monkeypatch.setattr(amule_service.socket, "getaddrinfo", failing)
    with pytest.raises(ValueError) as excinfo:
        amule_service.amule_server_connect("no.existe.tld:4662")
    assert "no.existe.tld" in str(excinfo.value)
    assert not FakeClient.instances


# ── Fail-closed sin configurar (la razón compartida de la casa) ──────────────


@pytest.mark.parametrize(
    "fn,args",
    [
        (amule_service.amule_servers, ()),
        (amule_service.amule_server_add, ("1.2.3.4:4662",)),
        (amule_service.amule_server_remove, ("1.2.3.4:4662",)),
        (amule_service.amule_server_connect, ("1.2.3.4:4662",)),
    ],
)
def test_unconfigured_raises_the_not_configured_reason(monkeypatch, fn, args):
    monkeypatch.setattr(config, "AMULE_URL", "")
    monkeypatch.setattr(config, "AMULE_EC_PASSWORD", "")
    with pytest.raises(RuntimeError, match="no está configurado"):
        fn(*args)


# ── Respuesta EC_OP_SERVER_LIST: sólo lo que el core envía ───────────────────


def _client_with_reply(tags) -> tuple[AmuleECClient, list]:
    """Cliente sin red cuya próxima respuesta es `EC_OP_SERVER_LIST` + `tags`."""
    client = AmuleECClient("1.2.3.4", 4712, "x")
    sent: list = []
    client._send = sent.append  # type: ignore[method-assign]
    client._recv_frame = lambda: (EC_OP_SERVER_LIST, list(tags))  # type: ignore[method-assign]
    return client, sent


def test_a_server_row_defaults_its_name_to_the_address_and_omits_absent_stats():
    entry = ECTag(EC_TAG_SERVER, 8, b"\x01\x02\x03\x04\x12\x36")
    client, _ = _client_with_reply([entry])
    # Sin nombre → «ip:puerto»; sin FAILED → False; y NINGÚN cero inventado.
    assert client.server_list() == [
        {"name": "1.2.3.4:4662", "address": "1.2.3.4:4662", "failed": False}
    ]


def test_a_server_row_carries_name_failed_and_only_the_stats_that_exist():
    entry = ECTag(
        EC_TAG_SERVER,
        8,
        b"\x01\x02\x03\x04\x12\x36",
        subtags=(
            ECTag(EC_TAG_SERVER_NAME, 6, b"MiServer\x00"),
            ECTag(EC_TAG_SERVER_FAILED, EC_TAGTYPE_UINT8, b"\x02"),
            ECTag(EC_TAG_SERVER_USERS, EC_TAGTYPE_UINT32, (1234).to_bytes(4, "big")),
        ),
    )
    client, sent = _client_with_reply([entry])
    assert client.server_list() == [
        {"name": "MiServer", "address": "1.2.3.4:4662", "failed": True, "users": 1234}
    ]
    # La petición fue GET_SERVER_LIST con DETAIL_LEVEL (byte a byte lo fija
    # tests_amule_ec_servers); aquí sólo se comprueba que se mandó.
    assert len(sent) == 1


def test_a_foreign_response_opcode_is_a_protocol_error():
    client = AmuleECClient("1.2.3.4", 4712, "x")
    client._send = lambda frame: None  # type: ignore[method-assign]
    client._recv_frame = lambda: (0x01, [])  # type: ignore[method-assign]
    with pytest.raises(AmuleECProtocolError):
        client.server_list()


def test_encode_ipv4_tag_rejects_a_non_numeric_ip_in_spanish():
    with pytest.raises(ValueError) as excinfo:
        encode_ipv4_tag(EC_TAG_SERVER, "servidor.tld", 4662)
    assert "dirección inválida" in str(excinfo.value)
