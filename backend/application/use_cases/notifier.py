"""Avisos al móvil por ntfy (C-01).

`send` devuelve siempre un resultado y **nunca lanza**: un canal caído, lento o
con token inválido no puede tumbar un import, un sondeo ni una petición HTTP
(S7). Quien avisa decide qué hacer con un `ok: False`; el envío no decide por él.

Formato: la API **JSON publish** de ntfy. El topic y los textos viajan en el
cuerpo porque van en UTF-8 — «Película», «añadida» — y una cabecera HTTP con
acentos es justo el sitio donde eso se rompe.
"""

from __future__ import annotations

import time

from config import get_setting
from state import http_session

#: Un aviso que tarda más que esto ya no sirve de nada, y el poller que lo
#: manda corre cada pocos segundos: no puede quedarse esperando.
DEFAULT_TIMEOUT = 5.0


def config() -> dict:
    """Lo guardado, con los tipos ya resueltos. Sin secretos fuera de aquí."""
    return {
        "url": (get_setting("notifications", "ntfy", "url", default="") or "").rstrip("/"),
        "topic": get_setting("notifications", "ntfy", "topic", default="") or "",
        "token": get_setting("notifications", "ntfy", "token", default="") or "",
        "enabled": bool(get_setting("notifications", "ntfy", "enabled", default=False)),
    }


async def send(
    title: str,
    message: str,
    *,
    tags: list[str] | None = None,
    priority: str | None = None,
) -> dict:
    """Publica el aviso. Devuelve `{ok, status, elapsed_ms, error}` siempre."""
    channel = config()
    if not (channel["enabled"] and channel["url"] and channel["topic"]):
        return {"ok": False, "status": None, "elapsed_ms": 0, "error": "not-configured"}

    body: dict = {"topic": channel["topic"], "title": title, "message": message}
    if tags:
        body["tags"] = list(tags)
    if priority:
        body["priority"] = priority
    headers = {"Authorization": f"Bearer {channel['token']}"} if channel["token"] else {}

    timeout = float(get_setting("intervals", "request_timeout", default=DEFAULT_TIMEOUT))
    started = time.monotonic()
    try:
        async with http_session() as session:
            async with session.post(channel["url"], json=body, headers=headers, timeout=timeout) as response:
                status = response.status
    except Exception as exc:  # noqa: BLE001 — un canal caído es un resultado, no una excepción
        return {
            "ok": False,
            "status": None,
            "elapsed_ms": int((time.monotonic() - started) * 1000),
            "error": f"{type(exc).__name__}: {exc}",
        }

    return {
        "ok": 200 <= status < 300,
        "status": status,
        "elapsed_ms": int((time.monotonic() - started) * 1000),
        "error": "" if 200 <= status < 300 else f"HTTP {status}",
    }
