"""Watchdog de aMule (T3, S2-S6): máquina de estados + tarea periódica de sondeo.

Por qué el canario de búsqueda y no el handshake (S2): el handshake de
`POST /api/amule/test` seguiría pasando con el subsistema de búsquedas/cola
muerto — justo el fallo reportado («cuando se hace cualquier busqueda, no
funciona») — así que cada ciclo manda `run_canary`, una búsqueda real con
timeout. Dos fallos consecutivos confirman «colgado»; UNO nunca confirma ni
reinicia (S2), y jamás se reinicia sin canal Docker (S4).

Por qué el estado vive aquí y la API lo recibe inyectado: `tests_architecture`
prohíbe a `interfaces/` importar `infrastructure/`, así que este módulo publica
un snapshot por reemplazo atómico (el lector conserva el dict que ya tiene) y
`app.py` — la raíz de composición — entrega el módulo a `GET /api/amule/health`.

La config y el canario se leen en cada ciclo (misma regla que S7: config al
momento). Los tests jamás abren red ni Docker: parchean `run_canary`,
`_restart_once`, `_config` o `DockerClient` en las costuras de este módulo.
"""

from __future__ import annotations

import asyncio
import os
import time

from infrastructure.amule_canary import run_canary
from infrastructure.docker_client import ContainerRef, DockerClient, DockerClientError
from infrastructure.settings_store import get_setting

__all__ = [
    "CONFIRM_THRESHOLD",
    "apply_restart_result",
    "get_state",
    "initial_state",
    "process_cycle",
    "tick",
    "watchdog_loop",
]

#: S2: two consecutive failed canaries confirm a hang — one never does.
CONFIRM_THRESHOLD = 2


# ── Estado: snapshot publicado por reemplazo atómico ─────────────────────────


def initial_state() -> dict:
    """Sin datos todavía: el payload honesto para el API y el estado limpio."""
    return {
        "state": "sin-datos",
        "detail": "sin datos del watchdog",
        "checked_at": None,
        "consecutive_failures": 0,
        "restart_attempts": 0,
        "last_restart_at": None,
    }


# Readers keep the dict they are handed, so it is only ever replaced, never
# mutated in place (S6: a restart already reported must not vanish under them).
_state: dict = initial_state()


def get_state() -> dict:
    """El snapshot vigente tal cual: el mismo dict hasta la próxima publicación."""
    return _state


def _publish(snapshot: dict) -> None:
    global _state
    _state = snapshot


# ── Máquina de estados: decisión pura ────────────────────────────────────────


def process_cycle(
    state: dict, canary, *, now: float, cooldown: float, max_attempts: int
) -> tuple[dict, bool]:
    """Una sonda contra la tabla de transiciones → (nuevo_estado, quiere_reinicio).

    `canary` es un `CanaryResult` de `infrastructure.amule_canary` (ok, status,
    reason). Nunca muta `state` ni publica: la decisión es pura.
    """
    new = dict(state)
    new["checked_at"] = now

    if canary.status == "unconfigured":
        # A config gap is not evidence of a hang: count nothing, so two failures
        # split by a gap can never fake a confirmation (S2).
        new.update(
            state="sin-configurar",
            detail=f"sin configurar: {canary.reason}",
            consecutive_failures=0,
        )
        return new, False

    if canary.ok:
        # A recovery resets the counters (S5); `recuperado` is sticky while healthy.
        recovered = state["state"] in ("colgado", "reiniciando", "recuperado")
        new.update(
            state="recuperado" if recovered else "sano",
            detail=(
                "recuperado: el canario vuelve a responder"
                if recovered
                else "sano: el canario responde"
            ),
            consecutive_failures=0,
            restart_attempts=0,
        )
        return new, False

    failures = state["consecutive_failures"] + 1
    new["consecutive_failures"] = failures
    if state["state"] == "alerta":
        return new, False  # alerta clears only on a healthy probe
    if failures < CONFIRM_THRESHOLD:
        new["detail"] = (
            f"fallo del canario ({failures}/{CONFIRM_THRESHOLD}), sin confirmar: {canary.reason}"
        )
        return new, False
    if state["restart_attempts"] >= max_attempts:
        # S5: a cap of restarts without recovery leaves the alert up for a human.
        new.update(
            state="alerta",
            detail=(
                f"alerta: {state['restart_attempts']} reinicios sin recuperación "
                "— intervención manual"
            ),
        )
        return new, False
    if state["last_restart_at"] is not None and now - state["last_restart_at"] < cooldown:
        new.update(state="colgado", detail="colgado confirmado — enfriamiento activo, sin reinicio")
        return new, False
    new.update(state="colgado", detail=f"colgado confirmado: {canary.reason}")
    return new, True


def apply_restart_result(state: dict, outcome: str, detail: str, *, now: float) -> dict:
    """Enruta el desenlace de UN intento de reinicio (S3/S4/S5) → nuevo estado."""
    new = dict(state)
    if outcome == "ok":
        new.update(
            state="reiniciando",
            detail=detail,
            restart_attempts=state["restart_attempts"] + 1,
            last_restart_at=now,
        )
    elif outcome == "failed":
        new.update(
            state="colgado",
            detail=f"reinicio fallido: {detail}",
            restart_attempts=state["restart_attempts"] + 1,
        )
    else:  # "no-channel" (S4): nothing was attempted, so no attempt is counted
        new.update(state="colgado", detail=f"solo detección, no se intentó reinicio: {detail}")
    return new


# ── Config al momento ────────────────────────────────────────────────────────


def _setting(key: str, env: str, default: str):
    # Same precedence as docker_client._configured_container_name: settings win,
    # the environment is the default.
    return get_setting("services", "amule", key, default=os.getenv(env, default))


def _num(raw, default: float) -> float:
    try:
        return float(raw)
    except (TypeError, ValueError):
        return default  # garbage in settings/env must not kill the loop


def _config() -> tuple[bool, float, float, int, float]:
    """(enabled, interval, cooldown, max_attempts, canary_timeout), leído al momento."""
    enabled = str(_setting("watchdog_enabled", "AMULE_WATCHDOG", "1")).strip().lower() not in (
        "0",
        "false",
        "no",
        "",
    )
    interval = _num(_setting("watchdog_interval", "AMULE_WATCHDOG_INTERVAL", "60"), 60.0)
    cooldown = _num(_setting("watchdog_cooldown", "AMULE_WATCHDOG_COOLDOWN", "600"), 600.0)
    max_attempts = int(
        _num(_setting("watchdog_max_restarts", "AMULE_WATCHDOG_MAX_RESTARTS", "3"), 3.0)
    )
    timeout = _num(_setting("watchdog_canary_timeout", "AMULE_WATCHDOG_CANARY_TIMEOUT", "10"), 10.0)
    return enabled, interval, cooldown, max_attempts, timeout


# ── Reinicio por Docker (S8: un único shape fijo) ────────────────────────────


def _restart_once() -> tuple[str, str]:
    """UN restart del contenedor resuelto → (outcome, detalle): ok | failed | no-channel."""
    client = DockerClient()
    try:
        ref: ContainerRef = client.resolve_container()
    except Exception as exc:
        # S4 fail-closed: without a resolved channel nothing is attempted, so
        # whatever broke resolution, the watchdog stays detection-only.
        return "no-channel", str(exc)
    try:
        client.restart_container(ref.id)
    except DockerClientError as exc:
        return "failed", str(exc)
    return "ok", f"reinicio enviado a {ref.name}"


# ── Ciclo y tarea periódica ──────────────────────────────────────────────────


async def tick() -> None:
    """Un ciclo completo: canario → decisión → reinicio opcional → publicar."""
    enabled, _interval, cooldown, max_attempts, timeout = _config()
    if not enabled:
        # Disabled = nothing is monitored: the API must show «sin-datos», never a
        # stale trail that outlives the watchdog (RED pins this transition).
        _publish(initial_state())
        return
    canary = await asyncio.to_thread(run_canary, timeout)
    new_state, wants = process_cycle(
        get_state(), canary, now=time.time(), cooldown=cooldown, max_attempts=max_attempts
    )
    if wants:
        outcome, detail = await asyncio.to_thread(_restart_once)
        new_state = apply_restart_result(new_state, outcome, detail, now=time.time())
    new_state["checked_at"] = time.time()
    _publish(new_state)


async def watchdog_loop() -> None:
    """La forma de resiliencia de `status.background_checker`, ciclo tras ciclo."""
    while True:
        try:
            await tick()
        except asyncio.CancelledError:
            raise
        except Exception as exc:  # noqa: BLE001 — one bad cycle must not kill detection
            _publish({**get_state(), "detail": f"error del watchdog: {exc}"})
        _, interval, *_ = _config()
        await asyncio.sleep(interval)
