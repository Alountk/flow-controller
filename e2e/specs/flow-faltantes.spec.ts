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
 * PR 7 of F-08 retired the Faltantes page into the Películas sub-views, and
 * the «Películas» page is deprecated in turn: «Películas V2» — the catalogue
 * with class chips — is the single source of truth. The missing content is
 * the «Sin archivo» chip filter now (same choice the Faltantes/Biblioteca
 * tabs were), and the wanted/missing listing the old spec drove is gone
 * with V1 — see the count notes below.
 *
 * Rules: role/accessible-name selectors; text selectors only where the markup
 * carries no ARIA role (justified inline, as in dashboard-bare.spec.ts);
 * web-first assertions with { timeout: 15000 } — the app polls at 2–15 s and
 * React Query retries twice, so an instant assertion would race the data.
 */

test('the stub listing renders rows and the catalogue filter is reachable', async ({ app }) => {
  await login(app);

  // The nav link only exists when an arr is configured (App.tsx hiddenPages);
  // its label comes from Sidebar.tsx NAV_ITEMS — "Películas V2", the
  // arr-dependent entry point that is now the only movies page.
  await app.getByRole('link', { name: /Películas V2/ }).click();

  // Route proof: the Topbar's page title (App.tsx PAGE_TITLES) is the h1.
  await expect(app.getByRole('heading', { level: 1, name: 'Películas V2' })).toBeVisible({ timeout: 15000 });
  // The list's own head — PeliculasV2List.tsx, <h2 class="sec-l2-title">.
  await expect(app.getByRole('heading', { level: 2, name: 'Películas' })).toBeVisible({ timeout: 15000 });
  // Design-03 shell: the service chips ride this topbar too.
  await expect(app.locator('.service-chips')).toBeVisible();

  // The list opens on «Todas»; the missing content is the «Sin archivo»
  // filter — the V2's Faltantes. The chips carry the stub's catalogue
  // counts (movies.json → 2 movies, both without file): the counts the
  // sub-view tabs never had.
  const classFilters = app.getByRole('group', { name: 'Filtrar por clase' });
  await expect(classFilters.getByRole('button', { name: 'Todas 2' })).toBeVisible({ timeout: 15000 });
  await expect(classFilters.getByRole('button', { name: 'Sin archivo 2' })).toBeVisible({ timeout: 15000 });
  await classFilters.getByRole('button', { name: /^Sin archivo/ }).click();

  // The missing list is the one showing: the chip is the one on duty, which
  // peliculasV2.test.tsx pins alongside the row assertions here (aria-pressed
  // is the chip's own state — no class scraping).
  await expect(classFilters.getByRole('button', { name: /^Sin archivo/ })).toHaveAttribute(
    'aria-pressed',
    'true',
    { timeout: 15000 },
  );

  // Both stub movies are missing their file, so both rows carry the badge —
  // PeliculasV2List.tsx, span.sec-class-badge.is-missing "Sin archivo" (the
  // pill the old page wore). No ARIA role → class-scoped text; the chip label
  // above shares the words, so the count is scoped to the rows. This is also
  // the stub's row count: wanted-missing.json's «Falta» total (1) has no V2
  // surface any more — the class chip is the honest successor.
  await expect(app.locator('.sec-movie-row .sec-class-badge.is-missing')).toHaveCount(2, { timeout: 15000 });

  // The rows' titles are stub data. V2 splits the row into a title span and a
  // "year · quality" line (span.sec-movie-title / span.sec-movie-sub, no ARIA
  // role → text), so name and year are asserted apart as before.
  await expect(app.getByText('Your Name.', { exact: true })).toBeVisible({ timeout: 15000 });
  await expect(app.getByText('Wanted Movie', { exact: true })).toBeVisible({ timeout: 15000 });
  // The year shares its line with quality in V2 ("2016 · —"), so the V1
  // exact-text year match cannot survive — scoped to the row's own sub line.
  await expect(
    app.getByRole('list', { name: 'Películas' }).getByRole('listitem').filter({ hasText: 'Your Name.' }).locator('.sec-movie-sub'),
  ).toContainText('2016', { timeout: 15000 });

  // The row's own action, one per rendered row — the chevron opens the detail
  // (PeliculasV2List.tsx, aria-label "Abrir <título>").
  await expect(app.getByRole('button', { name: 'Abrir Your Name.' })).toBeVisible({ timeout: 15000 });

  // The row's other actions moved into the quick-actions menu, which serves
  // the selection (V1's row buttons «🔍 Buscar» / «📁 En carpeta» became
  // «Buscar releases» / «Escanear carpeta» — the same ScanModal). The row
  // selects first, so the menu provably acts on THIS row.
  await app.getByRole('list', { name: 'Películas' }).getByRole('listitem').filter({ hasText: 'Your Name.' }).click();
  await expect(app.getByText('Seleccionado', { exact: true })).toBeVisible({ timeout: 15000 });
  await app.getByRole('button', { name: /Acciones rápidas/ }).click();
  const menu = app.getByRole('menu', { name: 'Acciones rápidas' });
  await expect(menu.getByRole('menuitem', { name: 'Ver detalle' })).toBeVisible({ timeout: 15000 });
  await expect(menu.getByRole('menuitem', { name: 'Buscar releases' })).toBeVisible({ timeout: 15000 });
  await expect(menu.getByRole('menuitem', { name: 'Escanear carpeta' })).toBeVisible({ timeout: 15000 });
  await app.keyboard.press('Escape');

  // NOT the honest failure state — PeliculasV2List.tsx emptyMessage() error
  // branch, "No se pudo leer el catálogo de Radarr" (no role → text). The rows
  // above already proved presence; this pins that the two are mutually
  // exclusive branches.
  await expect(app.getByText('No se pudo leer el catálogo de Radarr.')).toHaveCount(0);
  // NOT the honest empty state — PeliculasV2List.tsx emptyMessage(),
  // "No hay películas en el catálogo" (no role → text).
  await expect(app.getByText('No hay películas en el catálogo')).toHaveCount(0);
  // NOT the filter's own empty state — the «Sin archivo» filter rendered rows,
  // so "Ninguna película en Sin archivo." (the old page's «No hay películas
  // faltantes» successor) must be gone.
  await expect(app.getByText('Ninguna película en Sin archivo.')).toHaveCount(0);

  // "Todas" is the Biblioteca sub-view's successor — the whole catalogue,
  // fed by GET /api/wanted/all (movies.json → 2). One click back.
  await classFilters.getByRole('button', { name: /^Todas/ }).click();
  await expect(classFilters.getByRole('button', { name: /^Todas/ })).toHaveAttribute(
    'aria-pressed',
    'true',
    { timeout: 15000 },
  );

  // Both stub movies are still missing their file in the catalogue, so both
  // rows keep the badge (same count contract as above).
  await expect(app.locator('.sec-movie-row .sec-class-badge.is-missing')).toHaveCount(2, { timeout: 15000 });
  // Not the catalog's honest empty state.
  await expect(app.getByText('No hay películas en el catálogo')).toHaveCount(0);
});
