"""The login: one user, hashed password, server-side sessions.

Own file (``auth.db``) instead of ``history.db``: credentials and sessions are
not history, and a wiped or rotated history must never log the owner out.

Passwords use ``hashlib.scrypt`` (stdlib; no new dependency). Session tokens
are random and only their SHA-256 is stored, so a leaked database file cannot
be replayed as a cookie.
"""

from __future__ import annotations

import base64
import hashlib
import hmac
import os
import secrets
import sqlite3
import threading
import time
from pathlib import Path

from application.ports import SESSION_TTL_SECONDS

#: scrypt cost; N=2**14 is the interactive-login default (~16 MiB, tens of ms).
_N, _R, _P = 2**14, 8, 1
MIN_PASSWORD_LENGTH = 8

_SCHEMA = """
CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY CHECK (id = 1),
    username TEXT NOT NULL,
    pw_hash TEXT NOT NULL,
    created_at REAL NOT NULL
);
CREATE TABLE IF NOT EXISTS sessions (
    token_hash TEXT PRIMARY KEY,
    created_at REAL NOT NULL,
    expires_at REAL NOT NULL
);
"""


def hash_password(password: str) -> str:
    salt = secrets.token_bytes(16)
    digest = hashlib.scrypt(password.encode(), salt=salt, n=_N, r=_R, p=_P, dklen=32)
    return "scrypt${}${}${}${}${}".format(
        _N, _R, _P, base64.b64encode(salt).decode(), base64.b64encode(digest).decode()
    )


def check_password(password: str, stored: str) -> bool:
    try:
        _, n, r, p, salt, digest = stored.split("$")
        got = hashlib.scrypt(
            password.encode(), salt=base64.b64decode(salt), n=int(n), r=int(r), p=int(p), dklen=32
        )
        return hmac.compare_digest(got, base64.b64decode(digest))
    except (ValueError, TypeError):
        return False


def _token_hash(token: str) -> str:
    return hashlib.sha256(token.encode()).hexdigest()


class AuthStore:
    def __init__(self, path: str | os.PathLike, clock=time.time):
        self._path = Path(path)
        self._clock = clock
        self._lock = threading.Lock()
        self._ready = False
        # Burns the same scrypt cost when the username is wrong, so the
        # response time does not tell which half of the login failed.
        self._decoy_hash: str | None = None

    @property
    def _decoy(self) -> str:
        if self._decoy_hash is None:
            self._decoy_hash = hash_password(secrets.token_urlsafe(16))
        return self._decoy_hash

    def _connect(self) -> sqlite3.Connection:
        # Lazy: the composition root builds the store at import, and a dev
        # machine without /app/config must still be able to import the app.
        if not self._ready:
            self._path.parent.mkdir(parents=True, exist_ok=True)
            with sqlite3.connect(self._path, timeout=5) as db:
                db.executescript(_SCHEMA)
            try:
                os.chmod(self._path, 0o600)
            except OSError:
                pass
            self._ready = True
        return sqlite3.connect(self._path, timeout=5)

    def _exists(self) -> bool:
        """No file yet means nobody ever registered; reading must not create it.

        An EXISTING file that cannot be read is a different story: it raises,
        and the gateway keeps the app closed.
        """
        return self._path.exists()

    def has_user(self) -> bool:
        if not self._exists():
            return False
        with self._connect() as db:
            return db.execute("SELECT 1 FROM users").fetchone() is not None

    def create_user(self, username: str, password: str) -> bool:
        """False when the single user already exists; ValueError on a weak input."""
        username = username.strip()
        if not username:
            raise ValueError("username required")
        if len(password) < MIN_PASSWORD_LENGTH:
            raise ValueError(f"password must have at least {MIN_PASSWORD_LENGTH} characters")
        with self._lock, self._connect() as db:
            try:
                db.execute(
                    "INSERT INTO users (id, username, pw_hash, created_at) VALUES (1, ?, ?, ?)",
                    (username, hash_password(password), self._clock()),
                )
            except sqlite3.IntegrityError:
                return False
        return True

    def verify_login(self, username: str, password: str) -> bool:
        row = None
        if self._exists():
            with self._connect() as db:
                row = db.execute("SELECT username, pw_hash FROM users").fetchone()
        stored = row[1] if row else self._decoy
        password_ok = check_password(password, stored)
        name_ok = bool(row) and hmac.compare_digest(row[0].encode(), username.strip().encode())
        return password_ok and name_ok

    def change_password(self, current: str, new: str) -> bool:
        """False when `current` is wrong; ValueError on a weak `new`.

        Every session is revoked: whoever held the old password (or a stolen
        cookie) must not stay signed in. The caller opens a fresh one.
        """
        if len(new) < MIN_PASSWORD_LENGTH:
            raise ValueError(f"password must have at least {MIN_PASSWORD_LENGTH} characters")
        if not self._exists():
            return False
        with self._lock, self._connect() as db:
            row = db.execute("SELECT pw_hash FROM users").fetchone()
            if not row or not check_password(current, row[0]):
                return False
            db.execute("UPDATE users SET pw_hash = ?", (hash_password(new),))
            db.execute("DELETE FROM sessions")
        return True

    def create_session(self) -> str:
        token = secrets.token_urlsafe(32)
        now = self._clock()
        with self._lock, self._connect() as db:
            db.execute("DELETE FROM sessions WHERE expires_at <= ?", (now,))
            db.execute(
                "INSERT INTO sessions (token_hash, created_at, expires_at) VALUES (?, ?, ?)",
                (_token_hash(token), now, now + SESSION_TTL_SECONDS),
            )
        return token

    def session_valid(self, token: str) -> bool:
        if not token or not self._exists():
            return False
        with self._connect() as db:
            row = db.execute(
                "SELECT expires_at FROM sessions WHERE token_hash = ?", (_token_hash(token),)
            ).fetchone()
        return row is not None and row[0] > self._clock()

    def delete_session(self, token: str) -> None:
        with self._lock, self._connect() as db:
            db.execute("DELETE FROM sessions WHERE token_hash = ?", (_token_hash(token),))
