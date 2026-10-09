"""Enrichment shared by more than one route — behaviour nobody may keep private.

`_attach_grabbed_at` lived in `routes/wanted.py` while `routes/calendar.py`
imported it: one route owning a `_private` name that another route depended on
made the "private" a lie and coupled two handlers that share no purpose except
this mark. The helper sits beside both, imports only the gateway it needs, and
exposes the behaviour under its public name.

The marks come from ``history``, re-read per request, and never from
``_fetch_all_wanted``'s cache: that cache holds the arr's data, and this mark
is ours.
"""

from __future__ import annotations

import asyncio
import time

from application.gateways import history

# How far back a grab is still worth showing as "Pedida el ...".
#
# The trade-off is what a too-long and a too-short window each get wrong. A mark
# persists only while the title is still missing, so it answers "I asked for
# this and it has not arrived". Too short and a genuinely stuck download loses
# its mark after a few days, which is exactly when the signal matters most. Too
# long and a mark from an old, superseded attempt claims the current missing
# state was requested when it was not. 90 days covers a slow season pack and a
# month of retries while staying a statement about the present missing state.
WANTED_GRAB_LOOKBACK = 90 * 24 * 60 * 60


def _mark_fields(
    rows: dict[tuple[str, str, int], dict],
    marks: dict[tuple[str, str, int], float],
    key: tuple[str, str, int],
) -> dict:
    """The two own-grab fields for one item, both read from the same newest row.

    The instant comes from the date-only `marks` and the destination from the
    matching `rows` entry; both are projections of the same
    `own_grabs_latest_rows` result, so a payload can never pair a date from one
    grab with a folder from another. An item with no mark gets `None` for both
    rather than an absent field, so the frontend never has to tell "absent" from
    "unknown".
    """
    row = rows.get(key)
    return {
        "grabbed_at": marks.get(key),
        "grabbed_destination": row["destination"] if row else None,
    }


async def attach_grabbed_at(response: dict, *, source: str = "", kind: str = "") -> dict:
    """Add ``grabbed_at`` and ``grabbed_destination`` to every item on a body.

    Shared by every surface that shows the mark — ``/api/wanted``,
    ``/api/wanted/all``, ``/api/wanted/series/all`` and ``/api/calendar`` — so
    there is one enrichment rather than one per route. It handles both body
    shapes this app returns:

      - the grouped ``{"wanted": {service: {"items": [...]}}}`` shape, whose kind
        follows the service (``radarr`` → movie, ``sonarr`` → episode);
      - a flat ``{"items": [...]}`` shape, where the caller names the ``source``
        and ``kind`` because the items do not carry them — except the calendar,
        whose items already carry both ``source`` and ``type``, so it passes
        neither and the key is read per item.

    Called on the assembled body rather than inside either branch of
    ``/api/wanted`` on purpose: that route has a text-filtered branch and a plain
    one, and enriching only one of them would silently leave half the items
    unmarked. Do not move it back into a branch.

    The marks come from ``own_grabs``, re-read per request, and never from
    ``_fetch_all_wanted``'s cache: that cache holds the arr's data, and this mark
    is ours. Each item is copied so a cached or caller-owned dict is never
    mutated. An item with no mark gets ``grabbed_at: None`` and
    ``grabbed_destination: None`` — the fields are always present, so the
    frontend never has to tell "absent" from "unknown". The date and the
    destination always describe the same grab row (see ``_mark_fields``).
    """
    # One read for both fields: `rows` carries the destination and `marks` is
    # its date-only projection, so the two can never disagree.
    since = time.time() - WANTED_GRAB_LOOKBACK
    # `history.py`'s own contract: callers hand the synchronous API to
    # `asyncio.to_thread`. This one has no index on `grabbed_at`, so it is an
    # unindexed full scan — and it runs on every response of four routes.
    # `own_grabs_latest_map` stays inline: with `rows` given it is a pure dict
    # projection and does no I/O at all.
    rows = await asyncio.to_thread(history.own_grabs_latest_rows, since)
    marks = history.own_grabs_latest_map(since, rows=rows)

    wanted = response.get("wanted")
    if wanted:
        for source_key, page in wanted.items():
            items = page.get("items")
            if not items:
                continue
            # Radarr wanted items are movies, Sonarr's are episodes; the own-grab
            # key records which kind, so the mapping is explicit rather than
            # guessed.
            item_kind = "movie" if source_key == "radarr" else "episode"
            page["items"] = [
                {
                    **item,
                    **_mark_fields(rows, marks, (source_key, item_kind, item.get("id"))),
                }
                for item in items
            ]
        return response

    items = response.get("items")
    if items:
        response["items"] = [
            {
                **item,
                # The item's own source and type win when present (the calendar
                # carries both); otherwise the caller's explicit source/kind.
                **_mark_fields(
                    rows,
                    marks,
                    (
                        item.get("source") or source,
                        item.get("type") or kind,
                        item.get("id"),
                    ),
                ),
            }
            for item in items
        ]
    return response
