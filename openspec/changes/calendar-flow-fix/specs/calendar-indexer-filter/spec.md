# Calendar Indexer Filter Specification

## Purpose

This specification defines the requirement for plumbing the indexer selection through the full API chain and filtering releases server-side by indexer name.

## Requirements

### Requirement: Indexer Selection API Contract

The system SHALL accept an optional `indexer` parameter in the `CalendarReleasesRequest` and `fetchCalendarReleases()` functions.

#### Scenario: Backend request model includes indexer field

- GIVEN the `CalendarReleasesRequest` Pydantic model
- WHEN the model is defined
- THEN it MUST include an optional field `indexer: str | None = None`
- AND the field MUST be placed after the existing `id` field

#### Scenario: Frontend API function includes indexer parameter

- GIVEN the `fetchCalendarReleases()` TypeScript function
- WHEN the function signature is defined
- THEN it MUST include an optional parameter `indexer?: string`
- AND the parameter MUST be included in the JSON body sent to the backend

#### Scenario: Frontend modal passes selectedIndexer

- GIVEN the `handleSearch()` function in `CalendarModal.tsx`
- WHEN the search is triggered
- THEN the function MUST pass the `selectedIndexer` value to `fetchCalendarReleases()`
- AND the `selectedIndexer` value MUST be converted to string (or "all" if "all" is selected)

### Requirement: Server-Side Indexer Filtering

The system SHALL filter releases by indexer name on the server side after fetching from Radarr/Sonarr.

#### Scenario: Filter by specific indexer

- GIVEN the backend `arr_fetch_releases()` function receives an `indexer` parameter
- WHEN `indexer` is provided and is not "all"
- THEN the function MUST filter the releases array to only include releases where `release["indexer"] == indexer`
- AND the filtered releases MUST be returned in the response

#### Scenario: No filter when indexer is "all" or None

- GIVEN the backend `arr_fetch_releases()` function receives an `indexer` parameter
- WHEN `indexer` is "all" or `None`
- THEN the function MUST return all releases without filtering
- AND the response MUST be identical to the current behavior (backward compatible)

#### Scenario: Filter after quality parsing

- GIVEN the backend `arr_fetch_releases()` function
- WHEN releases are fetched from Radarr/Sonarr
- THEN the quality parsing MUST happen before the indexer filter
- AND the filter MUST be applied on the parsed releases array (not raw API response)

### Requirement: Frontend Indexer Selection State

The system SHALL maintain the selected indexer state in the modal and pass it through the API chain.

#### Scenario: Default indexer selection

- GIVEN the CalendarModal component mounts
- WHEN the component initializes
- THEN the `selectedIndexer` state MUST default to "all"
- AND the dropdown MUST show "All indexers" as selected

#### Scenario: User changes indexer selection

- GIVEN the CalendarModal component is open
- WHEN the user selects a different indexer from the dropdown
- THEN the `selectedIndexer` state MUST update to the selected indexer's ID (as string)
- AND the search message MUST reflect the selected indexer name

#### Scenario: Indexer selection persists across searches

- GIVEN the user has selected a specific indexer
- WHEN the user clicks search multiple times
- THEN the same indexer filter MUST be applied to each search
- AND the indexer selection MUST NOT reset between searches

## Edge Cases

### Scenario: Indexer name not found in releases

- GIVEN a specific indexer is selected for filtering
- WHEN no releases match that indexer name
- THEN the response MUST return an empty releases array
- AND the detail message SHOULD indicate "No releases found for indexer: {indexer}"

### Scenario: Indexer name case sensitivity

- GIVEN the indexer name provided by the user
- WHEN comparing with release indexer names
- THEN the comparison MUST be case-sensitive (exact match)
- AND the system MUST NOT perform fuzzy matching

### Scenario: Indexer selection with "all" value

- GIVEN the user selects "All indexers" in the dropdown
- WHEN the search is triggered
- THEN the `indexer` parameter MUST be "all"
- AND the backend MUST treat "all" the same as `None` (no filtering)

### Scenario: Backend receives unknown indexer name

- GIVEN the backend receives an indexer name that doesn't match any release
- WHEN filtering is applied
- THEN the filtered result will be empty
- AND the system MUST NOT return an error (empty result is valid)

## API Contract Changes

### New Request Field

```python
class CalendarReleasesRequest(BaseModel):
    source: str  # "radarr" or "sonarr"
    type: str  # "movie" or "episode"
    id: int  # Radarr movie ID or Sonarr episode ID
    indexer: str | None = None  # Optional indexer filter
```

### New Frontend Parameter

```typescript
fetchCalendarReleases(
  source: string,
  type: string,
  id: number,
  indexer?: string
): Promise<{ releases: Release[]; detail: string }>
```

### Response Format

No changes to response format. The `releases` array contains the same structure, just filtered.

## Testability

Each scenario is testable by:
- Unit testing the filter logic with mock releases
- Integration testing the full API chain with mock Radarr/Sonarr
- Frontend testing the dropdown state and API call parameters
- Testing backward compatibility (no indexer = all releases)