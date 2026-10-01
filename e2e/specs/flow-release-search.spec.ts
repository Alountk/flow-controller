import { test, expect, login } from '../fixtures/app';

/**
 * The headline flow from the backlog — Faltantes → buscar release → encolar —
 * against the STUB-backed install (phase 2: + docker-compose.e2e.yml).
 *
 * Card → release-search modal → Buscar Releases → results from fake-arr →
 * select one → Descargar → the grab-batch confirmation. The stub answers
 * POST /api/v3/release with 201, so this proves the UI flow end to end; it
 * does NOT download anything (see e2e/README.md).
 *
 * Same rules as flow-faltantes: role/accessible-name selectors, text only
 * where markup has no role (justified inline), web-first assertions with
 * { timeout: 15000 } because the app polls at 2–15 s and React Query
 * retries twice.
 */

test('a wanted card searches releases and grabs one end to end', async ({ app }) => {
  await login(app, 'test-key');

  // Nav link (Sidebar.tsx:27, icon + label "Faltantes"), then the page
  // heading (MissingContent.tsx:535).
  await app.getByRole('link', { name: /Faltantes/ }).click();
  await expect(app.getByRole('heading', { name: 'Contenido Faltante' })).toBeVisible({ timeout: 15000 });

  // Open the release-search modal from the card — MissingContent.tsx:631,
  // button "🔍 Buscar" (one card in the stub's missing list, so one match).
  await app.getByRole('button', { name: '🔍 Buscar' }).click();

  // Modal's search action — ReleaseSearchModal.tsx:390,
  // button "🔍 Buscar Releases".
  const searchButton = app.getByRole('button', { name: /Buscar Releases/ });
  await expect(searchButton).toBeVisible({ timeout: 15000 });

  // The indexer dropdown carries the stub's list (indexers.json → "Torznab")
  // — ReleaseSearchModal.tsx:330 renders {idx.name} as an <option>. Count,
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
  // beside the done-step close button, ReleaseSearchModal.tsx:598-599.
  await expect(app.getByText('1 descargados')).toBeVisible({ timeout: 15000 });
  await expect(app.getByRole('button', { name: 'Cerrar' })).toBeVisible({ timeout: 15000 });
});
