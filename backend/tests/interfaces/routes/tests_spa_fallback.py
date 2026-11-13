"""The catch-all that serves the SPA must not swallow API typos or leave the dist folder."""

import pytest
from fastapi.testclient import TestClient

import app as app_module


@pytest.fixture
def dist(tmp_path, monkeypatch):
    root = tmp_path / "dist"
    root.mkdir()
    (root / "index.html").write_text("<html>spa</html>")
    (root / "app.js").write_text("console.log(1)")
    # A sibling whose name starts with the dist folder's name.
    sibling = tmp_path / "dist-private"
    sibling.mkdir()
    (sibling / "secret.txt").write_text("do not serve")
    monkeypatch.setattr(app_module, "FRONTEND_DIST", str(root))
    return root


@pytest.fixture
def client(dist):
    return TestClient(app_module.app)


class TestUnknownApiPaths:
    @pytest.mark.parametrize("path", ["/api/nope", "/api/deep/nope", "/prototypes/nope.html"])
    def test_an_unknown_api_or_prototype_path_is_a_404_not_a_200(self, client, path):
        resp = client.get(path)

        assert resp.status_code == 404
        assert resp.json() == {"detail": "Not Found"}


class TestSpaFallbackStaysInsideDist:
    def test_a_client_side_route_gets_the_index(self, client):
        resp = client.get("/peliculas")

        assert resp.status_code == 200
        assert "spa" in resp.text

    def test_a_real_asset_is_served(self, client):
        assert client.get("/app.js").text == "console.log(1)"

    def test_a_sibling_folder_sharing_the_prefix_is_not_served(self, client):
        resp = client.get("/%2e%2e/dist-private/secret.txt")

        assert "do not serve" not in resp.text
