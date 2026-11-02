"""`/api/files/rename-preview` and `/api/files/rename-apply`.

The two halves of the Radarr-style rename for the 4K/3D copies: one proposes,
one moves. Radarr is patched on the names the route binds, so these tests never
touch the network — what matters here is the contract: what is offered, what is
refused, and that a refusal leaves the disk exactly as it was.
"""

from types import SimpleNamespace

import pytest

import config
import interfaces.http.routes.files as files_route
from tests._stubs import client

RADARR = {
    "key": "radarr",
    "kind": "arr",
    "configured": True,
    "url": "http://radarr.test",
    "api_key": "k",
}

NAMING = {
    "standard_movie_format": "{Movie Title} ({Release Year}) {Quality Full}",
    "movie_folder_format": "{Movie Title} ({Release Year})",
}

MOVIE = {
    "id": 7,
    "title": "The Batman",
    "year": 2022,
    "quality": "Bluray-1080p",
    "path": "/data/movies/The Batman (2022)",
    "file_name": "The Batman (2022) Bluray-1080p.mkv",
}


@pytest.fixture
def env(tmp_path, monkeypatch):
    """A 4K root inside the allowed roots, one Radarr, scriptable answers."""
    four_k = tmp_path / "4k"
    four_k.mkdir()
    monkeypatch.setattr(config, "ALLOWED_ROOTS", [str(four_k)])
    monkeypatch.setattr(config, "PATH_4K", str(four_k))
    monkeypatch.setattr(config, "PATH_3D", "")
    monkeypatch.setattr(config, "SERVICES", [RADARR])
    monkeypatch.setattr(config, "FOLDER_DOWNLOAD_TORRENT", str(tmp_path / "torrents"))

    answers = SimpleNamespace(movies=[MOVIE], naming=dict(NAMING))

    async def fake_movies(session, service, page=1, page_size=50):
        return {"items": list(answers.movies), "total": len(answers.movies)}

    async def fake_naming(session, service):
        return dict(answers.naming)

    monkeypatch.setattr(files_route, "fetch_all_movies_detailed", fake_movies)
    monkeypatch.setattr(files_route, "arr_naming_config", fake_naming)
    return SimpleNamespace(root=four_k, answers=answers, tmp=tmp_path)


def _preview(path: str) -> dict:
    resp = client.get("/api/files/rename-preview", params={"remote_path": path})
    assert resp.status_code == 200, resp.text
    return resp.json()


def _apply(**body) -> dict:
    resp = client.post("/api/files/rename-apply", json=body)
    assert resp.status_code == 200, resp.text
    return resp.json()


class TestPreview:
    def test_proposes_a_folder_and_a_name_for_a_loose_copy(self, env):
        video = env.root / "The.Batman.2022.2160p.REMUX.mkv"
        video.write_bytes(b"x")

        body = _preview(str(video))

        assert body["ok"] is True, body
        assert body["loose"] is True
        assert body["folder"] == "The Batman (2022)"
        assert "2160p" in body["name"]
        assert body["extension"] == ".mkv"

    def test_lists_the_sidecars_that_would_follow(self, env):
        video = env.root / "The.Batman.2022.2160p.mkv"
        video.write_bytes(b"x")
        (env.root / "The.Batman.2022.2160p.srt").write_bytes(b"x")

        body = _preview(str(video))

        assert [s["from"] for s in body["sidecars"]] == ["The.Batman.2022.2160p.srt"]

    def test_refuses_a_file_outside_the_quality_roots(self, env, monkeypatch):
        other = env.tmp / "storage"
        other.mkdir()
        monkeypatch.setattr(config, "ALLOWED_ROOTS", [str(other)])
        loose = other / "The.Batman.2022.2160p.mkv"
        loose.write_bytes(b"x")

        body = _preview(str(loose))

        assert body["ok"] is False
        assert "4K/3D" in body["detail"]

    def test_degrades_to_the_current_name_when_radarr_is_absent(self, env, monkeypatch):
        monkeypatch.setattr(config, "SERVICES", [])
        video = env.root / "The.Batman.2022.2160p.mkv"
        video.write_bytes(b"x")

        body = _preview(str(video))

        assert body["ok"] is True, body
        assert body["name"] == "The.Batman.2022.2160p"
        assert body["warnings"], "a proposal it could not derive must say so"

    def test_a_path_outside_every_root_is_forbidden(self, env):
        resp = client.get(
            "/api/files/rename-preview", params={"remote_path": "/etc/passwd"}
        )
        assert resp.status_code == 403


class TestApply:
    def test_creates_the_folder_moves_the_set_and_reports_it(self, env):
        video = env.root / "The.Batman.2022.2160p.mkv"
        video.write_bytes(b"video")
        (env.root / "The.Batman.2022.2160p.srt").write_bytes(b"subs")

        body = _apply(
            remote_path=str(video),
            folder="The Batman (2022)",
            name="The Batman (2022) 2160p",
        )

        assert body["ok"] is True, body
        folder = env.root / "The Batman (2022)"
        assert (folder / "The Batman (2022) 2160p.mkv").read_bytes() == b"video"
        assert (folder / "The Batman (2022) 2160p.srt").read_bytes() == b"subs"
        assert not video.exists()
        assert len(body["moved"]) == 2

    def test_refuses_to_overwrite_and_touches_nothing(self, env):
        video = env.root / "The.Batman.2022.2160p.mkv"
        video.write_bytes(b"video")
        squatter = env.root / "Taken.mkv"
        squatter.write_bytes(b"keep me")

        body = _apply(remote_path=str(video), folder="", name="Taken")

        assert body["ok"] is False
        assert "no se sobreescribe" in body["detail"]
        assert squatter.read_bytes() == b"keep me"
        assert video.read_bytes() == b"video"

    def test_honours_the_seed_guard(self, env, monkeypatch):
        video = env.root / "The.Batman.2022.2160p.mkv"
        video.write_bytes(b"video")
        monkeypatch.setattr(
            files_route.place_file, "seed_block_reason", lambda src, root, verb: "sembrando"
        )

        body = _apply(remote_path=str(video), folder="The Batman (2022)", name="The Batman (2022) 2160p")

        assert body["ok"] is False
        assert body["detail"] == "sembrando"
        assert video.exists()

    def test_refuses_a_bad_name_before_touching_the_disk(self, env):
        video = env.root / "The.Batman.2022.2160p.mkv"
        video.write_bytes(b"video")

        body = _apply(remote_path=str(video), folder="../escape", name="The Batman (2022) 2160p")

        assert body["ok"] is False
        assert video.exists()
        assert not (env.tmp / "escape").exists()

    def test_a_path_outside_every_root_is_forbidden(self, env):
        resp = client.post(
            "/api/files/rename-apply",
            json={"remote_path": "/etc/passwd", "folder": "", "name": "x"},
        )
        assert resp.status_code == 403
