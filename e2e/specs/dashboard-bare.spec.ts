import { test, expect, login } from '../fixtures/app';

/**
 * A bare/CI install: API_KEY set, no arr services configured.
 *
 * Mirrors the flow of frontend/src/__tests__/configuredServices.test.tsx:
 * wait for PRESENCE first (the empty state only renders once /api/services
 * has answered), then assert what the gating has removed. Asserting absence
 * while the app is still loading would prove nothing.
 */

test('shows the honest empty state and gates the arr-dependent pages', async ({ app }) => {
  await login(app, 'test-key');

  // Dashboard rendered (config loaded, key accepted).
  await expect(app.getByRole('heading', { name: 'Resumen del sistema' })).toBeVisible();

  // /api/services answered "nothing configured" — the same answer that
  // gates the nav. Presence first, so the absence check below is meaningful.
  await expect(
    app.getByRole('alert').filter({ hasText: 'No hay ningún servicio configurado' }),
  ).toBeVisible();

  // Gating: Películas needs an arr service and must be gone; the local
  // pages must stay. (Since PR 7 this re-pointed assertion carries real
  // meaning again: the old /Faltantes/ link never exists in any install,
  // so its absence would prove nothing.)
  await expect(app.getByRole('link', { name: /Películas/ })).toHaveCount(0);
  await expect(app.getByRole('link', { name: /Disco/ })).toBeVisible();
  await expect(app.getByRole('link', { name: /Configuración/ })).toBeVisible();

  // Queue sidebar: honest empties, no fake activity.
  // These two strings sit in plain divs with no ARIA role, so no role
  // selector can reach them without changing production markup.
  await expect(app.getByText('Sin operaciones', { exact: true })).toBeVisible();
  await expect(app.getByText('Sin descargas', { exact: true })).toBeVisible();
});
