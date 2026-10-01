import { test, expect, login } from '../fixtures/app';

/**
 * Faltantes against the STUB-backed install (phase 2: + docker-compose.e2e.yml).
 *
 * dashboard-bare.spec.ts pins the honest empty/error state of a bare install;
 * this spec is the mirror image: with fake-arr serving payloads captured from
 * a real Radarr, the listing must render rows from those payloads and the
 * honest states must be gone. One test, because "--list" is expected to show
 * five specs total.
 *
 * Rules: role/accessible-name selectors; text selectors only where the markup
 * carries no ARIA role (justified inline, as in dashboard-bare.spec.ts);
 * web-first assertions with { timeout: 15000 } — the app polls at 2–15 s and
 * React Query retries twice, so an instant assertion would race the data.
 */

test('the stub listing renders rows and the Todas tab is reachable', async ({ app }) => {
  await login(app, 'test-key');

  // The nav link only exists when an arr is configured (App.tsx hiddenPages);
  // its name comes from Sidebar.tsx:27 — icon span + label "Faltantes".
  await app.getByRole('link', { name: /Faltantes/ }).click();

  // Page heading — MissingContent.tsx:535, <h2>Contenido Faltante</h2>.
  await expect(app.getByRole('heading', { name: 'Contenido Faltante' })).toBeVisible({ timeout: 15000 });

  // The count is the stub's totalRecords (wanted-missing.json → 1) —
  // MissingContent.tsx:566, button "Faltantes ({radarrWantedTotal})".
  await expect(app.getByRole('button', { name: 'Faltantes (1)' })).toBeVisible({ timeout: 15000 });

  // The card's title is stub data. The title sits in a plain div with no ARIA
  // role (MissingContent.tsx:606), so no role selector can reach it without
  // changing production markup — text selector, as in dashboard-bare.spec.ts.
  // exact matches only the title div: ancestors carry the overview/actions too.
  await expect(app.getByText('Your Name. (2016)', { exact: true })).toBeVisible({ timeout: 15000 });

  // The card's own actions, one button per rendered row —
  // MissingContent.tsx:631, button "🔍 Buscar".
  await expect(app.getByRole('button', { name: '🔍 Buscar' })).toBeVisible({ timeout: 15000 });
  await expect(app.getByRole('button', { name: '📁 En carpeta' })).toBeVisible({ timeout: 15000 });

  // NOT the honest failure state — MissingContent.tsx:650, role=alert
  // "No se pudo consultar Radarr". The rows above already proved presence;
  // this pins that the two are mutually exclusive branches.
  await expect(
    app.getByRole('alert').filter({ hasText: 'No se pudo consultar Radarr' }),
  ).toHaveCount(0);
  // NOT the honest empty state — MissingContent.tsx:655,
  // div "No hay películas faltantes" (no role → text).
  await expect(app.getByText('No hay películas faltantes')).toHaveCount(0);

  // "Todas" — MissingContent.tsx:572, button "Todas ({radarrAllTotal || '...'})".
  // The catalog query is disabled until this click, so the button reads
  // "Todas (...)" right up to it.
  await app.getByRole('button', { name: /^Todas/ }).click();

  // After the click the query runs and the button carries the stub's catalog
  // size (movies.json → 2): role+name proves /api/v3/movie answered.
  await expect(app.getByRole('button', { name: 'Todas (2)' })).toBeVisible({ timeout: 15000 });

  // Both stub movies are missing their file, so both render the badge —
  // MissingContent.tsx:680, span "✗ Sin archivo" (no role → text; the count
  // pins the number of rendered rows).
  await expect(app.getByText('✗ Sin archivo')).toHaveCount(2);
  // Not the catalog's honest empty state — MissingContent.tsx:731.
  await expect(app.getByText('No hay películas en el catálogo')).toHaveCount(0);
});
