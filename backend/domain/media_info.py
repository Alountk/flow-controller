"""Radarr's `{MediaInfo …}` values, read from the file itself.

Radarr renders a name from what it probed: codec, bit depth, dynamic range,
audio and channels. We cannot ask it about a file it does not own, so the same
facts are read here with `media_mixer.probe_file`. Nothing is guessed from the
release name except the two things a probe cannot see — the source and the
group — and both come from Radarr's own fields or the name on disk.

Radarr's spellings are the contract, and they are read off its own source
(`FileNameBuilder` + `MediaInfoFormatter`), not off a memory of what a name
looks like: `{MediaInfo Simple}` is `"{VideoCodec} {AudioCodec}"` and nothing
else, `{MediaInfo AudioLanguages}` writes `[ES+EN+RU]` in capitals and is
**empty when the only audio is English**. A name that differs by one of those
would be refused by the self-check, which is the right outcome but leaves the
copy unnamed — so getting these exactly right is the whole job.
"""

from __future__ import annotations

import re

#: `FormatVideoCodec`: mpeg/av1 are fixed words, h264/hevc defer to the scene
#: name and fall back to `x264`/`h265`. The fallback is why a name can say
#: `h265` where another says `x265` — it is the release name, not the codec.
_VIDEO_FIXED = {
    "mpeg2video": "MPEG2",
    "mpeg1video": "MPEG",
    "vc1": "VC1",
    "av1": "AV1",
}
_SCENE_VIDEO = {
    "h264": ("AVC", "x264", "h264"),
    "hevc": ("HEVC", "x265", "h265"),
}

#: `FormatAudioCodec`: profiles that Radarr promotes to their own name.
_DTS_PROFILES = (
    ("DTS:X", "DTS-X"),
    ("DTS-HD MA", "DTS-HD MA"),
    ("DTS-ES", "DTS-ES"),
    ("DTS-HD HRA", "DTS-HD HRA"),
    ("DTS EXPRESS", "DTS Express"),
    ("DTS 96/24", "DTS 96/24"),
)
_AUDIO_CODEC = {
    "truehd": "TrueHD",
    "eac3": "EAC3",
    "ac3": "AC3",
    "aac": "AAC",
    "flac": "FLAC",
    "mp3": "MP3",
}

#: ISO 639-2 (B and T) -> the 639-1 codes Radarr prints. Unknown codes are
#: dropped rather than spelled out: a wrong code would fail the self-check, and
#: a silent extra token would be worse than a refused name.
_LANG = {
    "ara": "ar", "ben": "bn", "bul": "bg", "cat": "ca", "chi": "zh", "zho": "zh",
    "ces": "cs", "cze": "cs", "dan": "da", "deu": "de", "ger": "de", "ell": "el",
    "gre": "el", "eng": "en", "spa": "es", "est": "et", "eus": "eu", "baq": "eu",
    "fas": "fa", "per": "fa", "fin": "fi", "fra": "fr", "fre": "fr", "gle": "ga",
    "glg": "gl", "heb": "he", "hin": "hi", "hrv": "hr", "hun": "hu", "ind": "id",
    "isl": "is", "ice": "is", "ita": "it", "jpn": "ja", "kor": "ko", "lit": "lt",
    "lav": "lv", "mkd": "mk", "mac": "mk", "msa": "ms", "may": "ms", "mlt": "mt",
    "nld": "nl", "dut": "nl", "nor": "no", "nob": "nb", "pol": "pl", "por": "pt",
    "ron": "ro", "rum": "ro", "rus": "ru", "slk": "sk", "slo": "sk", "slv": "sl",
    "srp": "sr", "swe": "sv", "tam": "ta", "tel": "te", "tha": "th", "tur": "tr",
    "ukr": "uk", "urd": "ur", "vie": "vi", "yue": "zh", "zxx": "",
}

#: Transfer functions that mean high dynamic range; PQ is what HDR10 uses.
_HDR_TRANSFERS = {"smpte2084", "arib-std-b67"}

_GROUP_RE = re.compile(r"-([A-Za-z0-9][A-Za-z0-9@._]{1,19})$")

#: A group is never one of these: they are tokens of the release, not its author.
_NOT_A_GROUP = {
    "x264", "x265", "h264", "h265", "hevc", "av1", "dts", "dtshd", "truehd",
    "eac3", "ac3", "aac", "flac", "atmos", "hdr", "dv", "sdr", "remux", "proper",
    "repack", "multi", "dual", "subs", "esp", "eng", "cast",
}


def _first(tracks: list[dict]) -> dict:
    return tracks[0] if tracks else {}


def _scene_match(name: str, tokens: tuple[str, ...]) -> str:
    """`GetSceneNameMatch`: the first token the release name contains, else the last."""
    stem = name.rsplit(".", 1)[0] if "." in name else name
    lowered = stem.lower()
    for token in tokens:
        if token.lower() in lowered:
            return token
    return tokens[-1]


def video_codec(probe: dict, name: str = "") -> str:
    codec = (_first(probe.get("video_tracks") or []).get("codec") or "").lower()
    if not codec:
        return ""
    if codec in _SCENE_VIDEO:
        return _scene_match(name, _SCENE_VIDEO[codec])
    return _VIDEO_FIXED.get(codec, codec.upper())


def video_bit_depth(probe: dict) -> str:
    """Radarr's `10` / `8` / `12`, from the pix_fmt the probe reports."""
    pix_fmt = (_first(probe.get("video_tracks") or []).get("pix_fmt") or "").lower()
    match = re.search(r"(?:p|yuv\d{3}p|gbrp)(\d{2})(?:le|be)?$", pix_fmt)
    if match:
        return str(int(match.group(1)))
    return "8" if pix_fmt else ""


def video_dynamic_range(probe: dict) -> str:
    """`HDR` or `""` — Radarr says nothing at all for an SDR picture."""
    track = _first(probe.get("video_tracks") or [])
    transfer = (track.get("color_transfer") or "").lower()
    return "HDR" if (transfer in _HDR_TRANSFERS or _is_dolby_vision(track)) else ""


def video_dynamic_range_type(probe: dict) -> str:
    """`DV`, `HDR10`, `DV HDR10`, `HLG` … the finer word Radarr offers."""
    track = _first(probe.get("video_tracks") or [])
    if _is_dolby_vision(track):
        return "DV HDR10" if (track.get("color_transfer") or "").lower() == "smpte2084" else "DV"
    transfer = (track.get("color_transfer") or "").lower()
    if transfer == "smpte2084":
        return "HDR10"
    if transfer == "arib-std-b67":
        return "HLG"
    return "SDR"


def _is_dolby_vision(track: dict) -> bool:
    profile = (track.get("profile") or "").lower()
    return "dolby vision" in profile or (track.get("color_transfer") or "").lower() == "dv"


def audio_codec(probe: dict) -> str:
    track = _first(probe.get("audio_tracks") or [])
    codec = (track.get("codec") or "").lower()
    profile = (track.get("profile") or "").upper()
    if codec == "dts":
        # ffprobe reports plain `dts` and keeps the flavour in the profile.
        for prefix, label in _DTS_PROFILES:
            if prefix in profile:
                return label
        return "DTS"
    if codec == "truehd":
        return "TrueHD Atmos" if "ATMOS" in profile else "TrueHD"
    if codec == "eac3":
        return "EAC3 Atmos" if "ATMOS" in profile else "EAC3"
    if codec == "aac":
        return "HE-AAC" if "HE-AAC" in profile else "AAC"
    return _AUDIO_CODEC.get(codec, codec.upper() if codec else "")


def audio_channels(probe: dict) -> str:
    """Radarr prints one decimal, taking MediaInfo's channel positions if it has them."""
    track = _first(probe.get("audio_tracks") or [])
    layout = track.get("channel_layout") or ""
    match = re.match(r"(\d+(?:\.\d+)?)", layout)
    if match and "." in match.group(1):
        return match.group(1)
    channels = int(track.get("channels") or 0)
    return f"{channels}.0" if channels else ""


def audio_languages(probe: dict) -> str:
    """Radarr's `{MediaInfo AudioLanguages}`: `[ES+EN]`, and empty for English only."""
    return language_token(_codes(probe.get("audio_tracks") or []), skip_english_only=True)


def subtitle_languages(probe: dict) -> str:
    return language_token(_codes(probe.get("subtitle_tracks") or []))


def language_token(codes: "str | list[str]", skip_english_only: bool = False) -> str:
    """`[ES+EN+RU]` from `en/es/ru`, Radarr's `GetLanguagesToken` rule for rule."""
    items = re.split(r"[/+,]", codes) if isinstance(codes, str) else list(codes)
    seen: list[str] = []
    for item in items:
        code = _LANG.get((item or "").strip().lower(), (item or "").strip().lower())
        if not code or code == "und":
            continue
        code = code.upper()
        if code not in seen:
            seen.append(code)
    if skip_english_only and seen == ["EN"]:
        return ""
    return f"[{'+'.join(seen)}]" if seen else ""


def _codes(tracks: list[dict]) -> list[str]:
    return [str(track.get("language") or "") for track in tracks]



def resolution(probe: dict) -> str:
    """`2160` / `1080` / … from the picture itself, never from the name."""
    height = int(_first(probe.get("video_tracks") or []).get("height") or 0)
    for edge, label in ((1700, "2160"), (1000, "1080"), (700, "720"), (560, "576")):
        if height >= edge:
            return label
    return "480" if height else ""


def simple(probe: dict, name: str = "") -> str:
    """Radarr's `{MediaInfo Simple}`."""
    return compose(from_probe(probe, name))["simple"]


def full(probe: dict, name: str = "") -> str:
    """Radarr's `{MediaInfo Full}`."""
    return compose(from_probe(probe, name))["full"]


def release_group(name: str) -> str:
    """The group the file name ends with, or "" — a name cannot be invented.

    The tail of a scene name is the only place a group survives for a file
    Radarr does not own, and it is a declaration like the source token: what is
    refused are the tails that are plainly a resolution, an audio line or a
    release flag, because naming a file after `2160p` is worse than not naming
    the group at all.
    """
    stem = name.rsplit(".", 1)[0] if "." in name else name
    match = _GROUP_RE.search(stem)
    if not match:
        return ""
    group = match.group(1)
    if group.lower() in _NOT_A_GROUP or group[0].isdigit():
        return ""
    if re.search(r"\d{3,4}p", group, re.IGNORECASE) or re.search(r"\.\d", group):
        return ""
    return group


def compose(facts: dict) -> dict:
    """Fill `Simple` and `Full` the way `FileNameBuilder` builds them.

    `Simple` is `"{VideoCodec} {AudioCodec}"` — no bit depth, no dynamic range,
    no channels — and `Full` glues the audio languages to the codec:
    `x264 DTS[EN+ES] [ES]`. A tidier line would be a different line, and the
    self-check compares strings.
    """
    facts = {k: (v if v is not None else "") for k, v in facts.items()}
    video = facts.get("video_codec", "")
    audio = facts.get("audio_codec", "")
    simple = " ".join(part for part in (video, audio) if part)
    full = f"{video} {audio}{facts.get('audio_languages', '')} {facts.get('subtitle_languages', '')}"
    return {
        **facts,
        "simple": facts.get("simple") or simple,
        "full": facts.get("full") or full.strip(),
    }


def from_probe(probe: dict, name: str) -> dict:
    """Everything the file itself can say about itself, keyed for the tokens."""
    return compose(
        {
            "video_codec": video_codec(probe, name),
            "video_bit_depth": video_bit_depth(probe),
            "video_dynamic_range": video_dynamic_range(probe),
            "video_dynamic_range_type": video_dynamic_range_type(probe),
            "audio_codec": audio_codec(probe),
            "audio_channels": audio_channels(probe),
            "audio_languages": audio_languages(probe),
            "subtitle_languages": subtitle_languages(probe),
            "release_group": release_group(name),
        }
    )


def quality(name: str, declared: str, fallback: str, probe: dict) -> str:
    """`Container-Resolution` with the resolution the disk reports.

    Both halves can come from a different place and picking the wrong one is
    what the user saw: the source is only ever declared (the name, or Radarr's
    quality), while the resolution is measured. Taking the resolution from the
    declared quality gave `Remux-1080p` for a 2160p remux, because Radarr holds
    that movie's 1080p file.
    """
    container = _container(name) or _container(declared) or _container(fallback)
    pixels = resolution(probe) or _pixels(declared) or _pixels(fallback)
    if not container or not pixels:
        return ""
    return f"{container}-{pixels}p"


_QUALITY_RE = re.compile(r"^[A-Za-z0-9]+-\d{3,4}p$")

#: Source tokens, in the order Radarr ranks them. A remux outranks a Bluray and
#: keeps its own quality name, which is why it has to be asked for first.
_CONTAINERS = (
    (r"remux", "Remux"),
    (r"web[-. ]?dl", "WEBDL"),
    (r"web[-. ]?rip", "WEBRip"),
    (r"blu[-. ]?ray|bdrip|brrip|bd25|bd50|bdmv", "Bluray"),
    (r"hdtv", "HDTV"),
    (r"dvd", "DVD"),
)


def _container(text: str) -> str:
    """The source, from a release name or from a `Container-Resolution` string.

    Only a quality string is split on its dash: `WEB-DL` in a file name carries
    a dash of its own, and splitting there hid the token it was looking for.
    """
    text = text or ""
    head = text.partition("-")[0] if _QUALITY_RE.match(text) else text
    for token, label in _CONTAINERS:
        if re.search(rf"(?<![a-z0-9]){token}(?![a-z0-9])", head, re.IGNORECASE):
            return label
    return ""


def _pixels(text: str) -> str:
    match = re.search(r"(\d{3,4})p", text or "", re.IGNORECASE)
    return match.group(1) if match else ""
