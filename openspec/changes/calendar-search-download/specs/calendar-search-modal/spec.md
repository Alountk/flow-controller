# Calendar Search Modal Specification

## Purpose

Define the behavior of the modal overlay that opens when a user clicks a Calendar card for content without a file. The modal enables searching for the content and triggering a download.

## Requirements

### Requirement: Modal Opens on Card Click

The system MUST open a search/download modal when a user clicks a Calendar card where `has_file` is `false`.

#### Scenario: Card without file triggers modal

- GIVEN a Calendar card is displayed with `has_file: false`
- WHEN the user clicks the card
- THEN a modal overlay opens
- AND the modal displays the item's poster, title, date, and type (movie/episode)
- AND the modal shows a "Search" button

#### Scenario: Card with file does not trigger modal

- GIVEN a Calendar card is displayed with `has_file: true`
- WHEN the user clicks the card
- THEN no modal opens
- AND the card remains unchanged

### Requirement: Modal Displays Item Details

The system MUST display relevant details of the Calendar item in the modal.

#### Scenario: Movie item details

- GIVEN the modal opens for a movie item
- WHEN the modal is displayed
- THEN it shows the movie poster (if available)
- AND it shows the movie title and year
- AND it shows the release date
- AND it shows a "🎬 Película" badge

#### Scenario: Episode item details

- GIVEN the modal opens for an episode item
- WHEN the modal is displayed
- THEN it shows the series poster (if available)
- AND it shows the series title
- AND it shows the season and episode number (S01E01 format)
- AND it shows the episode title
- AND it shows the air date
- AND it shows a "📺 Episodio" badge

### Requirement: Modal Closes on User Action

The system MUST allow the user to close the modal without taking action.

#### Scenario: Close via X button

- GIVEN the modal is open
- WHEN the user clicks the X button
- THEN the modal closes
- AND no search or download is triggered

#### Scenario: Close via Escape key

- GIVEN the modal is open
- WHEN the user presses the Escape key
- THEN the modal closes
- AND no search or download is triggered

#### Scenario: Close via backdrop click

- GIVEN the modal is open
- WHEN the user clicks outside the modal (on the backdrop)
- THEN the modal closes
- AND no search or download is triggered

### Requirement: Modal Shows Search Status

The system MUST display the status of the search operation.

#### Scenario: Search pending

- GIVEN the user has clicked "Search"
- WHEN the search is in progress
- THEN the button shows "Buscando..."
- AND the button is disabled

#### Scenario: Search completed successfully

- GIVEN a search was triggered
- WHEN the search completes with results
- THEN the modal shows "Búsqueda completada"
- AND the search button is re-enabled

#### Scenario: Search completed with no results

- GIVEN a search was triggered
- WHEN the search completes with no results
- THEN the modal shows "No se encontraron resultados"
- AND the search button is re-enabled

#### Scenario: Search failed

- GIVEN a search was triggered
- WHEN the search fails (network error, service unavailable)
- THEN the modal shows an error message
- AND the search button is re-enabled
