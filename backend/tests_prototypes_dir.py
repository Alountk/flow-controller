"""The prototypes folder is resolved to the wrong place inside the container.

`config.BASE_DIR` is `os.path.dirname(config.py)`:

- **locally** that is `<repo>/backend`, so `../prototypes` is `<repo>/prototypes` ✅
- **in the container** the Dockerfile does `COPY backend/*.py .` with
  `WORKDIR /app`, flattening the package, so `BASE_DIR` is `/app` and
  `../prototypes` resolves to **`/prototypes`** — while the image actually
  ships them at `/app/prototypes` (`COPY prototypes/ /app/prototypes/`).

`os.path.isdir("/prototypes")` is false, `list_prototypes` returns `[]`,
and the Prototipos page shows its empty state. The section itself is a
hardcoded sidebar entry, so seeing it proves nothing about the directory.

Both layouts are legitimate; the resolver has to cope with both instead of
baking one of them into the constant.
"""

import json
import os
import pathlib

from routes.settings import PROTOTYPES_DIR, _resolve_prototypes_dir


def _make(tmp_path, *parts, files=("a.html",)):
    root = tmp_path.joinpath(*parts)
    root.mkdir(parents=True, exist_ok=True)
    for name in files:
        (root / name).write_text("<!DOCTYPE html><html></html>")
    return str(root)


class TestTheResolverCopesWithBothLayouts:
    def test_the_repo_layout_where_config_sits_next_to_prototypes(self, tmp_path):
        """Local dev: <repo>/backend/config.py, <repo>/prototypes/."""
        base = tmp_path / "repo" / "backend"
        base.mkdir(parents=True)
        expected = _make(tmp_path, "repo", "prototypes")

        assert _resolve_prototypes_dir(str(base)) == expected

    def test_the_container_layout_where_config_sits_beside_them(self, tmp_path):
        """Docker: backend/*.py flattened into /app, so prototypes live INSIDE."""
        base = tmp_path / "app"
        base.mkdir(parents=True)
        expected = _make(tmp_path, "app", "prototypes")

        resolved = _resolve_prototypes_dir(str(base))

        assert resolved == expected, (
            "this is the deployed case: the image ships /app/prototypes and the "
            "old constant looked at /app/../prototypes = /prototypes"
        )
        assert os.path.isdir(resolved), "the answer has to exist to be useful"

    def test_it_falls_back_to_the_repo_layout_when_neither_exists(self, tmp_path):
        """Missing directory must not raise — the endpoint reports empty anyway."""
        base = tmp_path / "empty"
        base.mkdir(parents=True)

        resolved = _resolve_prototypes_dir(str(base))

        assert resolved == str(tmp_path / "prototypes")

    def test_the_container_layout_is_what_the_image_builds(self, tmp_path):
        """Pin the assumption against the Dockerfile's own destination.

        If the Dockerfile ever copies elsewhere this test — and the resolver —
        must be revisited rather than silently rotting.
        """
        dockerfile = pathlib.Path(__file__).resolve().parent.parent / "Dockerfile"
        assert "COPY prototypes/ /app/prototypes/" in dockerfile.read_text()

        base = tmp_path / "app"
        base.mkdir(parents=True)
        _make(tmp_path, "app", "prototypes")

        assert _resolve_prototypes_dir(str(base)) == str(base / "prototypes")


class TestTheEndpointUsesIt:
    def test_the_endpoint_lists_from_the_resolved_directory(self, tmp_path, monkeypatch):
        from fastapi.testclient import TestClient
        from app import app
        import routes.settings as settings_route

        target = tmp_path / "here"
        target.mkdir()
        (target / "setup-01.html").write_text("<!DOCTYPE html><html></html>")
        (target / "notes.md").write_text("not a prototype")
        archive = target / "archive"
        archive.mkdir()
        (archive / "old.html").write_text("<!DOCTYPE html><html></html>")

        monkeypatch.setattr(settings_route, "PROTOTYPES_DIR", str(target))
        client = TestClient(app, raise_server_exceptions=False)

        body = client.get("/api/prototypes").json()

        # `name`/`file` are the contract the gallery renders; the rest are the
        # manifest annotations with their fail-open defaults.
        assert [(item["name"], item["file"]) for item in body] == [
            ("setup-01", "setup-01.html")
        ], "only top-level .html — archive/ and non-html files must not become tabs"
        assert body[0]["status"] == "unlisted", body[0]
        assert body[0]["section"] == "otros"

    def test_a_missing_directory_is_an_empty_list_not_a_500(self, tmp_path, monkeypatch):
        from fastapi.testclient import TestClient
        from app import app
        import routes.settings as settings_route

        monkeypatch.setattr(settings_route, "PROTOTYPES_DIR", str(tmp_path / "nowhere"))
        client = TestClient(app, raise_server_exceptions=False)

        assert client.get("/api/prototypes").json() == []


def test_the_shipped_constant_points_somewhere_plausible():
    """Locally this is <repo>/prototypes; the point is it is never a bare root."""
    assert PROTOTYPES_DIR.endswith("prototypes"), PROTOTYPES_DIR
    assert PROTOTYPES_DIR != "/prototypes" or not os.path.isdir(PROTOTYPES_DIR)


# ── The manifest: what is chosen, what was thrown away ────────────────────────


def _catalogued(target, *, files=("a.html",), manifest=None):
    target.mkdir(parents=True, exist_ok=True)
    for name in files:
        (target / name).write_text("<!DOCTYPE html><html></html>")
    if manifest is not None:
        (target / "manifest.json").write_text(
            json.dumps({"items": manifest}), encoding="utf-8"
        )
    return str(target)


def _listed(target, monkeypatch):
    import routes.settings as settings_route
    from fastapi.testclient import TestClient
    from app import app

    monkeypatch.setattr(settings_route, "PROTOTYPES_DIR", str(target))
    return TestClient(app, raise_server_exceptions=False).get("/api/prototypes").json()


class TestTheManifestMarksChosenAndThrownAway:
    def test_a_selected_entry_carries_its_status_and_recommendation(
        self, tmp_path, monkeypatch
    ):
        target = _catalogued(
            tmp_path / "p",
            files=("setup-02.html",),
            manifest=[
                {
                    "file": "setup-02.html",
                    "section": "setup",
                    "status": "selected",
                    "recommend": True,
                    "note": "La tarjeta con foco enfoca el paso actual.",
                }
            ],
        )

        [item] = _listed(target, monkeypatch)

        assert item["status"] == "selected"
        assert item["recommend"] is True
        assert item["section"] == "setup"
        assert item["note"].startswith("La tarjeta")

    def test_a_discarded_entry_keeps_the_reason_it_was_thrown_away(
        self, tmp_path, monkeypatch
    ):
        """A discarded design with no reason is a decision nobody can learn
        from — the next person rebuilds it."""
        target = _catalogued(
            tmp_path / "p",
            files=("setup-01.html",),
            manifest=[
                {
                    "file": "setup-01.html",
                    "section": "setup",
                    "status": "discarded",
                    "note": "Siete pasos en una columna: se perdía el contexto.",
                }
            ],
        )

        [item] = _listed(target, monkeypatch)

        assert item["status"] == "discarded"
        assert "Siete pasos" in item["note"]

    def test_a_file_nobody_catalogued_is_shown_anyway(self, tmp_path, monkeypatch):
        """Fail open. The gallery is a directory listing; the manifest only
        annotates it. Requiring an entry would mean a new .html could vanish."""
        target = _catalogued(tmp_path / "p", files=("stray.html",))

        [item] = _listed(target, monkeypatch)

        assert item["file"] == "stray.html"
        assert item["status"] == "unlisted"
        assert item["section"] == "otros"
        assert item["recommend"] is False

    def test_a_manifest_that_cannot_be_read_does_not_break_the_gallery(
        self, tmp_path, monkeypatch
    ):
        target = _catalogued(tmp_path / "p", files=("a.html",))
        pathlib.Path(target, "manifest.json").write_text("{not json", encoding="utf-8")

        body = _listed(target, monkeypatch)

        assert [item["file"] for item in body] == ["a.html"]
        assert body[0]["status"] == "unlisted"

    def test_an_entry_pointing_at_a_file_that_is_gone_is_dropped(
        self, tmp_path, monkeypatch
    ):
        """There is nothing to preview, so a stale entry is noise — and the
        obvious naive merge would ship a tab with a blank frame."""
        target = _catalogued(
            tmp_path / "p",
            files=("a.html",),
            manifest=[{"file": "deleted.html", "status": "selected"}],
        )

        body = _listed(target, monkeypatch)

        assert [item["file"] for item in body] == ["a.html"]

    def test_the_flat_fields_the_current_page_never_stop_working(
        self, tmp_path, monkeypatch
    ):
        target = _catalogued(tmp_path / "p", files=("setup-02.html",))

        [item] = _listed(target, monkeypatch)

        assert item["name"] == "setup-02"
        assert item["file"] == "setup-02.html"
