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
 * PR 7 of F-08 retired the Faltantes page: the flow now lives in the
 * Películas section's Faltantes/Biblioteca sub-views. The nav link and the
 * "Contenido Faltante" heading went with the page; the sub-view tabs are the
 * filter the page's Faltantes/Todas buttons used to be.
 *
 * Rules: role/accessible-name selectors; text selectors only where the markup
 * carries no ARIA role (justified inline, as in dashboard-bare.spec.ts);
 * web-first assertions with { timeout: 15000 } — the app polls at 2–15 s and
 * React Query retries twice, so an instant assertion would race the data.
 */

test('the stub listing renders rows and the Biblioteca sub-view is reachable', async ({ app }) => {
  await login(app, 'test-key');

  // The nav link only exists when an arr is configured (App.tsx hiddenPages);
  // its label comes from Sidebar.tsx NAV_ITEMS — "Películas", the
  // arr-dependent entry point that replaced the Faltantes page link.
  await app.getByRole('link', { name: /Películas/ }).click();

  // Section heading — Peliculas.tsx, <h2>Películas</h2>. The Topbar's page
  // title is a span, so this is the only heading that matches.
  await expect(app.getByRole('heading', { name: 'Películas' })).toBeVisible({ timeout: 15000 });

  // The section opens on Biblioteca; the missing list is the Faltantes
  // sub-view — the old page's default tab, now one click away.
  await app.getByRole('tab', { name: 'Faltantes' }).click();

  // The missing list is the one showing: aria-selected on its tab
  // (Sections.test.tsx proves the attribute). The sub-view tabs carry no
  // counts — the tab IS the filter — so this plus the rows below replace the
  // page's button "Faltantes (1)".
  await expect(app.getByRole('tab', { name: 'Faltantes' })).toHaveAttribute(
    'aria-selected',
    'true',
    { timeout: 15000 },
  );

  // Exactly the stub's missing total (wanted-missing.json → 1): one row,
  // each carrying the missing pill — MediaPane.tsx faltaStatus, span "Falta".
  // No ARIA role on the pill → text selector; exact so the tab "Faltantes"
  // and the panel's own "Falta" metadata cannot dilute the count.
  await expect(app.getByText('Falta', { exact: true })).toHaveCount(1, { timeout: 15000 });

  // The card's title is stub data. The section row splits the page's
  // "title (year)" line into two spans (span.sec-row-name + span.sec-row-year,
  // no ARIA role → text, as before), so name and year are asserted apart —
  // together they carry the same information the old exact match did.
  await expect(app.getByText('Your Name.', { exact: true })).toBeVisible({ timeout: 15000 });
  await expect(app.getByText('2016', { exact: true })).toBeVisible({ timeout: 15000 });

  // The card's own actions, one button per rendered row — the section rows
  // keep every action the page's cards had (MediaPane.tsx:935/941).
  await expect(app.getByRole('button', { name: '🔍 Buscar' })).toBeVisible({ timeout: 15000 });
  await expect(app.getByRole('button', { name: '📁 En carpeta' })).toBeVisible({ timeout: 15000 });

  // NOT the honest failure state — MediaPane.tsx:1008, role=alert
  // "No se pudo consultar Radarr". The rows above already proved presence;
  // this pins that the two are mutually exclusive branches.
  await expect(
    app.getByRole('alert').filter({ hasText: 'No se pudo consultar Radarr' }),
  ).toHaveCount(0);
  // NOT the honest empty state — MediaPane.tsx:1013,
  // div "No hay películas faltantes" (no role → text).
  await expect(app.getByText('No hay películas faltantes')).toHaveCount(0);

  // "Todas" became the Biblioteca sub-view — the section's default list,
  // fed by GET /api/wanted/all (movies.json → 2).
  await app.getByRole('tab', { name: 'Biblioteca' }).click();
  await expect(app.getByRole('tab', { name: 'Biblioteca' })).toHaveAttribute(
    'aria-selected',
    'true',
    { timeout: 15000 },
  );

  // Both stub movies are missing their file, so both rows carry the pill —
  // MediaPane.tsx:618, span.sec-pill "Sin archivo" (the page's "✗ Sin
  // archivo" badge became the pill; no role → text, exact so only pills are
  // counted — the count pins the number of rendered rows).
  await expect(app.getByText('Sin archivo', { exact: true })).toHaveCount(2, { timeout: 15000 });
  // Not the catalog's honest empty state — MediaPane.tsx:1219.
  await expect(app.getByText('No hay películas en el catálogo')).toHaveCount(0);
});
