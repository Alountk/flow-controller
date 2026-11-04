"""El recorrido: qué ficheros cuentan y qué se le pasa a la regla.

El `walk` se inyecta (como en `scan_wanted`) para no depender de un disco real;
los tamaños sí son reales sobre un `tmp_path`, porque son la cifra que el usuario
usa para decidir qué borra.
"""

import os

from application.use_cases.duplicate_scan import collect_video_files, scan_duplicates


def fake_walk(tree):
    """`{carpeta: [nombres]}` → un walk como el de `os.walk`."""
    def walk(_root):
        for folder, names in tree.items():
            yield folder, [], names
    return walk


def test_only_video_extensions_are_collected(tmp_path):
    folder = tmp_path / "Film (2001)"
    folder.mkdir()
    for name in ("Film 1080p.mkv", "Film 1080p.es.srt", "poster.jpg", "Film 1080p.nfo"):
        (folder / name).write_bytes(b"x" * 5)

    found = collect_video_files([str(tmp_path)], walk=fake_walk({str(folder): [
        "Film 1080p.mkv", "Film 1080p.es.srt", "poster.jpg", "Film 1080p.nfo"]}))

    assert [os.path.basename(f["path"]) for f in found] == ["Film 1080p.mkv"]
    assert found[0]["size"] == 5


def test_a_root_that_does_not_exist_is_skipped_not_fatal(tmp_path):
    found = collect_video_files([str(tmp_path / "no-existe")], walk=fake_walk({}))
    assert found == []


def test_scan_reports_the_folders_with_two_videos_of_the_same_class(tmp_path):
    folder = tmp_path / "movies" / "Now You See Me (2013)"
    folder.mkdir(parents=True)
    (folder / "Now You See Me (2013) WEBRip-1080p - h265 DTS - [ES+EN].mkv").write_bytes(b"x" * 100)
    (folder / "Now You See Me (2013) WEBDL-1080p - h265 TrueHD Atmos - [EN+ES].mkv").write_bytes(b"x" * 200)
    names = sorted(os.listdir(folder))

    groups = scan_duplicates(
        [str(tmp_path)],
        walk=fake_walk({str(folder): names}),
        known={str(folder): "Now You See Me (2013) WEBRip-1080p - h265 DTS - [ES+EN].mkv"},
        titles={str(folder): "Now You See Me"},
    )

    assert len(groups) == 1
    assert groups[0]["title"] == "Now You See Me"
    assert groups[0]["reclaimable"] == 200


def test_the_scan_can_say_radarr_did_not_answer(tmp_path):
    folder = tmp_path / "Film (2001)"
    folder.mkdir()
    (folder / "Film 1080p.mkv").write_bytes(b"x" * 10)
    (folder / "Film 1080p CD2.mkv").write_bytes(b"x" * 20)

    groups = scan_duplicates(
        [str(tmp_path)],
        walk=fake_walk({str(folder): sorted(os.listdir(folder))}),
        radarr_available=False,
    )

    assert groups[0]["reclaimable"] == 0
    assert all(f["known"] is None for f in groups[0]["files"])
