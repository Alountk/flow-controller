"""The source path of a download, read from its own trace."""

import logging

from application.use_cases import trace_cache

log = logging.getLogger("flow-controller")


def _ids(record: dict) -> set[str]:
    ids = {str(record.get("download_id") or "").lower(), str(record.get("matched_hash") or "").lower()}
    return ids - {""}


async def source_from_trace(payload: dict) -> str:
    """The path a request without `output_path` should have carried.

    Empty when the download has no trace or its trace names no path.
    """
    wanted = _ids(payload)
    if not wanted:
        return ""
    try:
        traces = await trace_cache.get_traces()
    except Exception:  # noqa: BLE001 — a fallback must never break the action
        log.warning("source_from_trace: could not read the traces", exc_info=True)
        return ""
    for trace in traces:
        if wanted & _ids(trace):
            return (trace.get("torrent") or {}).get("content_path") or (trace.get("queue") or {}).get("output_path") or ""
    return ""
