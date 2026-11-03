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

    def fake_probe(_path):
        return {
            "video_tracks": [{"codec": "hevc", "width": 3840, "height": 1606, "pix_fmt": "yuv420p10le",
                              "color_transfer": "smpte2084"}],
            "audio_tracks": [{"codec": "dts", "profile": "DTS-HD MA", "channels": 6,
                              "language": "eng"}],
            "subtitle_tracks": [],
        }

    # ffprobe is external: the route gets a stand-in that answers like one.
    monkeypatch.setattr(files_route, "probe_file", fake_probe)
    monkeypatch.setattr(files_route, "fetch_all_movies_detailed", fake_movies)
    monkeypatch.setattr(files_route, "arr_naming_config", fake_naming)
    return SimpleNamespace(root=four_k, answers=answers, tmp=tmp_path)


def _preview(path: str, movie_id: int = 0) -> dict:
    params = {"remote_path": path}
    if movie_id:
        params["movie_id"] = movie_id
    resp = client.get("/api/files/rename-preview", params=params)
    assert resp.status_code == 200, resp.text
    return resp.json()


def _search(q: str) -> dict:
    resp = client.get("/api/files/rename-movies", params={"q": q})
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

    def test_a_movie_picked_by_hand_names_a_copy_the_pattern_could_not(self, env):
        # What the instance showed: Radarr knows the movie, but has no file of
        # its own to reproduce the pattern against, so nothing could be named.
        env.answers.movies = [{k: v for k, v in MOVIE.items() if k != "file_name"}]
        video = env.root / "The.Batman.2022.2160p.REMUX.mkv"
        video.write_bytes(b"x")
        blind = _preview(str(video))
        assert blind["named"] is False, blind
        assert blind["folder"] == ""

        body = _preview(str(video), movie_id=7)

        assert body["ok"] is True, body
        assert body["named"] is True
        assert body["folder"] == "The Batman (2022)"
        assert "2160p" in body["name"]
        assert any("mano" in w for w in body["warnings"]), "the gate it skipped is admitted"

    def test_an_unknown_movie_id_refuses_instead_of_guessing(self, env):
        video = env.root / "The.Batman.2022.2160p.mkv"
        video.write_bytes(b"x")

        body = _preview(str(video), movie_id=999)

        assert body["ok"] is False
        assert "catálogo" in body["detail"]

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

    def test_a_movie_picked_by_hand_names_a_copy_the_pattern_could_not(self, env):
        # What the instance showed: Radarr knows the movie, but has no file of
        # its own to reproduce the pattern against, so nothing could be named.
        env.answers.movies = [{k: v for k, v in MOVIE.items() if k != "file_name"}]
        video = env.root / "The.Batman.2022.2160p.REMUX.mkv"
        video.write_bytes(b"x")
        blind = _preview(str(video))
        assert blind["named"] is False, blind
        assert blind["folder"] == ""

        body = _preview(str(video), movie_id=7)

        assert body["ok"] is True, body
        assert body["named"] is True
        assert body["folder"] == "The Batman (2022)"
        assert "2160p" in body["name"]
        assert any("mano" in w for w in body["warnings"]), "the gate it skipped is admitted"

    def test_an_unknown_movie_id_refuses_instead_of_guessing(self, env):
        video = env.root / "The.Batman.2022.2160p.mkv"
        video.write_bytes(b"x")

        body = _preview(str(video), movie_id=999)

        assert body["ok"] is False
        assert "catálogo" in body["detail"]

    def test_a_path_outside_every_root_is_forbidden(self, env):
        resp = client.post(
            "/api/files/rename-apply",
            json={"remote_path": "/etc/passwd", "folder": "", "name": "x"},
        )
        assert resp.status_code == 403


class TestSearch:
    def test_finds_the_movie_by_what_the_person_typed(self, env):
        env.answers.movies = [
            MOVIE,
            {"id": 9, "title": "Alien", "year": 1979, "path": "/data/movies/Alien (1979)"},
            {"id": 10, "title": "Batman Begins", "year": 2005, "path": "/data/movies/Batman Begins (2005)"},
        ]

        body = _search("batman")

        assert [m["title"] for m in body["items"]] == ["Batman Begins", "The Batman"]
        assert body["items"][1]["folder"] == "The Batman (2022)", "the folder Radarr uses"

    def test_finds_by_spanish_title_and_year(self, env):
        env.answers.movies = [
            {"id": 11, "title": "El caballero oscuro", "year": 2008, "path": "/data/movies/El caballero oscuro (2008)"}
        ]

        assert [m["id"] for m in _search("caballero")["items"]] == [11]
        assert [m["id"] for m in _search("El caballero oscuro 2008")["items"]] == [11]

    def test_an_empty_query_offers_nothing_to_pick(self, env):
        assert _search("")["items"] == []

    def test_says_nothing_when_radarr_is_not_configured(self, env, monkeypatch):
        monkeypatch.setattr(config, "SERVICES", [])

        body = _search("batman")

        assert body["ok"] is True
        assert body["items"] == []


class TestCandidates:
    def test_candidates_scans_roots_and_proposes_with_probed_resolution(self, env):
        env.answers.naming = {
            "standard_movie_format": "{Movie Title} ({Release Year}) {Quality Title} - {MediaInfo Simple}",
            "movie_folder_format": "{Movie Title} ({Release Year})",
        }
        env.answers.movies = [
            {
                **MOVIE,
                "file_name": "The Batman (2022) Bluray-1080p - h264 EAC3.mkv",
                "media_info": {"video_codec": "h264", "audio_codec": "EAC3"},
            }
        ]
        video = env.root / "The.Batman.2022.REMUX.mkv"
        video.write_bytes(b"x")

        resp = client.get("/api/files/rename-candidates")
        assert resp.status_code == 200
        body = resp.json()
        assert body["ok"] is True
        assert len(body["items"]) == 1
        item = body["items"][0]
        assert item["named"] is True
        # Probed width (3840) proves 2160p despite cropped height (1606) and no resolution in filename
        assert "Remux-2160p" in item["name"]

