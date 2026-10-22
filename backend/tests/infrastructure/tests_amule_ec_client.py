"""Cliente EC de aMule: framing, autenticación, búsqueda y ops de cola (S1/T2, S7).

Contrato fijado aquí byte a byte (fixtures literales; sin red real, sin `.env`):

- frame = u32 flags (base 0x20) + u32 longitud del payload, big-endian; payload =
  u8 opcode + u16 nº de tags + tags. Tag = u16 ((código<<1) | bit0=tiene subtags)
  + u8 tipo + u32 taglen (incluye el tamaño cable de las subtags) + [u16 nº de
  subtags si bit0] + subtags + dato propio. Strings = UTF-8 + NUL final contado
  en el u32 taglen (sin longitud interna). Enteros en el tipo más estrecho posible
  (UINT8/16/32/64 = tipos 2/3/4/5; el lector es agnóstico de ancho).
- Auth de 3 pasos: `EC_OP_AUTH_REQ 0x02` (CLIENT_NAME 0x0100 + CLIENT_VERSION
  0x0101 strings + PROTOCOL_VERSION 0x0002 u16 = 0x0204) → `EC_OP_AUTH_SALT 0x4F`
  (PASSWD_SALT 0x000B u64) → `EC_OP_AUTH_PASSWD 0x50` (PASSWD_HASH 0x0001 HASH16)
  con digest = md5( md5pw + md5_hex("%lX" % salt) ). Vector de la spec: password
  "amule", salt 0x85E4BA4461965156 → digest 9dd41c0b85c8b7cd0a0b1a8ecf9f5d29.
  Si la contraseña ya es un md5-hex de 32 chars se usa TAL CUAL como primer
  término (sin re-hashear). Éxito = `EC_OP_AUTH_OK 0x04` (SERVER_VERSION 0x050B);
  `EC_OP_AUTH_FAIL 0x03` / `EC_OP_FAILED 0x05` → excepción tipada.
- Búsqueda: `EC_OP_SEARCH_START 0x26` con EXACTAMENTE un tag envoltorio
  `EC_TAG_SEARCH_TYPE 0x0701` (dato propio u32 = modo) y subtags
  `EC_TAG_SEARCH_NAME 0x0702` + `EC_TAG_SEARCH_FILE_TYPE 0x0705` (strings; el
  vacío = sin filtrar). Poll de `EC_OP_SEARCH_PROGRESS 0x29`
  (`EC_TAG_SEARCH_STATUS 0x0708`) y `EC_OP_SEARCH_RESULTS 0x28` con
  DETAIL_LEVEL = EC_DETAIL_FULL (0x02) → tags `EC_TAG_SEARCHFILE 0x0700` con
  subtags 0x0301 nombre, 0x0303 tamaño, 0x031e hash MD4, 0x030a/0x030d fuentes,
  0x0308 estado. Cierre con `EC_OP_SEARCH_STOP 0x27` sin parámetros.
- Ops: `EC_OP_ADD_LINK 0x09` (tag STRING 0x0000 = enlace ed2k, subtag
  `EC_TAG_PARTFILE_CAT 0x030F`); cola por hash (tag `EC_TAG_PARTFILE 0x0300`
  HASH16): `EC_OP_PARTFILE_PAUSE 0x19` / `EC_OP_PARTFILE_RESUME 0x1A` /
  `EC_OP_PARTFILE_PRIO_SET 0x1C` (subtag 0x0309) / `EC_OP_PARTFILE_SET_CAT 0x1E`
  (subtag 0x030F) / `EC_OP_PARTFILE_DELETE 0x1D`; descarga de resultado
  `EC_OP_DOWNLOAD_SEARCH_RESULT 0x2A` (subtag 0x030F). Todo `EC_OP_FAILED` sube
  como excepción tipada; errores de conexión/timeout idem. Nada de esto imprime
  ni devuelve contraseñas ni hashes.
"""

import pytest

from infrastructure.amule_ec_client import (
    EC_DETAIL_CMD,
    EC_DETAIL_FULL,
    EC_DETAIL_WEB,
    EC_OP_ADD_LINK,
    EC_OP_DOWNLOAD_SEARCH_RESULT,
    EC_OP_FAILED,
    EC_OP_MISC_DATA,
    EC_OP_NOOP,
    EC_OP_PARTFILE_DELETE,
    EC_OP_PARTFILE_PAUSE,
    EC_OP_PARTFILE_PRIO_SET,
    EC_OP_PARTFILE_RESUME,
    EC_OP_PARTFILE_SET_CAT,
    EC_OP_SEARCH_PROGRESS,
    EC_OP_SEARCH_RESULTS,
    EC_OP_SEARCH_START,
    EC_OP_SEARCH_STOP,
    EC_SEARCH_GLOBAL,
    EC_SEARCH_KAD,
    EC_SEARCH_LOCAL,
    EC_SEARCH_PROGRESS_DONE,
    EC_TAGTYPE_CUSTOM,
    EC_TAGTYPE_DOUBLE,
    EC_TAGTYPE_HASH16,
    EC_TAGTYPE_IPV4,
    EC_TAGTYPE_STRING,
    EC_TAGTYPE_UINT128,
    EC_TAGTYPE_UINT16,
    EC_TAGTYPE_UINT32,
    EC_TAGTYPE_UINT64,
    EC_TAGTYPE_UINT8,
    AmuleECClient,
    AmuleECCommandError,
    AmuleECConnectionError,
    AmuleECError,
    AmuleECAuthError,
    AmuleECProtocolError,
    AmuleECTimeoutError,
    SearchResult,
    build_add_link,
    build_auth_request,
    build_partfile_delete,
    build_partfile_pause,
    build_partfile_resume,
    build_partfile_set_category,
    build_partfile_set_priority,
    build_passwd_response,
    build_download_search_result,
    build_search_progress,
    build_search_results,
    build_search_start,
    build_search_stop,
    compute_passwd_hash,
    decode_frame,
    encode_frame,
    encode_string_tag,
    encode_tag,
    encode_uint_tag,
)

# ---------------------------------------------------------------------------
# Fixtures byte a byte (hex literal; generadas a mano desde la spec + probe).
# ---------------------------------------------------------------------------

#: AUTH_REQ con client_name "flow-controller", client_version "0.1".
AUTH_REQ = (
    "000000200000002e02000302000600000010666c6f772d636f6e74726f6c6c6572"
    "0002020600000004302e3100000403000000020204"
)
#: AUTH_PASSWD con el digest del vector de la spec (password "amule").
AUTH_PASSWD_AMULE = "000000200000001a500001000209000000109dd41c0b85c8b7cd0a0b1a8ecf9f5d29"
#: AUTH_PASSWD cuando la contraseña ya es md5-hex (primer término verbatim).
AUTH_PASSWD_VERBATIM = "000000200000001a50000100020900000010c026c9ce0f30018c5a5eebf0ad7fdb69"
#: Respuesta AUTH_SALT con salt 0x85E4BA4461965156 (u64).
AUTH_SALT_REPLY = "00000020000000124f00010016050000000885e4ba4461965156"
#: Respuesta AUTH_OK con EC_TAG_SERVER_VERSION "3.0.1".
AUTH_OK_REPLY = "00000020000000100400010a160600000006332e302e3100"
#: Respuesta AUTH_FAIL con mensaje del servidor.
AUTH_FAIL_REPLY = (
    "00000020000000200300010000060000001641757468656e7469636174696f6e20666169"
    "6c656400"
)
#: EC_OP_FAILED con EC_TAG_STRING "Invalid link or already on list.".
FAILED_REPLY = (
    "000000200000002b05000100000600000021496e76616c6964206c696e6b206f7220616c"
    "7265616479206f6e206c6973742e00"
)
#: EC_OP_NOOP (éxito de las ops de cola / ADD_LINK).
NOOP_REPLY = "0000002000000003010000"
#: EC_OP_MISC_DATA (respuesta de SEARCH_STOP en el camino single-search).
MISC_DATA_REPLY = "0000002000000003070000"
#: EC_OP_STRINGS "Search in progress. Refetch results in a moment!".
STRINGS_REPLY = (
    "000000200000003b0600010000060000003153656172636820696e2070726f67726573732e"
    "205265666574636820726573756c747320696e2061206d6f6d656e742100"
)
#: SEARCH_START "ubuntu" modo GLOBAL(1), file_type "" — envoltorio único.
SEARCH_START_UBUNTU = (
    "00000020000000262600010e03040000001a00020e0406000000077562756e7475"
    "000e0a06000000010000000001"
)
#: SEARCH_START "iso" modo KAD(2) con todos los opcionales del builder.
SEARCH_START_OPTS = (
    "00000020000000532600010e03040000004700060e04060000000469736f000e0a"
    "0600000006566964656f000e0c06000000046d7034000e0e0200000001050e0603"
    "0000000204000e080500000008000000010000000000000002"
)
#: Poll de progreso sin parámetros.
SEARCH_PROGRESS_REQ = "0000002000000003290000"
#: SEARCH_STOP sin parámetros (camino single-search legacy).
SEARCH_STOP_REQ = "0000002000000003270000"
#: Petición de resultados con EC_TAG_DETAIL_LEVEL = EC_DETAIL_FULL (0x02).
SEARCH_RESULTS_REQ = "000000200000000b2800010008020000000102"
#: Respuesta de progreso con EC_TAG_SEARCH_STATUS = 37 (u16).
PROGRESS_REPLY_37 = "000000200000000c2900010e1003000000020025"
#: Respuesta de progreso con barra 0xFFFF (búsqueda terminada).
PROGRESS_REPLY_DONE = "000000200000000c2900010e100300000002ffff"
#: Respuesta SEARCH_RESULTS real con dos ficheros (anchos de entero variados a
#: propósito: el lector es agnóstico de ancho).
SEARCH_RESULTS_REPLY = (
    "00000020000000d82800020e01040000006c00060602060000001f7562756e74752d3234"
    "2e30342d6465736b746f702d616d6436342e69736f00060605000000080000000141986000"
    "063c09000000100102030405060708090a0b0c0d0e0f1006140300000002002a061a040000"
    "00040000000706100200000001050000002a0e010400000057000506020600000016446562"
    "69616e203132206e6574696e73742e69736f000606040000000428775000063c0900000010"
    "100f0e0d0c0b0a090807060504030201061404000000040000012c061a0300000002000c00"
    "00002b"
)
#: ADD_LINK con enlace ed2k y subtag PARTFILE_CAT = 7.
ADD_LINK_CAT7 = (
    "0000002000000052090001000106000000460001061e0200000001076564326b3a2f2f7c"
    "66696c657c746573742e62696e7c313032347c303031313232333334343535363637373838"
    "39396161626263636464656566667c2f00"
)
#: ADD_LINK sin categoría.
ADD_LINK_NO_CAT = (
    "00000020000000480900010000060000003e6564326b3a2f2f7c66696c657c746573742e62"
    "696e7c313032347c3030313132323333343435353636373738383939616162626363646465"
    "6566667c2f00"
)
#: PAUSE sobre el hash 00112233445566778899aabbccddeeff.
PAUSE = "000000200000001a1900010600090000001000112233445566778899aabbccddeeff"
#: RESUME sobre el mismo hash.
RESUME = "000000200000001a1a00010600090000001000112233445566778899aabbccddeeff"
#: PRIO_SET con prioridad 3 (u8 en el subtag 0x0309).
PRIO3 = (
    "00000020000000241c00010601090000001800010612020000000103001122334455667788"
    "99aabbccddeeff"
)
#: SET_CAT con categoría 5 (u8 en el subtag 0x030F).
CAT5 = (
    "00000020000000241e0001060109000000180001061e020000000105001122334455667788"
    "99aabbccddeeff"
)
#: DELETE por hash.
DELETE = "000000200000001a1d00010600090000001000112233445566778899aabbccddeeff"
#: DOWNLOAD_SEARCH_RESULT con categoría 7.
DOWNLOAD_RESULT_CAT7 = (
    "00000020000000242a0001060109000000180001061e020000000107001122334455667788"
    "99aabbccddeeff"
)
#: DOWNLOAD_SEARCH_RESULT sin categoría.
DOWNLOAD_RESULT_NO_CAT = (
    "000000200000001a2a00010600090000001000112233445566778899aabbccddeeff"
)

HASH_HEX = "00112233445566778899aabbccddeeff"
LINK = "ed2k://|file|test.bin|1024|00112233445566778899aabbccddeeff|/"
#: Credenciales falsas: jamás se leen de `.env.local` en los tests.
FAKE_PASSWORD = "amule"
FAKE_MD5_PASSWORD = "0123456789abcdef0123456789abcdef"
SALT = 0x85E4BA4461965156


class FakeSocket:
    """Socket simulado: nunca abre red; `recv` sirve los frames encolados."""

    def __init__(self, replies=(), recv_error=None):
        self._buf = b"".join(bytes.fromhex(r) for r in replies)
        self._recv_error = recv_error
        self.sent = []
        self.timeout = None
        self.closed = False

    def sendall(self, data):
        self.sent.append(bytes(data))

    def recv(self, n):
        if self._recv_error is not None:
            raise self._recv_error
        if not self._buf:
            return b""
        chunk, self._buf = self._buf[:n], self._buf[n:]
        return chunk

    def settimeout(self, timeout):
        self.timeout = timeout

    def close(self):
        self.closed = True


@pytest.fixture(autouse=True)
def no_real_network(monkeypatch):
    """Red real prohibida: sin stub explícito, conectar es fallo del test."""

    def _guard(*args, **kwargs):
        raise AssertionError("los tests de amule_ec_client no pueden abrir red real")

    monkeypatch.setattr("infrastructure.amule_ec_client.socket.create_connection", _guard)


def _connect(monkeypatch, replies=(), recv_error=None, password=FAKE_PASSWORD, **kwargs):
    """Cliente conectado contra un FakeSocket que responde `replies`."""
    fake = FakeSocket(replies, recv_error=recv_error)
    monkeypatch.setattr(
        "infrastructure.amule_ec_client.socket.create_connection",
        lambda addr, timeout: fake,
    )
    client = AmuleECClient("127.0.0.1", 4712, password, **kwargs)
    client.connect()
    return client, fake


# ---------------------------------------------------------------------------
# Framing: u32 flags (0x20) + u32 longitud, big-endian; u8 opcode + u16 tags.
# ---------------------------------------------------------------------------


def test_frame_encode_noop_is_byte_exact():
    assert encode_frame(0x01, []).hex() == NOOP_REPLY


def test_protocol_codes_match_eccodes_abstract():
    """Códigos EXACTOS de `ECCodes.abstract`/`ECTagTypes.abstract` de
    amule-org/amule (fuente de verdad): ningún opcode ni tipo inventado."""
    assert EC_OP_NOOP == 0x01
    assert EC_OP_FAILED == 0x05
    assert EC_OP_MISC_DATA == 0x07
    assert EC_OP_ADD_LINK == 0x09
    assert EC_OP_PARTFILE_PAUSE == 0x19
    assert EC_OP_PARTFILE_RESUME == 0x1A
    assert EC_OP_PARTFILE_PRIO_SET == 0x1C
    assert EC_OP_PARTFILE_DELETE == 0x1D
    assert EC_OP_PARTFILE_SET_CAT == 0x1E
    assert EC_OP_SEARCH_START == 0x26
    assert EC_OP_SEARCH_STOP == 0x27
    assert EC_OP_SEARCH_RESULTS == 0x28
    assert EC_OP_SEARCH_PROGRESS == 0x29
    assert EC_OP_DOWNLOAD_SEARCH_RESULT == 0x2A
    assert EC_TAGTYPE_CUSTOM == 1
    assert EC_TAGTYPE_UINT8 == 2
    assert EC_TAGTYPE_UINT16 == 3
    assert EC_TAGTYPE_UINT32 == 4
    assert EC_TAGTYPE_UINT64 == 5
    assert EC_TAGTYPE_STRING == 6
    assert EC_TAGTYPE_DOUBLE == 7
    assert EC_TAGTYPE_IPV4 == 8
    assert EC_TAGTYPE_HASH16 == 9
    assert EC_TAGTYPE_UINT128 == 10
    assert (EC_SEARCH_LOCAL, EC_SEARCH_GLOBAL, EC_SEARCH_KAD) == (0x00, 0x01, 0x02)
    assert (EC_DETAIL_CMD, EC_DETAIL_WEB, EC_DETAIL_FULL) == (0x00, 0x01, 0x02)


def test_frame_decode_reads_flags_length_opcode_and_tag_count():
    opcode, tags = decode_frame(bytes.fromhex(SEARCH_START_UBUNTU))
    assert opcode == 0x26
    assert len(tags) == 1
    wrapper = tags[0]
    assert wrapper.code == 0x0701
    assert wrapper.as_int() == EC_SEARCH_GLOBAL
    assert [s.code for s in wrapper.subtags] == [0x0702, 0x0705]
    assert wrapper.subtags[0].as_str() == "ubuntu"
    assert wrapper.subtags[1].as_str() == ""


def test_frame_decode_rejects_inconsistent_length():
    broken = bytearray(bytes.fromhex(NOOP_REPLY))
    broken[7] = 0x2A  # longitud declarada imposible
    with pytest.raises(AmuleECProtocolError):
        decode_frame(bytes(broken))
    with pytest.raises(AmuleECProtocolError):
        decode_frame(bytes.fromhex(NOOP_REPLY)[:-1])  # truncado


# ---------------------------------------------------------------------------
# Tags: strings con NUL contado, subtags dentro del taglen, entero más estrecho.
# ---------------------------------------------------------------------------


def test_string_tag_counts_trailing_nul_in_length():
    tag = encode_string_tag(0x0702, "ubuntu")
    assert tag.hex() == "0e040600000007" + b"ubuntu\x00".hex()


def test_uint_tag_uses_narrowest_type():
    assert encode_uint_tag(0x0708, 5).hex() == "0e10020000000105"
    assert encode_uint_tag(0x0002, 0x0102).hex() == "000403000000020102"
    assert encode_uint_tag(0x0701, 0x10000).hex() == "0e02040000000400010000"
    assert encode_uint_tag(0x0701, 1 << 40).hex() == "0e0205000000080000010000000000"


def test_taglen_includes_wire_size_of_subtags():
    wrapper = encode_tag(
        0x0701,
        4,  # UINT32
        (1).to_bytes(4, "big"),
        children=[encode_string_tag(0x0702, "ubuntu"), encode_string_tag(0x0705, "")],
    )
    # 0x1a = 26 = tamaño cable de las dos subtags (14 + 8) + dato propio (4).
    assert wrapper.hex() == (
        "0e03040000001a00020e0406000000077562756e747500"
        "0e0a060000000100" + "00000001"
    )


def test_decode_search_results_fixture_field_by_field():
    opcode, tags = decode_frame(bytes.fromhex(SEARCH_RESULTS_REPLY))
    assert opcode == 0x28
    assert [t.code for t in tags] == [0x0700, 0x0700]
    first = tags[0]
    assert first.as_int() == 0x2A  # ECID propio del contenedor
    assert {s.code for s in first.subtags} == {0x0301, 0x0303, 0x031E, 0x030A, 0x030D, 0x0308}
    assert first.subtags[0].as_str() == "ubuntu-24.04-desktop-amd64.iso"
    assert first.subtags[1].as_int() == 5395472384  # u64, lector agnóstico de ancho


# ---------------------------------------------------------------------------
# Autenticación: vector de la spec y md5-hex verbatim.
# ---------------------------------------------------------------------------


def test_passwd_hash_matches_spec_vector():
    # Vector de la spec: password "amule", salt 0x85E4BA4461965156.
    assert compute_passwd_hash(FAKE_PASSWORD, SALT).hex() == "9dd41c0b85c8b7cd0a0b1a8ecf9f5d29"


def test_passwd_hash_uses_md5_hex_verbatim_as_first_term():
    # Un md5-hex de 32 chars NO se re-hashea: primer término = la cadena tal cual.
    assert compute_passwd_hash(FAKE_MD5_PASSWORD, SALT).hex() == "c026c9ce0f30018c5a5eebf0ad7fdb69"


def test_auth_handshake_follows_spec_vector(monkeypatch):
    client, fake = _connect(monkeypatch, replies=[AUTH_SALT_REPLY, AUTH_OK_REPLY])
    assert build_auth_request("flow-controller", "0.1").hex() == AUTH_REQ
    assert (
        build_passwd_response(bytes.fromhex("9dd41c0b85c8b7cd0a0b1a8ecf9f5d29")).hex()
        == AUTH_PASSWD_AMULE
    )
    assert fake.sent[0].hex() == AUTH_REQ
    assert fake.sent[1].hex() == AUTH_PASSWD_AMULE  # digest 9dd41c0b…
    assert fake.timeout == 20.0


def test_auth_ok_parses_server_version(monkeypatch):
    """`EC_OP_AUTH_OK 0x04` → connect() devuelve SERVER_VERSION (0x050B)."""
    fake = FakeSocket([AUTH_SALT_REPLY, AUTH_OK_REPLY])
    monkeypatch.setattr(
        "infrastructure.amule_ec_client.socket.create_connection",
        lambda addr, timeout: fake,
    )
    client = AmuleECClient("127.0.0.1", 4712, FAKE_PASSWORD)
    assert client.connect() == "3.0.1"


def test_auth_password_md5_hex_used_verbatim_as_first_term(monkeypatch):
    client, fake = _connect(
        monkeypatch,
        replies=[AUTH_SALT_REPLY, AUTH_OK_REPLY],
        password=FAKE_MD5_PASSWORD,
    )
    # El md5-hex NO se re-hashea: primer término = la cadena tal cual.
    assert fake.sent[1].hex() == AUTH_PASSWD_VERBATIM


def test_auth_fail_raises_typed_exception(monkeypatch):
    with pytest.raises(AmuleECAuthError) as excinfo:
        _connect(monkeypatch, replies=[AUTH_SALT_REPLY, AUTH_FAIL_REPLY])
    assert isinstance(excinfo.value, AmuleECError)


def test_failed_reply_surfaces_as_typed_exception(monkeypatch):
    client, fake = _connect(monkeypatch, replies=[AUTH_SALT_REPLY, AUTH_OK_REPLY, FAILED_REPLY])
    with pytest.raises(AmuleECCommandError) as excinfo:
        client.add_ed2k(LINK)
    assert "Invalid link or already on list." in str(excinfo.value)
    assert isinstance(excinfo.value, AmuleECError)


def test_errors_never_leak_password_or_hash(monkeypatch):
    secret = "fake-secret-pw-xyz"
    with pytest.raises(AmuleECError) as excinfo:
        _connect(monkeypatch, replies=[AUTH_SALT_REPLY, AUTH_FAIL_REPLY], password=secret)
    message = str(excinfo.value)
    assert secret not in message
    assert "9dd41c0b85c8b7cd0a0b1a8ecf9f5d29" not in message


# ---------------------------------------------------------------------------
# Búsqueda: envoltorio único SEARCH_TYPE, progreso, resultados, stop.
# ---------------------------------------------------------------------------


def test_search_start_packet_has_single_wrapper_tag(monkeypatch):
    assert build_search_start("ubuntu", EC_SEARCH_GLOBAL, file_type="").hex() == SEARCH_START_UBUNTU
    opcode, tags = decode_frame(bytes.fromhex(SEARCH_START_UBUNTU))
    assert opcode == 0x26
    assert len(tags) == 1  # EXACTAMENTE un tag envoltorio
    wrapper = tags[0]
    assert wrapper.code == 0x0701
    assert wrapper.as_int() == 1  # dato propio u32 = modo
    assert [(s.code, s.as_str()) for s in wrapper.subtags] == [
        (0x0702, "ubuntu"),
        (0x0705, ""),
    ]


def test_search_start_optional_filters():
    built = build_search_start(
        "iso",
        2,
        file_type="Video",
        extension="mp4",
        availability=5,
        min_size=1024,
        max_size=4294967296,
    )
    assert built.hex() == SEARCH_START_OPTS


def test_search_sends_request_and_returns_strings_reply(monkeypatch):
    client, fake = _connect(
        monkeypatch,
        replies=[AUTH_SALT_REPLY, AUTH_OK_REPLY, STRINGS_REPLY],
    )
    message = client.search("ubuntu", EC_SEARCH_GLOBAL)
    assert fake.sent[2].hex() == SEARCH_START_UBUNTU
    assert message == "Search in progress. Refetch results in a moment!"


@pytest.mark.parametrize(
    ("reply", "expected"),
    [(PROGRESS_REPLY_37, 37), (PROGRESS_REPLY_DONE, EC_SEARCH_PROGRESS_DONE)],
)
def test_search_progress_request_and_status_parsing(monkeypatch, reply, expected):
    assert build_search_progress().hex() == SEARCH_PROGRESS_REQ
    client, fake = _connect(
        monkeypatch,
        replies=[AUTH_SALT_REPLY, AUTH_OK_REPLY, reply],
    )
    assert client.search_progress() == expected
    assert fake.sent[2].hex() == SEARCH_PROGRESS_REQ


def test_search_results_request_and_parsing(monkeypatch):
    assert build_search_results(EC_DETAIL_FULL).hex() == SEARCH_RESULTS_REQ
    client, fake = _connect(
        monkeypatch,
        replies=[AUTH_SALT_REPLY, AUTH_OK_REPLY, SEARCH_RESULTS_REPLY],
    )
    results = client.search_results(detail=EC_DETAIL_FULL)
    assert fake.sent[2].hex() == SEARCH_RESULTS_REQ
    assert results == [
        SearchResult(
            name="ubuntu-24.04-desktop-amd64.iso",
            size=5395472384,
            file_hash="0102030405060708090a0b0c0d0e0f10",
            sources=42,
            sources_xfer=7,
            status=5,
        ),
        SearchResult(
            name="Debian 12 netinst.iso",
            size=678907904,
            file_hash="100f0e0d0c0b0a090807060504030201",
            sources=300,
            sources_xfer=12,
            status=0,
        ),
    ]


def test_search_stop_sends_parameterless_packet(monkeypatch):
    client, fake = _connect(
        monkeypatch,
        replies=[AUTH_SALT_REPLY, AUTH_OK_REPLY, MISC_DATA_REPLY],
    )
    assert build_search_stop().hex() == SEARCH_STOP_REQ
    client.search_stop()
    assert fake.sent[2].hex() == SEARCH_STOP_REQ


# ---------------------------------------------------------------------------
# Operaciones: ADD_LINK y ops de cola por hash.
# ---------------------------------------------------------------------------


def test_add_ed2k_packet_bytes(monkeypatch):
    assert build_add_link(LINK, category=7).hex() == ADD_LINK_CAT7
    assert build_add_link(LINK).hex() == ADD_LINK_NO_CAT
    client, fake = _connect(
        monkeypatch,
        replies=[AUTH_SALT_REPLY, AUTH_OK_REPLY, NOOP_REPLY],
    )
    client.add_ed2k(LINK, category=7)
    assert fake.sent[2].hex() == ADD_LINK_CAT7


@pytest.mark.parametrize(
    ("builder", "expected"),
    [
        (lambda h: build_partfile_pause(h), PAUSE),
        (lambda h: build_partfile_resume(h), RESUME),
        (lambda h: build_partfile_set_priority(h, 3), PRIO3),
        (lambda h: build_partfile_set_category(h, 5), CAT5),
        (lambda h: build_partfile_delete(h), DELETE),
        (lambda h: build_download_search_result(h, category=7), DOWNLOAD_RESULT_CAT7),
        (lambda h: build_download_search_result(h), DOWNLOAD_RESULT_NO_CAT),
    ],
)
def test_queue_operation_packets_are_byte_exact(builder, expected):
    assert builder(HASH_HEX).hex() == expected


def test_queue_op_sends_request_and_consumes_noop(monkeypatch):
    client, fake = _connect(
        monkeypatch,
        replies=[AUTH_SALT_REPLY, AUTH_OK_REPLY, NOOP_REPLY],
    )
    client.pause(HASH_HEX)
    assert fake.sent[2].hex() == PAUSE


# ---------------------------------------------------------------------------
# Excepciones tipadas de conexión y timeout.
# ---------------------------------------------------------------------------


def test_connection_failure_is_wrapped_as_typed_error(monkeypatch):
    def _refused(addr, timeout):
        raise ConnectionRefusedError(61, "Connection refused")

    monkeypatch.setattr("infrastructure.amule_ec_client.socket.create_connection", _refused)
    client = AmuleECClient("127.0.0.1", 4712, FAKE_PASSWORD)
    with pytest.raises(AmuleECConnectionError) as excinfo:
        client.connect()
    assert isinstance(excinfo.value, AmuleECError)


def test_timeout_is_wrapped_as_typed_error(monkeypatch):
    import socket as _socket

    with pytest.raises(AmuleECTimeoutError) as excinfo:
        _connect(monkeypatch, replies=[], recv_error=_socket.timeout("timed out"))
    assert isinstance(excinfo.value, AmuleECError)
