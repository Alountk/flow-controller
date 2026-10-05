"""`GET /api/files/roots` — the explorer's labelled roots.

Three kinds of destination, offered only when configured AND present on disk:
the mounts to navigate, each arr's library, and the quality folders (4K / 3D).
Navigation comes first because `FileManager`'s dual pane defaults to
`roots[0]`/`roots[1]` — reordering the list would move the panes' starting
folders, which nobody asked for.

The arr side is patched on `interfaces.http.routes.files.arr_root_folders`:
the endpoint calls the name bound in the route module, and patching
`application.gateways` would not reach it.
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
SONARR = {
    "key": "sonarr",
    "kind": "arr",
    "configured": True,
    "url": "http://sonarr.test",
    "api_key": "k",
}


@pytest.fixture
def env(tmp_path, monkeypatch):
    """A controlled world: two navigation mounts, both arrs configured, no
    quality folders, and a scriptable arr answer per key."""
    mounts = []
    for name in ("storage", "storage-6tb"):
        p = tmp_path / "mnt" / name
        p.mkdir(parents=True)
        mounts.append(str(p))
    monkeypatch.setattr(config, "ALLOWED_ROOTS", mounts)
    monkeypatch.setattr(config, "SERVICES", [RADARR, SONARR])
    monkeypatch.setattr(config, "PATH_4K", "")
    monkeypatch.setattr(config, "PATH_3D", "")

    answers: dict[str, list[str]] = {}

    async def fake_arr_root_folders(session, service):
        return list(answers.get(service["key"], []))

    monkeypatch.setattr(files_route, "arr_root_folders", fake_arr_root_folders)
    return SimpleNamespace(mounts=mounts, answers=answers, tmp=tmp_path)


def _get() -> dict:
    resp = client.get("/api/files/roots")
    assert resp.status_code == 200
    return resp.json()


def _entry(body: dict, path: str) -> dict:
    return next(e for e in body["roots"] if e["path"] == path)


class TestLabelledRoots:
    def test_path_4k_appears_with_role_4k_and_its_label(self, env, monkeypatch):
        four_k = env.tmp / "movies" / "4k"
        four_k.mkdir(parents=True)
        monkeypatch.setattr(config, "PATH_4K", str(four_k))
        # `config.rebuild()` puts the routed folder INSIDE ALLOWED_ROOTS (the
        # copy engine must be allowed to write there) — it must still render
        # once, as its own destination, not as plain navigation.
        monkeypatch.setattr(config, "ALLOWED_ROOTS", env.mounts + [str(four_k)])

        body = _get()

        entry = _entry(body, str(four_k))
        assert entry["role"] == "4k"
        assert entry["label"] == "4K · 2160p"
        assert entry["name"] == "4k"
        assert [e for e in body["roots"] if e["path"] == str(four_k)] == [entry], (
            "the quality folder is listed exactly once"
        )

    def test_path_3d_appears_with_role_3d(self, env, monkeypatch):
        three_d = env.tmp / "movies" / "3d"
        three_d.mkdir(parents=True)
        monkeypatch.setattr(config, "PATH_3D", str(three_d))

        entry = _entry(_get(), str(three_d))

        assert entry["role"] == "3d"
        assert entry["label"] == "3D"
        assert entry["name"] == "3d"

    def test_library_roots_come_from_the_arr_with_role_and_service(self, env):
        movies = env.tmp / "movies" / "es"
        movies.mkdir(parents=True)
        shows = env.tmp / "shows"
        shows.mkdir(parents=True)
        env.answers["radarr"] = [str(movies)]
        env.answers["sonarr"] = [str(shows)]

        body = _get()

        radarr = _entry(body, str(movies))
        assert radarr["role"] == "library"
        assert radarr["service"] == "radarr"
        assert radarr["label"] == "Biblioteca (películas) · 1080 y por debajo"

        sonarr = _entry(body, str(shows))
        assert sonarr["role"] == "library"
        assert sonarr["service"] == "sonarr"
        assert sonarr["label"] == "Biblioteca (series) · 1080 y por debajo"

    def test_path_4k_empty_is_absent(self, env):
        """Not configured must not render as an entry with an empty path."""
        body = _get()

        assert [e for e in body["roots"] if e.get("role") == "4k"] == []
        assert [e for e in body["roots"] if e["path"] == ""] == []

    def test_a_path_that_is_not_a_directory_is_absent(self, env, monkeypatch):
        missing = env.tmp / "not-on-disk"
        monkeypatch.setattr(config, "PATH_4K", str(missing))
        env.answers["radarr"] = [str(env.tmp / "also-missing")]

        body = _get()

        assert [e for e in body["roots"] if e["path"] == str(missing)] == []
        assert [e for e in body["roots"] if e["path"] == str(env.tmp / "also-missing")] == []

    def test_an_arr_returning_no_roots_says_so_in_detail(self, env):
        """Both arrs are configured and both answer `[]` — `arr_root_folders`
        cannot tell "unreachable" from "has no root folder", so the endpoint
        says what actually happened instead of claiming success with a short
        list (the `calendar_destinations` rule)."""
        body = _get()

        assert [e for e in body["roots"] if e.get("role") == "library"] == []
        assert body["detail"], "a configured arr that returned nothing must be stated"
        assert "radarr" in body["detail"]
        assert "sonarr" in body["detail"]

    def test_every_entry_keeps_path_and_name(self, env, monkeypatch):
        """Three frontend consumers read `path` and `name` — the addition of
        roles and labels must not cost them their fields."""
        movies = env.tmp / "movies" / "es"
        movies.mkdir(parents=True)
        four_k = env.tmp / "movies" / "4k"
        four_k.mkdir(parents=True)
        three_d = env.tmp / "movies" / "3d"
        three_d.mkdir(parents=True)
        env.answers["radarr"] = [str(movies)]
        monkeypatch.setattr(config, "PATH_4K", str(four_k))
        monkeypatch.setattr(config, "PATH_3D", str(three_d))

        roots = _get()["roots"]
        assert len(roots) >= 5

        for entry in roots:
            assert isinstance(entry.get("path"), str) and entry["path"], entry
            assert isinstance(entry.get("name"), str) and entry["name"], entry

    def test_navigation_roots_come_first(self, env, monkeypatch):
        movies = env.tmp / "movies" / "es"
        movies.mkdir(parents=True)
        four_k = env.tmp / "movies" / "4k"
        four_k.mkdir(parents=True)
        env.answers["radarr"] = [str(movies)]
        monkeypatch.setattr(config, "PATH_4K", str(four_k))

        roots = _get()["roots"]

        # The two mounts stay roots[0]/roots[1]: the dual pane starts there.
        assert [r["path"] for r in roots[:2]] == env.mounts
        assert all(r["role"] == "navigation" for r in roots[:2])
        # Everything else follows them.
        nav_paths = set(env.mounts)
        assert [r["path"] for r in roots if r["path"] not in nav_paths] == [
            str(movies),
            str(four_k),
        ]
