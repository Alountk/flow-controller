"""Where the arr keeps a grab's title: the folder a library download ends up in."""


def library_path(grab: dict, library_paths: dict[str, dict[int, str]] | None) -> str | None:
    source = grab.get("source") or ""
    item_id = grab.get("series_id") if source == "sonarr" else grab.get("movie_id")
    if not library_paths or item_id is None:
        return None
    return library_paths.get(source, {}).get(item_id) or None
