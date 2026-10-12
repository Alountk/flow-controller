"""Fan-out bus for `/api/events` (sse-events T1).

One process, many EventSource readers: publishers (the task registry, the
trace sweep, the downloads poller) hand an event dict to `publish`, every
subscriber's queue gets its own copy, and the SSE route in
`interfaces/http/routes/events.py` reads its queue and writes the wire.

The whole contract lives in three words — **never await, never raise**:

* `publish` is synchronous and only ever calls `put_nowait`. It runs inside
  `TaskManager.update`, which is called from worker threads
  (`asyncio.to_thread`) as well as the event loop; a publisher that blocked
  on a slow browser tab would stall every copy, mux, grab, and search in the
  app. A queue at its bound drops ITS OWN oldest event (drop-oldest): the
  newest state is what an invalidation is for, and the polling fallback
  (`refetchInterval`, deliberately still on) repairs anything a dropped event
  would have refreshed.
* One broken subscriber — full queue, closed loop, foreign thread — must only
  ever cost *that* subscriber its copy. Failures are caught per queue, and a
  subscriber whose loop is gone is dropped from the registry rather than
  retried forever.

This module deliberately knows nothing about tasks, traces, or downloads:
it must stay importable from `task_manager` (legacy), the application use
cases, and the routes without a single cycle. The event dict's shape is the
publishers' business; only the SSE route reads it.
"""

from __future__ import annotations

import asyncio
import threading

#: Per-subscriber bound. A burst of ~256 events between two loop turns is a
#: pathological amount of invalidation traffic for a single-user app, and a
#: bounded queue is what makes drop-oldest possible at all: an unbounded one
#: would make a dead reader a memory leak instead of a dropped copy.
DEFAULT_MAXSIZE = 256


class EventBus:
    """Subscriber registry with non-blocking, drop-oldest delivery."""

    def __init__(self, maxsize: int = DEFAULT_MAXSIZE) -> None:
        self._maxsize = maxsize
        #: Queue -> the loop it belongs to, so a publish from a worker thread
        #: can wake the consumer on its own loop if the direct put cannot.
        self._queues: dict[asyncio.Queue, asyncio.AbstractEventLoop] = {}
        #: Subscribers arrive (SSE connections) from the loop and leaves can
        #: come from any thread — a plain lock over a dict of pointers.
        self._lock = threading.Lock()

    def subscribe(self) -> asyncio.Queue:
        """Register a bounded queue; the caller reads it and may unsubscribe."""
        queue: asyncio.Queue = asyncio.Queue(maxsize=self._maxsize)
        with self._lock:
            self._queues[queue] = asyncio.get_running_loop()
        return queue

    def unsubscribe(self, queue: asyncio.Queue) -> None:
        """Drop a queue (SSE disconnect / generator close). Idempotent."""
        with self._lock:
            self._queues.pop(queue, None)

    def subscriber_count(self) -> int:
        """How many queues are registered right now (B2: the refresher's gate).

        The SSE route subscribes before its first yield and unsubscribes in
        `finally`, so this count is exactly "how many readers are on the
        stream" — the condition `trace_refresher` builds traces against: no
        subscriber, no build anyone could observe.
        """
        with self._lock:
            return len(self._queues)

    def publish(self, event: dict) -> None:
        """Deliver `event` to every subscriber. Never awaits, never raises."""
        with self._lock:
            subscribers = list(self._queues.items())
        for queue, loop in subscribers:
            try:
                self._offer(queue, event)
            except Exception:
                # A direct put can fail for reasons a dict cannot model: a
                # consumer waiting on `get()` from a worker-thread publish,
                # a loop that closed under us. Wake the consumer on ITS loop
                # instead; if even that fails, this subscriber is gone.
                try:
                    loop.call_soon_threadsafe(self._offer, queue, event)
                except Exception:
                    self.unsubscribe(queue)

    @staticmethod
    def _offer(queue: asyncio.Queue, event: dict) -> None:
        """One queue's copy: bounded, drop-oldest, silent on overflow."""
        try:
            queue.put_nowait(event)
        except asyncio.QueueFull:
            try:
                queue.get_nowait()
            except asyncio.QueueEmpty:
                pass  # a racing reader emptied it first — the put below wins
            try:
                queue.put_nowait(event)
            except asyncio.QueueFull:
                pass  # another producer filled the gap: this copy is dropped


#: The process-wide bus every publisher and the SSE route share.
_bus = EventBus()


def subscribe() -> asyncio.Queue:
    """Join the bus. Must be called from a running event loop."""
    return _bus.subscribe()


def unsubscribe(queue: asyncio.Queue) -> None:
    """Leave the bus (the SSE route's generator calls this on close)."""
    _bus.unsubscribe(queue)


def publish(event: dict) -> None:
    """Fan an event out to every subscriber. Never awaits, never raises."""
    try:
        _bus.publish(event)
    except Exception:  # noqa: BLE001 — belt: no publisher may ever see this
        pass


def subscriber_count() -> int:
    """How many readers hold a queue (B2: `trace_refresher` builds for ≥1)."""
    return _bus.subscriber_count()
