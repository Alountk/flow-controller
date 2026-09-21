"""Test environment pinned so the suite does not depend on the developer's setup.

A service counts as usable only when it has both a URL and an API key. Without
keys, every service is 'unconfigured' and the routes that need one short-circuit
— so the suite passed locally, where backend/.env supplies real keys, and failed
in CI, where there is no .env at all.

Setting them here (before any test module imports config) makes the outcome the
same everywhere. `load_dotenv` does not override existing variables, so these
win over a local .env.
"""

import os

os.environ.setdefault("RADARR_URL", "http://localhost:7878")
os.environ.setdefault("RADARR_API_KEY", "test-radarr-key")
os.environ.setdefault("SONARR_URL", "http://localhost:8989")
os.environ.setdefault("SONARR_API_KEY", "test-sonarr-key")
os.environ.setdefault("AMUTORRENT_URL", "http://localhost:4000")
os.environ.setdefault("AMUTORRENT_API_KEY", "test-amutorrent-key")
