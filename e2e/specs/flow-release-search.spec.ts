import { test, expect, login } from '../fixtures/app';

/**
 * The headline flow from the backlog — Faltantes → buscar release → encolar —
 * against the STUB-backed install (phase 2: + docker-compose.e2e.yml).
 *
 * Row → search inside the detail panel's Releases tab (PR 5 of F-08) →
 * Buscar Releases → results from fake-arr → select one → Descargar → the
 * grab-batch confirmation. The stub answers POST /api/v3/release with 201,
 * so this proves the UI flow end to end; it does NOT download anything (see
 * e2e/README.md).
 *
 * PR 7 retired the Faltantes page: the wanted card now lives in the
 * Películas section's Faltantes sub-view, and the search opens INLINE in the
 * panel — no backdrop, no Escape, and the done step's exit reads
 * "Nueva búsqueda" instead of the overlay's "Cerrar".
 *
 * Same rules as flow-faltantes: role/accessible-name selectors, text only
 * where markup has no role (justified inline), web-first assertions with
 * { timeout: 15000 } because the app polls at 2–15 s and React Query
 * retries twice.
 */

test('a wanted card searches releases and grabs one end to end', async ({ app }) => {
  await login(app, 'test-key');

  // Nav link (Sidebar.tsx NAV_ITEMS, label "Películas"), then the section
  // heading (Peliculas.tsx, <h2>Películas</h2>).
  await app.getByRole('link', { name: /Películas/ }).click();
  await expect(app.getByRole('heading', { name: 'Películas' })).toBeVisible({ timeout: 15000 });

  // The wanted card lives in the Faltantes sub-view: the old page opened on
  // its missing tab, the section opens on Biblioteca — one click restores
  // the starting point this spec has always used.
  await app.getByRole('tab', { name: 'Faltantes' }).click();

  // The movie row keeps the page's own action — MediaPane.tsx:935,
  // button "🔍 Buscar" (sectionsPanel.test's routing test proves this exact
  // click). In the section it bubbles to the row: the row selects and the
  // search opens inside the panel's Releases tab — no modal ever.
  // Playwright matches role names by substring: this resolves to ONE button
  // because the panel's "🔍 Buscar Releases" does not exist until this click
  // selects the row. Never re-query it after the click.
  await app.getByRole('button', { name: '🔍 Buscar' }).click();

  // Releases is what must be showing now: it is the panel's default tab and
  // every sub-view switch resets it (Peliculas.tsx detailTab), but the detail
  // tabs expose their state only as a class — no aria-selected on a
  // role=group button — so the class is the only honest "active" selector.
  await expect(app.locator('.sec-dtab.is-active')).toHaveText('Releases', { timeout: 15000 });

  // The panel's search action — the SAME body the overlay modal renders,
  // ReleaseSearchModal.tsx:496, button "🔍 Buscar Releases".
  const searchButton = app.getByRole('button', { name: /Buscar Releases/ });
  await expect(searchButton).toBeVisible({ timeout: 15000 });

  // The indexer dropdown carries the stub's list (indexers.json → "Torznab")
  // — ReleaseSearchModal.tsx:435 renders {idx.name} as an <option>. Count,
  // not visibility: options of a closed <select> are not painted.
  await expect(app.getByRole('option', { name: 'Torznab' })).toHaveCount(1, { timeout: 15000 });

  await searchButton.click();

  // Results appeared. The select-all checkbox's accessible name comes from
  // its wrapping label's count text — ReleaseSearchModal.tsx:436-447,
  // "3 releases encontrados" (releases.json has 3).
  await expect(app.getByRole('checkbox', { name: '3 releases encontrados' })).toHaveCount(1, { timeout: 15000 });

  // The release title itself — ReleaseSearchModal.tsx:574, div.release-title
  // (no role → text selector, justified as above).
  await expect(app.getByText('Your.Name.2016.1080p.BluRay.x264-GRP')).toBeVisible({ timeout: 15000 });

  // The destination combo offers the stub's root folder (rootfolders.json)
  // — ReleaseSearchModal.tsx:473 renders each folder as an <option>.
  await expect(app.getByRole('option', { name: '/mnt/storage/movies' })).toHaveCount(1, { timeout: 15000 });

  // Select ONE release. The row checkbox sits in a label with no text
  // (ReleaseSearchModal.tsx:566-572), so it has no accessible name to query
  // by: within role=checkbox, index 0 is the named select-all asserted above
  // and index 1 is the first release row.
  await app.getByRole('checkbox').nth(1).check();

  // The batch grab button only appears with a selection —
  // ReleaseSearchModal.tsx:451-452, button "⬇️ Descargar (1)".
  const grabButton = app.getByRole('button', { name: /Descargar \(1\)/ });
  await expect(grabButton).toBeVisible({ timeout: 15000 });
  await grabButton.click();

  // Success feedback. grab-batch answers detail "1 descargados"
  // (backend/routes/calendar.py:370) and the done step renders it in the
  // status block — ReleaseSearchModal.tsx:360, plain div (no role → text) —
  // beside the done-step exit button, ReleaseSearchModal.tsx:722-723.
  await expect(app.getByText('1 descargados')).toBeVisible({ timeout: 15000 });
  // In panel presentation the exit reads "Nueva búsqueda": the panel is not
  // a dialog, so its dismiss restarts the search — "Cerrar" is overlay-only
  // (ReleaseSearchModal.tsx:390, dismissLabel).
  await expect(app.getByRole('button', { name: 'Nueva búsqueda' })).toBeVisible({ timeout: 15000 });
});
