"""`application.use_cases.library_rename` — identify the movie, propose, apply.

The proposal is a suggestion, the apply is the irreversible half. Both are
tested here without HTTP: the route only validates, guards and maps.

S4 is the reason this file exists: a name is offered only when the Radarr
pattern reproduces the name Radarr already chose for that movie's own file. A
pattern we merely *believe* we understand is how a library gets renamed wrong
with total confidence.
"""

import os
from pathlib import Path
from unittest.mock import patch

import pytest

from application.use_cases import library_rename

NAMING = {
    "standard_movie_format": "{Movie Title} ({Release Year}) {Quality Full}",
    "movie_folder_format": "{Movie Title} ({Release Year})",
}

BATMAN = {
    "id": 7,
    "title": "The Batman",
    "year": 2022,
    "quality": "Bluray-1080p",
    "path": "/data/movies/The Batman (2022)",
    "file_name": "The Batman (2022) Bluray-1080p.mkv",
}

ALIEN = {
    "id": 3,
    "title": "Alien",
    "year": 1979,
    "quality": "Bluray-1080p",
    "path": "/data/movies/Alien (1979)",
    "file_name": "Alien (1979) Bluray-1080p.mkv",
}

ALIENS = {
    "id": 4,
    "title": "Aliens",
    "year": 1986,
    "quality": "Bluray-1080p",
    "path": "/data/movies/Aliens (1986)",
    "file_name": "Aliens (1986) Bluray-1080p.mkv",
}


class TestMatchMovie:
    """Exact after cleaning, never substring — and a tie is a refusal."""

    def test_matches_on_title_and_year(self):
        movie, reason = library_rename.match_movie("The.Batman.2022.2160p.REMUX", [BATMAN])
        assert movie is BATMAN
        assert reason == ""

    def test_does_not_let_alien_claim_aliens(self):
        movie, reason = library_rename.match_movie("Aliens.1986.2160p", [ALIEN])
        assert movie is None
        assert "no coincide" in reason

    def test_prefers_the_right_one_of_two_similar_titles(self):
        movie, _ = library_rename.match_movie("Aliens.1986.2160p", [ALIEN, ALIENS])
        assert movie is ALIENS

    def test_refuses_a_tie_instead_of_guessing(self):
        twin = {**BATMAN, "id": 99, "path": "/data/movies/The Batman (2022) copy"}
        movie, reason = library_rename.match_movie("The.Batman.2022.2160p", [BATMAN, twin])
        assert movie is None
        assert "varias" in reason

    def test_accepts_a_file_whose_name_radarr_wrote_itself(self):
        movie, _ = library_rename.match_movie("The Batman (2022) Bluray-1080p", [BATMAN])
        assert movie is BATMAN

    def test_does_not_match_a_movie_with_no_year_against_a_yearless_stem(self):
        # Without a year the key is the bare title; the stem must still start
        # with it, or every title would claim every longer title.
        movie, _ = library_rename.match_movie("Batman.2022", [BATMAN])
        assert movie is None


class TestProposal:
    """S1/S2/S3/S4: what the dialog shows before anything is touched."""

    def _proposal(self, video, movies=(BATMAN,), naming=NAMING, siblings=(), roots=("/data/4k",)):
        return library_rename.proposal(
            video_path=video,
            movies=list(movies),
            naming_cfg=naming,
            siblings=list(siblings),
            roots=list(roots),
        )

    def test_offers_a_folder_and_a_name_for_a_loose_file(self, tmp_path):
        root = tmp_path / "4k"
        root.mkdir()
        video = root / "The.Batman.2022.2160p.UHD.BluRay.REMUX.mkv"
        video.write_bytes(b"x")

        got = self._proposal(str(video), roots=[str(root)])

        assert got["ok"] is True
        assert got["loose"] is True
        assert got["folder"] == "The Batman (2022)"
        assert got["name"].startswith("The Batman (2022) ")
        assert "2160p" in got["name"], "the copy's own resolution has to survive"
        assert got["extension"] == ".mkv"
        assert got["warnings"] == []

    def test_does_not_offer_a_folder_for_a_file_already_inside_one(self, tmp_path):
        root = tmp_path / "4k"
        inside = root / "The Batman (2022)"
        inside.mkdir(parents=True)
        video = inside / "The.Batman.2022.2160p.REMUX.mkv"
        video.write_bytes(b"x")

        got = self._proposal(str(video), roots=[str(root)])

        assert got["loose"] is False
        assert got["folder"] == ""

    def test_lists_the_sidecars_that_follow(self, tmp_path):
        root = tmp_path / "4k"
        root.mkdir()
        video = root / "The.Batman.2022.2160p.mkv"
        video.write_bytes(b"x")
        (root / "The.Batman.2022.2160p.srt").write_bytes(b"x")
        (root / "Other.Movie.2020.srt").write_bytes(b"x")

        got = self._proposal(
            str(video), siblings=["The.Batman.2022.2160p.mkv", "The.Batman.2022.2160p.srt",
                                  "Other.Movie.2020.srt"], roots=[str(root)]
        )

        assert [s["from"] for s in got["sidecars"]] == ["The.Batman.2022.2160p.srt"]
        assert got["sidecars"][0]["to"] == f"{got['name']}.srt"

    def test_says_so_instead_of_inventing_when_the_pattern_cannot_be_reproduced(self, tmp_path):
        lying = {
            "standard_movie_format": "{Movie Title} ({Release Year}) {Quality Full} {Release Group}",
            "movie_folder_format": "{Movie Title} ({Release Year})",
        }
        root = tmp_path / "4k"
        root.mkdir()
        video = root / "The.Batman.2022.2160p.mkv"
        video.write_bytes(b"x")

        got = self._proposal(str(video), naming=lying, roots=[str(root)])

        assert got["name"] == "The.Batman.2022.2160p", "falls back to the name it has"
        assert got["named"] is False
        # The folder is NOT offered either: moving the copy into a tidy folder
        # around the same scene name is a half rename, and it reads as though
        # the rename had failed. The copy stays where it is until someone names
        # it in the dialog.
        assert got["folder"] == ""
        assert any("plantilla" in w for w in got["warnings"])

    def test_falls_back_to_the_current_name_when_no_movie_matches(self, tmp_path):
        root = tmp_path / "4k"
        root.mkdir()
        video = root / "Unknown.Film.1999.2160p.mkv"
        video.write_bytes(b"x")

        got = self._proposal(str(video), roots=[str(root)])

        assert got["ok"] is True
        assert got["name"] == "Unknown.Film.1999.2160p"
        assert got["folder"] == ""
        assert got["movie"] is None
        assert any("no coincide" in w for w in got["warnings"])

    def test_reports_an_unreadable_folder_instead_of_guessing_names(self, tmp_path):
        got = self._proposal(str(tmp_path / "4k" / "missing.mkv"), roots=[str(tmp_path / "4k")])

        assert got["ok"] is False
        assert got["detail"]


class TestApply:
    """S5-S8: never overwrite, stay in the root, move the set or report it."""

    def _setup(self, tmp_path):
        root = tmp_path / "4k"
        root.mkdir()
        video = root / "The.Batman.2022.2160p.mkv"
        video.write_bytes(b"video")
        (root / "The.Batman.2022.2160p.srt").write_bytes(b"subs")
        return root, video

    def test_creates_the_folder_and_moves_the_video_into_it(self, tmp_path):
        root, video = self._setup(tmp_path)

        got = library_rename.apply_rename(
            video_path=str(video),
            folder="The Batman (2022)",
            stem="The Batman (2022) 2160p",
            siblings=["The.Batman.2022.2160p.mkv"],
            roots=[str(root)],
            blocked=lambda path, verb: None,
        )

        assert got["ok"] is True, got
        target = root / "The Batman (2022)" / "The Batman (2022) 2160p.mkv"
        assert target.exists()
        assert not video.exists()
        assert target.read_bytes() == b"video"

    def test_moves_the_sidecars_and_keeps_their_suffix(self, tmp_path):
        root, video = self._setup(tmp_path)

        got = library_rename.apply_rename(
            video_path=str(video),
            folder="The Batman (2022)",
            stem="The Batman (2022) 2160p",
            siblings=["The.Batman.2022.2160p.mkv", "The.Batman.2022.2160p.srt"],
            roots=[str(root)],
            blocked=lambda path, verb: None,
        )

        assert got["ok"] is True, got
        folder = root / "The Batman (2022)"
        assert (folder / "The Batman (2022) 2160p.srt").read_bytes() == b"subs"
        assert [Path(m["to"]).name for m in got["moved"]] == [
            "The Batman (2022) 2160p.mkv",
            "The Batman (2022) 2160p.srt",
        ]

    def test_refuses_to_overwrite_an_existing_file(self, tmp_path):
        root, video = self._setup(tmp_path)
        squatter = root / "The Batman (2022) 2160p.mkv"
        squatter.write_bytes(b"do not lose me")

        got = library_rename.apply_rename(
            video_path=str(video),
            folder="",
            stem="The Batman (2022) 2160p",
            siblings=["The.Batman.2022.2160p.mkv"],
            roots=[str(root)],
            blocked=lambda path, verb: None,
        )

        assert got["ok"] is False
        assert "The Batman (2022) 2160p.mkv" in got["detail"]
        assert squatter.read_bytes() == b"do not lose me"
        assert video.exists(), "a refused rename moves nothing"

    def test_refuses_when_the_folder_name_is_taken_by_a_file(self, tmp_path):
        root, video = self._setup(tmp_path)
        (root / "The Batman (2022)").write_bytes(b"i am a file")

        got = library_rename.apply_rename(
            video_path=str(video),
            folder="The Batman (2022)",
            stem="The Batman (2022) 2160p",
            siblings=[],
            roots=[str(root)],
            blocked=lambda path, verb: None,
        )

        assert got["ok"] is False
        assert video.exists()

    def test_refuses_a_destination_outside_the_roots(self, tmp_path):
        root, video = self._setup(tmp_path)

        got = library_rename.apply_rename(
            video_path=str(video),
            folder="../escape",
            stem="The Batman (2022) 2160p",
            siblings=[],
            roots=[str(root)],
            blocked=lambda path, verb: None,
        )

        assert got["ok"] is False
        assert video.exists()
        assert not (tmp_path / "escape").exists()

    def test_refuses_a_source_outside_the_roots(self, tmp_path):
        outside = tmp_path / "downloads"
        outside.mkdir()
        video = outside / "The.Batman.2022.2160p.mkv"
        video.write_bytes(b"x")
        root = tmp_path / "4k"
        root.mkdir()

        got = library_rename.apply_rename(
            video_path=str(video),
            folder="The Batman (2022)",
            stem="The Batman (2022) 2160p",
            siblings=[],
            roots=[str(root)],
            blocked=lambda path, verb: None,
        )

        assert got["ok"] is False
        assert "no está" in got["detail"]

    def test_honours_the_seed_guard(self, tmp_path):
        root, video = self._setup(tmp_path)
        calls: list[str] = []

        def blocked(path, verb):
            calls.append(path)
            return "La carpeta de descargas está sembrando"

        got = library_rename.apply_rename(
            video_path=str(video),
            folder="The Batman (2022)",
            stem="The Batman (2022) 2160p",
            siblings=[],
            roots=[str(root)],
            blocked=blocked,
        )

        assert got["ok"] is False
        assert calls == [os.path.realpath(str(video))]

    def test_bad_names_never_reach_the_disk(self, tmp_path):
        root, video = self._setup(tmp_path)

        for folder, stem in [("..", "ok"), ("ok", "../ok"), ("", "")]:
            got = library_rename.apply_rename(
                video_path=str(video),
                folder=folder,
                stem=stem,
                siblings=[],
                roots=[str(root)],
                blocked=lambda path, verb: None,
            )
            assert got["ok"] is False, (folder, stem)
        assert video.exists()

    def test_refuses_two_sidecars_that_would_land_on_the_same_name(self, tmp_path):
        """On a case-insensitive volume `.es.srt` and `.ES.srt` are one file.

        Both render to a distinct-looking target, so only the *comparison* can
        catch it — and `os.rename` would replace one with the other silently.
        """
        root = tmp_path / "4k"
        root.mkdir()
        video = root / "Alien.1979.mkv"
        video.write_bytes(b"video")
        (root / "Alien.1979.es.srt").write_bytes(b"es")
        (root / "Alien.1979.ES.srt").write_bytes(b"ES")

        got = library_rename.apply_rename(
            video_path=str(video),
            folder="Alien (1979)",
            stem="Alien (1979) 2160p",
            siblings=["Alien.1979.mkv", "Alien.1979.es.srt", "Alien.1979.ES.srt"],
            roots=[str(root)],
            blocked=lambda path, verb: None,
        )

        assert got["ok"] is False
        assert video.exists(), "a refused rename moves nothing"

    def test_reports_each_file_it_moved_so_the_rename_can_be_undone(self, tmp_path):
        root, video = self._setup(tmp_path)

        got = library_rename.apply_rename(
            video_path=str(video),
            folder="The Batman (2022)",
            stem="The Batman (2022) 2160p",
            siblings=["The.Batman.2022.2160p.mkv"],
            roots=[str(root)],
            blocked=lambda path, verb: None,
        )

        assert got["moved"][0]["from"] == str(video)
        assert got["moved"][0]["to"] == str(root / "The Batman (2022)" / "The Batman (2022) 2160p.mkv")

    def test_a_failed_sidecar_is_reported_instead_of_hidden(self, tmp_path):
        root, video = self._setup(tmp_path)

        with patch("application.use_cases.library_rename.os.rename",
                   side_effect=[None, OSError("permission denied")]):
            got = library_rename.apply_rename(
                video_path=str(video),
                folder="The Batman (2022)",
                stem="The Batman (2022) 2160p",
                siblings=["The.Batman.2022.2160p.mkv", "The.Batman.2022.2160p.srt"],
                roots=[str(root)],
                blocked=lambda path, verb: None,
            )

        assert got["ok"] is True
        assert [f["name"] for f in got["failed"]] == ["The.Batman.2022.2160p.srt"]
        assert got["detail"], "the partial result has to be described, not swallowed"


class TestRefuseLoser:
    def test_a_refused_plan_never_reports_ok(self):
        got = library_rename.refusal("Ya existe: x.mkv")
        assert got == {"ok": False, "detail": "Ya existe: x.mkv"}


@pytest.mark.parametrize("seed", ["/data/4k"])
def test_roots_are_compared_on_their_real_path(tmp_path, seed):
    """A symlinked root is still the root, the same way the seed guard reads paths."""
    real = tmp_path / "real"
    real.mkdir()
    link = tmp_path / "link"
    link.symlink_to(real)
    video = link / "The.Batman.2022.2160p.mkv"
    video.write_bytes(b"x")

    got = library_rename.proposal(
        video_path=str(video),
        movies=[BATMAN],
        naming_cfg=NAMING,
        siblings=["The.Batman.2022.2160p.mkv"],
        roots=[str(real)],
    )

    assert got["loose"] is True


class TestCandidates:
    """S2 and S5: what the section lists, and what it refuses to hide."""

    NAMING = {
        "standard_movie_format": "{Movie Title} ({Release Year}) {Quality Full}",
        "movie_folder_format": "{Movie Title} ({Release Year})",
    }

    MOVIE = {
        "id": 7,
        "title": "Alien",
        "year": 1979,
        "path": "/mnt/1080/Alien (1979)",
        "quality": "Bluray-1080p",
        "file_name": "Alien (1979) Bluray-1080p.mkv",
    }

    def _tree(self, tmp_path, *files):
        root = tmp_path / "4k"
        root.mkdir()
        for rel in files:
            path = root / rel
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_bytes(b"x")
        return str(root)

    def test_lists_a_copy_that_does_not_follow_the_template(self, tmp_path):
        root = self._tree(tmp_path, "Alien.1979.2160p.mkv")

        got = library_rename.candidates(
            roots=[root], movies=[self.MOVIE], naming_cfg=self.NAMING
        )

        assert [item["src"] for item in got["items"]] == [f"{root}/Alien.1979.2160p.mkv"]
        assert got["items"][0]["ok"] is True
        assert got["scanned"] == 1

    def test_skips_a_copy_that_already_follows_the_template(self, tmp_path):
        # Exactly what the template renders for that movie and that 2160p copy
        # (Radarr's quality plus the copy's own resolution): nothing to do.
        root = self._tree(tmp_path, "Alien (1979)/Alien (1979) Bluray-2160p.mkv")
        naming = {
            "standard_movie_format": "{Movie Title} ({Release Year}) {Quality Full}",
            "movie_folder_format": "{Movie Title} ({Release Year})",
        }

        got = library_rename.candidates(
            roots=[root], movies=[self.MOVIE], naming_cfg=naming
        )

        assert got["items"] == []
        assert got["scanned"] == 1

    def test_a_copy_it_cannot_propose_appears_with_its_warning(self, tmp_path):
        # S5: an unidentified file is shown, not hidden — the library is not complete.
        root = self._tree(tmp_path, "Unknown.Thing.2020.mkv")

        got = library_rename.candidates(
            roots=[root], movies=[self.MOVIE], naming_cfg=self.NAMING
        )

        assert len(got["items"]) == 1
        assert got["items"][0]["ok"] is True
        assert got["items"][0]["warnings"]

    def test_ignores_a_file_that_is_not_media_and_a_missing_root(self, tmp_path):
        root = self._tree(tmp_path, "notas.txt")

        got = library_rename.candidates(
            roots=[root, str(tmp_path / "missing")], movies=[self.MOVIE], naming_cfg=self.NAMING
        )

        assert got["items"] == []
        assert got["scanned"] == 0

    def test_lists_a_copy_it_cannot_name_without_offering_a_folder(self, tmp_path):
        """The reported half rename: a folder appeared, the file kept its name."""
        untracked = {k: v for k, v in self.MOVIE.items() if k != "file_name"}
        root = self._tree(tmp_path, "Alien.1979.2160p.REMASTERED.mkv")

        got = library_rename.candidates(roots=[root], movies=[untracked], naming_cfg=self.NAMING)

        assert [item["named"] for item in got["items"]] == [False]
        assert got["items"][0]["folder"] == ""
        assert got["items"][0]["name"] == "Alien.1979.2160p.REMASTERED", "no invented name"

    def test_never_lists_a_named_copy_without_its_folder_plan(self, tmp_path):
        root = self._tree(tmp_path, "Alien.1979.2160p.mkv")

        got = library_rename.candidates(roots=[root], movies=[self.MOVIE], naming_cfg=self.NAMING)

        item = got["items"][0]
        assert item["named"] is True
        assert item["folder"] == "Alien (1979)"
        assert item["name"] == "Alien (1979) Bluray-1080p", "the quality it could place"
