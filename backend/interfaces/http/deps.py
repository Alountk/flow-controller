"""Shared HTTP dependencies — what every protected route asks the framework first.

`verify_api_key` used to live in `routes/status.py`, and seven route modules
imported it from there: a route reaching into another route's module for its
auth meant the "status" module was secretly the app's dependency bag. This is
the bag. FastAPI's `Depends` does not care where the callable comes from — only
that it is the same callable — so every signature keeps working unchanged.
"""

from fastapi import Header, HTTPException

from application.gateways import credentials


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


async def verify_api_key(x_api_key: str | None = Header(default=None)):
    """Reject anything that does not match the stored hash of the app key.

    The key itself is not kept anywhere, so this compares hashes in constant
    time instead of the two strings.
    """
    from application.gateways import auth_required as _auth_required

    if not _auth_required():
        return ""

    if not key_matches(x_api_key):
        raise HTTPException(status_code=401, detail="API key inválida")
    return x_api_key
