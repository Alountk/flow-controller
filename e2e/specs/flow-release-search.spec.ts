import { test, expect, login } from '../fixtures/app';

/**
 * The headline flow from the backlog — Faltantes → buscar release → encolar —
 * against the STUB-backed install (phase 2: + docker-compose.e2e.yml).
 *
 * Row → search inside the detail panel's Releases tab (PR 5 of F-08) →
 * results from fake-arr → select one → Descargar → the grab-batch
 * confirmation. The stub answers POST /api/v3/release with 201, so this
 * proves the UI flow end to end; it does NOT download anything (see
 * e2e/README.md).
 *
 * PR 7 retired the Faltantes page: the wanted card now lives in the
 * Películas section's Faltantes sub-view, and the search opens INLINE in the
 * panel — no backdrop, no Escape. A successful grab then keeps you ON the
 * results, so the panel never lands on the done step at all: only the overlay
 * reaches it (and reads "Cerrar" there). The panel's remaining exit,
 * "Nueva búsqueda", lives on the error step and trades the results for a new
 * indexer round-trip — which is exactly what the assertions below pin as
 * absent after a grab.
 *
 * The operator initiates every search: selecting a row NEVER searches. The
 * panel lands on its own 🔍 Buscar Releases button, THAT press starts the
 * request (and changing the indexer re-runs it), the rows read as the file
 * selector (name · idioma · calidad · size · semillas), and "Acción
 * principal" below the list spells the routing out. The overlay modal keeps
 * its button and its initial step; this spec never leaves the panel to prove
 * the split.
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

  // The movie row keeps the page's own action — MediaPane.tsx,
  // button "🔍 Buscar" (sectionsPanel.test's routing test proves this exact
  // click). In the section it bubbles to the row: the row selects and the
  // Releases tab opens with the panel's OWN "🔍 Buscar Releases" waiting —
  // no modal ever, and no search either (selection never searches). This
  // resolves to ONE button even though Playwright matches role names by
  // substring, because the panel is not open yet: the click below is what
  // opens it.
  await app.getByRole('button', { name: '🔍 Buscar' }).click();

  // Releases is what must be showing now: it is the panel's default tab and
  // every sub-view switch resets it (Peliculas.tsx detailTab), but the detail
  // tabs expose their state only as a class — no aria-selected on a
  // role=group button — so the class is the only honest "active" selector.
  await expect(app.locator('.sec-dtab.is-active')).toHaveText('Releases', { timeout: 15000 });

  // The contract, pinned: the panel's OWN search button is here, waiting —
  // selection did not press it. (The overlay modal elsewhere renders the
  // same button; this spec never leaves the panel to reach it.)
  await expect(app.getByRole('button', { name: /Buscar Releases/ })).toBeVisible();

  // The indexer dropdown carries the stub's list (indexers.json → "Torznab")
  // — ReleaseSearchModal renders {idx.name} as an <option>. It stays as the
  // trigger for a re-search. Count, not visibility: options of a closed
  // <select> are not painted.
  await expect(app.getByRole('option', { name: 'Torznab' })).toHaveCount(1, { timeout: 15000 });

  // The operator presses 🔍 Buscar Releases — THE way a search starts now —
  // and the results below are the proof the press ran. The select-all
  // checkbox's accessible name comes from its wrapping label's count text,
  // "3 releases encontrados" (releases.json has 3).
  await app.getByRole('button', { name: /Buscar Releases/ }).click();
  await expect(app.getByRole('checkbox', { name: '3 releases encontrados' })).toHaveCount(1, { timeout: 15000 });

  // The file selector's first row: the file's name alone on its line —
  // div.release-title (no role → text selector, justified as above).
  await expect(app.getByText('Your.Name.2016.1080p.BluRay.x264-GRP')).toBeVisible({ timeout: 15000 });

  // Acción principal, below the file list: the readout that spells the
  // routing out — its heading, then the first rule. `exact` so only the `li`
  // matches: the rule list's own text is all three rules concatenated, and an
  // `li` has no reliable content-derived accessible name across engines.
  await expect(app.getByRole('heading', { name: 'Acción principal' })).toBeVisible({ timeout: 15000 });
  await expect(
    app.getByText('1080 o menor → biblioteca (la del arr)', { exact: true }),
  ).toBeVisible({ timeout: 15000 });

  // The destination combo offers the stub's root folder (rootfolders.json)
  // — ReleaseSearchModal renders each folder as an <option>.
  await expect(app.getByRole('option', { name: '/mnt/storage/movies' })).toHaveCount(1, { timeout: 15000 });

  // Select ONE release. The row checkbox sits in a label with no text
  // (its label holds no text), so it has no accessible name to query
  // by: within role=checkbox, index 0 is the named select-all asserted above
  // and index 1 is the first release row.
  await app.getByRole('checkbox').nth(1).check();

  // The batch grab button only appears with a selection — button
  // "⬇️ Descargar (1)".
  const grabButton = app.getByRole('button', { name: /Descargar \(1\)/ });
  await expect(grabButton).toBeVisible({ timeout: 15000 });
  await grabButton.click();

  // Success feedback. grab-batch answers detail "1 descargados"
  // (backend/routes/calendar.py:370) and the panel now surfaces it as a
  // notice ABOVE the list — plain div, no role → text — instead of trading
  // that list for a done step.
  await expect(app.getByText('1 descargados')).toBeVisible({ timeout: 15000 });
  // The list SURVIVED the grab: the row that could be grabbed NEXT is still
  // on screen, because a successful grab in the panel stays on the results
  // step — that is the complaint this changed ("puse uno a descargar y no me
  // deja coger otro"). Same locator as the pre-grab assertion above, so it
  // resolves to the same single row.
  await expect(app.getByText('Your.Name.2016.1080p.BluRay.x264-GRP')).toBeVisible({ timeout: 15000 });
  // And the exit that used to trade this list for a fresh indexer round-trip
  // ("Nueva búsqueda" drops the panel cache and re-searches) is gone —
  // toHaveCount(0) pins that absence as the post-grab contract.
  await expect(app.getByRole('button', { name: 'Nueva búsqueda' })).toHaveCount(0);
});
