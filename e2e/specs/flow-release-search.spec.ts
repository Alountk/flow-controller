import { test, expect, login } from '../fixtures/app';

/**
 * The headline flow from the backlog — missing title → buscar release →
 * encolar — against the STUB-backed install (phase 2: + docker-compose.e2e.yml).
 *
 * Row → search inside the detail panel's Releases tab (PR 5 of F-08) →
 * results from OUR sources (S1: the app's Torznab registry, seeded in Phase 2
 * against fake-arr's /torznab/api — Radarr is not a search source anymore) →
 * press the row's "→ 1080" destination button → the single grab, which
 * dispatches the row's link to the qBittorrent Web API fake-arr now also
 * serves (S2). The stub adds no torrent, so this proves the UI flow end to
 * end; it does NOT download anything (see e2e/README.md).
 *
 * PR 7 retired the Faltantes page and the «Películas» page is deprecated in
 * turn: «Películas V2» is the single source of truth. The wanted row lives in
 * the catalogue's «Sin archivo» filter, the row's chevron opens the fullscreen
 * detail, and the search opens INLINE in the detail's Releases tab — no
 * backdrop, no Escape. A successful grab then keeps you ON the results, so
 * the panel never lands on the done step at all: only the overlay modal (the
 * list's «Acciones rápidas» → «Buscar releases») reaches it and reads "Cerrar"
 * there. The panel's remaining exit, "Nueva búsqueda", lives on the error step
 * and trades the results for a new indexer round-trip — which is exactly what
 * the assertions below pin as absent after a grab.
 *
 * The operator initiates every search: selecting a row NEVER searches. The
 * detail lands on its own 🔍 Buscar Releases button, THAT press starts the
 * request (and toggling a site re-runs it), the rows read as the file
 * selector (name · size · semillas — S5: chips only for fields the source
 * really states, never invented quality/language) and carry their three
 * destination buttons (→ 1080 / → 4K / → 3D) — the press on one of them
 * is what grabs. This spec never leaves the panel to prove the split.
 *
 * Same rules as flow-faltantes: role/accessible-name selectors, text only
 * where markup has no role (justified inline), web-first assertions with
 * { timeout: 15000 } because the app polls at 2–15 s and React Query
 * retries twice.
 */

test('a wanted row searches releases and grabs one end to end', async ({ app }) => {
  await login(app, 'test-key');

  // Nav link (Sidebar.tsx NAV_ITEMS, label "Películas V2"), then the Topbar's
  // page title as the route proof (App.tsx PAGE_TITLES).
  await app.getByRole('link', { name: /Películas V2/ }).click();
  await expect(app.getByRole('heading', { level: 1, name: 'Películas V2' })).toBeVisible({ timeout: 15000 });

  // The wanted row lives under the missing filter: the catalogue opens on
  // «Todas», one click on «Sin archivo» restores the starting point this spec
  // has always used (the old Faltantes sub-view's successor).
  await app.getByRole('group', { name: 'Filtrar por clase' }).getByRole('button', { name: /^Sin archivo/ }).click();

  // The movie row's own action is the chevron — PeliculasV2List.tsx,
  // button[aria-label="Abrir Your Name."] (the V1 row's «🔍 Buscar» became
  // this: only the chevron opens, the row body just selects). The click opens
  // the detail on its Releases tab with the panel's OWN "🔍 Buscar Releases"
  // waiting — no search either (selection never searches).
  await app.getByRole('button', { name: 'Abrir Your Name.' }).click();

  // Releases is what must be showing now: it is the detail's default tab
  // (Peliculas.tsx detailTab) and every open resets to it, but the detail
  // tabs expose their state only as a class — no aria-selected on a
  // role=group button — so the class is the only honest "active" selector.
  await expect(app.locator('.sec-dtab.is-active')).toHaveText('Releases', { timeout: 15000 });

  // The contract, pinned: the panel's OWN search button is here, waiting —
  // selection did not press it. (The overlay modal elsewhere renders the
  // same button; this spec never leaves the panel to reach it.)
  await expect(app.getByRole('button', { name: /Buscar Releases/ })).toBeVisible();

  // The operator presses 🔍 Buscar Releases — THE way a search starts now —
  // and the results below are the proof the press ran. The select-all
  // checkbox's accessible name comes from its wrapping label's count text,
  // "3 releases encontrados" (the stub's Torznab feed answers with 3).
  await app.getByRole('button', { name: /Buscar Releases/ }).click();
  await expect(app.getByText('3 releases encontrados')).toBeVisible({ timeout: 15000 });

  // The site checkboxes replace the indexer dropdown: the block lists the
  // seeded registry row "Torznab" alongside aMule and Prowlarr, all checked —
  // the selection that rides the NEXT search's POST (a toggle re-runs it).
  // Scope the box by class: the block carries no role or aria-label, and the
  // results' select-all checkbox is legitimately elsewhere in the page.
  await expect(app.getByText('Sitios de búsqueda:')).toBeVisible({ timeout: 15000 });
  await expect(
    app.locator('.calendar-sites').getByRole('checkbox', { name: 'Torznab' }),
  ).toBeChecked({ timeout: 15000 });

  // The file selector's first row: the file's name alone on its line —
  // div.release-title (no role → text selector, justified as above).
  await expect(app.getByText('Your.Name.2016.1080p.BluRay.x264-GRP')).toBeVisible({ timeout: 15000 });

  // The destination buttons are the row's action now (F-12): the arr library
  // — labelled «1080» since «buscador-tabla» S2 — is always offered, the
  // folders the deployment has NOT configured disable their buttons instead of
  // lying (CI sets no PATH_4K/PATH_3D).
  const libraryBtn = app.locator('.release-dest-btn', { hasText: '1080' }).first();
  await expect(libraryBtn).toBeEnabled({ timeout: 15000 });
  await expect(app.locator('.release-dest-btn', { hasText: '4K' }).first()).toBeDisabled();
  await expect(app.locator('.release-dest-btn', { hasText: '3D' }).first()).toBeDisabled();

  // One press = one grab: the row's link goes straight to the qBittorrent
  // Web API fake-arr serves (S2 — no arr on this path anymore), under the
  // library category the arr watches (S3).
  await libraryBtn.click();

  // Success feedback: the backend's own detail — the qBittorrent client's
  // exact words for THIS add, URL and S3 library category pinned — rides
  // above the results as the panel's notice (div.release-detail-note): plain
  // div, no role → text, scoped to the detail region because the SAME text
  // also lives in the toast (F-13), and a document-wide text query is
  // legitimately ambiguous. The fullscreen detail carries the same
  // aria-label the split panel did.
  await expect(
    app
      .getByRole('region', { name: 'Panel de detalle' })
      .getByText('Descarga añadida en qBittorrent (http://127.0.0.1:4400), categoría radarr'),
  ).toBeVisible({ timeout: 15000 });

  // …and the ambient confirmation reaches past the panel: the toast carries
  // the same detail (F-13).
  await expect(app.locator('.toast-ok')).toContainText(
    'Descarga añadida en qBittorrent (http://127.0.0.1:4400), categoría radarr',
    { timeout: 15000 },
  );
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
