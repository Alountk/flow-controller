"""The mass search asks first and can be stopped afterwards (C-09).

``POST /api/wanted/search`` used to fire ``MissingMoviesSearch`` on sight: on
2026-10-07 one call fired grabs for 24 missing movies with no confirmation and
no way to cancel (the command id Radarr returned was discarded). Two
contracts, one route:

- a mass search without ``confirm: true`` launches NOTHING and says so with
  ``needs_confirm`` — a distinct field from ``error``, because nothing failed;
- the launched answer carries ``command_id``, the handle
  ``POST /api/wanted/search/cancel`` forwards back to the arr;
- the cancel route returns the arr's answer verbatim (404 included: an
  already-finished command is the arr's fact, not our error).

Only the collaborators the route module imports are patched, so the real route
bodies run.
"""

from unittest.mock import AsyncMock, patch

from tests._stubs import client

MASS_SEARCH = "/api/wanted/search"
CANCEL = "/api/wanted/search/cancel"


def _post(payload: dict):
    return client.post(MASS_SEARCH, json=payload)


class TestMassSearchNeedsConfirmation:
    def test_without_confirm_nothing_is_launched(self):
        with patch(
            "interfaces.http.routes.wanted.arr_search_missing_movies",
            new_callable=AsyncMock,
        ) as fire:
            body = _post({"source": "radarr"}).json()

        fire.assert_not_called()
        assert body["ok"] is False
        assert body["needs_confirm"] is True
        assert body["command"] == "MissingMoviesSearch"
        assert "confirm=true" in body["detail"]

    def test_sonarr_mass_search_names_the_episode_command(self):
        body = _post({"source": "sonarr"}).json()

        assert body["needs_confirm"] is True
        assert body["command"] == "MissingEpisodeSearch"

    def test_with_confirm_it_fires_and_carries_the_command_id(self):
        fired = AsyncMock(return_value={"ok": True, "detail": "encolado", "command_id": 42})
        with patch("interfaces.http.routes.wanted.arr_search_missing_movies", fired):
            body = _post({"source": "radarr", "confirm": True}).json()

        fired.assert_awaited_once()
        assert body["ok"] is True
        assert body["command_id"] == 42
        assert body["source"] == "radarr"

    def test_an_unconfigured_service_never_asks_for_confirmation(self):
        """No service is a fact about the setup — not a prompt to confirm."""
        body = _post({"source": "nope"}).json()

        assert body["error"] == "servicio desconocido: nope"
        assert "needs_confirm" not in body


class TestCancelCommand:
    def test_the_command_id_reaches_the_arr(self):
        cancelled = AsyncMock(return_value={"ok": True, "detail": "Comando 7 cancelado"})
        with patch("interfaces.http.routes.wanted.arr_cancel_command", cancelled):
            body = client.post(CANCEL, json={"source": "radarr", "command_id": 7}).json()

        cancelled.assert_awaited_once()
        assert cancelled.await_args.args[2] == 7
        assert body["ok"] is True
        assert body["command_id"] == 7
        assert body["source"] == "radarr"

    def test_an_unconfigured_service_returns_the_usual_error(self):
        body = client.post(CANCEL, json={"source": "nope", "command_id": 7}).json()

        assert body["ok"] is False
        assert body["error"] == "servicio desconocido: nope"

    def test_the_arrs_404_is_passed_through_not_swallowed(self):
        cancelled = AsyncMock(
            return_value={"ok": False, "detail": "Comando 7 no encontrado: ya finalizado o id desconocido"}
        )
        with patch("interfaces.http.routes.wanted.arr_cancel_command", cancelled):
            body = client.post(CANCEL, json={"source": "radarr", "command_id": 7}).json()

        assert body["ok"] is False
        assert "no encontrado" in body["detail"]
