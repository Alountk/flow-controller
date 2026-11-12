"""Shared HTTP dependencies — what every protected route asks the framework first.

`verify_api_key` used to live in `routes/status.py`, and seven route modules
imported it from there: a route reaching into another route's module for its
auth meant the "status" module was secretly the app's dependency bag. This is
the bag. FastAPI's `Depends` does not care where the callable comes from — only
that it is the same callable — so every signature keeps working unchanged.
"""

import logging

from fastapi import Cookie, Header, HTTPException

from application.gateways import credentials

log = logging.getLogger("flow-controller")

#: The login session cookie: HttpOnly, so the page can never read it.
SESSION_COOKIE = "fc_session"


def session_ok(token: str | None) -> bool:
    """Whether the cookie carries a live login session. A broken store means no."""
    from application import gateways

    if not token or gateways.login is None:
        return False
    try:
        return gateways.login.session_valid(token)
    except Exception:
        log.exception("login store unreadable; treating the session as invalid")
        return False


def key_matches(x_api_key: str | None) -> bool:
    """Whether the presented key is the stored one (hash comparison, constant time).

    Both the dependency below and the rate-limit edge ask this: one answer
    about what "the right key" means, so the edge can never classify a
    request as authenticated while this dependency rejects it (or the
    reverse) over a second copy of the rules.
    """
    from application.gateways import get_settings

    if not x_api_key:
        return False
    security = get_settings().get("security", {})
    return credentials.verify_api_key(
        x_api_key, security.get("api_key_salt", ""), security.get("api_key_hash", "")
    )


def unauthorized() -> HTTPException:
    """The 401. An install with an API key keeps the text clients already match on."""
    from application.gateways import settings

    detail = "API key inválida" if settings.auth_required() else "No autenticado"
    return HTTPException(status_code=401, detail=detail)


async def verify_api_key(
    x_api_key: str | None = Header(default=None),
    fc_session: str | None = Cookie(default=None),
):
    """Let in a live login session or the (optional) script key; reject the rest.

    The name stays because ~140 routes depend on it. The key itself is not
    kept anywhere, so it is compared by hash in constant time.
    """
    from application.gateways import auth_required as _auth_required

    if not _auth_required():
        return ""

    if session_ok(fc_session):
        return ""
    if key_matches(x_api_key):
        return x_api_key
    raise unauthorized()
