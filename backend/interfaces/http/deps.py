"""Shared HTTP dependencies — what every protected route asks the framework first.

`verify_api_key` used to live in `routes/status.py`, and seven route modules
imported it from there: a route reaching into another route's module for its
auth meant the "status" module was secretly the app's dependency bag. This is
the bag. FastAPI's `Depends` does not care where the callable comes from — only
that it is the same callable — so every signature keeps working unchanged.
"""

from fastapi import Header, HTTPException

from application.gateways import credentials


async def verify_api_key(x_api_key: str | None = Header(default=None)):
    """Reject anything that does not match the stored hash of the app key.

    The key itself is not kept anywhere, so this compares hashes in constant
    time instead of the two strings.
    """
    from application.gateways import auth_required as _auth_required, get_settings

    if not _auth_required():
        return ""

    security = get_settings().get("security", {})
    if not x_api_key or not credentials.verify_api_key(
        x_api_key, security.get("api_key_salt", ""), security.get("api_key_hash", "")
    ):
        raise HTTPException(status_code=401, detail="API key inválida")
    return x_api_key
