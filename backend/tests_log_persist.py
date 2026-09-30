"""The log handler rewrote the whole file for every warning.

`_BufferHandler._persist` did `read_text()` of up to 500 lines, appended one
line, then `write_text()` of everything back — **per WARNING record**, on
whatever thread emitted it, which is the event loop for the ~37 `log.warning`
sites in `clients.py`, `history.py` and `routes/`.

An arr that is down produces a warning per failed probe every few seconds, so
the cost was O(file size) repeated at failure rate, in the worst possible place.

The fix is one append syscall. Trimming still has to happen, but amortised over
a size threshold instead of paid on every record.
"""

import logging

import pytest

import state


@pytest.fixture(autouse=True)
def _isolated_log_file(tmp_path, monkeypatch):
    """Point the handler at a scratch file and start the byte counter cold."""
    target = tmp_path / "logs.json"
    monkeypatch.setattr(state, "_LOG_FILE", target)
    monkeypatch.setattr(state, "_LOG_BYTES", 0, raising=False)

    # app.py mounts the handler on the "flow-controller" logger; this module
    # never imports app, so mount it here — but only if nobody else has, or
    # every record would be persisted twice.
    log = logging.getLogger("flow-controller")
    mounted_here = state.buf_handler not in log.handlers
    if mounted_here:
        log.addHandler(state.buf_handler)
    yield target
    if mounted_here:
        log.removeHandler(state.buf_handler)


def _warn(message: str = "probe failed") -> None:
    logging.getLogger("flow-controller").warning(message)


class TestPersistIsOneAppend:
    def test_a_record_is_appended_without_reading_the_file(self, _isolated_log_file):
        reads = []
        original_read = type(_isolated_log_file).read_text

        def spy(self, *args, **kwargs):
            reads.append(str(self))
            return original_read(self, *args, **kwargs)

        type(_isolated_log_file).read_text = spy
        try:
            # Two records, not one: on the first the file does not exist yet, so
            # today's read-modify-write skips the read and the test would pass
            # for the wrong reason.
            _warn("radarr: no respondio a tiempo")
            _warn("sonarr: no respondio a tiempo")
        finally:
            type(_isolated_log_file).read_text = original_read

        assert reads == [], "persist read the whole file to append one line"
        assert _isolated_log_file.exists()
        assert "sonarr: no respondio a tiempo" in _isolated_log_file.read_text()

    def test_the_file_is_not_rewritten_for_every_record(self, _isolated_log_file):
        writes = []
        original_write = type(_isolated_log_file).write_text

        def spy(self, *args, **kwargs):
            writes.append(str(self))
            return original_write(self, *args, **kwargs)

        type(_isolated_log_file).write_text = spy
        try:
            for i in range(3):
                _warn(f"warning {i}")
        finally:
            type(_isolated_log_file).write_text = original_write

        assert len(writes) == 0, (
            f"the file was rewritten {len(writes)} times for 3 records; "
            "one append each is the whole point"
        )
        assert _isolated_log_file.read_text().count("warning") == 3

    def test_the_record_still_reaches_the_visible_buffer(self, _isolated_log_file):
        state._LOG_BUFFER.clear()
        _warn("esto debe verse en /api/logs")

        assert any("esto debe verse" in e["message"] for e in state._LOG_BUFFER), (
            "the in-memory buffer is what /api/logs serves; persistence must not touch it"
        )


class TestTrimIsAmortised:
    def test_it_trims_once_the_file_grows_past_the_threshold(
        self, _isolated_log_file, monkeypatch
    ):
        monkeypatch.setattr(state, "_LOG_FILE_MAX_BYTES", 64)
        monkeypatch.setattr(state, "_LOG_BYTES", 60)  # already near the line

        _warn("one more record pushes it over")

        assert _isolated_log_file.exists()
        lines = [ln for ln in _isolated_log_file.read_text().splitlines() if ln]
        assert len(lines) <= state._LOG_FILE_MAX_LINES, (
            "the file must come back under the line cap after a trim"
        )
        assert state._LOG_BYTES == _isolated_log_file.stat().st_size, (
            "the counter must be reset by the trim, or every later write trims again "
            "and we are back to one rewrite per record"
        )
