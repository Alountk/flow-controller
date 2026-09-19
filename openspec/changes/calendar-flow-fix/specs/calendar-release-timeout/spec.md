# Calendar Release Timeout Specification

## Purpose

This specification defines the requirement for increasing the backend release search timeout and aligning the frontend timeout to prevent premature cancellation of release searches.

## Requirements

### Requirement: Backend Release Search Timeout Increase

The system SHALL increase the backend timeout for release searches from 25 seconds to 60 seconds.

#### Scenario: Backend timeout value

- GIVEN the backend `arr_fetch_releases()` function is called
- WHEN the timeout is configured
- THEN the timeout MUST be set to `REQUEST_TIMEOUT * 12` (which equals 60 seconds given `REQUEST_TIMEOUT = 5`)
- AND the timeout MUST be passed as `aiohttp.ClientTimeout(total=...)` to the HTTP request

#### Scenario: Timeout error message reflects new timeout

- GIVEN the backend times out waiting for Radarr/Sonarr response
- WHEN a `TimeoutError` is caught
- THEN the error detail MUST include the new timeout duration (60 seconds)
- AND the error message MUST be in the same format as before: "Timeout: Radarr/Sonarr no respondió en {timeout}s. Verifica que el servicio esté activo."

### Requirement: Frontend Timeout Alignment

The system SHALL align the frontend timeout to 65 seconds to stay above the new backend timeout.

#### Scenario: Frontend timeout value

- GIVEN the frontend `fetchCalendarReleases()` function is called
- WHEN the timeout is configured
- THEN the timeout MUST be set to 65000 milliseconds (65 seconds)
- AND the timeout MUST be used with `AbortController` to cancel the fetch if exceeded

#### Scenario: Frontend timeout error handling

- GIVEN the frontend fetch times out (AbortController triggers)
- WHEN an `AbortError` is caught
- THEN the error detail MUST be "Timeout: Radarr/Sonarr no respondió. Verifica que el servicio esté activo."
- AND the timeout MUST NOT be shorter than the backend timeout (60 seconds) to avoid premature cancellation

### Requirement: Timeout Coordination

The system SHALL ensure that the frontend timeout is always greater than the backend timeout.

#### Scenario: Frontend timeout buffer

- GIVEN the backend timeout is 60 seconds
- WHEN the frontend timeout is set
- THEN the frontend timeout MUST be at least 5 seconds greater than the backend timeout
- AND the frontend timeout SHOULD be a single source of truth (hardcoded value, not derived from backend)

## Edge Cases

### Scenario: Backend timeout configuration change

- GIVEN a developer changes the `REQUEST_TIMEOUT` constant
- WHEN the backend timeout calculation uses `REQUEST_TIMEOUT * 12`
- THEN the frontend timeout remains hardcoded at 65 seconds
- AND the system MUST NOT break if the backend timeout changes (frontend timeout is independent)

### Scenario: Network latency

- GIVEN network latency causes the request to take longer than 60 seconds
- WHEN the backend timeout triggers
- THEN the backend returns a timeout error with the new duration
- AND the frontend receives the error after its own timeout (or earlier if backend responds with error)

## API Contract Changes

No API contract changes for timeout - the timeout is internal behavior. The response format remains the same.

## Testability

Each scenario is testable by:
- Mocking the Radarr/Sonarr response to delay beyond timeout
- Verifying the timeout values are correctly set
- Verifying error messages contain the correct timeout duration
- Verifying frontend timeout is greater than backend timeout