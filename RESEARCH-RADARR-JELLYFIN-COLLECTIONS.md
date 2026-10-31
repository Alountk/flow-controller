# Research: Radarr collections ↔ Jellyfin collections

Question (owner, 2026-10-31): «investigar el tema de las colecciones de radarr
y como poder enlazarlo con las colecciones de jellyfin». Placed at repo root
per the repo's convention for standing notes (ROADMAP.md, BACKLOG.md,
HANDOFF.md — no docs/ directory exists). Method: primary sources only
(Servarr wiki + Radarr's generated OpenAPI docs, jellyfin/jellyfin source,
Jellyfin OpenAPI spec, official plugin repo). Every claim is cited; claims I
could not trace to a primary source are marked **unverified**.

## 0. Current state in flow-controller

- The codebase has **zero Jellyfin code** (verified by the parent: no matches
  for "jellyfin" in `backend/` or `frontend/src/`).
- Radarr access exists: `backend/infrastructure/arr_client.py` (base URL +
  `X-Api-Key`-style auth already wired for `/api/v3/*`), consumed by
  `routes/wanted.py`, `routes/mediacover.py`, `routes/files.py`, etc.
  Introducing a Jellyfin client would mirror this module pattern (settings
  keys + client + routes), not invent a new architecture.

## 1. Radarr collections

- **What they are**: «Collections groups movies that belong to a TMDb movie
  collection (for example, a film series). Collections are populated
  automatically from the metadata of movies you add» — i.e. they are
  *derived* from TMDb, not user-created containers. Editable options per
  collection: monitored, minimum availability, quality profile, root folder,
  tags, search-on-add; monitored collections auto-add their movies as
  metadata refreshes. Source: Servarr wiki, Radarr → Library → Collections.
- **API surface** (Radarr's own OpenAPI, generated client docs agree):
  - `GET /api/v3/collection` — list; supports a `?tmdbId=` filter.
  - `GET /api/v3/collection/{id}` — one collection.
  - `PUT /api/v3/collection` — bulk settings update (`CollectionUpdateResource`).
  - `PUT /api/v3/collection/{id}` — update one collection's settings.
  - **There is no `POST` (create) and no `DELETE` endpoint** for collections
    in the generated API docs — consistent with them being derived from TMDb
    metadata of library movies; the API only reconfigures them.
  - Auth: `X-Api-Key` header or `?apikey=` query (already how `arr_client`
    talks to Radarr).
  Sources: radarr.video/docs (official API docs), Radarr/Radarr
  `src/Radarr.Api.V3/openapi.json` (Automated API Docs commit), generated
  clients (docs.rs `collection_api.rs`, github.com/devopsarr/radarr-rs).
- **What each collection carries**: title + `tmdbId` + images (the generated
  client filters by `tmdbId`, proving the field exists on
  `CollectionResource`). **unverified**: whether `GET /api/v3/collection`
  embeds the member movie list (schema not quoted here) — plan the member
  mapping from the movie catalogue if not.
- Legacy: «Collection Lists are no longer supported in Radarr v4.2 and have
  been migrated to collections within Radarr» (Servarr wiki, Supported).
  Search filters can target `Collection (Enum Collections)`.

## 2. Jellyfin collections

- **Data model**: collections are `BoxSet` items managed by
  `ICollectionManager` (`MediaBrowser.Controller/Collections`). Creation
  options include `ProviderIds` internally (`CollectionCreationOptions :
  IHasProviderIds`) — the server *can* attach provider ids to a collection.
- **HTTP API** (`Jellyfin.Api/Controllers/CollectionController.cs`, route
  `Collections`, policy `Policies.CollectionManagement`):
  - `POST /Collections?name=<n>&ids=<comma-delimited item GUIDs>[&parentId=][&isLocked=]`
    → `200` with `CollectionCreationResult { Id }`.
  - `POST /Collections/{collectionId}/Items?ids=<guids>` → `204` (add).
  - `DELETE /Collections/{collectionId}/Items?ids=<guids>` → `204` (remove).
  - **unverified**: renaming/deleting a whole BoxSet — not in this
    controller; presumably the generic `DELETE /Items/{itemId}` and
    `POST /Items/{itemId}` metadata update, not quoted here.
  - Note: the HTTP create call exposes only `name`/`ids`/`parentId`/
    `isLocked` — **no ProviderIds query parameter**, so a boxset created
    through the API starts without a TMDb id of its own unless set via a
    metadata update.
  Sources: jellyfin/jellyfin `CollectionController.cs`,
  `ICollectionManager.cs`, `CollectionCreationOptions.cs`.
- **Listing**: `GET /Items?includeItemTypes=BoxSet` is a real OpenAPI query
  param (`includeItemTypes`, comma delimited) — spec at
  api.jellyfin.org/openapi (stable/unstable JSON), and used verbatim in
  jellyfin/jellyfin issue #16454. Caveat from that issue: with
  `parentId=<BoxSet>` + `includeItemTypes=BoxSet` the server currently
  returns libraries instead of nested collections (a server bug, BoxSet
  listings at top level are unaffected).
- **Movie ↔ TMDb linkage**: `BaseItem.ProviderIds` is a case-insensitive
  dictionary of provider → id (`BaseItem.cs`); movies carry the TMDb id
  under the `Tmdb` key (docs example: `ProviderIds: {"Tmdb": "603"}`).
  **Important API limit** (jellyfin discussion #10156, maintainer
  nielsvanvelzen): «It is not possible to query items by provider id» — you
  can filter with `hasTmdbId=true`, then match the id client-side from the
  `ProviderIds` field (`Fields=ProviderIds`).
  Auth: `Authorization: MediaBrowser Token=<API_KEY>` (docs example).
- **Automatic TMDb-driven collections in Jellyfin**: the official plugin
  **jellyfin-plugin-tmdbboxsets** («TMDb Box Sets») «automatically creates
  Box Sets and Collections based on TMDb's collection IDs», with config:
  minimum number of movies (default 2), strip «Collection» keyword, and a
  refresh action `POST TMDbBoxSets/Refresh` (queues a library scan). The web
  UI also offers a display option «Group movies in collections»
  (jellyfin.org forum guidance — community, not spec).
  Sources: github.com/jellyfin/jellyfin-plugin-tmdbboxsets (README +
  configuration page source).

## 3. Linking strategies (Radarr → Jellyfin)

Both sides key on **TMDb ids**, so a link is always resolvable: Radarr
collection `tmdbId` → Jellyfin movies' `ProviderIds.Tmdb` → their item GUIDs.

- **Option A — zero code (Jellyfin does it itself).** Install/enable the
  official TMDb Box Sets plugin in Jellyfin (+ «Group movies in
  collections»). Jellyfin derives the same TMDb collections Radarr shows,
  for the movies it has. flow-controller does nothing.
  - Effort: **XS** (configuration only). Covers ~90% of the visible need.
  - Limits: only Jellyfin's own library; timing tied to metadata refresh;
    no control/verification from this app.
- **Option B — verification view in flow-controller (read-only).** App reads
  Radarr collections (`GET /api/v3/collection`, + movie catalogue for
  membership if not embedded) and Jellyfin's `GET /Items?includeItemTypes=
  BoxSet` (+ movie items with `Fields=ProviderIds`, `hasTmdbId=true`),
  computes a diff per TMDb collection (missing in Jellyfin / members
  missing / present), shows it, and can trigger
  `POST TMDbBoxSets/Refresh`. Manual fixes stay in Jellyfin.
  - Effort: **S–M**: Jellyfin client (mirror `arr_client`), settings keys
    (URL + API key), one route, one panel; no writes → low risk.
  - Failure modes: Jellyfin library scan lag (movie not indexed yet →
    reported as missing until rescan), API key permissions.
- **Option C — app-driven sync (write).** flow-controller creates/updates
  Jellyfin BoxSets: for each Radarr collection, `POST /Collections?name=
  <title>&ids=<mapped GUIDs>` (or add missing members via
  `POST /Collections/{id}/Items`), optionally set cover via metadata
  endpoints, on demand or as a scheduled job.
  - Effort: **M–L**: everything in B plus write endpoints, idempotency
    (name-based matching is fragile — renames and localized titles),
    duplicate avoidance, job/progress (same single-flight pattern as the
    ffprobe library job), and a settings toggle.
  - Failure modes: duplicates on title mismatch; created BoxSets have no
    TMDb `ProviderIds` through the HTTP create call (so future re-matching
    must fall back to names/members); Jellyfin-side deletions diverging
    from Radarr; timing between Radarr metadata refresh and Jellyfin scan.

**Suggested order**: A now (if the Jellyfin instance exists) → B as the
first code increment (read-only, honest diff) → C only if manual fixing
becomes annoying. If A is enabled, C risks fighting the plugin for the same
BoxSets — pick A *or* C, not both.

## 4. What flow-controller would need (size)

- New `backend/infrastructure/jellyfin_client.py` (mirror of `arr_client`:
  base URL, `MediaBrowser Token` auth, `/Items` paged fetch, `/Collections`
  create/add) — **M** for B, **M** for C's extra writes.
- Settings: `jellyfin_url`, `jellyfin_api_key` (+ enable toggle) in the
  settings store (existing key-mapping pattern).
- Routes: `/api/jellyfin/collections` (diff, B) and
  `/api/jellyfin/collections/sync` (C, single-flight job + status endpoint).
- Frontend: a panel in Settings (connection test) + a collections section
  (Calidad/Peliculas or its own tab).
- T-shirt total: **B ≈ S–M**, **C ≈ L** (B+C together ≈ M–L).

## 5. Open questions / risks for the owner

1. **Does a Jellyfin instance exist here, and where?** (URL + API key
   availability; nothing in the repo or config suggests one yet.)
2. Is the **TMDb Box Sets plugin** installed/enabled there? (Decides
   A vs B/C; A and C should not run together.)
3. Desired direction: **read-only diff (B)** or **automatic sync (C)**?
4. Should collections created by the app be **locked** (`isLocked`) to
   survive Jellyfin's own metadata refresh?
5. Timing policy: on demand, scheduled, or after each Radarr refresh?
6. **unverified** items above: Radarr collection member embedding, BoxSet
   rename/delete endpoints — verify against a live OpenAPI before building C.

## Sources

- Radarr collections (concept): https://wiki.servarr.com/radarr/library
- Radarr supported lists (v4.2 migration): https://wiki.servarr.com/en/radarr/supported
- Radarr API docs (Collection API): https://radarr.video/docs/api
- Radarr OpenAPI source: https://github.com/Radarr/Radarr (src/Radarr.Api.V3/openapi.json, commit e5d479a)
- Generated client (endpoints + `?tmdbId=` filter + auth): https://docs.rs/radarr/latest/src/radarr/apis/collection_api.rs.html
- Generated client table: https://github.com/devopsarr/radarr-rs/blob/main/docs/CollectionApi.md
- Jellyfin CollectionController: https://github.com/jellyfin/jellyfin/blob/master/Jellyfin.Api/Controllers/CollectionController.cs
- Jellyfin ICollectionManager: https://github.com/jellyfin/jellyfin/blob/master/MediaBrowser.Controller/Collections/ICollectionManager.cs
- Jellyfin CollectionCreationOptions (ProviderIds): https://github.com/jellyfin/jellyfin/blob/master/MediaBrowser.Controller/Collections/CollectionCreationOptions.cs
- Jellyfin BaseItem.ProviderIds: https://github.com/jellyfin/jellyfin/blob/master/MediaBrowser.Controller/Entities/BaseItem.cs
- Jellyfin OpenAPI spec: https://api.jellyfin.org/openapi/ (jellyfin-openapi-stable.json)
- Jellyfin `/Items` includeItemTypes behavior + bug: https://github.com/jellyfin/jellyfin/issues/16454
- Jellyfin "cannot query by provider id" + `hasTmdbId`: https://github.com/jellyfin/jellyfin/discussions/10156
- Jellyfin metadata API (auth header, ProviderIds `Tmdb` key): https://jellyfin-jellyfin.mintlify.app/api/media/metadata
- Jellyfin official metadata docs: https://jellyfin.org/docs/general/server/metadata/
- TMDb Box Sets plugin: https://github.com/jellyfin/jellyfin-plugin-tmdbboxsets
- Jellyfin forum («Group movies in collections» display option): https://jellyfin.org/forum/ (community guidance, not spec)
