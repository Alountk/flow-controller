"""Rename a library copy Radarr cannot see, and say how sure we are.

Radarr renames what it owns and nothing else: a copy sitting in the 4K or 3D
root has no `movieFile` row, so `RenameMovie` never offers it a name. What
Radarr does expose is its pattern and, for the movie it tracks, the folder and
file name it already chose.

So the proposal is built from those two, and the pattern only gets to name a
file when it reproduces the name Radarr already wrote — the same gate
`copy_engine` uses before it writes a copy.

The rest of this module is the irreversible half: refuse collisions, stay
inside the root, honour the seed guard, and report every file it moved so the
rename can be undone by hand.
"""

from __future__ import annotations

import os
from pathlib import Path
from typing import Callable, Iterable, Iterator

from domain import naming
from domain import rename_plan
from domain.release_tokens import quality_from_title

#: Why `path` may not be renamed — injected so the route owns config and the
#: guard's torrent root, exactly like `/api/files/rename` already does.
Blocked = Callable[[str, str], "str | None"]


def refusal(detail: str) -> dict:
    return {"ok": False, "detail": detail}


def _real(path: str) -> str:
    return os.path.realpath(path)


def in_root(path: str, roots: Iterable[str]) -> str:
    """The root `path` belongs to, or "" — compared on real paths."""
    real = _real(path)
    for root in roots:
        if not root:
            continue
        real_root = _real(root)
        if real == real_root or real.startswith(real_root + "/"):
            return root
    return ""


def match_movie(stem: str, movies: list[dict]) -> tuple[dict | None, str]:
    """The one movie whose title and year open `stem`, or None and why not.

    Exact after cleaning (`naming.clean_title`), never substring: `Aliens` must
    not be claimed by `Alien`. A tie is refused rather than guessed — two
    movies that both fit would mean renaming one film after another.
    """
    wanted = naming.clean_title(stem)
    if not wanted:
        return None, "el nombre del archivo no deja nada con lo que identificar la película"

    hits: list[dict] = []
    for movie in movies:
        title = (movie.get("title") or "").strip()
        if not title:
            continue
        year = movie.get("year")
        key = naming.clean_title(f"{title} {year}" if year else title)
        if key and wanted.startswith(key):
            hits.append(movie)

    if len(hits) == 1:
        return hits[0], ""
    if not hits:
        return None, "no coincide ninguna película del catálogo con el nombre del archivo"
    titles = ", ".join(sorted(str(m.get("title") or "") for m in hits))
    return None, f"varias películas encajan: {titles}"


def _folder_of(movie: dict) -> str:
    """Radarr's own folder for the movie — the answer it already acted on."""
    path = (movie.get("path") or "").strip()
    return os.path.basename(path) if path else ""


def proposal(
    *,
    video_path: str,
    movies: list[dict],
    naming_cfg: dict,
    siblings: Iterable[str],
    roots: Iterable[str],
) -> dict:
    """What the dialog should prefill: folder, name, sidecars and warnings.

    Everything is a suggestion the user can edit, so a doubt is a warning, not
    a failure. Only an unreadable file is a failure — there is nothing to
    propose for it.
    """
    if not os.path.isfile(video_path):
        return refusal(f"No se pudo leer el archivo: {video_path}")

    roots = list(roots)
    name = os.path.basename(video_path)
    extension = Path(name).suffix
    stem = rename_plan.base_name(name)
    loose = _real(os.path.dirname(video_path)) in {_real(r) for r in roots if r}

    pattern = (naming_cfg or {}).get("standard_movie_format", "") or ""
    folder_pattern = (naming_cfg or {}).get("movie_folder_format", "") or ""
    quality = quality_from_title(name) or ""

    warnings: list[str] = []
    movie, reason = match_movie(stem, movies)
    proposed_stem = stem
    folder = ""

    if movie is None:
        warnings.append(reason)
    else:
        if not quality:
            quality = (movie.get("quality") or "").strip()
            if quality:
                warnings.append("el nombre del archivo no declara calidad; se usó la de Radarr")

        reference = naming.build_values(
            title=movie.get("title", ""), year=movie.get("year"), quality=movie.get("quality", "")
        )
        trusted = bool(pattern) and naming.reproduced_radarr(
            pattern, reference, movie.get("file_name", "")
        )
        if not pattern:
            warnings.append("Radarr no expone un patrón de nombrado; se propone el nombre actual")
        elif not trusted:
            warnings.append(
                "la plantilla de Radarr no se pudo reproducir con el archivo de esa película; "
                "se propone el nombre actual"
            )
        else:
            rendered = naming.evaluate(
                pattern,
                naming.build_values(
                    title=movie.get("title", ""), year=movie.get("year"), quality=quality
                ),
            )
            if rendered:
                proposed_stem = Path(rendered).name
            else:
                warnings.append("la plantilla no se pudo evaluar con la calidad de esta copia")

        if loose:
            folder = _folder_of(movie)
            if not folder and folder_pattern:
                folder = naming.evaluate(
                    folder_pattern,
                    naming.build_values(
                        title=movie.get("title", ""), year=movie.get("year"), quality=quality
                    ),
                ) or ""
            if not folder:
                warnings.append("no se pudo deducir el nombre de la carpeta: escríbelo")

    sidecars = [
        {"from": s, "to": rename_plan.sidecar_target(name, s, proposed_stem)}
        for s in rename_plan.sidecars(name, siblings)
    ]

    return {
        "ok": True,
        "src": video_path,
        "loose": loose,
        "folder": folder,
        "name": proposed_stem,
        "extension": extension,
        "sidecars": sidecars,
        "warnings": warnings,
        "movie": (
            {"id": movie.get("id"), "title": movie.get("title"), "year": movie.get("year")}
            if movie
            else None
        ),
        "detail": "",
    }


def _targets(
    src: Path, folder: str, stem: str, siblings: Iterable[str]
) -> tuple[Path, list[tuple[str, Path]]]:
    """Where the video and each sidecar go, without deciding whether they may."""
    parent = src.parent / folder if folder else src.parent
    plan = [(src.name, parent / f"{stem}{src.suffix}")]
    for sibling in rename_plan.sidecars(src.name, siblings):
        plan.append((sibling, parent / rename_plan.sidecar_target(src.name, sibling, stem)))
    return parent, plan


def apply_rename(
    *,
    video_path: str,
    folder: str,
    stem: str,
    siblings: Iterable[str],
    roots: Iterable[str],
    blocked: Blocked,
) -> dict:
    """Rename the video and its sidecars into `folder`, or move nothing.

    Collisions are checked for the whole set before the first `os.rename`, and
    every rename is reported: `os.rename` replaces the target silently, so an
    unguarded name is not a rename, it is a deletion.
    """
    src = Path(video_path)
    if not src.is_file():
        return refusal(f"No es un archivo: {video_path}")

    real_src = _real(str(src))
    if not in_root(real_src, roots):
        return refusal(f"El archivo no está dentro de una raíz 4K/3D: {video_path}")

    clean_folder = ""
    if folder.strip():
        clean_folder = rename_plan.folder_name(folder) or ""
        if not clean_folder:
            return refusal(f"Nombre de carpeta no válido: {folder}")

    clean_stem = rename_plan.file_stem(stem)
    if not clean_stem:
        return refusal(f"Nombre de archivo no válido: {stem}")

    guard = blocked(real_src, "renombrar")
    if guard:
        return refusal(guard)

    parent, plan = _targets(src, clean_folder, clean_stem, siblings)
    if not in_root(str(parent), roots):
        return refusal(f"El destino se sale de la raíz: {parent}")
    if os.path.lexists(parent) and not os.path.isdir(parent):
        return refusal(f"Ya existe un archivo con el nombre de la carpeta: {parent.name}")

    # Two targets that differ only by case are one file on a case-insensitive
    # volume (APFS, CIFS), and `os.rename` would replace the first with the
    # second. The comparison is the only place that can be caught.
    folded = [str(target).casefold() for _, target in plan]
    if len(set(folded)) != len(folded):
        return refusal("Dos archivos acabarían con el mismo nombre: no se renombra nada")

    for _, target in plan:
        if os.path.lexists(target):
            return refusal(f"Ya existe {target.name}: no se sobreescribe")

    moved: list[dict] = []
    failed: list[dict] = []
    try:
        parent.mkdir(parents=True, exist_ok=True)
    except OSError as exc:
        return refusal(f"{type(exc).__name__}: {exc}")

    for name, target in plan:
        source = src.parent / name
        if name != src.name and not source.exists():
            continue
        try:
            os.rename(source, target)
            moved.append({"from": str(source), "to": str(target)})
        except OSError as exc:
            failed.append({"name": name, "detail": f"{type(exc).__name__}: {exc}"})

    if not moved:
        return refusal(failed[0]["detail"] if failed else "No se renombró nada")

    detail = f"Renombrado: {moved[0]['from']} → {moved[0]['to']}"
    if failed:
        detail += "; no se pudo: " + ", ".join(f["name"] for f in failed)
    return {"ok": True, "moved": moved, "failed": failed, "detail": detail}


def _iter_videos(root: str) -> Iterator[tuple[str, list[str]]]:
    """(video path, sibling names) for each video in `root`, two levels deep.

    That is the shape of the library: a copy loose in the root, or one inside
    its movie folder. Deeper is an extras/season structure and not our business.
    """
    for entry in _walk(root, depth=2):
        yield entry


def _walk(directory: str, depth: int, seen: set[str] | None = None) -> Iterator[tuple[str, list[str]]]:
    seen = seen if seen is not None else set()
    real = _real(directory)
    if real in seen or depth < 0:
        return
    seen.add(real)
    try:
        names = sorted(os.listdir(directory))
    except OSError:
        return
    if any(Path(n).suffix.lower() in naming.MEDIA_EXTENSIONS for n in names):
        videos = [
            n for n in names
            if Path(n).suffix.lower() in naming.MEDIA_EXTENSIONS
            and os.path.isfile(os.path.join(directory, n))
        ]
        for name in videos:
            yield os.path.join(directory, name), names
    if depth == 0:
        return
    for name in names:
        child = os.path.join(directory, name)
        if os.path.isdir(child) and not os.path.islink(child):
            yield from _walk(child, depth - 1, seen)


def candidates(*, roots: Iterable[str], movies: list[dict], naming_cfg: dict) -> dict:
    """Every 4K/3D copy that does NOT already follow Radarr's template (S2).

    A copy whose proposal matches what it already is does not appear. One that
    could not be proposed appears WITH its warning and `ok: false` (S5): hiding
    it would make the library look complete when it is not.
    """
    roots = [r for r in roots if r]
    items: list[dict] = []
    scanned = 0
    for root in roots:
        if not os.path.isdir(root):
            continue
        for video_path, siblings in _iter_videos(root):
            scanned += 1
            got = proposal(
                video_path=video_path,
                movies=movies,
                naming_cfg=naming_cfg,
                siblings=siblings,
                roots=roots,
            )
            if got["ok"]:
                current = rename_plan.base_name(os.path.basename(video_path))
                # Unidentifiable is not "done": nothing was proposed for it, so
                # hiding it would make the root look finished when it is not.
                needs_work = (
                    got["movie"] is None
                    or got["name"] != current
                    or (got["loose"] and bool(got["folder"]))
                )
                if not needs_work:
                    continue
            items.append(got)
    items.sort(key=lambda item: str(item.get("src") or ""))
    return {"ok": True, "items": items, "scanned": scanned, "detail": ""}
