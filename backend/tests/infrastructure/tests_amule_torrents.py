import asyncio

import config
from infrastructure import amule_torrents


def _patch(monkeypatch, tmp_path, rows):
    monkeypatch.setattr(config, "FOLDER_DOWNLOAD_AMULE", str(tmp_path))
    monkeypatch.setattr(amule_torrents, "amule_downloads", lambda: rows)
    monkeypatch.setattr(amule_torrents, "amule_categories", lambda: {"radarr": 1})


def test_queue_rows_and_finished_files_on_disk_are_both_reported(monkeypatch, tmp_path):
    (tmp_path / "Done.mkv").write_bytes(b"x")
    rows = [{"hash": "AB", "name": "Busy.mkv", "size_full": 10, "size_done": 5, "state": "downloading", "category": 1}]
    _patch(monkeypatch, tmp_path, rows)

    found = asyncio.run(amule_torrents.fetch_amule_torrents({"Done.mkv": "", "Gone.mkv": ""}))

    assert {t["name"]: t["progress"] for t in found} == {"Busy.mkv": 0.5, "Done.mkv": 1.0}
    assert found[0]["category"] == "radarr"


def test_a_name_still_in_the_queue_is_not_reported_twice(monkeypatch, tmp_path):
    (tmp_path / "Busy.mkv").write_bytes(b"x")
    rows = [{"hash": "AB", "name": "Busy.mkv", "size_full": 10, "size_done": 5, "state": "downloading"}]
    _patch(monkeypatch, tmp_path, rows)

    assert len(asyncio.run(amule_torrents.fetch_amule_torrents({"Busy.mkv": ""}))) == 1


def test_an_unreachable_amule_is_an_empty_answer(monkeypatch, tmp_path):
    def down():
        raise OSError("refused")

    _patch(monkeypatch, tmp_path, [])
    monkeypatch.setattr(amule_torrents, "amule_downloads", down)

    assert asyncio.run(amule_torrents.fetch_amule_torrents({"x": ""})) == []
