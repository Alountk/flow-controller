"""The HTTP edge: one id per request, a budget per client, failures in the log.

C-05. Mounted once, in ``app.py``, so it wraps EVERYTHING the app answers —
routes, static mounts, the SPA fallback — instead of each route remembering
to care. It is one middleware holding both jobs on purpose: the id has to
exist before the budget can log with it, and two middlewares would turn that
ordering into an invisible convention.

**Request id.** An inbound ``X-Request-Id`` is echoed only when it is a
plausible token (``[A-Za-z0-9._-]{1,64}``); anything longer or of another
charset is replaced, because the value travels straight back out as a header
and an unbounded echo is header injection. Otherwise a uuid4 hex. Every
answer carries it, and every failure (status ≥ 400) logs it through the
app's own ``flow-controller`` logger — the same logger the log buffer and
``/api/logs`` read — so a line in the log is answerable to the request that
caused it. An unhandled crash is logged with its id too, then re-raised
unchanged: the framework's plain-text 500 is generated above this layer and
does not carry the header (stated, not hidden).

**Budgets** (fixed windows — algorithm and rationale in ``rate_limit.py``):

- *general*: ``GENERAL_LIMIT`` requests per window per client key. The key
  is a truncated hash of the API key WHEN AUTHENTICATED (auth enabled and
  the presented key verifies), else the client address — one key per
  deployment means key-only bucketing would put every honest client in one
  pot, and address-only bucketing would too, behind a reverse proxy. An
  unverified key never separates a bucket, so guessing cannot mint fresh
  budgets.
- *auth failures*: ``AUTH_FAILURE_LIMIT`` rejections (401s) per window per
  address, checked BEFORE the request is served. This is the path the
  backlog row exists for: a leaked key without a limit is a hole, and a
  guessed key is worse. Counting actual 401s classifies exactly — the edge
  cannot otherwise tell a protected route from a static asset.

A refusal is ``429`` with ``Retry-After`` and ``{"detail", "retry_after"}``
— the app's error shape plus the machine number.

**Not covered** (stated, not hidden): there are no inbound WebSockets in
this app to police, and the one streaming route (mediacover) gets its
header before the first byte and counts as ONE request — per-byte limiting
is out of scope. Behind a reverse proxy the "client address" is the proxy's
unless the deployment passes the real peer: budgets are per-deployment
there, which a single-user app can accept.
"""

from __future__ import annotations

import hashlib
import logging
import re
import uuid

from fastapi.responses import JSONResponse
from starlette.middleware.base import BaseHTTPMiddleware
from starlette.requests import Request

from application.gateways import auth_required
from interfaces.http.deps import key_matches
from interfaces.http.rate_limit import FixedWindow

log = logging.getLogger("flow-controller")

#: What an inbound id must be to travel back out untouched.
REQUEST_ID = re.compile(r"\A[A-Za-z0-9._-]{1,64}\Z")

#: Requests per window per client key — the whole app, frontend polling included.
GENERAL_LIMIT = 300
#: Rejected key attempts per window per address: the brute-force budget.
AUTH_FAILURE_LIMIT = 10
#: One window length for both budgets, in seconds.
WINDOW_SECONDS = 60

general = FixedWindow(GENERAL_LIMIT, WINDOW_SECONDS)
auth_failures = FixedWindow(AUTH_FAILURE_LIMIT, WINDOW_SECONDS)


def _request_id(inbound: str | None) -> str:
    """Echo the inbound id when it is safe to, else mint a uuid4 hex."""
    if inbound and REQUEST_ID.match(inbound):
        return inbound
    return uuid.uuid4().hex


def _client_key(request: Request, address: str) -> str:
    """Budget key: the API key's fingerprint when authenticated, the address otherwise.

    The fingerprint is a truncated SHA-256 of the presented key — the key
    itself never enters the store. Only a key that VERIFIES separates the
    bucket, so an attacker rotating guesses all land in the same address
    budget instead of minting one per guess.
    """
    presented = request.headers.get("x-api-key")
    if presented and auth_required() and key_matches(presented):
        digest = hashlib.sha256(presented.encode("utf-8")).hexdigest()[:16]
        return f"{address}|{digest}"
    return address


def _refused(retry_after: int, request_id: str, detail: str) -> JSONResponse:
    """The 429 shape: the app's ``detail`` body plus the machine number."""
    return JSONResponse(
        status_code=429,
        content={"detail": detail, "retry_after": retry_after},
        headers={"Retry-After": str(retry_after), "X-Request-Id": request_id},
    )


class RequestGuards(BaseHTTPMiddleware):
    """Stamp, budget, and account for every request the app answers."""

    async def dispatch(self, request: Request, call_next):
        request_id = _request_id(request.headers.get("x-request-id"))
        try:
            address = request.client.host if request.client else "unknown"

            wait = auth_failures.peek(address)
            if wait is not None:
                response = _refused(wait, request_id, "Demasiados intentos de API key")
            else:
                allowed, wait = general.hit(_client_key(request, address))
                if not allowed:
                    response = _refused(wait, request_id, "Límite de peticiones superado")
                else:
                    response = await call_next(request)
                    if response.status_code == 401:
                        # A rejection is an attempt against the key. The
                        # dependency produced the verdict; the edge only
                        # counts it — one classifier, not two.
                        auth_failures.hit(address)
        except Exception:
            log.exception(
                "%s %s request_id=%s", request.method, request.url.path, request_id
            )
            raise

        if response.status_code >= 400:
            (log.error if response.status_code >= 500 else log.warning)(
                "%s %s -> %s request_id=%s",
                request.method,
                request.url.path,
                response.status_code,
                request_id,
            )
        response.headers["X-Request-Id"] = request_id
        return response
