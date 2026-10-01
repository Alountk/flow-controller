import { test, expect, login } from '../fixtures/app';

/**
 * The AuthGate on a keyed install (CI runs with API_KEY=test-key).
 *
 * Mirrors the flow of frontend/src/__tests__/authGate.test.tsx, but against
 * the real backend instead of a mocked fetch: fill the key, press Entrar,
 * land on the dashboard — or, for a wrong key, get the alert and go nowhere.
 */

test('a correct key unlocks the dashboard', async ({ app }) => {
  await login(app, 'test-key');

  await expect(app.getByRole('heading', { name: 'Resumen del sistema' })).toBeVisible();
});

test('a wrong key is rejected with an alert', async ({ app }) => {
  await login(app, 'clave-incorrecta');

  await expect(app.getByRole('alert')).toContainText('API key incorrecta');
  // The rejection must not leak through to the app.
  await expect(app.getByRole('heading', { name: 'Resumen del sistema' })).toHaveCount(0);
});
