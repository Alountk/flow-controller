# Calendar Radarr/Sonarr Integration Specification

## Purpose

Define how the Calendar search modal integrates with Radarr and Sonarr for searching indexers and triggering downloads.

## Requirements

### Requirement: Search via Radarr/Sonarr Indexers

The system MUST use Radarr's or Sonarr's configured indexers to search for content.

#### Scenario: Search for movie in Radarr

- GIVEN the modal opens for a movie item
- AND the movie is already in Radarr's library (has a Radarr movie ID)
- WHEN the user clicks "Search"
- THEN the system sends a `MoviesSearch` command to Radarr with the movie ID
- AND the system returns the search result status

#### Scenario: Search for episode in Sonarr

- GIVEN the modal opens for an episode item
- AND the episode's series is already in Sonarr's library (has a Sonarr series ID)
- WHEN the user clicks "Search"
- THEN the system sends an `EpisodeSearch` command to Sonarr with the episode ID
- AND the system returns the search result status

### Requirement: Add to Library Before Search

The system MUST add content to Radarr/Sonarr library if it's not already tracked, before searching.

#### Scenario: Add movie to Radarr then search

- GIVEN the modal opens for a movie item
- AND the movie is NOT in Radarr's library
- WHEN the user clicks "Add & Search"
- THEN the system sends a `POST /api/v3/movie` request to Radarr with the movie metadata
- AND upon success, the system triggers a search for the newly added movie
- AND the system returns the combined status

#### Scenario: Add series to Sonarr then search

- GIVEN the modal opens for an episode item
- AND the episode's series is NOT in Sonarr's library
- WHEN the user clicks "Add & Search"
- THEN the system sends a `POST /api/v3/series` request to Sonarr with the series metadata
- AND upon success, the system triggers a search for the newly added episode
- AND the system returns the combined status

#### Scenario: Add fails — service unavailable

- GIVEN the modal opens for content not in the library
- WHEN the user clicks "Add & Search"
- AND the add request fails (service unavailable, invalid data)
- THEN the modal shows an error message
- AND no search is triggered

### Requirement: Determine Library Membership

The system MUST determine whether content is already in Radarr/Sonarr library.

#### Scenario: Movie already in Radarr

- GIVEN the Calendar item has `type: "movie"`
- AND the backend can find a matching movie in Radarr by title/year
- THEN the system uses the "Search" flow (no add needed)

#### Scenario: Movie not in Radarr

- GIVEN the Calendar item has `type: "movie"`
- AND no matching movie exists in Radarr
- THEN the system shows "Add & Search" instead of "Search"

#### Scenario: Episode series already in Sonarr

- GIVEN the Calendar item has `type: "episode"`
- AND the series exists in Sonarr
- THEN the system uses the "Search" flow (no add needed)

#### Scenario: Episode series not in Sonarr

- GIVEN the Calendar item has `type: "episode"`
- AND the series does not exist in Sonarr
- THEN the system shows "Add & Search" instead of "Search"

### Requirement: Backend Endpoints

The system MUST expose endpoints for calendar search and add operations.

#### Scenario: POST /api/calendar/search

- GIVEN a request with `source` ("radarr" or "sonarr"), `type` ("movie" or "episode"), and `id` (Radarr/Sonarr ID)
- WHEN the endpoint is called
- THEN the system delegates to `arr_search_movie` or `arr_search_episode`
- AND returns `{"ok": true/false, "detail": "..."}`

#### Scenario: POST /api/calendar/add

- GIVEN a request with `source`, `type`, and item metadata (title, year, etc.)
- WHEN the endpoint is called
- THEN the system sends `POST /api/v3/movie` or `POST /api/v3/series` to the appropriate service
- AND returns `{"ok": true/false, "id": <new_id>, "detail": "..."}`

### Requirement: Frontend API Functions

The system MUST provide frontend API functions for calendar search operations.

#### Scenario: searchCalendarItem function

- GIVEN the frontend calls `searchCalendarItem(source, type, id)`
- WHEN the call completes
- THEN it returns `{ ok: boolean, detail: string }`

#### Scenario: addCalendarItem function

- GIVEN the frontend calls `addCalendarItem(source, type, metadata)`
- WHEN the call completes
- THEN it returns `{ ok: boolean, id?: number, detail: string }`
