"""amule_watchdog (T3, S2/S5/S6) — the transition table IS the spec.

S2: two consecutive failed canaries confirm a hang («cuando se hace cualquier
busqueda, no funciona»), never one. S5: cooldown between restarts, a cap of
consecutive restarts without recovery that opens `alerta`, and recovery that
resets the counters. S6: every state carries `detail` + `checked_at` so the API
never hides an automatic restart.

No test opens real sockets: `run_canary`, `DockerClient` and `_restart_once`
are monkeypatched at the module seam.
"""

import asyncio

import pytest

from infrastructure import amule_watchdog as w
from infrastructure.amule_canary import CanaryResult


def _ok(status: str = "ok", reason: str = "") -> CanaryResult:
    return CanaryResult(status == "ok", status, reason)  # type: ignore[arg-type]


def _hung() -> CanaryResult:
    return CanaryResult(False, "timeout", "timeout: search exceeded 10s")


def _state(**overrides):
    state = w.initial_state()
    state.update(overrides)
    return state


# ── process_cycle: threshold, cooldown, cap (S2/S5) ─────────────────────────


def test_a_healthy_probe_leaves_the_state_sane():
    state, wants = w.process_cycle(_state(), _ok(), now=1000.0, cooldown=600.0, max_attempts=3)
    assert state["state"] == "sano"
    assert state["consecutive_failures"] == 0
    assert state["checked_at"] == 1000.0
    assert wants is False


def test_the_first_failure_never_confirms_a_hang():
    state, wants = w.process_cycle(_state(), _hung(), now=1000.0, cooldown=600.0, max_attempts=3)
    assert wants is False, "one failed canary must not trigger a restart (S2: 2 = confirmado)"
    assert state["state"] != "colgado"
    assert state["consecutive_failures"] == 1


def test_two_consecutive_failures_confirm_the_hang_and_ask_for_a_restart():
    state, _ = w.process_cycle(_state(), _hung(), now=1000.0, cooldown=600.0, max_attempts=3)
    state, wants = w.process_cycle(state, _hung(), now=1060.0, cooldown=600.0, max_attempts=3)
    assert state["state"] == "colgado"
    assert state["consecutive_failures"] == 2
    assert wants is True


def test_a_healthy_probe_between_failures_resets_the_threshold():
    state, _ = w.process_cycle(_state(), _hung(), now=1000.0, cooldown=600.0, max_attempts=3)
    state, _ = w.process_cycle(state, _ok(), now=1060.0, cooldown=600.0, max_attempts=3)
    state, wants = w.process_cycle(state, _hung(), now=1120.0, cooldown=600.0, max_attempts=3)
    assert wants is False
    assert state["consecutive_failures"] == 1


def test_cooldown_blocks_a_second_restart_until_it_elapses():
    state = _state(state="colgado", consecutive_failures=2, restart_attempts=1, last_restart_at=1000.0)
    state, wants = w.process_cycle(state, _hung(), now=1060.0, cooldown=600.0, max_attempts=3)
    assert wants is False, "S5: cooldown between restarts"
    assert "frio" in state["detail"] or "enfriamiento" in state["detail"] or "cooldown" in state["detail"]
    state, wants = w.process_cycle(state, _hung(), now=1600.0, cooldown=600.0, max_attempts=3)
    assert wants is True


def test_the_restart_cap_opens_alert_and_stops_restarting():
    state = _state(state="colgado", consecutive_failures=2, restart_attempts=3, last_restart_at=1000.0)
    state, wants = w.process_cycle(state, _hung(), now=5000.0, cooldown=600.0, max_attempts=3)
    assert state["state"] == "alerta"
    assert wants is False


def test_alerta_survives_further_failures():
    state = _state(state="alerta", restart_attempts=3, last_restart_at=1000.0)
    state, wants = w.process_cycle(state, _hung(), now=9000.0, cooldown=600.0, max_attempts=3)
    assert state["state"] == "alerta"
    assert wants is False


def test_alerta_clears_only_on_a_healthy_probe():
    state = _state(state="alerta", consecutive_failures=3, restart_attempts=3, last_restart_at=1000.0)
    state, wants = w.process_cycle(state, _ok(), now=9000.0, cooldown=600.0, max_attempts=3)
    assert state["state"] == "sano"
    assert state["restart_attempts"] == 0
    assert state["consecutive_failures"] == 0
    assert wants is False


def test_unconfigured_is_never_a_hang():
    probe = _ok("unconfigured", "not configured: no AMULE_URL")
    state, wants = w.process_cycle(_state(), probe, now=1000.0, cooldown=600.0, max_attempts=3)
    assert state["state"] == "sin-configurar"
    assert wants is False
    assert state["consecutive_failures"] == 0


# ── apply_restart_result: outcome routing (S3/S4/S5) ────────────────────────


def test_a_successful_restart_enters_verification():
    state = _state(state="colgado", consecutive_failures=2, restart_attempts=0)
    state = w.apply_restart_result(state, "ok", "reinicio enviado a amuled", now=2000.0)
    assert state["state"] == "reiniciando"
    assert state["restart_attempts"] == 1
    assert state["last_restart_at"] == 2000.0


def test_a_failed_restart_counts_the_attempt_and_stays_hung():
    state = _state(state="colgado", restart_attempts=1)
    state = w.apply_restart_result(state, "failed", "docker engine returned HTTP 500", now=2000.0)
    assert state["state"] == "colgado"
    assert state["restart_attempts"] == 2
    assert "HTTP 500" in state["detail"]


def test_no_channel_is_detection_only_and_counts_no_attempt():
    state = _state(state="colgado", restart_attempts=1)
    state = w.apply_restart_result(state, "no-channel", "container 'amuled' not found", now=2000.0)
    assert state["state"] == "colgado"
    assert state["restart_attempts"] == 1, "S4: without a channel nothing is attempted"
    assert "detección" in state["detail"] or "detection" in state["detail"]


def test_recovery_after_a_restart_resets_the_counters():
    state = _state(state="reiniciando", consecutive_failures=2, restart_attempts=2, last_restart_at=2000.0)
    state, wants = w.process_cycle(state, _ok(), now=2060.0, cooldown=600.0, max_attempts=3)
    assert state["state"] == "recuperado"
    assert state["restart_attempts"] == 0, "S5: a recovery resets the counter"
    assert wants is False


def test_recovery_is_sticky_while_health_stays_good():
    state = _state(state="recuperado", restart_attempts=0, last_restart_at=2000.0)
    state, _ = w.process_cycle(state, _ok(), now=2120.0, cooldown=600.0, max_attempts=3)
    assert state["state"] == "recuperado"


# ── _restart_once: outcome mapping (S4 fail-closed) ─────────────────────────


def test_resolution_failure_maps_to_no_channel(monkeypatch):
    from infrastructure.docker_client import DockerResolutionError

    class Boom:
        def __init__(self, *args, **kwargs):
            pass

        def resolve_container(self):
            raise DockerResolutionError("ambiguous: 2 containers match /amule/i")

    monkeypatch.setattr(w, "DockerClient", Boom)
    outcome, detail = w._restart_once()
    assert outcome == "no-channel"
    assert "ambiguous" in detail


def test_restart_error_maps_to_failed(monkeypatch):
    from infrastructure.docker_client import DockerEngineError

    class Gone:
        def __init__(self, *args, **kwargs):
            pass

        def resolve_container(self):
            return w.ContainerRef(id="abc123", name="amuled", image="amule/amule:latest")

        def restart_container(self, container_id, stop_timeout_s=10):
            raise DockerEngineError("docker engine returned HTTP 500 while restarting", 500)

    monkeypatch.setattr(w, "DockerClient", Gone)
    outcome, detail = w._restart_once()
    assert outcome == "failed"
    assert "HTTP 500" in detail


def test_a_clean_restart_maps_to_ok(monkeypatch):
    class Happy:
        calls: list = []

        def __init__(self, *args, **kwargs):
            pass

        def resolve_container(self):
            return w.ContainerRef(id="abc123", name="amuled", image="amule/amule:latest")

        def restart_container(self, container_id, stop_timeout_s=10):
            Happy.calls.append(container_id)

    monkeypatch.setattr(w, "DockerClient", Happy)
    outcome, detail = w._restart_once()
    assert outcome == "ok"
    assert detail == "reinicio enviado a amuled"
    assert Happy.calls == ["abc123"]


# ── tick: the full cycle through the module seam ────────────────────────────


def _fake_config(enabled=True, interval=60.0, cooldown=600.0, max_attempts=3, timeout=10.0):
    return (enabled, interval, cooldown, max_attempts, timeout)


def test_tick_publishes_sane_after_a_healthy_probe(monkeypatch):
    monkeypatch.setattr(w, "_config", lambda: _fake_config())
    monkeypatch.setattr(w, "run_canary", lambda timeout: _ok())
    asyncio.run(w.tick())
    assert w.get_state()["state"] == "sano"


def test_tick_confirms_a_hang_and_restarts_once(monkeypatch):
    monkeypatch.setattr(w, "_config", lambda: _fake_config())
    monkeypatch.setattr(w, "run_canary", lambda timeout: _hung())
    outcomes = []

    def fake_restart():
        outcomes.append(1)
        return "ok", "reinicio enviado a amuled"

    monkeypatch.setattr(w, "_restart_once", fake_restart)
    asyncio.run(w.tick())  # failure 1: no restart yet
    assert outcomes == []
    asyncio.run(w.tick())  # failure 2: confirmed
    assert outcomes == [1]
    assert w.get_state()["state"] == "reiniciando"
    assert w.get_state()["restart_attempts"] == 1


def test_disabled_watchdog_tick_does_nothing(monkeypatch):
    monkeypatch.setattr(w, "_config", lambda: _fake_config(enabled=False))
    called = []
    monkeypatch.setattr(w, "run_canary", lambda timeout: called.append(1) or _ok())
    asyncio.run(w.tick())
    assert called == []
    assert w.get_state()["state"] == "sin-datos"


def test_loop_survives_an_unexpected_tick_error(monkeypatch):
    monkeypatch.setattr(w, "_config", lambda: _fake_config())

    def explode(timeout):  # arity mirrors the seam: tick calls run_canary(timeout) (S5)
        raise RuntimeError("boom")

    monkeypatch.setattr(w, "run_canary", explode)
    sleeps = []

    async def stop_after_sleep(seconds):
        sleeps.append(seconds)
        raise asyncio.CancelledError

    monkeypatch.setattr(w.asyncio, "sleep", stop_after_sleep)
    with pytest.raises(asyncio.CancelledError):
        asyncio.run(w.watchdog_loop())
    assert sleeps, "the loop must keep cycling after an inner error"
    assert "boom" in w.get_state()["detail"]


# ── get_state: an atomic snapshot (S6) ──────────────────────────────────────


def test_get_state_returns_the_snapshot_not_the_live_mutable(monkeypatch):
    monkeypatch.setattr(w, "_config", lambda: _fake_config())
    monkeypatch.setattr(w, "run_canary", lambda timeout: _ok())
    asyncio.run(w.tick())
    snapshot = w.get_state()
    monkeypatch.setattr(w, "run_canary", lambda timeout: _hung())
    asyncio.run(w.tick())
    assert snapshot["state"] == "sano", "a previously returned snapshot must not mutate under the reader"
