import { test, expect, ensureAdmin, login } from '../fixtures/app';

/**
 * The account is the first screen (CI runs with API_KEY=test-key, which now
 * only proves ownership when the administrator is created).
 *
 * Against the real backend instead of a mocked fetch: the first spec of a run
 * creates the administrator through the UI, the rest sign in.
 */

test('the first screen is the account, never an API key prompt', async ({ app }) => {
  await app.goto('/');

  await expect(app.getByLabel('Usuario')).toBeVisible();
  await expect(app.getByLabel('Contraseña', { exact: true })).toBeVisible();
  await expect(app.getByRole('heading', { level: 1, name: 'Dashboard' })).toHaveCount(0);
  // The only place the old key appears is the one-time ownership proof.
  await expect(app.getByLabel('API key', { exact: true })).toHaveCount(0);
});

test('the correct account unlocks the dashboard', async ({ app }) => {
  await login(app);

  await expect(app.getByRole('heading', { level: 1, name: 'Dashboard' })).toBeVisible();
});

test('a wrong password is rejected with an alert', async ({ app, request }) => {
  await ensureAdmin(request);

  await login(app, 'contraseña-incorrecta');

  await expect(app.getByRole('alert')).toContainText('Usuario o contraseña incorrectos');
  // The rejection must not leak through to the app.
  await expect(app.getByRole('heading', { level: 1, name: 'Dashboard' })).toHaveCount(0);
});

test('the session survives a reload', async ({ app }) => {
  await login(app);
  await expect(app.getByRole('heading', { level: 1, name: 'Dashboard' })).toBeVisible();

  await app.reload();

  await expect(app.getByRole('heading', { level: 1, name: 'Dashboard' })).toBeVisible();
  await expect(app.getByLabel('Usuario')).toHaveCount(0);
});

test('the script key still opens the API, but is not how the UI signs in', async ({ request }) => {
  await ensureAdmin(request);

  expect((await request.get('/api/auth/check')).status()).toBe(401);
  expect(
    (await request.get('/api/auth/check', { headers: { 'X-Api-Key': 'test-key' } })).status(),
  ).toBe(200);
});
