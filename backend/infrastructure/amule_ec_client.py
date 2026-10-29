"""Cliente EC directo de aMule (S1/T2) — framing, auth, búsqueda y ops de cola.

Sustituye el transporte de aMuTorrent hablando en crudo con `amuled`
(`AMULE_URL`:`AMULE_EC_PORT`). Sólo stdlib (`socket`, `hashlib`, `struct`,
`typing`; `zlib` sólo se importa al recibir un frame con `EC_FLAG_ZLIB`, como
hace el probe); sin dependencias nuevas. Los tests jamás abren red real.

Wire format (verificado en vivo por `/tmp/ec_probe.py` contra aMule 3.0.1 y por
`src/libs/ec/abstracts/ECCodes.abstract` + `ECTagTypes.abstract` de
`amule-org/amule`, fuente de verdad de los códigos):

- frame = u32 flags (base 0x20) + u32 longitud del payload, big-endian;
  payload = u8 opcode + u16 nº de tags + tags;
- tag = u16 ((código<<1) | bit0=tiene subtags) + u8 tipo + u32 taglen +
  [u16 nº de subtags si bit0] + subtags + dato propio; el taglen incluye el
  tamaño cable de las subtags (sin contar el u16 del contador);
- strings = UTF-8 + NUL final, y el u32 taglen cuenta ese NUL (no hay
  longitud interna: el u32 que precede al string ES el campo taglen);
- enteros en el tipo más estrecho posible (el lector es agnóstico de ancho);
- tipos EC: UINT8 2, UINT16 3, UINT32 4, UINT64 5, STRING 6, HASH16 9.

Autenticación de 3 pasos: `EC_OP_AUTH_REQ 0x02` (CLIENT_NAME, CLIENT_VERSION y
PROTOCOL_VERSION 0x0204 obligatorio) → `EC_OP_AUTH_SALT 0x4F` (PASSWD_SALT u64)
→ `EC_OP_AUTH_PASSWD 0x50` (PASSWD_HASH HASH16) con digest =
md5( md5pw + md5_hex("%lX" % salt) ). `AMULE_EC_PASSWORD` YA es el md5-hex de
32 caracteres del password y se usa tal cual como primer término (no se
re-hashea el password real; el probe normaliza a minúsculas). Éxito =
`EC_OP_AUTH_OK 0x04`. El servidor limita los logins fallidos: NUNCA reintentar
autenticación a ciegas, y jamás imprimir ni loguear contraseña o digest.

Todo error de conexión/timeout/rechazo sube como excepción tipada de este
módulo (`AmuleECError` y derivadas); nunca un traceback crudo hacia HTTP, y
nunca con secretos en el mensaje.
"""

import hashlib
import socket
import struct
from typing import NamedTuple, Sequence

__all__ = [
    # Cliente y tipos de datos
    "AmuleECClient",
    "ECTag",
    "SearchResult",
    # Excepciones tipadas
    "AmuleECCommandError",
    "AmuleECConnectionError",
    "AmuleECError",
    "AmuleECAuthError",
    "AmuleECProtocolError",
    "AmuleECTimeoutError",
    # Constantes de protocolo (ECCodes.abstract / ECTagTypes.abstract)
    "DEFAULT_TIMEOUT",
    "EC_BASE_FLAGS",
    "EC_FLAG_ZLIB",
    "EC_PROTO_VERSION",
    "EC_OP_NOOP",
    "EC_OP_AUTH_REQ",
    "EC_OP_AUTH_FAIL",
    "EC_OP_AUTH_OK",
    "EC_OP_FAILED",
    "EC_OP_STRINGS",
    "EC_OP_MISC_DATA",
    "EC_OP_ADD_LINK",
    "EC_OP_PARTFILE_PAUSE",
    "EC_OP_PARTFILE_RESUME",
    "EC_OP_PARTFILE_PRIO_SET",
    "EC_OP_PARTFILE_DELETE",
    "EC_OP_PARTFILE_SET_CAT",
    "EC_OP_SEARCH_START",
    "EC_OP_SEARCH_STOP",
    "EC_OP_SEARCH_RESULTS",
    "EC_OP_SEARCH_PROGRESS",
    "EC_OP_DOWNLOAD_SEARCH_RESULT",
    "EC_OP_GET_SERVER_LIST",
    "EC_OP_SERVER_LIST",
    "EC_OP_SERVER_CONNECT",
    "EC_OP_SERVER_REMOVE",
    "EC_OP_SERVER_ADD",
    "EC_OP_GET_SHARED_FILES",
    "EC_OP_SHARED_FILES",
    "EC_OP_GET_PREFERENCES",
    "EC_OP_SET_PREFERENCES",
    "EC_OP_KNOWNFILE_DELETE",
    "EC_OP_AUTH_SALT",
    "EC_OP_AUTH_PASSWD",
    "EC_TAG_STRING",
    "EC_TAG_PASSWD_HASH",
    "EC_TAG_PROTOCOL_VERSION",
    "EC_TAG_DETAIL_LEVEL",
    "EC_TAG_PASSWD_SALT",
    "EC_TAG_CLIENT_NAME",
    "EC_TAG_CLIENT_VERSION",
    "EC_TAG_SERVER",
    "EC_TAG_SERVER_NAME",
    "EC_TAG_SERVER_ADDRESS",
    "EC_TAG_SERVER_PING",
    "EC_TAG_SERVER_USERS",
    "EC_TAG_SERVER_USERS_MAX",
    "EC_TAG_SERVER_FILES",
    "EC_TAG_SERVER_PRIO",
    "EC_TAG_SERVER_FAILED",
    "EC_TAG_SERVER_STATIC",
    "EC_TAG_SERVER_VERSION",
    "EC_TAG_PARTFILE",
    "EC_TAG_PARTFILE_NAME",
    "EC_TAG_PARTFILE_SIZE_FULL",
    "EC_TAG_PARTFILE_STATUS",
    "EC_TAG_PARTFILE_PRIO",
    "EC_TAG_PARTFILE_SOURCE_COUNT",
    "EC_TAG_PARTFILE_SOURCE_COUNT_XFER",
    "EC_TAG_PARTFILE_CAT",
    "EC_TAG_PARTFILE_HASH",
    "EC_TAG_SEARCHFILE",
    "EC_TAG_SEARCH_TYPE",
    "EC_TAG_SEARCH_NAME",
    "EC_TAG_SEARCH_MIN_SIZE",
    "EC_TAG_SEARCH_MAX_SIZE",
    "EC_TAG_SEARCH_FILE_TYPE",
    "EC_TAG_SEARCH_EXTENSION",
    "EC_TAG_SEARCH_AVAILABILITY",
    "EC_TAG_SEARCH_STATUS",
    "EC_TAG_ECID",
    "EC_TAG_KNOWNFILE",
    "EC_TAG_KNOWNFILE_FILENAME",
    "EC_TAG_KNOWNFILE_PATH",
    "EC_TAG_SELECT_PREFS",
    "EC_TAG_PREFS_CATEGORIES",
    "EC_TAG_CATEGORY",
    "EC_TAG_CATEGORY_TITLE",
    "EC_TAGTYPE_CUSTOM",
    "EC_TAGTYPE_UINT8",
    "EC_TAGTYPE_UINT16",
    "EC_TAGTYPE_UINT32",
    "EC_TAGTYPE_UINT64",
    "EC_TAGTYPE_STRING",
    "EC_TAGTYPE_DOUBLE",
    "EC_TAGTYPE_IPV4",
    "EC_TAGTYPE_HASH16",
    "EC_TAGTYPE_UINT128",
    "EC_DETAIL_CMD",
    "EC_DETAIL_WEB",
    "EC_DETAIL_FULL",
    "EC_SEARCH_LOCAL",
    "EC_SEARCH_GLOBAL",
    "EC_SEARCH_KAD",
    "EC_SEARCH_PROGRESS_DONE",
    "EC_PREFS_CATEGORIES",
    # Builders y utilidades de cable
    "build_add_link",
    "build_auth_request",
    "build_download_search_result",
    "build_get_preferences",
    "build_get_shared_files",
    "build_knownfile_delete",
    "build_partfile_delete",
    "build_partfile_pause",
    "build_partfile_resume",
    "build_partfile_set_category",
    "build_partfile_set_priority",
    "build_passwd_response",
    "build_search_progress",
    "build_search_results",
    "build_search_start",
    "build_search_stop",
    "build_server_add",
    "build_server_connect",
    "build_server_remove",
    "build_get_server_list",
    "compute_passwd_hash",
    "decode_frame",
    "encode_frame",
    "encode_ipv4_tag",
    "encode_string_tag",
    "encode_tag",
    "encode_uint_tag",
    "find_tag",
]

# --- Flags de transporte ---------------------------------------------------

EC_FLAG_ZLIB = 0x00000001
EC_BASE_FLAGS = 0x20

# --- Opcodes (ECCodes.abstract) -------------------------------------------

EC_OP_NOOP = 0x01
EC_OP_AUTH_REQ = 0x02
EC_OP_AUTH_FAIL = 0x03
EC_OP_AUTH_OK = 0x04
EC_OP_FAILED = 0x05
EC_OP_STRINGS = 0x06
EC_OP_MISC_DATA = 0x07
EC_OP_ADD_LINK = 0x09
EC_OP_GET_SHARED_FILES = 0x10
EC_OP_PARTFILE_PAUSE = 0x19
EC_OP_PARTFILE_RESUME = 0x1A
EC_OP_PARTFILE_PRIO_SET = 0x1C
EC_OP_PARTFILE_DELETE = 0x1D
EC_OP_PARTFILE_SET_CAT = 0x1E
EC_OP_SHARED_FILES = 0x22  # respuesta a GET_SHARED_FILES
EC_OP_SEARCH_START = 0x26
EC_OP_SEARCH_STOP = 0x27
EC_OP_SEARCH_RESULTS = 0x28
EC_OP_SEARCH_PROGRESS = 0x29
EC_OP_DOWNLOAD_SEARCH_RESULT = 0x2A
EC_OP_GET_SERVER_LIST = 0x2C
EC_OP_SERVER_LIST = 0x2D  # respuesta a GET_SERVER_LIST
EC_OP_SERVER_CONNECT = 0x2F
EC_OP_SERVER_REMOVE = 0x30
EC_OP_SERVER_ADD = 0x31
EC_OP_GET_PREFERENCES = 0x3F
EC_OP_SET_PREFERENCES = 0x40  # respuesta a GET_PREFERENCES (verificado en vivo)
EC_OP_KNOWNFILE_DELETE = 0x6A
EC_OP_AUTH_SALT = 0x4F
EC_OP_AUTH_PASSWD = 0x50

# --- Tags (ECCodes.abstract) ----------------------------------------------

EC_TAG_STRING = 0x0000
EC_TAG_PASSWD_HASH = 0x0001
EC_TAG_PROTOCOL_VERSION = 0x0002
EC_TAG_DETAIL_LEVEL = 0x0004
EC_TAG_PASSWD_SALT = 0x000B
EC_TAG_ECID = 0x000F
EC_TAG_CLIENT_NAME = 0x0100
EC_TAG_CLIENT_VERSION = 0x0101
EC_TAG_SERVER = 0x0500
EC_TAG_SERVER_NAME = 0x0501
EC_TAG_SERVER_ADDRESS = 0x0503
EC_TAG_SERVER_PING = 0x0504
EC_TAG_SERVER_USERS = 0x0505
EC_TAG_SERVER_USERS_MAX = 0x0506
EC_TAG_SERVER_FILES = 0x0507
EC_TAG_SERVER_PRIO = 0x0508
EC_TAG_SERVER_FAILED = 0x0509
EC_TAG_SERVER_STATIC = 0x050A
EC_TAG_SERVER_VERSION = 0x050B
EC_TAG_PARTFILE = 0x0300
EC_TAG_PARTFILE_NAME = 0x0301
EC_TAG_PARTFILE_SIZE_FULL = 0x0303
EC_TAG_PARTFILE_STATUS = 0x0308
EC_TAG_PARTFILE_PRIO = 0x0309
EC_TAG_PARTFILE_SOURCE_COUNT = 0x030A
EC_TAG_PARTFILE_SOURCE_COUNT_XFER = 0x030D
EC_TAG_PARTFILE_CAT = 0x030F
EC_TAG_PARTFILE_HASH = 0x031E
EC_TAG_SEARCHFILE = 0x0700
EC_TAG_SEARCH_TYPE = 0x0701
EC_TAG_SEARCH_NAME = 0x0702
EC_TAG_SEARCH_MIN_SIZE = 0x0703
EC_TAG_SEARCH_MAX_SIZE = 0x0704
EC_TAG_SEARCH_FILE_TYPE = 0x0705
EC_TAG_SEARCH_EXTENSION = 0x0706
EC_TAG_SEARCH_AVAILABILITY = 0x0707
EC_TAG_SEARCH_STATUS = 0x0708
EC_TAG_KNOWNFILE = 0x0400
EC_TAG_KNOWNFILE_FILENAME = 0x0408
EC_TAG_KNOWNFILE_PATH = 0x0416
EC_TAG_SELECT_PREFS = 0x1000
EC_TAG_PREFS_CATEGORIES = 0x1100
EC_TAG_CATEGORY = 0x1101
EC_TAG_CATEGORY_TITLE = 0x1102

#: EcPrefs (máscara uint32 de EC_TAG_SELECT_PREFS).
EC_PREFS_CATEGORIES = 0x00000001

# --- Tipos de tag (ECTagTypes.abstract) -----------------------------------

EC_TAGTYPE_CUSTOM = 1
EC_TAGTYPE_UINT8 = 2
EC_TAGTYPE_UINT16 = 3
EC_TAGTYPE_UINT32 = 4
EC_TAGTYPE_UINT64 = 5
EC_TAGTYPE_STRING = 6
EC_TAGTYPE_DOUBLE = 7
EC_TAGTYPE_IPV4 = 8
EC_TAGTYPE_HASH16 = 9
EC_TAGTYPE_UINT128 = 10

# --- Niveles de detalle y modos de búsqueda -------------------------------

EC_DETAIL_CMD = 0x00
EC_DETAIL_WEB = 0x01
EC_DETAIL_FULL = 0x02

EC_SEARCH_LOCAL = 0x00
EC_SEARCH_GLOBAL = 0x01
EC_SEARCH_KAD = 0x02

EC_PROTO_VERSION = 0x0204

#: Barra de `EC_TAG_SEARCH_STATUS`: 0..100 en curso, 0xFFFF terminada.
EC_SEARCH_PROGRESS_DONE = 0xFFFF

DEFAULT_TIMEOUT = 20.0


# --- Excepciones tipadas ---------------------------------------------------


class AmuleECError(Exception):
    """Base: todo fallo del cliente EC sube como una de estas."""


class AmuleECConnectionError(AmuleECError):
    """No se pudo conectar o la conexión EC se cayó."""


class AmuleECTimeoutError(AmuleECError):
    """amuled no respondió dentro del timeout."""


class AmuleECProtocolError(AmuleECError):
    """Frame o respuesta que no cumple el protocolo EC."""


class AmuleECAuthError(AmuleECError):
    """Autenticación rechazada por amuled (no reintentar a ciegas)."""


class AmuleECCommandError(AmuleECError):
    """amuled respondió `EC_OP_FAILED`; el mensaje es el del servidor."""


# --- Modelo de tag ---------------------------------------------------------


class ECTag(NamedTuple):
    """Tag EC decodificado: código, tipo, dato propio y subtags."""

    code: int
    type: int
    data: bytes
    subtags: tuple = ()

    def as_int(self) -> int:
        """Valor entero sea cual sea su ancho (el lector es agnóstico)."""
        return int.from_bytes(self.data, "big") if self.data else 0

    def as_str(self) -> str:
        """String UTF-8 sin el NUL final del cable."""
        return self.data.rstrip(b"\x00").decode("utf-8", "replace")

    def as_hash_hex(self) -> str:
        """HASH16/MD4 en hex minúscula (32 chars)."""
        return self.data.hex()


class SearchResult(NamedTuple):
    """Resultado de búsqueda de `EC_TAG_SEARCHFILE` (detalle FULL)."""

    name: str
    size: int
    file_hash: str
    sources: int  # noqa: V107 — campo del registro SearchResult (lo consume T4/T5)
    sources_xfer: int  # noqa: V107 — campo del registro SearchResult (lo consume T4/T5)
    status: int = 0


def find_tag(tags: Sequence[ECTag], code: int) -> ECTag | None:
    """Primer tag con `code`, buscando también dentro de los subtags."""
    for tag in tags:
        if tag.code == code:
            return tag
        found = find_tag(tag.subtags, code)
        if found is not None:
            return found
    return None


# --- Codificación (encode) -------------------------------------------------


def _uint(value: int, width: int) -> bytes:
    return value.to_bytes(width, "big")


def encode_tag(code: int, type_: int, data: bytes, children: Sequence[bytes] = ()) -> bytes:
    """Tag en bytes de cable; `children` son tags ya codificados (subtags).

    taglen = tamaño cable de las subtags + tamaño del dato propio; el contador
    de subtags (u16) NO cuenta en el taglen.
    """
    name = code << 1
    subs = b"".join(children)
    if children:
        name |= 1
        body = _uint(len(subs) + len(data), 4) + _uint(len(children), 2) + subs + data
    else:
        body = _uint(len(data), 4) + data
    return _uint(name, 2) + _uint(type_, 1) + body


def _string_data(text: str) -> bytes:
    # Valor string = UTF-8 + NUL final; la "u32 longitud" del cable es el propio
    # campo taglen (cuenta el NUL). No hay longitud interna (ECTag.cpp).
    return text.encode("utf-8") + b"\x00"


def encode_string_tag(code: int, text: str) -> bytes:
    """String EC: UTF-8 + NUL final, contado por el taglen (sin longitud interna)."""
    return encode_tag(code, EC_TAGTYPE_STRING, _string_data(text))


def encode_uint_tag(code: int, value: int) -> bytes:
    """Entero EC en el tipo más estrecho posible (8/16/32/64 bits)."""
    if value < 0:
        raise ValueError("los enteros EC no admiten signo")
    for type_, width in (
        (EC_TAGTYPE_UINT8, 1),
        (EC_TAGTYPE_UINT16, 2),
        (EC_TAGTYPE_UINT32, 4),
        (EC_TAGTYPE_UINT64, 8),
    ):
        if value < 1 << (8 * width):
            return encode_tag(code, type_, _uint(value, width))
    raise ValueError("entero EC demasiado grande")


def _hash16(file_hash) -> bytes:
    """MD4 de 16 bytes desde hex de 32 chars o desde `bytes`."""
    if isinstance(file_hash, str):
        if len(file_hash) != 32:
            raise ValueError("hash MD4 inválido (se espera hex de 32 caracteres)")
        try:
            raw = bytes.fromhex(file_hash)
        except ValueError as exc:
            raise ValueError("hash MD4 inválido (hex ilegible)") from exc
    else:
        raw = bytes(file_hash)
        if len(raw) != 16:
            raise ValueError("hash MD4 inválido (se esperan 16 bytes)")
    return raw


def encode_hash_tag(code: int, file_hash) -> bytes:
    """Tag HASH16 (tipo 9) con el MD4 en crudo."""
    return encode_tag(code, EC_TAGTYPE_HASH16, _hash16(file_hash))


def encode_ipv4_tag(code: int, ipv4: str, port: int) -> bytes:
    """Tag IPV4: 4B de IP numérica en orden de red + 2B de puerto (igual orden).

    El core sólo admite binario (`GetServerByIPTCP`): un nombre aquí es un
    error de la capa de servicio, y sube como `ValueError` en español.
    """
    try:
        packed = socket.inet_aton(ipv4)
    except OSError as exc:
        raise ValueError(f"dirección inválida: «{ipv4}» no es una IP numérica") from exc
    return encode_tag(code, EC_TAGTYPE_IPV4, packed + _uint(port, 2))


def encode_frame(opcode: int, tags: Sequence[bytes] = ()) -> bytes:
    """Frame completo: u32 flags (0x20) + u32 longitud + u8 opcode + u16 tags."""
    payload = _uint(opcode, 1) + _uint(len(tags), 2) + b"".join(tags)
    return struct.pack(">II", EC_BASE_FLAGS, len(payload)) + payload


# --- Decodificación (decode) ------------------------------------------------


class _Reader:
    def __init__(self, data: bytes):
        self._data = data
        self._pos = 0

    @property
    def pos(self) -> int:
        return self._pos

    def take(self, n: int) -> bytes:
        if n < 0 or self._pos + n > len(self._data):
            raise AmuleECProtocolError("frame EC truncado")
        chunk = self._data[self._pos : self._pos + n]
        self._pos += n
        return chunk

    def uint(self, n: int) -> int:
        return int.from_bytes(self.take(n), "big")

    def done(self) -> bool:
        return self._pos == len(self._data)


def _read_tag(reader: _Reader) -> ECTag:
    name = reader.uint(2)
    code = name >> 1
    has_subs = bool(name & 1)
    type_ = reader.uint(1)
    taglen = reader.uint(4)
    subs = []
    subs_wire = 0
    if has_subs:
        subcount = reader.uint(2)
        for _ in range(subcount):
            start = reader.pos
            subs.append(_read_tag(reader))
            subs_wire += reader.pos - start
    own_len = taglen - subs_wire
    if own_len < 0:
        raise AmuleECProtocolError("taglen EC inconsistente")
    return ECTag(code, type_, reader.take(own_len), tuple(subs))


def decode_frame(frame: bytes) -> tuple[int, list[ECTag]]:
    """Frame de cable → (opcode, tags). Valida flags/longitud y estructura."""
    if len(frame) < 8:
        raise AmuleECProtocolError("frame EC truncado")
    flags, length = struct.unpack(">II", frame[:8])
    payload = frame[8:]
    if len(payload) != length:
        raise AmuleECProtocolError("longitud de frame EC inconsistente")
    if flags & EC_FLAG_ZLIB:
        # Sólo si el par lo negoció; el probe hace lo mismo.
        import zlib

        try:
            payload = zlib.decompress(payload)
        except zlib.error as exc:
            raise AmuleECProtocolError("frame EC comprimido ilegible") from exc
    reader = _Reader(payload)
    opcode = reader.uint(1)
    count = reader.uint(2)
    tags = [_read_tag(reader) for _ in range(count)]
    if not reader.done():
        raise AmuleECProtocolError("sobran bytes en el frame EC")
    return opcode, tags


# --- Paquetes de petición (builders puros) ---------------------------------


def build_auth_request(client_name: str, client_version: str) -> bytes:
    """Primer paso del handshake: nombre, versión y protocolo 0x0204."""
    return encode_frame(
        EC_OP_AUTH_REQ,
        [
            encode_string_tag(EC_TAG_CLIENT_NAME, client_name),
            encode_string_tag(EC_TAG_CLIENT_VERSION, client_version),
            encode_uint_tag(EC_TAG_PROTOCOL_VERSION, EC_PROTO_VERSION),
        ],
    )


def compute_passwd_hash(password: str, salt: int) -> bytes:
    """Digest HASH16 = md5( md5pw + md5_hex("%lX" % salt) ), 16 bytes.

    Si `password` ya es un md5-hex de 32 caracteres (`AMULE_EC_PASSWORD`) se usa
    tal cual como primer término, sin re-hashear. NUNCA imprimir el resultado.
    """
    if _is_md5_hex(password):
        md5pw = password.lower()
    else:
        md5pw = hashlib.md5(password.encode("utf-8")).hexdigest()
    md5salt = hashlib.md5(f"{salt:X}".encode("ascii")).hexdigest()
    return hashlib.md5((md5pw + md5salt).encode("ascii")).digest()


def _is_md5_hex(text: str) -> bool:
    return len(text) == 32 and all(c in "0123456789abcdefABCDEF" for c in text)


def build_passwd_response(digest: bytes) -> bytes:
    """Tercer paso del handshake: PASSWD_HASH HASH16 con el digest calculado."""
    return encode_frame(EC_OP_AUTH_PASSWD, [encode_hash_tag(EC_TAG_PASSWD_HASH, digest)])


def build_search_start(
    query: str,
    mode: int = EC_SEARCH_GLOBAL,
    *,
    file_type: str = "",
    extension: str | None = None,
    availability: int | None = None,
    min_size: int | None = None,
    max_size: int | None = None,
) -> bytes:
    """`EC_OP_SEARCH_START` con EXACTAMENTE un envoltorio `EC_TAG_SEARCH_TYPE`.

    El envoltorio lleva el modo como dato propio u32 y como subtags siempre
    `EC_TAG_SEARCH_NAME` + `EC_TAG_SEARCH_FILE_TYPE` (vacío = sin filtrar); los
    opcionales sólo cuando procede (mismo criterio que `CEC_Search_Tag`).
    """
    children = [
        encode_string_tag(EC_TAG_SEARCH_NAME, query),
        encode_string_tag(EC_TAG_SEARCH_FILE_TYPE, file_type),
    ]
    if extension:
        children.append(encode_string_tag(EC_TAG_SEARCH_EXTENSION, extension))
    if availability:
        children.append(encode_uint_tag(EC_TAG_SEARCH_AVAILABILITY, availability))
    if min_size:
        children.append(encode_uint_tag(EC_TAG_SEARCH_MIN_SIZE, min_size))
    if max_size:
        children.append(encode_uint_tag(EC_TAG_SEARCH_MAX_SIZE, max_size))
    wrapper = encode_tag(EC_TAG_SEARCH_TYPE, EC_TAGTYPE_UINT32, _uint(mode, 4), children=children)
    return encode_frame(EC_OP_SEARCH_START, [wrapper])


def build_search_progress() -> bytes:
    """Poll de `EC_OP_SEARCH_PROGRESS` sin parámetros."""
    return encode_frame(EC_OP_SEARCH_PROGRESS, [])


def build_search_results(detail: int = EC_DETAIL_FULL) -> bytes:
    """Petición de resultados con `EC_TAG_DETAIL_LEVEL` (EC_DETAIL_FULL = 0x02)."""
    return encode_frame(EC_OP_SEARCH_RESULTS, [encode_uint_tag(EC_TAG_DETAIL_LEVEL, detail)])


def build_search_stop() -> bytes:
    """`EC_OP_SEARCH_STOP` sin parámetros (camino single-search legacy)."""
    return encode_frame(EC_OP_SEARCH_STOP, [])


def build_add_link(ed2k_link: str, category: int | None = None) -> bytes:
    """`EC_OP_ADD_LINK`: tag STRING con el ed2k y subtag PARTFILE_CAT opcional."""
    children = [encode_uint_tag(EC_TAG_PARTFILE_CAT, category)] if category is not None else []
    link_tag = encode_tag(EC_TAG_STRING, EC_TAGTYPE_STRING, _string_data(ed2k_link), children=children)
    return encode_frame(EC_OP_ADD_LINK, [link_tag])


def _partfile_frame(opcode: int, file_hash, children: Sequence[bytes] = ()) -> bytes:
    hashtag = encode_tag(EC_TAG_PARTFILE, EC_TAGTYPE_HASH16, _hash16(file_hash), children=children)
    return encode_frame(opcode, [hashtag])


def build_partfile_pause(file_hash) -> bytes:
    return _partfile_frame(EC_OP_PARTFILE_PAUSE, file_hash)


def build_partfile_resume(file_hash) -> bytes:
    return _partfile_frame(EC_OP_PARTFILE_RESUME, file_hash)


def build_partfile_set_priority(file_hash, priority: int) -> bytes:
    """`EC_OP_PARTFILE_PRIO_SET` con subtag `EC_TAG_PARTFILE_PRIO`."""
    return _partfile_frame(
        EC_OP_PARTFILE_PRIO_SET, file_hash, [encode_uint_tag(EC_TAG_PARTFILE_PRIO, priority)]
    )


def build_partfile_set_category(file_hash, category: int) -> bytes:
    """`EC_OP_PARTFILE_SET_CAT` con subtag `EC_TAG_PARTFILE_CAT`."""
    return _partfile_frame(
        EC_OP_PARTFILE_SET_CAT, file_hash, [encode_uint_tag(EC_TAG_PARTFILE_CAT, category)]
    )


def build_partfile_delete(file_hash) -> bytes:
    return _partfile_frame(EC_OP_PARTFILE_DELETE, file_hash)


def build_download_search_result(file_hash, category: int | None = None) -> bytes:
    """`EC_OP_DOWNLOAD_SEARCH_RESULT` por hash, con PARTFILE_CAT opcional."""
    children = [encode_uint_tag(EC_TAG_PARTFILE_CAT, category)] if category is not None else []
    return _partfile_frame(EC_OP_DOWNLOAD_SEARCH_RESULT, file_hash, children)


def build_get_preferences(prefs: int = EC_PREFS_CATEGORIES) -> bytes:
    """`EC_OP_GET_PREFERENCES` con `EC_TAG_SELECT_PREFS` (máscara EcPrefs).

    La respuesta llega como `EC_OP_SET_PREFERENCES` (verificado en vivo).
    """
    return encode_frame(EC_OP_GET_PREFERENCES, [encode_uint_tag(EC_TAG_SELECT_PREFS, prefs)])


def build_get_shared_files(detail: int = EC_DETAIL_FULL) -> bytes:
    """`EC_OP_GET_SHARED_FILES` con `EC_TAG_DETAIL_LEVEL` — la identidad
    completa (ECID, ruta, nombre) sólo llega en detalle FULL."""
    return encode_frame(EC_OP_GET_SHARED_FILES, [encode_uint_tag(EC_TAG_DETAIL_LEVEL, detail)])


def build_knownfile_delete(file_hash, ecid: int, directory: str, name: str) -> bytes:
    """`EC_OP_KNOWNFILE_DELETE`: KNOWNFILE(MD4) + ECID + KNOWNFILE_PATH
    (directorio) + PARTFILE_NAME (basename). El servidor verifica
    identidad/ruta antes de borrar (ECCodes.abstract): NOOP si borra;
    FAILED + STRING si no, dejando el fichero compartido/listado."""
    return encode_frame(
        EC_OP_KNOWNFILE_DELETE,
        [
            encode_hash_tag(EC_TAG_KNOWNFILE, file_hash),
            encode_uint_tag(EC_TAG_ECID, ecid),
            encode_string_tag(EC_TAG_KNOWNFILE_PATH, directory),
            encode_string_tag(EC_TAG_PARTFILE_NAME, name),
        ],
    )


def build_server_add(address: str, name: str = "") -> bytes:
    """`EC_OP_SERVER_ADD`: dirección «ip:puerto» SIEMPRE, nombre sólo si existe.

    Sin nombre el tag no viaja y el core pone la dirección completa
    (`Get_EC_Response_Server_Add`: name.IsEmpty() ? full_addr : name).
    """
    tags = [encode_string_tag(EC_TAG_SERVER_ADDRESS, address)]
    if name:
        tags.append(encode_string_tag(EC_TAG_SERVER_NAME, name))
    return encode_frame(EC_OP_SERVER_ADD, tags)


def build_server_remove(ipv4: str, port: int) -> bytes:
    """`EC_OP_SERVER_REMOVE` con el selector único `EC_TAG_SERVER` tipo IPV4."""
    return encode_frame(EC_OP_SERVER_REMOVE, [encode_ipv4_tag(EC_TAG_SERVER, ipv4, port)])


def build_server_connect(ipv4: str, port: int) -> bytes:
    """`EC_OP_SERVER_CONNECT` con el mismo selector IPV4 que remove."""
    return encode_frame(EC_OP_SERVER_CONNECT, [encode_ipv4_tag(EC_TAG_SERVER, ipv4, port)])


def build_get_server_list(detail: int = EC_DETAIL_FULL) -> bytes:
    """Petición de la lista con `EC_TAG_DETAIL_LEVEL` — igual que `build_search_results`."""
    return encode_frame(EC_OP_GET_SERVER_LIST, [encode_uint_tag(EC_TAG_DETAIL_LEVEL, detail)])


# --- Cliente ---------------------------------------------------------------


class AmuleECClient:
    """Cliente síncrono de amuled sobre EC (socket inyectable vía tests).

    Uso: `client = AmuleECClient(host, port, password)`; `client.connect()`
    (handshake completo) … operaciones … `client.close()`. También sirve de
    context manager, que conecta si hace falta.
    """

    def __init__(
        self,
        host: str,
        port: int,
        password: str,
        *,
        timeout: float = DEFAULT_TIMEOUT,
        client_name: str = "flow-controller",
        client_version: str = "0.1",
    ):
        self._host = host
        self._port = int(port)
        self._password = password
        self._timeout = timeout
        self._client_name = client_name
        self._client_version = client_version
        self._sock = None

    # -- conexión y handshake --

    def connect(self) -> str | None:
        """TCP + handshake de 3 pasos. Devuelve la versión del servidor (AUTH_OK).

        Todo fallo es una `AmuleECError`. La autenticación nunca se reintenta a
        ciegas: el servidor limita los logins fallidos por IP.
        """
        try:
            sock = socket.create_connection((self._host, self._port), self._timeout)
        except TimeoutError as exc:
            raise AmuleECTimeoutError("amuled no responde (timeout al conectar)") from exc
        except OSError as exc:
            raise AmuleECConnectionError("no se pudo conectar con amuled") from exc
        self._sock = sock
        sock.settimeout(self._timeout)
        try:
            return self._authenticate()
        except AmuleECError:
            self.close()
            raise

    def close(self) -> None:
        if self._sock is not None:
            try:
                self._sock.close()
            finally:
                self._sock = None

    def __enter__(self) -> "AmuleECClient":
        if self._sock is None:
            self.connect()
        return self

    def __exit__(self, *_exc_info) -> None:
        self.close()

    def _authenticate(self) -> str | None:
        self._send(build_auth_request(self._client_name, self._client_version))
        opcode, tags = self._recv_frame()
        self._raise_if_rejected(opcode, tags)
        if opcode != EC_OP_AUTH_SALT:
            raise AmuleECProtocolError("respuesta inesperada en el handshake EC")
        salt_tag = find_tag(tags, EC_TAG_PASSWD_SALT)
        if salt_tag is None:
            raise AmuleECProtocolError("AUTH_SALT sin EC_TAG_PASSWD_SALT")
        digest = compute_passwd_hash(self._password, salt_tag.as_int())
        self._send(build_passwd_response(digest))
        opcode, tags = self._recv_frame()
        self._raise_if_rejected(opcode, tags)
        if opcode != EC_OP_AUTH_OK:
            raise AmuleECProtocolError("respuesta inesperada en el handshake EC")
        version = find_tag(tags, EC_TAG_SERVER_VERSION)
        return version.as_str() if version is not None else None

    # -- búsqueda --

    def search(
        self,
        query: str,
        mode: int = EC_SEARCH_GLOBAL,
        *,
        file_type: str = "",
        extension: str | None = None,
        availability: int | None = None,
        min_size: int | None = None,
        max_size: int | None = None,
    ) -> str:
        """Lanza la búsqueda y devuelve el mensaje `EC_OP_STRINGS` del servidor."""
        self._send(
            build_search_start(
                query,
                mode,
                file_type=file_type,
                extension=extension,
                availability=availability,
                min_size=min_size,
                max_size=max_size,
            )
        )
        opcode, tags = self._recv_frame()
        self._raise_if_rejected(opcode, tags)
        if opcode != EC_OP_STRINGS:
            raise AmuleECProtocolError("respuesta inesperada a SEARCH_START")
        message = find_tag(tags, EC_TAG_STRING)
        return message.as_str() if message is not None else ""

    def search_progress(self) -> int:  # noqa: V105 — API pública del cliente EC; la consumen T3-T5
        """Poll de progreso: barra `EC_TAG_SEARCH_STATUS` (0..100, 0xFFFF=fin)."""
        self._send(build_search_progress())
        opcode, tags = self._recv_frame()
        self._raise_if_rejected(opcode, tags)
        if opcode != EC_OP_SEARCH_PROGRESS:
            raise AmuleECProtocolError("respuesta inesperada a SEARCH_PROGRESS")
        status = find_tag(tags, EC_TAG_SEARCH_STATUS)
        if status is None:
            raise AmuleECProtocolError("SEARCH_PROGRESS sin EC_TAG_SEARCH_STATUS")
        return status.as_int()

    def search_results(self, detail: int = EC_DETAIL_FULL) -> list[SearchResult]:  # noqa: V105 — API pública del cliente EC; la consumen T3-T5
        """Resultados actuales como `SearchResult` (nombre/tamaño/hash/fuentes)."""
        self._send(build_search_results(detail))
        opcode, tags = self._recv_frame()
        self._raise_if_rejected(opcode, tags)
        if opcode != EC_OP_SEARCH_RESULTS:
            raise AmuleECProtocolError("respuesta inesperada a SEARCH_RESULTS")
        results = []
        for tag in tags:
            if tag.code != EC_TAG_SEARCHFILE:
                continue
            results.append(
                SearchResult(
                    name=_field_str(tag, EC_TAG_PARTFILE_NAME),
                    size=_field_int(tag, EC_TAG_PARTFILE_SIZE_FULL),
                    file_hash=_field_hash(tag, EC_TAG_PARTFILE_HASH),
                    sources=_field_int(tag, EC_TAG_PARTFILE_SOURCE_COUNT),
                    sources_xfer=_field_int(tag, EC_TAG_PARTFILE_SOURCE_COUNT_XFER),
                    status=_field_int(tag, EC_TAG_PARTFILE_STATUS),
                )
            )
        return results

    def search_stop(self) -> None:  # noqa: V105 — API pública del cliente EC; la consumen T3-T5
        """Cierra la búsqueda single-search (`EC_OP_SEARCH_STOP` sin parámetros)."""
        self._send(build_search_stop())
        self._await_ack()

    # -- operaciones --

    def add_ed2k(self, ed2k_link: str, category: int | None = None) -> None:  # noqa: V105 — API pública del cliente EC; la consumen T3-T5
        """Encola un enlace ed2k (`EC_OP_ADD_LINK`)."""
        self._send(build_add_link(ed2k_link, category))
        self._await_ack()

    def download_search_result(self, file_hash, category: int | None = None) -> None:  # noqa: V105 — API pública del cliente EC; la consumen T3-T5
        """Encola un resultado de búsqueda por hash (`EC_OP_DOWNLOAD_SEARCH_RESULT`)."""
        self._send(build_download_search_result(file_hash, category))
        self._await_ack()

    def pause(self, file_hash) -> None:  # noqa: V105 — API pública del cliente EC; la consumen T3-T5
        self._send(build_partfile_pause(file_hash))
        self._await_ack()

    def resume(self, file_hash) -> None:  # noqa: V105 — API pública del cliente EC; la consumen T3-T5
        self._send(build_partfile_resume(file_hash))
        self._await_ack()

    def set_priority(self, file_hash, priority: int) -> None:  # noqa: V105 — API pública del cliente EC; la consumen T3-T5
        self._send(build_partfile_set_priority(file_hash, priority))
        self._await_ack()

    def set_category(self, file_hash, category: int) -> None:  # noqa: V105 — API pública del cliente EC; la consumen T3-T5
        self._send(build_partfile_set_category(file_hash, category))
        self._await_ack()

    def delete(self, file_hash) -> None:  # noqa: V105 — API pública del cliente EC; la consumen T3-T5
        self._send(build_partfile_delete(file_hash))
        self._await_ack()

    # -- servidores (T2/S3) --

    def server_add(self, address: str, name: str = "") -> None:
        """Añade un servidor (`EC_OP_SERVER_ADD`); la dirección viaja verbatim."""
        self._send(build_server_add(address, name))
        self._await_ack()

    def server_remove(self, ipv4: str, port: int) -> None:
        """Quita un servidor por IP:puerto (`EC_OP_SERVER_REMOVE`)."""
        self._send(build_server_remove(ipv4, port))
        self._await_ack()

    def server_connect(self, ipv4: str, port: int) -> None:
        """Pide al core conectar con un servidor (`EC_OP_SERVER_CONNECT`)."""
        self._send(build_server_connect(ipv4, port))
        self._await_ack()

    def server_list(self) -> list:
        """Servidores del core como filas `{name, address, failed, ...}`.

        `EC_OP_SERVER_LIST`: cada `EC_TAG_SERVER` trae el IPV4 como dato propio
        y sólo los subtags presentes — `CEC_Server_Tag` omite ceros y vacíos —,
        así que los números opcionales viajan SÓLO cuando existen: aquí no se
        inventa ningún cero. El nombre ausente cae a la dirección «ip:puerto».
        """
        self._send(build_get_server_list())
        opcode, tags = self._recv_frame()
        self._raise_if_rejected(opcode, tags)
        if opcode != EC_OP_SERVER_LIST:
            raise AmuleECProtocolError("respuesta inesperada a GET_SERVER_LIST")
        rows = []
        for tag in tags:
            if tag.code != EC_TAG_SERVER:
                continue
            address = _ipv4_text(tag.data)
            row = {
                "name": _field_str(tag, EC_TAG_SERVER_NAME) or address,
                "address": address,
                "failed": bool(_field_int(tag, EC_TAG_SERVER_FAILED)),
            }
            for code, key in _SERVER_OPTIONAL_FIELDS:
                sub = find_tag(tag.subtags, code)
                if sub is not None:
                    row[key] = sub.as_int()
            rows.append(row)
        return rows

    # -- categorías y borrado en disco (T5/L7) --

    def categories(self) -> dict:
        """Categorías de aMule como `{título: índice}`.

        `EC_OP_GET_PREFERENCES` con `EC_TAG_PREFS_CATEGORIES`: cada
        `EC_TAG_CATEGORY` trae el ÍNDICE como dato propio y el título en
        `EC_TAG_CATEGORY_TITLE`. Binding verificado en vivo (2026-10-22)
        contra el `<select>` de amuleweb: índice == posición en la lista.
        Un título duplicado conserva el primer índice.
        """
        self._send(build_get_preferences(EC_PREFS_CATEGORIES))
        opcode, tags = self._recv_frame()
        self._raise_if_rejected(opcode, tags)
        if opcode != EC_OP_SET_PREFERENCES:
            raise AmuleECProtocolError("respuesta inesperada a GET_PREFERENCES")
        mapping: dict = {}
        for wrapper in tags:
            if wrapper.code != EC_TAG_PREFS_CATEGORIES:
                continue
            for cat in wrapper.subtags:
                if cat.code != EC_TAG_CATEGORY:
                    continue
                title = find_tag(cat.subtags, EC_TAG_CATEGORY_TITLE)
                if title is None:
                    continue
                mapping.setdefault(title.as_str(), cat.as_int())
        return mapping

    def shared_identity(self, file_hash) -> tuple | None:
        """`(ECID, directorio, basename)` de un fichero COMPLETO, o None.

        `EC_OP_GET_SHARED_FILES` en detalle FULL: el MD4 viaja en
        `EC_TAG_PARTFILE_HASH`, el ECID es el dato propio de
        `EC_TAG_KNOWNFILE`, y `EC_TAG_KNOWNFILE_FILENAME` trae la ruta
        completa mientras `EC_TAG_PARTFILE_NAME` es el basename (verificado
        en vivo). Un hash ausente de la lista de compartidos no es un
        fichero completo: la única identidad que `KNOWNFILE_DELETE` acepta.
        """
        self._send(build_get_shared_files(EC_DETAIL_FULL))
        opcode, tags = self._recv_frame()
        self._raise_if_rejected(opcode, tags)
        if opcode != EC_OP_SHARED_FILES:
            raise AmuleECProtocolError("respuesta inesperada a GET_SHARED_FILES")
        want = _hash16(file_hash)
        for entry in tags:
            if entry.code != EC_TAG_KNOWNFILE:
                continue
            listed = find_tag(entry.subtags, EC_TAG_PARTFILE_HASH)
            if listed is None or listed.data != want:
                continue
            full = find_tag(entry.subtags, EC_TAG_KNOWNFILE_FILENAME)
            name = find_tag(entry.subtags, EC_TAG_PARTFILE_NAME)
            if full is None or name is None:
                return None
            return entry.as_int(), full.as_str().rpartition("/")[0], name.as_str()
        return None

    def delete_disk(self, file_hash) -> bool:
        """Borra del disco un fichero COMPLETO (`EC_OP_KNOWNFILE_DELETE`).

        True si amuled confirmó el borrado; False si el hash no figura como
        fichero completo (el llamante opta por `PARTFILE_DELETE`). Un FAILED
        del servidor sube como excepción tipada: nunca se fuerza el borrado.
        """
        identity = self.shared_identity(file_hash)
        if identity is None:
            return False
        ecid, directory, name = identity
        self._send(build_knownfile_delete(file_hash, ecid, directory, name))
        self._await_ack()
        return True

    # -- transporte --

    def _send(self, frame: bytes) -> None:
        try:
            self._sock.sendall(frame)
        except TimeoutError as exc:
            raise AmuleECTimeoutError("amuled no responde (timeout de envío)") from exc
        except OSError as exc:
            raise AmuleECConnectionError("conexión EC con amuled caída") from exc

    def _recv_frame(self) -> tuple[int, list[ECTag]]:
        try:
            header = self._read_exact(8)
            _flags, length = struct.unpack(">II", header)
            return decode_frame(header + self._read_exact(length))
        except TimeoutError as exc:
            raise AmuleECTimeoutError("amuled no responde (timeout de lectura)") from exc
        except OSError as exc:
            raise AmuleECConnectionError("conexión EC con amuled caída") from exc

    def _read_exact(self, n: int) -> bytes:
        chunks = []
        remaining = n
        while remaining > 0:
            chunk = self._sock.recv(remaining)
            if not chunk:
                raise AmuleECConnectionError("amuled cerró la conexión EC")
            chunks.append(chunk)
            remaining -= len(chunk)
        return b"".join(chunks)

    def _await_ack(self) -> None:
        """Toda petición tiene una respuesta: NOOP si va bien, FAILED si no."""
        opcode, tags = self._recv_frame()
        self._raise_if_rejected(opcode, tags)

    @staticmethod
    def _raise_if_rejected(opcode: int, tags: list[ECTag]) -> None:
        if opcode == EC_OP_FAILED:
            raise _failed_error(tags)
        if opcode == EC_OP_AUTH_FAIL:
            raise AmuleECAuthError("autenticación rechazada por amuled")


def _failed_error(tags: Sequence[ECTag]) -> AmuleECCommandError:
    """`EC_OP_FAILED` → excepción con el mensaje del servidor (sin secretos)."""
    message = find_tag(tags, EC_TAG_STRING)
    text = message.as_str() if message is not None else "amuled rechazó la operación"
    return AmuleECCommandError(text)


def _field_str(tag: ECTag, code: int) -> str:
    sub = find_tag(tag.subtags, code)
    return sub.as_str() if sub is not None else ""


def _field_int(tag: ECTag, code: int) -> int:
    sub = find_tag(tag.subtags, code)
    return sub.as_int() if sub is not None else 0


def _field_hash(tag: ECTag, code: int) -> str:
    sub = find_tag(tag.subtags, code)
    return sub.as_hash_hex() if sub is not None else ""


def _ipv4_text(data: bytes) -> str:
    """«a.b.c.d:puerto» del dato IPV4 del cable (4B IP + 2B puerto)."""
    if len(data) != 6:
        raise AmuleECProtocolError("tag IPV4 EC con longitud inesperada")
    return f"{socket.inet_ntoa(data[:4])}:{int.from_bytes(data[4:], 'big')}"


#: Subtags opcionales de `EC_TAG_SERVER` (CEC_Server_Tag): sólo cuando existen.
_SERVER_OPTIONAL_FIELDS = (
    (EC_TAG_SERVER_PING, "ping"),
    (EC_TAG_SERVER_USERS, "users"),
    (EC_TAG_SERVER_USERS_MAX, "users_max"),
    (EC_TAG_SERVER_FILES, "files"),
    (EC_TAG_SERVER_PRIO, "prio"),
    (EC_TAG_SERVER_STATIC, "static"),
)
