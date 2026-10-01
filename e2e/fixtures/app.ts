import { test as base, expect, type Page } from '@playwright/test';

export { expect };

/**
 * Fresh browser context per test.
 *
 * The API key lives in localStorage (`flow-controller-api-key`, written by
 * `rememberApiKey`), so a key logged in by one test must never be visible to
 * the next. Playwright already creates a new context per test; this fixture
 * makes that the explicit contract of the suite and gives every spec the same
 * entry point (a bare `goto('/')`, no stored key).
 */
export const test = base.extend<{ app: Page }>({
  app: async ({ page }, use) => {
    await use(page);
  },
});

/**
 * Drive the AuthGate: open `/`, type the key, press Entrar.
 *
 * Leaves the page wherever the click lands — callers assert the outcome, so
 * the same helper serves both the happy path and the rejected-key path.
 */
export async function login(app: Page, key: string): Promise<void> {
  await app.goto('/');
  await app.getByLabel('API key').fill(key);
  await app.getByRole('button', { name: 'Entrar' }).click();
}
