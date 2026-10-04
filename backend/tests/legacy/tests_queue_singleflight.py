"""The file queue promised to run sequentially and did not.

`queue_add` unconditionally started a new `_consume_queue` task on every POST,
and nothing ever checked whether one was already running. Two adds therefore
picked two different pending operations (each flips its own to "running" under
the lock) and copied them *at the same time* — contradicting the docstring,
contradicting `task_manager.py`'s "sequential queue", and overwriting the GC
reference so the earlier tasks became unreferenced while still running.

The check and the flag flip must happen under the same lock the consumer uses
to decide it is done, or there is a lost-wakeup window in both directions.
"""

import asyncio
from unittest.mock import patch

import state
from interfaces.http.routes import files
from state import file_queue


class TestOnlyOneConsumerEverRuns:
    def _reset(self):
        file_queue.clear()
        state.consumer_active = False
        state.queue_consumer_task = None

    def test_three_ensure_calls_start_exactly_one_consumer(self):
        self._reset()
        started = []

        async def park():
            started.append(1)
            await asyncio.Event().wait()

        async def run():
            with patch.object(files, "_consume_queue", new=park):
                await files._ensure_consumer()
                await files._ensure_consumer()
                await files._ensure_consumer()
                # Let the scheduled task actually run: it appends on its first
                # step, not on creation.
                await asyncio.sleep(0)
                task = state.queue_consumer_task
            if task is not None:
                task.cancel()
                try:
                    await task
                except asyncio.CancelledError:
                    pass
            return len(started)

        try:
            count = asyncio.run(run())
        finally:
            self._reset()

        assert count == 1, f"{count} consumers started; the queue is no longer sequential"

    def test_the_consumer_clears_the_flag_when_it_drains(self):
        """Otherwise the next add would find the flag stuck and never start one."""
        self._reset()

        async def run():
            state.consumer_active = True
            file_queue.clear()
            await files._consume_queue()
            return state.consumer_active

        try:
            assert asyncio.run(run()) is False, "a drained consumer left the flag set"
        finally:
            self._reset()

    def test_a_crashed_consumer_does_not_wedge_the_queue(self):
        """A consumer that died must not block every later add.

        The flag alone would: it is left set, and there is no consumer to clear
        it. `_ensure_consumer` therefore also consults the task handle.
        """
        self._reset()

        async def boom():
            raise RuntimeError("boom")

        async def run():
            state.consumer_active = True  # what a crash leaves behind
            dead = asyncio.create_task(boom())
            await asyncio.gather(dead, return_exceptions=True)
            assert dead.done()

            state.queue_consumer_task = dead  # stale handle to a dead task
            started = []

            async def fresh():
                started.append(1)
                await asyncio.Event().wait()

            with patch.object(files, "_consume_queue", new=fresh):
                await files._ensure_consumer()
                await asyncio.sleep(0)
                task = state.queue_consumer_task
            if task is not None:
                task.cancel()
                try:
                    await task
                except asyncio.CancelledError:
                    pass
            return len(started)

        try:
            count = asyncio.run(run())
        finally:
            self._reset()

        assert count == 1, "a dead consumer left the queue wedged"
