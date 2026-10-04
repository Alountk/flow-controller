"""One shared HTTP session for the process, private ones where there is no process.

The backend used to build `aiohttp.ClientSession()` at every one of its 30 call
sites. Each construction opens a fresh connection, so nothing was ever reused:
no keep-alive, and no ceiling on how many sockets a burst could open.

`state.http_session()` is the seam. Under a lifespan — i.e. in production, which
runs exactly one event loop — it yields THE session, so every outbound call
pools onto it. Outside a lifespan it yields a private session that closes on
exit, which is what the test suite has always done and what every existing
`session_cls.call_count` assertion still depends on.
"""

import asyncio

import aiohttp

from state import close_shared_session, http_session, open_shared_session


class TestNoLifespanMeansAPrivateSession:
    """Tests never enter the lifespan, so nothing may be shared across them."""

    def test_a_private_session_is_created_and_closed_per_scope(self):
        async def run():
            async with http_session() as session:
                return session

        session = asyncio.run(run())
        assert isinstance(session, aiohttp.ClientSession)
        assert session.closed, "without a lifespan the scope must not leak a session"

    def test_two_scopes_do_not_share(self):
        async def run():
            async with http_session() as a:
                pass
            async with http_session() as b:
                pass
            return a, b

        a, b = asyncio.run(run())
        assert a is not b, "two independent scopes must not be handed one session"


class TestTheLifespanSharesOneSession:
    def test_every_scope_gets_the_same_session_and_it_pools(self):
        # Inspect INSIDE the scope: closing in a `finally` before returning
        # would null the connector and make the assertions meaningless.
        async def run():
            open_shared_session()
            try:
                async with http_session() as first, http_session() as second:
                    return first is second, first._connector
            finally:
                await close_shared_session()

        same, connector = asyncio.run(run())
        assert same, "the whole point: one session for every outbound call"
        assert isinstance(connector, aiohttp.TCPConnector), (
            "a shared session without a connector has no pool and no ceiling"
        )
        assert connector.limit and connector.limit_per_host, "the ceiling must be explicit"

    def test_the_shared_session_is_closed_when_the_lifespan_ends(self):
        async def run():
            open_shared_session()
            async with http_session() as session:
                pass
            await close_shared_session()
            return session

        session = asyncio.run(run())
        assert session.closed, "an unclosed shared session outlives the app"

    def test_a_closed_shared_session_is_not_handed_out(self):
        async def run():
            open_shared_session()
            async with http_session() as shared:
                pass
            await close_shared_session()
            # Somebody asks after shutdown: they must not get the dead object.
            async with http_session() as after:
                return shared, after

        shared, after = asyncio.run(run())
        assert shared.closed
        assert after is not shared, "a dead shared session must never be handed out"
