import type { Page } from '@playwright/test';
import { test, expect, login } from '../fixtures/app';

/**
 * The kanban cards must FIT their column — measured, not eyeballed.
 *
 * Both bugs this pins were reported as "las cards hacen overflow y no se
 * ajustan al ancho", and both measured as card.width > column.width:
 *
 * - the view: cards are grid items whose automatic minimum size is their
 *   min-content, so a nowrap path inside one card widened every card past
 *   its track (860px card in a 201px column, measured). Fixed with a
 *   `minmax(0, 1fr)` track and `min-width: 0` on the item;
 * - the prototype: at the stacked breakpoint the sidebar went full-width
 *   but the shell never wrapped, so the content was squeezed off-screen
 *   and its cards overflowed a ~20px column. Fixed with `flex-wrap`.
 *
 * The view half of that contract now measures S2's unified task list: the
 * board+tail stacking (and its fixed 70/30 split) is gone — ONE list of
 * rows under filter tabs, and a row must fit the list exactly like a card
 * had to fit its column.
 *
 * Tolerance is 1px: subpixel rounding is not overflow.
 */

const FIT = 1;

interface FitReport {
  checked: number;
  bad: string[];
  boardOverflow: number;
}

/** Per-row report: every row vs the width of the box it lives in. */
function measureIn(page: Page, cardSel: string, bodySel: string, boardSel: string): Promise<FitReport> {
  return page.evaluate(
    (sels) => {
      const bad: string[] = [];
      let checked = 0;
      for (const body of document.querySelectorAll(sels.bodySel)) {
        const bodyWidth = body.getBoundingClientRect().width;
        for (const card of body.querySelectorAll(sels.cardSel)) {
          checked += 1;
          const width = card.getBoundingClientRect().width;
          if (width > bodyWidth + 1) {
            bad.push(
              `${(card.textContent ?? '').trim().slice(0, 40)}: ${width.toFixed(1)} > ${bodyWidth.toFixed(1)}`,
            );
          }
        }
      }
      const boardEl = document.querySelector(sels.boardSel);
      return {
        checked,
        bad,
        boardOverflow: boardEl ? boardEl.scrollWidth - boardEl.clientWidth : 0,
      };
    },
    { cardSel, bodySel, boardSel },
  );
}

test('the kanban prototype fits its columns at the stacked breakpoint', async ({ app }) => {
  await login(app, 'test-key');
  // The reported width: <=900px is where the sidebar stacks and the shell
  // used to stop wrapping. Measure exactly there, not at a comfortable size.
  await app.setViewportSize({ width: 900, height: 900 });
  await app.goto('/prototypes/seguimiento-02-kanban.html');

  await expect(app.locator('.k-card').first()).toBeVisible();
  const { checked, bad, boardOverflow } = await measureIn(app, '.k-card', '.col-body', '.board');

  expect(checked).toBeGreaterThan(0);
  expect(bad).toEqual([]);
  expect(boardOverflow).toBeLessThanOrEqual(FIT);
});

test('the Seguimiento task rows fit the unified list (S2)', async ({ app }) => {
  await login(app, 'test-key');
  // login() returns the moment the button is clicked, but the key is only
  // stored after the async verification answers. Navigating before that
  // reloads the app with no key and drops us back on the AuthGate.
  await expect(app.getByRole('heading', { level: 1, name: 'Dashboard' })).toBeVisible({ timeout: 15000 });

  await app.goto('/seguimiento');

  // The new contract, explicit: the view is the tab bar + ONE list — rows of
  // traces, copy operations and mix tasks, whatever the environment happens
  // to carry — and the rows must fit that list.
  await expect(app.getByRole('tab', { name: /^Activas/ })).toBeVisible({ timeout: 15000 });
  await expect(app.locator('.sg-list')).toBeVisible({ timeout: 15000 });

  // Rows live under their filter tabs (S2) — fit is a per-tab contract: a row
  // must fit the list wherever its filter puts it, default tab or not.
  let checked = 0;
  let listOverflow = 0;
  const bad: string[] = [];
  for (const name of [/^Activas/, 'Completadas', 'Errores']) {
    await app.getByRole('tab', { name }).click();
    const report = await measureIn(app, '.sg-row', '.sg-list', '.sg-list');
    checked += report.checked;
    listOverflow = Math.max(listOverflow, report.boardOverflow);
    bad.push(...report.bad);
  }

  expect(bad).toEqual([]);
  expect(listOverflow).toBeLessThanOrEqual(FIT);
  if (checked === 0) {
    // The stub only produces rows if an earlier spec queued or grabbed
    // something; the list itself still has to fit either way, and the row
    // assertion above runs the moment any row exists in any tab.
    test.info().annotations.push({
      type: 'note',
      description: 'no task rows in this environment — row fit not measurable',
    });
  }
});

test('the view is one filtered task list — tabs above, sweep below, no board (S2)', async ({ app }) => {
  await login(app, 'test-key');
  await expect(app.getByRole('heading', { level: 1, name: 'Dashboard' })).toBeVisible({ timeout: 15000 });

  await app.goto('/seguimiento');
  await expect(app.locator('.sg-list')).toBeVisible({ timeout: 15000 });

  // The layout contract after S2's redesign: the top of the page is the task
  // list and nothing else — no board, no columns, no in-page header, no
  // summary strip (the old sections must not resurface); completed and
  // failed rows are hidden under their tabs; the page never scrolls, the
  // LIST does; the auto-copy sweep rides below the list.
  const layout = await app.evaluate((fit) => {
    const content = document.querySelector('.content');
    const list = document.querySelector('.sg-list');
    const sweep = document.querySelector('.auto-copy');
    if (!content || !list || !sweep) return null;
    const listBox = list.getBoundingClientRect();
    const sweepBox = sweep.getBoundingClientRect();
    return {
      lists: document.querySelectorAll('.sg-list').length,
      boards: document.querySelectorAll('.sg-board').length,
      cols: document.querySelectorAll('.sg-col').length,
      rows: document.querySelectorAll('.sg-row').length,
      tabs: [...document.querySelectorAll('[role="tab"]')].map((t) => t.textContent ?? ''),
      activeTab: document.querySelector('[role="tab"][aria-selected="true"]')?.textContent ?? '',
      directSweep: Boolean(document.querySelector('.sg > .auto-copy')),
      sweepInList: Boolean(document.querySelector('.sg-list .auto-copy')),
      hasSummary: Boolean(document.querySelector('.sg-sum')),
      hasHeader: Boolean(document.querySelector('.sg-head')),
      pageScrolls: content.scrollHeight - content.clientHeight,
      listIsScrollBox: getComputedStyle(list).overflowY === 'auto',
      sweepBelowList: sweepBox.top >= listBox.bottom - fit,
    };
  }, FIT);

  expect(layout).not.toBeNull();
  expect(layout!.lists).toBe(1);
  expect(layout!.boards).toBe(0);
  expect(layout!.cols).toBe(0);
  // The exact tab vocabulary of decision L3, «Activas (n)» selected by
  // default, and the rows hidden under their own tabs.
  expect(layout!.tabs.map((t) => t.replace(/ \(\d+\)$/, ''))).toEqual([
    'Activas',
    'Completadas',
    'Errores',
  ]);
  expect(layout!.activeTab).toMatch(/^Activas \(\d+\)$/);
  expect(layout!.directSweep).toBe(false);
  expect(layout!.sweepInList).toBe(false);
  expect(layout!.hasSummary).toBe(false);
  expect(layout!.hasHeader).toBe(false);
  // The page must not scroll — the list owns its overflow, so one long list
  // never drags the sweep off screen.
  expect(layout!.pageScrolls).toBeLessThanOrEqual(FIT);
  expect(layout!.listIsScrollBox).toBe(true);
  expect(layout!.sweepBelowList).toBe(true);
});

test('the unified list fills the view — the 70/30 split is gone (S2)', async ({ app }) => {
  await login(app, 'test-key');
  await expect(app.getByRole('heading', { level: 1, name: 'Dashboard' })).toBeVisible({ timeout: 15000 });

  await app.goto('/seguimiento');
  await expect(app.locator('.sg-list')).toBeVisible({ timeout: 15000 });

  // The replacement for the fixed board/tail share: there are no halves left
  // to divide. The list takes the FULL width ("menos paneles, una sola
  // lectura") and the tabs + list + sweep stack closes the box exactly —
  // content-driven shares were what made the halves negotiate over pixels.
  const box = await app.evaluate(() => {
    const frame = document.querySelector('.sg-frame');
    const sg = document.querySelector('.sg');
    const tabs = document.querySelector('.sg-tabs');
    const list = document.querySelector('.sg-list');
    const sweep = document.querySelector('.sg-sweep');
    if (!frame || !sg || !tabs || !list || !sweep) return null;
    const f = frame.getBoundingClientRect();
    const t = tabs.getBoundingClientRect();
    const l = list.getBoundingClientRect();
    const s = sweep.getBoundingClientRect();
    return {
      frameW: f.width,
      frameH: f.height,
      listW: l.width,
      listH: l.height,
      stacked: t.height + l.height + s.height,
      gap: parseFloat(getComputedStyle(sg).rowGap) || 0,
    };
  });

  expect(box).not.toBeNull();
  // One reading, one column: the list IS the width of the view.
  expect(Math.abs(box!.listW - box!.frameW)).toBeLessThanOrEqual(FIT);
  // And the stack closes the box — tabs + list + sweep + the two gaps = the
  // whole content area, so the page cannot scroll however long the list grows.
  expect(Math.abs(box!.stacked + 2 * box!.gap - box!.frameH)).toBeLessThanOrEqual(FIT);
});
