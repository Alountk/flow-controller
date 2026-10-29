"""Builders EC de servidores (S3): peticiones ADD/REMOVE/CONNECT/GET_LIST byte a byte.

Contrato fijado aquí sobre la fuente del core (`ExternalConn.cpp`):

- ADD (`0x31`): `Get_EC_Response_Server_Add` parte `EC_TAG_SERVER_ADDRESS`
  (string «ip:puerto») por ':' y usa `EC_TAG_SERVER_NAME`; sin nombre, NO se
  envía el tag y el core pone la dirección completa (name.IsEmpty() ?
  full_addr : name). Éxito → `EC_OP_NOOP`; fallo → `EC_OP_FAILED` +
  `EC_TAG_STRING`.
- REMOVE (`0x30`) / CONNECT (`0x2F`): selector ÚNICO `EC_TAG_SERVER 0x0500`
  con tipo IPV4 (4B IP en orden de red + 2B puerto en orden de red) — el core
  resuelve con `GetServerByIPTCP`; la resolución de nombres NO vive aquí,
  sino en el servicio.
- GET_SERVER_LIST (`0x2C`) con `EC_TAG_DETAIL_LEVEL` = `EC_DETAIL_FULL 0x02`;
  la respuesta es `EC_OP_SERVER_LIST 0x2D` (lista vacía si la red ed2k está
  apagada o el core está solo en Kad).
"""

from infrastructure.amule_ec_client import (
    EC_OP_GET_SERVER_LIST,
    EC_OP_SERVER_ADD,
    EC_OP_SERVER_CONNECT,
    EC_OP_SERVER_REMOVE,
    EC_TAG_SERVER,
    EC_TAG_SERVER_ADDRESS,
    EC_TAG_SERVER_NAME,
    build_get_server_list,
    build_server_add,
    build_server_connect,
    build_server_remove,
)

#: ADD «1.2.3.4:4662» con nombre «MiServer»: tags 0x0503 (string, 13 B con
#: NUL) y 0x0501 (string, 9 B con NUL), payload 0x27.
SERVER_ADD = (
    "00000020000000273100020a06060000000d312e322e332e343a3436363200"
    "0a0206000000094d6953657276657200"
)
#: ADD sin nombre: solo el tag de dirección (ntags 0x0001, payload 0x17).
SERVER_ADD_NO_NAME = "00000020000000173100010a06060000000d312e322e332e343a3436363200"
#: GET_SERVER_LIST con DETAIL_LEVEL = FULL (0x02), payload 0x0b.
SERVER_LIST_REQ = "000000200000000b2c00010008020000000102"
#: REMOVE sobre 1.2.3.4:4662 — tag 0x0500 tipo IPV4 (0x08):
#: ip 01020304 + puerto 0x1236 (4662), payload 0x10.
SERVER_REMOVE = "00000020000000103000010a000800000006010203041236"
#: CONNECT: mismo selector, opcode 0x2F.
SERVER_CONNECT = "00000020000000102f00010a000800000006010203041236"


def test_server_add_frame_is_address_and_name():
    assert build_server_add("1.2.3.4:4662", "MiServer").hex() == SERVER_ADD


def test_server_add_without_name_omits_the_name_tag():
    """Sin nombre el tag no viaja: el core rellena con la dirección completa."""
    assert build_server_add("1.2.3.4:4662").hex() == SERVER_ADD_NO_NAME


def test_get_server_list_asks_full_detail():
    assert build_get_server_list().hex() == SERVER_LIST_REQ


def test_remove_selects_the_server_as_an_ipv4_tag():
    assert build_server_remove("1.2.3.4", 4662).hex() == SERVER_REMOVE


def test_connect_selects_the_server_as_an_ipv4_tag():
    assert build_server_connect("1.2.3.4", 4662).hex() == SERVER_CONNECT


def test_constants_match_eccodes_abstract():
    assert (EC_OP_SERVER_ADD, EC_OP_SERVER_REMOVE, EC_OP_SERVER_CONNECT) == (0x31, 0x30, 0x2F)
    assert EC_OP_GET_SERVER_LIST == 0x2C
    assert (EC_TAG_SERVER, EC_TAG_SERVER_NAME, EC_TAG_SERVER_ADDRESS) == (0x0500, 0x0501, 0x0503)
