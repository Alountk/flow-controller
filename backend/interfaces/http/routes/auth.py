"""Login, logout and "who am I" — the door the session cookie opens.

Deliberately OUTSIDE ``verify_api_key``: these routes are how a browser gets
the credential in the first place. A wrong password is a 401 so the edge's
failure budget (10 per minute per address) throttles guessing; ``me`` answers
200 either way, so the page's own boot probe never spends that budget.
"""

from __future__ import annotations

import logging
import sqlite3

from fastapi import APIRouter, Cookie, Header, HTTPException, Request, Response
from pydantic import BaseModel

from application import gateways
from application.ports import SESSION_TTL_SECONDS
from interfaces.http.deps import SESSION_COOKIE, key_matches, session_ok

router = APIRouter()
log = logging.getLogger("flow-controller")


class Credentials(BaseModel):
    username: str = ""
    password: str = ""


def _store():
    if gateways.login is None:
        raise HTTPException(status_code=503, detail="Login no disponible")
    return gateways.login


def open_session(request: Request, response: Response) -> None:
    secure = (
        request.url.scheme == "https"
        or request.headers.get("x-forwarded-proto", "").split(",")[0].strip() == "https"
    )
    response.set_cookie(
        SESSION_COOKIE,
        _store().create_session(),
        max_age=SESSION_TTL_SECONDS,
        httponly=True,
        samesite="strict",
        secure=secure,
        path="/",
    )


def create_first_user(username: str, password: str) -> None:
    """Create THE user or say why not: 400 for weak input, 409 if one exists.

    Shared by `register` and the first-run setup, so both enforce one rule.
    """
    store = _store()
    if store.has_user():
        raise HTTPException(status_code=409, detail="Ya existe un usuario")
    try:
        created = store.create_user(username, password)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc))
    except (sqlite3.Error, OSError):
        # A read-only config volume cannot hold the account. Saying so beats an
        # anonymous 500, and it must not be papered over with an in-memory user:
        # after a restart the install would look unclaimed and open.
        log.exception("could not persist the login account")
        raise HTTPException(
            status_code=503,
            detail="No se pudo guardar la cuenta: el directorio de configuración no es escribible",
        )
    if not created:
        raise HTTPException(status_code=409, detail="Ya existe un usuario")


@router.post("/api/auth/login")
async def login(creds: Credentials, request: Request, response: Response):
    try:
        ok = _store().verify_login(creds.username, creds.password)
    except sqlite3.Error:
        raise HTTPException(status_code=503, detail="Login no disponible")
    if not ok:
        raise HTTPException(status_code=401, detail="Usuario o contraseña incorrectos")
    open_session(request, response)
    return {"ok": True}


@router.post("/api/auth/logout")
async def logout(response: Response, fc_session: str | None = Cookie(default=None)):
    if fc_session and gateways.login is not None:
        gateways.login.delete_session(fc_session)
    response.delete_cookie(SESSION_COOKIE, path="/")
    return {"ok": True}


@router.get("/api/auth/me")
async def me(
    x_api_key: str | None = Header(default=None),
    fc_session: str | None = Cookie(default=None),
):
    required = gateways.auth_required()
    return {
        "authenticated": (not required) or session_ok(fc_session) or key_matches(x_api_key),
        "auth_required": required,
        "has_user": gateways.has_login_user(),
    }


@router.post("/api/auth/register")
async def register(
    creds: Credentials,
    request: Request,
    response: Response,
    x_api_key: str | None = Header(default=None),
):
    """Create THE user. Only once, and only for whoever already owns the install.

    With a key configured, presenting it proves ownership (an existing install
    migrating to login). With neither key nor user it is the first run, which
    is as open as the setup wizard it belongs to.
    """
    if _store().has_user():
        raise HTTPException(status_code=409, detail="Ya existe un usuario")
    if gateways.settings.auth_required() and not key_matches(x_api_key):
        raise HTTPException(status_code=401, detail="API key inválida")
    create_first_user(creds.username, creds.password)
    open_session(request, response)
    return {"ok": True}
