import { defineConfig, devices } from '@playwright/test';

/**
 * The tests run against a *running* app instance: CI brings one up with
 * docker compose before invoking this suite, and a local run does the same.
 * There is intentionally no `webServer` block: the app is a single FastAPI
 * process that also serves the built frontend, and a wrong base URL should
 * fail loudly rather than silently start a second server.
 */
export default defineConfig({
  testDir: './specs',
  // One app instance, one worker: every test talks to the same backend
  // (settings.json, queue, trace), so parallel tests would race on server
  // state even though their browser contexts are isolated.
  workers: 1,
  fullyParallel: false,
  // One retry: `on-first-retry` trace/screenshot only fire if there is a
  // retry to fire on, and a first-attempt flake should not fail the suite.
  retries: 1,
  reporter: [['list'], ['html', { open: 'never' }]],
  use: {
    baseURL: 'http://localhost:8000',
    trace: 'on-first-retry',
    // ScreenshotMode has no 'on-first-retry' — 'on-first-failure' is the
    // closest capture-on-problem mode (one shot, not every attempt).
    screenshot: 'on-first-failure',
    video: 'off',
  },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
  outputDir: 'test-results',
});
