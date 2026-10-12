"""T1 — the event bus behind `/api/events`.

The contract these tests pin is the one the whole feature rests on: a
publisher NEVER awaits and NEVER raises. A slow, full, or dead subscriber
loses *its* copy of an event and nobody else's — `TaskManager.update` calls
publish from worker threads (`asyncio.to_thread`) while holding nothing but
the task lock's word, and a copy that dies because a browser tab stalled
would be worse than no bus at all.
"""

from __future__ import annotations

import asyncio

import event_bus
from event_bus import EventBus


def test_publish_fans_out_to_every_subscriber():
    async def scenario():
        first = event_bus.subscribe()
        second = event_bus.subscribe()
        try:
            event_bus.publish({"kind": "task", "task_id": "t1"})
            return (
                await asyncio.wait_for(first.get(), 1),
                await asyncio.wait_for(second.get(), 1),
            )
        finally:
            event_bus.unsubscribe(first)
            event_bus.unsubscribe(second)

    first_event, second_event = asyncio.run(scenario())
    assert first_event == second_event == {"kind": "task", "task_id": "t1"}


def test_a_full_subscriber_drops_its_oldest_and_the_publisher_keeps_going():
    """Bounded queue, drop-oldest: the newest event is the one worth keeping.

    The publisher is synchronous — if `publish` blocked on a full queue this
    test would hang rather than fail, which is exactly the regression it
    exists to catch (a stuck browser tab must not stall `TaskManager.update`).
    """

    async def scenario():
        bus = EventBus(maxsize=2)
        queue = bus.subscribe()
        for n in range(5):
            bus.publish({"n": n})
        return queue.get_nowait(), queue.get_nowait()

    oldest, newest = asyncio.run(scenario())
    assert (oldest, newest) == ({"n": 3}, {"n": 4}), (
        "a bounded queue must hold the newest events, not the oldest"
    )


def test_one_full_subscriber_never_stalls_another():
    async def scenario():
        bus = EventBus(maxsize=2)
        slow = bus.subscribe()  # never read while the overflow happens
        fast = bus.subscribe()

        bus.publish({"n": 1})
        first = fast.get_nowait()  # fast drains; slow stays full
        bus.publish({"n": 2})
        bus.publish({"n": 3})

        slow_events = [slow.get_nowait(), slow.get_nowait()]
        fast_events = [fast.get_nowait(), fast.get_nowait()]
        return first, slow_events, fast_events

    first, slow_events, fast_events = asyncio.run(scenario())
    assert first == {"n": 1}
    assert slow_events == [{"n": 2}, {"n": 3}], "the slow copy drops its own oldest"
    assert fast_events == [{"n": 2}, {"n": 3}], "the fast copy still receives everything"


def test_unsubscribed_queues_receive_nothing_more():
    async def scenario():
        queue = event_bus.subscribe()
        event_bus.unsubscribe(queue)
        event_bus.publish({"kind": "task"})
        await asyncio.sleep(0)
        try:
            queue.get_nowait()
        except asyncio.QueueEmpty:
            return True
        return False

    assert asyncio.run(scenario()) is True


def test_a_subscriber_whose_loop_is_gone_cannot_break_publish():
    """`publish` runs wherever the app settles a task — including long after
    a request's event loop closed. A dead subscriber drops; the call returns.
    """

    async def scenario():
        return event_bus.subscribe()

    queue = asyncio.run(scenario())  # its loop is closed by now
    try:
        event_bus.publish({"kind": "task"})  # must not raise
    finally:
        event_bus.unsubscribe(queue)
