# Media Mixer UI Specification

## Purpose

Frontend component for the media mixer feature, providing file selection, track comparison, audio track selection, and mux progress monitoring. Integrates with the existing flow-controller dashboard navigation and component patterns.

## Requirements

### Requirement: FR-013 — Media Mixer Navigation Entry

The system SHALL add a "Media Mixer" navigation item to the sidebar, accessible to all users.

#### Scenario: Sidebar displays Media Mixer link

- GIVEN the user is viewing the flow-controller dashboard
- WHEN the sidebar renders
- THEN a "Media Mixer" link SHALL appear in the navigation with an appropriate icon (e.g. "🎬")
- AND clicking it SHALL navigate to the Media Mixer page

#### Scenario: Page title updates on navigation

- WHEN the user navigates to the Media Mixer page
- THEN the topbar title SHALL display "Media Mixer"

### Requirement: FR-014 — Two-File Selection

The system SHALL allow the user to select exactly two video files from the filesystem for probe analysis.

#### Scenario: Select two files via file browser

- GIVEN the user is on the Media Mixer page
- WHEN the user selects two video files using the file selection inputs
- THEN both file paths SHALL be stored in component state
- AND the "Analyze" button SHALL become enabled

#### Scenario: Analyze button disabled with fewer than two files

- GIVEN the user has selected zero or one file
- WHEN the Media Mixer page renders
- THEN the "Analyze" button SHALL be disabled
- AND a tooltip or hint SHALL indicate "Select two files to analyze"

#### Scenario: Replace a selected file

- GIVEN the user has selected file A and file B
- WHEN the user selects file C in place of file A
- THEN file A SHALL be replaced by file C in the selection
- AND the "Analyze" button SHALL remain enabled

#### Scenario: Clear file selection

- WHEN the user clicks a clear/reset button
- THEN both file selections SHALL be cleared
- AND the "Analyze" button SHALL become disabled

### Requirement: FR-015 — Analyze Action

The system SHALL call the probe endpoint and display results including video track auto-selection, audio track selection with checkboxes, and compatibility warnings.

#### Scenario: Successful analysis displays results

- GIVEN the user has selected two files and clicked "Analyze"
- WHEN the probe endpoint returns successfully
- THEN the system SHALL display a results panel with:
  - File A metadata (filename, format, duration)
  - File B metadata (filename, format, duration)
  - Video tracks for each file with auto-selected track highlighted
  - Audio tracks for each file with checkboxes
  - Compatibility warnings section (if any)

#### Scenario: Analysis in progress shows loading state

- GIVEN the user clicked "Analyze" and the probe request is in flight
- WHEN the results have not yet returned
- THEN a loading spinner or skeleton SHALL be displayed
- AND the "Analyze" button SHALL be disabled during loading

#### Scenario: Analysis fails with error

- GIVEN the probe endpoint returns an error
- WHEN the response is received
- THEN an error message SHALL be displayed below the file selectors
- AND the error SHALL match the detail from the API response
- AND the results panel SHALL NOT be displayed

#### Scenario: Analysis with compatibility warnings

- GIVEN the probe returns warnings (FPS mismatch, duration mismatch)
- WHEN the results are displayed
- THEN a warnings section SHALL be visible with yellow/amber styling
- AND each warning SHALL display the type and description
- AND the "Mix" button SHALL remain enabled (warnings do not block)

### Requirement: FR-016 — Audio Track Selection

The system SHALL display audio tracks from both files with checkboxes, allowing the user to select which tracks to include and their order.

#### Scenario: Audio tracks displayed with checkboxes

- GIVEN the probe results contain audio tracks from both files
- WHEN the results panel renders
- THEN each audio track SHALL display: codec, language, channels, bitrate
- AND each track SHALL have a checkbox (unchecked by default except `default` tracks)
- AND default tracks SHALL have their checkbox pre-checked

#### Scenario: Select audio tracks from both files

- GIVEN file A has audio track index 1 (English 5.1) and file B has audio track index 2 (Spanish 2.0)
- WHEN the user checks both checkboxes
- THEN both tracks SHALL be included in the mux request
- AND the order of selection SHALL be preserved in the request

#### Scenario: Deselect all audio tracks

- GIVEN the user has checked some audio tracks
- WHEN the user unchecks all checkboxes
- THEN the "Mix" button SHALL become disabled
- AND a hint SHALL indicate "Select at least one audio track"

#### Scenario: Select order determines output track order

- GIVEN the user checks English track first, then Spanish track
- WHEN the user clicks "Mix"
- THEN the mux request SHALL list English track before Spanish track
- AND the output file SHALL have English as the first audio track

### Requirement: FR-017 — Mix Action

The system SHALL call the mux endpoint with the selected tracks and display progress with cancellation support.

#### Scenario: Start mux and show progress

- GIVEN the user has selected tracks and clicked "Mix"
- WHEN the mux endpoint returns a task_id
- THEN a progress bar SHALL be displayed
- AND a "Cancel" button SHALL be visible next to the progress bar
- AND the progress SHALL update by polling the task endpoint every 2 seconds

#### Scenario: Progress bar updates

- GIVEN a mux task is running with progress 0.3
- WHEN the task is polled
- THEN the progress bar SHALL fill to 30%
- AND the detail text SHALL be displayed below the bar

#### Scenario: Mux completes successfully

- GIVEN the mux task status becomes "done"
- WHEN the progress is polled
- THEN the progress bar SHALL show 100%
- AND a success message SHALL be displayed
- AND the output file path SHALL be shown
- AND the "Cancel" button SHALL disappear

#### Scenario: Mux fails

- GIVEN the mux task status becomes "error"
- WHEN the progress is polled
- THEN an error message SHALL be displayed with the detail text
- AND the progress bar SHALL show an error state (red)
- AND the "Cancel" button SHALL disappear

#### Scenario: Cancel mux

- GIVEN a mux task is running
- WHEN the user clicks "Cancel"
- THEN the cancel endpoint SHALL be called
- AND the progress bar SHALL show "Cancelled"
- AND the task polling SHALL stop

#### Scenario: Mix button disabled without audio selection

- GIVEN the user has not selected any audio tracks
- WHEN the Media Mixer page renders the mix section
- THEN the "Mix" button SHALL be disabled

### Requirement: FR-018 — State Management

The component SHALL use React state for file selection, probe results, task progress, and UI state. Server state SHALL be managed via @tanstack/react-query where applicable.

#### Scenario: Component state resets on page navigation

- GIVEN the user navigates away from Media Mixer
- WHEN the user navigates back
- THEN the component SHALL reset to its initial state
- AND previous probe results SHALL NOT persist

#### Scenario: Probe results cleared on file change

- GIVEN probe results are displayed for files A and B
- WHEN the user changes either file selection
- THEN the probe results SHALL be cleared
- AND the results panel SHALL hide
- AND the mix section SHALL reset

### Requirement: FR-019 — Error States

The system SHALL display user-friendly error messages for all failure modes.

#### Scenario: Network error during probe

- GIVEN the backend is unreachable
- WHEN the user clicks "Analyze"
- THEN an error message SHALL display: "Cannot connect to server"
- AND the results panel SHALL NOT show

#### Scenario: Network error during mux

- GIVEN the backend becomes unreachable after mux starts
- WHEN progress polling fails
- THEN the progress display SHALL show "Connection lost — task may still be running"

#### Scenario: Invalid file format error

- GIVEN the probe returns "Invalid format" for a selected file
- WHEN the error is received
- THEN the error message SHALL be displayed near the corresponding file selector
- AND the user SHALL be able to change the file and retry

### Requirement: FR-020 — Loading States

The system SHALL provide visual feedback during all async operations.

#### Scenario: Analyze loading state

- WHEN the probe request is in flight
- THEN a spinner SHALL appear in the analyze button
- AND the button SHALL be disabled
- AND file selectors SHALL be disabled

#### Scenario: Mix loading state

- WHEN the mux request is being submitted
- THEN a spinner SHALL appear in the mix button
- AND the button SHALL be disabled
- AND track selection checkboxes SHALL be disabled

## Component Hierarchy

```
MediaMixer (page component)
├── FileSelectorGroup
│   ├── FileSelector (file A)
│   └── FileSelector (file B)
├── AnalyzeButton
├── ProbeResults (conditional, after successful probe)
│   ├── FileMetadataCard (file A)
│   │   ├── VideoTrackList
│   │   │   └── VideoTrack (auto-selected highlighted)
│   │   └── AudioTrackList
│   │       └── AudioTrackRow (with checkbox)
│   ├── FileMetadataCard (file B)
│   │   ├── VideoTrackList
│   │   │   └── VideoTrack (auto-selected highlighted)
│   │   └── AudioTrackList
│   │       └── AudioTrackRow (with checkbox)
│   └── CompatibilityWarnings (conditional)
├── MixSection (conditional, after probe)
│   ├── SelectedTracksSummary
│   ├── MixButton
│   └── MuxProgress (conditional, after mix start)
│       ├── ProgressBar
│       ├── CancelButton
│       └── OutputPath (conditional, after completion)
└── ErrorDisplay (conditional)
```

## User Interactions

1. **Navigate** → Click "Media Mixer" in sidebar → Page loads with empty file selectors
2. **Select files** → Use file browser inputs → Two file paths populated → "Analyze" enables
3. **Analyze** → Click "Analyze" → Loading spinner → Results panel appears
4. **Review results** → See video tracks (auto-selected), audio tracks (checkboxes), warnings
5. **Select audio** → Check desired audio tracks → "Mix" enables when ≥1 selected
6. **Mix** → Click "Mix" → Progress bar appears → Polls for updates
7. **Monitor** → Watch progress bar fill → Cancel available
8. **Complete** → Success message + output path displayed
9. **Retry** → Change selections and repeat from step 2 or 6

## Integration Points

### Settings Integration

The settings page SHALL include a new field for `paths.output_mixed` under the Paths section, following the same pattern as existing `download_amule` and `download_torrent` fields.

#### Scenario: Settings page shows output_mixed field

- GIVEN the user navigates to Settings
- WHEN the Paths section renders
- THEN a field for "Mixed Output Folder" SHALL be displayed
- AND it SHALL show the current value of `paths.output_mixed`
- AND the user SHALL be able to edit and save it

### Settings Schema Addition

The `DEFAULTS` dict in `settings.py` SHALL be extended:

```python
"paths": {
    "download_amule": "/mnt/storage-6tb/shared-downloads/amule",
    "download_torrent": "/mnt/storage/downloads/qbittorrent/completed",
    "allowed_roots": ["/mnt/storage", "/mnt/storage-6tb"],
    "output_mixed": "/mnt/storage/mixed",
}
```

The `_env_to_settings` mapping SHALL include:

```python
"FOLDER_OUTPUT_MIXED": ("paths", "output_mixed"),
```

### Sidebar Integration

The `Page` type in `Sidebar.tsx` SHALL be extended to include `'mixer'`, and `PAGE_PATHS` SHALL include `mixer: '/mixer'`.

### App.tsx Integration

The `App.tsx` router SHALL add a condition for `page === 'mixer'` rendering `<MediaMixer />`.

### Dockerfile Integration

The Dockerfile SHALL install ffmpeg in the runtime stage:

```dockerfile
RUN apt-get update && apt-get install -y --no-install-recommends ffmpeg && rm -rf /var/lib/apt/lists/*
```

## Accessibility

- All interactive elements SHALL be keyboard-navigable
- Checkboxes SHALL have visible labels (track info serves as label)
- Progress bar SHALL use `role="progressbar"` with `aria-valuenow` and `aria-valuemax`
- Error messages SHALL use `role="alert"` for screen reader announcement

## Responsive Behavior

- File selectors SHALL stack vertically on narrow viewports (< 768px)
- Track lists SHALL remain scrollable if tracks overflow the viewport
- Progress bar SHALL maintain full width at all viewport sizes
