"""The `indexers` store — the direct Torznab registry («indexadores-directos» T3/S2).

What these pin down:

* the PUBLIC view (list/create/update results) never carries a raw api_key —
  it is masked like `routes/settings.py:122-128` (`"****" + last4`), always,
  whether the value is encrypted at rest or not;
* the INTERNAL accessor (`indexers_raw`) DOES hand out the plaintext key —
  that is the call path T4 will use — but only for enabled rows by default,
  and never from anything a response is built from;
* the key is encrypted at rest when `FC_SECRET` is set (the `credentials.py`
  precedent) and unreadable ciphertext is reported as unreadable, never
  passed off as a key;
* an update that does not carry `api_key` never touches the stored key;
* every function degrades gracefully when the store is down (`_conn is None`);
* `init_db` creates the `indexers` table (plain `CREATE TABLE IF NOT EXISTS`
  inside `SCHEMA` — no ALTER for new tables).

No real keys anywhere: the fakes below are obviously fake and the tests
assert they never leak, not that they round-trip as themselves.
"""

import sqlite3

import pytest

from infrastructure import sqlite_history as history

FAKE_KEY = "FAKE-KEY-do-not-use-9876"
MASKED = "****9876"


@pytest.fixture
def db(tmp_path):
    """A fresh database per test, isolated from the real config volume."""
    history.close()
    history.init_db(tmp_path / "history.db")
    yield tmp_path / "history.db"
    history.close()


# ── create / list ────────────────────────────────────────────────────────────


def test_create_and_list_round_trip(db):
    row = history.indexer_create("NoNaMe", "http://indexer.test/torznab/api", FAKE_KEY)

    assert row["name"] == "NoNaMe"
    assert row["url"] == "http://indexer.test/torznab/api"
    assert row["enabled"] == 1
    assert row["id"] > 0

    rows = history.indexers_list()
    assert [r["id"] for r in rows] == [row["id"]]


def test_public_rows_never_carry_the_raw_key(db):
    row = history.indexer_create("NoNaMe", "http://indexer.test/torznab/api", FAKE_KEY)

    assert row["api_key"] == MASKED
    assert FAKE_KEY not in str(row)
    listed = history.indexers_list()
    assert listed[0]["api_key"] == MASKED
    assert FAKE_KEY not in str(listed)


def test_an_empty_key_stays_empty_in_the_public_view(db):
    row = history.indexer_create("Abierto", "http://open.test/api", "")

    assert row["api_key"] == ""


def test_mask_matches_the_settings_precedent_for_short_keys(db):
    row = history.indexer_create("Corta", "http://short.test/api", "abc")

    assert row["api_key"] == "****"


# ── update ───────────────────────────────────────────────────────────────────


def test_update_without_the_key_keeps_the_stored_one(db):
    history.indexer_create("Viejo", "http://a.test/api", FAKE_KEY)
    row_id = history.indexers_list()[0]["id"]

    updated = history.indexer_update(row_id, name="Nuevo")

    assert updated["name"] == "Nuevo"
    assert updated["api_key"] == MASKED
    assert history.indexers_raw(indexer_id=row_id)[0]["api_key"] == FAKE_KEY


def test_update_with_a_new_key_replaces_it(db):
    history.indexer_create("Rotada", "http://a.test/api", FAKE_KEY)
    row_id = history.indexers_list()[0]["id"]

    updated = history.indexer_update(row_id, api_key="NEW-FAKE-KEY-1234")

    assert updated["api_key"] == "****1234"
    assert history.indexers_raw(indexer_id=row_id)[0]["api_key"] == "NEW-FAKE-KEY-1234"
    assert FAKE_KEY not in str(updated)


def test_update_of_a_missing_row_is_none(db):
    assert history.indexer_update(999, name="Nadie") is None


# ── delete / enable toggle ───────────────────────────────────────────────────


def test_delete_removes_the_row(db):
    history.indexer_create("Borrable", "http://a.test/api", FAKE_KEY)
    row_id = history.indexers_list()[0]["id"]

    assert history.indexer_delete(row_id) is True
    assert history.indexers_list() == []
    assert history.indexer_delete(row_id) is False


def test_disabling_a_row_drops_it_from_the_call_list_but_not_from_the_registry(db):
    history.indexer_create("Pausable", "http://a.test/api", FAKE_KEY)
    row_id = history.indexers_list()[0]["id"]

    history.indexer_update(row_id, enabled=0)

    assert history.indexers_raw() == [], "a disabled indexer must never be queried"
    assert [r["id"] for r in history.indexers_list()] == [row_id]
    # The «Probar» button must work before (re-)enabling: the per-row accessor
    # is the one deliberate opt-out from the enabled-only rule.
    assert history.indexers_raw(indexer_id=row_id)[0]["name"] == "Pausable"

    history.indexer_update(row_id, enabled=1)
    assert [r["id"] for r in history.indexers_raw()] == [row_id]


# ── the internal raw-key accessor ────────────────────────────────────────────


def test_the_internal_accessor_hands_the_plaintext_key_for_calls(db):
    """The one place a raw key is allowed to appear: the T4 call path.

    This asserts against the INTERNAL accessor on purpose — no HTTP response
    is built from it, and the route tests assert the opposite for responses.
    """
    history.indexer_create("Callable", "http://a.test/api", FAKE_KEY)

    rows = history.indexers_raw()

    assert rows[0]["api_key"] == FAKE_KEY
    assert rows[0]["url"] == "http://a.test/api"


# ── encryption at rest (the credentials.py precedent) ────────────────────────


def _stored_value(path) -> str:
    conn = sqlite3.connect(path)
    try:
        return conn.execute("SELECT api_key FROM indexers").fetchone()[0]
    finally:
        conn.close()


def test_the_key_is_encrypted_at_rest_when_a_secret_is_set(db, monkeypatch):
    monkeypatch.setenv("FC_SECRET", "unit-test-secret")

    history.indexer_create("Cifrada", "http://a.test/api", FAKE_KEY)

    stored = _stored_value(db)
    assert stored.startswith("enc:"), "FC_SECRET set means the key must not sit in the clear"
    assert FAKE_KEY not in stored
    # ...and the call path still gets the plaintext back.
    assert history.indexers_raw()[0]["api_key"] == FAKE_KEY
    assert history.indexers_list()[0]["api_key"] == MASKED


def test_a_key_stored_plain_stays_readable_after_a_secret_appears(db, monkeypatch):
    """Legacy rows (no FC_SECRET at write time) must not become unreadable."""
    history.indexer_create("Legada", "http://a.test/api", FAKE_KEY)

    monkeypatch.setenv("FC_SECRET", "unit-test-secret")

    assert history.indexers_raw()[0]["api_key"] == FAKE_KEY


def test_unreadable_ciphertext_is_never_passed_off_as_a_key(db, monkeypatch):
    """A rotated FC_SECRET must read as 'unreadable', never as a wrong key."""
    monkeypatch.setenv("FC_SECRET", "first-secret")
    history.indexer_create("Rota", "http://a.test/api", FAKE_KEY)

    monkeypatch.setenv("FC_SECRET", "second-secret")

    rows = history.indexers_raw()
    assert rows[0]["api_key"] is None, "None = unreadable, distinct from '' (no key)"
    assert history.indexers_list()[0]["api_key"] == "****"
    assert FAKE_KEY not in str(history.indexers_list())


# ── degradation ──────────────────────────────────────────────────────────────


def test_everything_degrades_when_the_store_is_down():
    history.close()

    assert history.indexers_list() == []
    assert history.indexer_create("X", "http://x.test/api", FAKE_KEY) is None
    assert history.indexer_update(1, name="X") is None
    assert history.indexer_delete(1) is False
    assert history.indexers_raw() == []
    assert history.indexers_raw(indexer_id=1) == []


# ── schema ───────────────────────────────────────────────────────────────────


def test_init_db_creates_the_indexers_table(db):
    conn = sqlite3.connect(db)
    try:
        tables = {
            row[0]
            for row in conn.execute("SELECT name FROM sqlite_master WHERE type='table'")
        }
        columns = {
            row[1] for row in conn.execute("PRAGMA table_info(indexers)")
        }
    finally:
        conn.close()

    assert "indexers" in tables
    assert {"id", "name", "url", "api_key", "categories", "enabled",
            "created_at", "updated_at"} <= columns


def test_reopening_an_existing_database_keeps_the_rows(db):
    history.indexer_create("Sobreviviente", "http://a.test/api", FAKE_KEY)

    history.close()
    history.init_db(db)

    assert [r["name"] for r in history.indexers_list()] == ["Sobreviviente"]
