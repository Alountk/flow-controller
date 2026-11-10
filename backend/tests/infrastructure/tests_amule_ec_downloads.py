"""Cola de descargas EC de aMule (pagina-descargas T1/S2): `get_downloads()`.

Contrato fijado aquí sobre `src/libs/ec/abstracts/ECCodes.abstract` de
`amule-org/amule` (la fuente que cita el docstring del cliente):

- Petición `EC_OP_GET_DLOAD_QUEUE 0x0D` con `EC_TAG_DETAIL_LEVEL` =
  `EC_DETAIL_FULL 0x02`; respuesta `EC_OP_DLOAD_QUEUE 0x1F` con un
  `EC_TAG_PARTFILE 0x0300` por descarga y sus subtags (0x0301 nombre, 0x0303
  size_full, 0x0306 size_done, 0x0307 speed, 0x0308 status, 0x0309 prio,
  0x030A sources, 0x030D sources_xfer, 0x030E ed2k_link, 0x030F cat, 0x0317
  stopped, 0x0318 download_active, 0x031E hash HASH16, 0x0324 speed_smoothed).
- Fila S2: `{hash, name, size_full, size_done, progress_pct, speed,
  eta_seconds, state, stopped, status_code, priority, category, sources,
  ed2k_link, source}` con `source: "amule"`. `state` según el doc:
  `size_done >= size_full` → completed; `stopped` o `status_code == 7` →
  paused (el 7 es «Paused» en el `StatusString` de amuleweb); `DOWNLOAD_ACTIVE`,
  `speed > 0` o `SOURCE_COUNT_XFER > 0` → downloading; resto → waiting.
  `eta_seconds = (size_full - size_done) / speed` sólo con `speed > 0`, y el
  orden del core se respeta SIN reordenar. `priority`/`status_code` crudos.
"""

import pytest

from infrastructure import amule_ec_client as ec

HASH32 = "00112233445566778899aabbccddeeff"
LINK = "ed2k://|file|ubuntu.iso|1000|00112233445566778899aabbccddeeff|/"

#: Petición GET_DLOAD_QUEUE con DETAIL_LEVEL = EC_DETAIL_FULL (0x02), payload 0x0b.
GET_DLOAD_QUEUE_REQ = "000000200000000b0d00010008020000000102"


# ---------------------------------------------------------------------------
# Fixtures de cable: builders byte a byte y árboles de tags «sólo lo que el
# core envía» (mismo criterio que tests_amule_servers_service).
# ---------------------------------------------------------------------------


def _uint(code: int, value: int) -> ec.ECTag:
    return ec.ECTag(code, ec.EC_TAGTYPE_UINT32, value.to_bytes(4, "big"))


def _text(code: int, value: str) -> ec.ECTag:
    return ec.ECTag(code, ec.EC_TAGTYPE_STRING, value.encode("utf-8") + b"\x00")


def _partfile(**over) -> ec.ECTag:
    """`EC_TAG_PARTFILE` con los subtags del schema S2; `over` cambia campos."""
    fields = {
        "hash": HASH32,
        "name": "ubuntu.iso",
        "size_full": 1000,
        "size_done": 400,
        "speed": 100,
        "status": 0,
        "stopped": 0,
        "active": 0,
        "sources": 5,
        "sources_xfer": 0,
        "prio": 1,
        "cat": 0,
        "link": LINK,
        **over,
    }
    return ec.ECTag(
        ec.EC_TAG_PARTFILE,
        ec.EC_TAGTYPE_CUSTOM,
        b"",
        (
            _text(ec.EC_TAG_PARTFILE_NAME, fields["name"]),
            _uint(ec.EC_TAG_PARTFILE_SIZE_FULL, fields["size_full"]),
            _uint(ec.EC_TAG_PARTFILE_SIZE_DONE, fields["size_done"]),
            _uint(ec.EC_TAG_PARTFILE_SPEED, fields["speed"]),
            _uint(ec.EC_TAG_PARTFILE_STATUS, fields["status"]),
            _uint(ec.EC_TAG_PARTFILE_PRIO, fields["prio"]),
            _uint(ec.EC_TAG_PARTFILE_SOURCE_COUNT, fields["sources"]),
            _uint(ec.EC_TAG_PARTFILE_SOURCE_COUNT_XFER, fields["sources_xfer"]),
            _text(ec.EC_TAG_PARTFILE_ED2K_LINK, fields["link"]),
            _uint(ec.EC_TAG_PARTFILE_CAT, fields["cat"]),
            _uint(ec.EC_TAG_PARTFILE_STOPPED, fields["stopped"]),
            _uint(ec.EC_TAG_PARTFILE_DOWNLOAD_ACTIVE, fields["active"]),
            ec.ECTag(ec.EC_TAG_PARTFILE_HASH, ec.EC_TAGTYPE_HASH16, bytes.fromhex(fields["hash"])),
        ),
    )


def _client_with_reply(tags) -> tuple[ec.AmuleECClient, list]:
    """Cliente sin red cuya próxima respuesta es `EC_OP_DLOAD_QUEUE` + `tags`."""
    client = ec.AmuleECClient("1.2.3.4", 4712, "x")
    sent: list = []
    client._send = sent.append  # type: ignore[method-assign]
    client._recv_frame = lambda: (ec.EC_OP_DLOAD_QUEUE, list(tags))  # type: ignore[method-assign]
    return client, sent


# ---------------------------------------------------------------------------
# Builders byte a byte (fuente: ECCodes.abstract).
# ---------------------------------------------------------------------------


def test_get_dload_queue_asks_full_detail():
    assert ec.build_get_dload_queue().hex() == GET_DLOAD_QUEUE_REQ
    opcode, tags = ec.decode_frame(ec.build_get_dload_queue())
    assert opcode == ec.EC_OP_GET_DLOAD_QUEUE
    assert [t.code for t in tags] == [ec.EC_TAG_DETAIL_LEVEL]


def test_constants_match_eccodes_abstract():
    assert (ec.EC_OP_GET_DLOAD_QUEUE, ec.EC_OP_DLOAD_QUEUE) == (0x0D, 0x1F)
    assert (
        ec.EC_TAG_PARTFILE,
        ec.EC_TAG_PARTFILE_NAME,
        ec.EC_TAG_PARTFILE_SIZE_FULL,
        ec.EC_TAG_PARTFILE_SIZE_DONE,
        ec.EC_TAG_PARTFILE_SPEED,
        ec.EC_TAG_PARTFILE_STATUS,
        ec.EC_TAG_PARTFILE_PRIO,
        ec.EC_TAG_PARTFILE_SOURCE_COUNT,
        ec.EC_TAG_PARTFILE_SOURCE_COUNT_XFER,
        ec.EC_TAG_PARTFILE_ED2K_LINK,
        ec.EC_TAG_PARTFILE_CAT,
        ec.EC_TAG_PARTFILE_STOPPED,
        ec.EC_TAG_PARTFILE_DOWNLOAD_ACTIVE,
        ec.EC_TAG_PARTFILE_HASH,
        ec.EC_TAG_PARTFILE_SPEED_SMOOTHED,
    ) == (
        0x0300, 0x0301, 0x0303, 0x0306, 0x0307, 0x0308, 0x0309, 0x030A,
        0x030D, 0x030E, 0x030F, 0x0317, 0x0318, 0x031E, 0x0324,
    )


# ---------------------------------------------------------------------------
# Parseo: la fila S2 completa, con `state`/`eta_seconds` derivados.
# ---------------------------------------------------------------------------


def test_get_downloads_builds_the_s2_row_and_sends_the_request():
    client, sent = _client_with_reply([_partfile()])

    assert client.get_downloads() == [
        {
            "hash": HASH32,
            "name": "ubuntu.iso",
            "size_full": 1000,
            "size_done": 400,
            "progress_pct": 40.0,
            "speed": 100,
            "eta_seconds": 6,
            "state": "downloading",
            "stopped": False,
            "status_code": 0,
            "priority": 1,
            "category": 0,
            "sources": 5,
            "ed2k_link": LINK,
            "source": "amule",
        }
    ]
    assert len(sent) == 1, "una sola petición GET_DLOAD_QUEUE"


def test_the_row_is_exactly_the_s2_schema():
    client, _ = _client_with_reply([_partfile()])
    (row,) = client.get_downloads()
    assert set(row) == {
        "hash", "name", "size_full", "size_done", "progress_pct", "speed",
        "eta_seconds", "state", "stopped", "status_code", "priority",
        "category", "sources", "ed2k_link", "source",
    }
    assert row["source"] == "amule"


def test_get_downloads_keeps_the_core_order():
    first = _partfile(hash="ffeeddccbbaa99887766554433221100", name="primero.bin")
    second = _partfile(name="segundo.bin")
    client, _ = _client_with_reply([first, second])

    rows = client.get_downloads()
    assert [r["name"] for r in rows] == ["primero.bin", "segundo.bin"], "S2: sin reordenar"


def test_completed_wins_the_state_when_done_reaches_full():
    client, _ = _client_with_reply([_partfile(size_done=1000, size_full=1000, stopped=1, speed=0)])
    (row,) = client.get_downloads()
    assert row["state"] == "completed"


@pytest.mark.parametrize("over", [{"stopped": 1}, {"status": 7}])
def test_stopped_or_status_seven_reads_as_paused(over):
    client, _ = _client_with_reply([_partfile(speed=0, **over)])
    (row,) = client.get_downloads()
    assert row["state"] == "paused"


@pytest.mark.parametrize(
    "over, expected",
    [
        ({"active": 1, "speed": 0}, "downloading"),
        ({"speed": 50}, "downloading"),
        ({"sources_xfer": 2, "speed": 0}, "downloading"),
        ({"speed": 0}, "waiting"),
    ],
)
def test_downloading_needs_some_activity(over, expected):
    client, _ = _client_with_reply([_partfile(**over)])
    (row,) = client.get_downloads()
    assert row["state"] == expected


@pytest.mark.parametrize(
    "over, expected",
    [
        ({}, 6),  # (1000-400)/100
        ({"size_done": 0, "speed": 300}, 3),  # 10/3 se trunca a segundos
        ({"speed": 0}, None),
    ],
)
def test_eta_seconds_only_exist_when_speed_moves(over, expected):
    client, _ = _client_with_reply([_partfile(**over)])
    (row,) = client.get_downloads()
    assert row["eta_seconds"] == expected


@pytest.mark.parametrize(
    "over, expected",
    [
        ({"size_full": 3, "size_done": 1}, 33.3),
        ({"size_full": 0, "size_done": 0}, 0),
        ({"size_full": 1000, "size_done": 1200}, 100.0),
    ],
)
def test_progress_pct_is_the_share_of_size_full(over, expected):
    client, _ = _client_with_reply([_partfile(**over)])
    (row,) = client.get_downloads()
    assert row["progress_pct"] == expected


def test_priority_and_status_code_travel_raw():
    client, _ = _client_with_reply([_partfile(prio=4, status=7, speed=0)])
    (row,) = client.get_downloads()
    assert row["priority"] == 4, "PrioString 0=Baja..6=Release: el valor crudo viaja tal cual"
    assert row["status_code"] == 7


def test_absent_subtags_read_as_neutral_values_without_inventing_them():
    entry = ec.ECTag(
        ec.EC_TAG_PARTFILE,
        ec.EC_TAGTYPE_CUSTOM,
        b"",
        (
            ec.ECTag(ec.EC_TAG_PARTFILE_HASH, ec.EC_TAGTYPE_HASH16, bytes.fromhex(HASH32)),
            _text(ec.EC_TAG_PARTFILE_NAME, "solo-nombre.bin"),
            _uint(ec.EC_TAG_PARTFILE_SIZE_FULL, 10),
            _uint(ec.EC_TAG_PARTFILE_SIZE_DONE, 3),
        ),
    )
    client, _ = _client_with_reply([entry])
    (row,) = client.get_downloads()
    assert row["speed"] == 0
    assert row["eta_seconds"] is None
    assert row["state"] == "waiting"
    assert row["ed2k_link"] == ""
    assert row["priority"] == 0
    assert row["category"] is None  # sin CAT no hay categoría: no es el índice 0


def test_a_foreign_response_opcode_is_a_protocol_error():
    client = ec.AmuleECClient("1.2.3.4", 4712, "x")
    client._send = lambda frame: None  # type: ignore[method-assign]
    client._recv_frame = lambda: (0x01, [])  # type: ignore[method-assign]
    with pytest.raises(ec.AmuleECProtocolError):
        client.get_downloads()
