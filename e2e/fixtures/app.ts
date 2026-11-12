import { test as base, expect, type APIRequestContext, type Page } from '@playwright/test';

export { expect };

/**
 * Fresh browser context per test.
 *
 * The login session is an HttpOnly cookie, so a session opened by one test must
 * never be visible to the next. Playwright already creates a new context per
 * test; this fixture makes that the explicit contract of the suite and gives
 * every spec the same entry point (a bare `goto('/')`, no session).
 */
export const test = base.extend<{ app: Page }>({
  app: async ({ page }, use) => {
    // The lamp this suite was missing. A React tree that throws renders
    // whatever ErrorBoundary shows and NOTHING reaches the server — so the
    // container log looks healthy and the spec times out on a heading. These
    // lines are the only place that failure can say anything.
    const noise: string[] = [];
    page.on('console', (msg) => {
      if (msg.type() === 'error' || msg.type() === 'warning') {
        noise.push(`[console.${msg.type()}] ${msg.text()}`);
      }
    });
    page.on('pageerror', (err) => noise.push(`[pageerror] ${err.message}\n${err.stack ?? ''}`));
    page.on('requestfailed', (req) =>
      noise.push(`[requestfailed] ${req.method()} ${req.url()} — ${req.failure()?.errorText}`),
    );
    await use(page);
    if (noise.length) {
      // Printed, never thrown: this is a lamp, not a gate.
      console.log('\n===== browser said =====');
      for (const line of noise) console.log('  ' + line);
      console.log('===== /browser said =====\n');
    }
  },
});

/** The administrator every spec signs in as. One instance, one account. */
export const ADMIN = { username: 'admin', password: 'e2e-admin-password' };

/**
 * CI's install was born with `API_KEY=test-key`. That old key is the proof of
 * ownership the very first «Crear administrador» has to present; after that it
 * is only a token for scripts and the UI never asks for it again.
 */
export const LEGACY_API_KEY = 'test-key';

/**
 * Drive the AuthGate: open `/`, fill the account, press the button.
 *
 * The instance outlives the tests, so the FIRST caller creates the
 * administrator and every later one signs in; the helper looks at which form
 * the app shows instead of assuming an order. Leaves the page wherever the
 * click lands — callers assert the outcome.
 */
export async function login(app: Page, password: string = ADMIN.password): Promise<void> {
  await app.goto('/');
  const create = app.getByRole('button', { name: 'Crear administrador' });
  const enter = app.getByRole('button', { name: 'Entrar' });
  await create.or(enter).waitFor();

  await app.getByLabel('Usuario').fill(ADMIN.username);
  await app.getByLabel('Contraseña', { exact: true }).fill(password);
  if (await create.isVisible()) {
    await app.getByLabel('Repite la contraseña').fill(password);
    await app.getByLabel('API key actual').fill(LEGACY_API_KEY);
    await create.click();
  } else {
    await enter.click();
  }
}

/** Make sure the administrator exists, without a browser (for specs about the login form). */
export async function ensureAdmin(request: APIRequestContext): Promise<void> {
  const me = await (await request.get('/api/auth/me')).json();
  if (me.has_user) return;
  const res = await request.post('/api/auth/register', {
    data: ADMIN,
    headers: { 'X-Api-Key': LEGACY_API_KEY },
  });
  expect(res.ok()).toBe(true);
}
