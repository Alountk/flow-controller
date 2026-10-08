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
 * Tolerance is 1px: subpixel rounding is not overflow.
 */

const FIT = 1;

interface FitReport {
  checked: number;
  bad: string[];
  boardOverflow: number;
}

/** Per-column report: every card vs the width of the body it lives in. */
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

test('the Seguimiento cards fit their columns', async ({ app }) => {
  await login(app, 'test-key');
  // login() returns the moment the button is clicked, but the key is only
  // stored after the async verification answers. Navigating before that
  // reloads the app with no key and drops us back on the AuthGate.
  await expect(app.getByRole('heading', { name: 'Resumen del sistema' })).toBeVisible();

  await app.goto('/seguimiento');

  // The page has no in-page header (the topbar carries the title): the tail
  // always renders, the columns only when there is something to track — and
  // the stub's queue/history fixtures guarantee there is.
  await expect(app.locator('.sg-ops')).toBeVisible();
  await expect(app.locator('.sg-col')).toHaveCount(4);

  const { checked, bad, boardOverflow } = await measureIn(app, '.sg-card', '.sg-col-body', '.sg-board');

  expect(bad).toEqual([]);
  expect(boardOverflow).toBeLessThanOrEqual(FIT);
  if (checked === 0) {
    // The stub only produces trace rows if an earlier spec grabbed something;
    // the columns and the board still have to fit either way, and the card
    // assertion above runs the moment any card exists.
    test.info().annotations.push({
      type: 'note',
      description: 'no trace rows in this environment — card fit not measurable',
    });
  }
});

test('the view is the board and the tail — and the board alone scrolls', async ({ app }) => {
  await login(app, 'test-key');
  await expect(app.getByRole('heading', { name: 'Resumen del sistema' })).toBeVisible();

  await app.goto('/seguimiento');
  await expect(app.locator('.sg-ops')).toBeVisible();

  // The layout contract after B-09's follow-up: the top of the page is the
  // kanban and nothing else — no in-page header, no summary strip, no sweep
  // block (the old section must not resurface); the page never scrolls, the
  // board does, and the operations queue rides below as the tail.
  const layout = await app.evaluate(() => {
    const sg = document.querySelector('.sg');
    const content = document.querySelector('.content');
    const board = document.querySelector('.sg-board');
    if (!sg || !content) return null;
    const colBodies = [...document.querySelectorAll('.sg-col-body')];
    return {
      children: [...sg.children].map((el) => el.className),
      directSweep: Boolean(document.querySelector('.sg > .auto-copy')),
      hasSummary: Boolean(document.querySelector('.sg-sum')),
      hasHeader: Boolean(document.querySelector('.sg-head')),
      pageScrolls: content.scrollHeight - content.clientHeight,
      boardScrolls: board ? board.scrollHeight - board.clientHeight : -1,
      colBodiesScrolling: colBodies.filter(
        (el) => getComputedStyle(el).overflowY === 'auto',
      ).length,
      colBodies: colBodies.length,
    };
  });

  expect(layout).not.toBeNull();
  expect(layout!.children).toHaveLength(2);
  expect(layout!.children[1]).toBe('sg-ops');
  expect(['sg-board', 'sg-empty']).toContain(layout!.children[0]);
  expect(layout!.directSweep).toBe(false);
  expect(layout!.hasSummary).toBe(false);
  expect(layout!.hasHeader).toBe(false);
  // The page and the BOARD itself must not scroll — each column owns its
  // own overflow, so one long column never drags the others off screen.
  expect(layout!.pageScrolls).toBeLessThanOrEqual(1);
  expect(layout!.boardScrolls).toBeLessThanOrEqual(1);
  expect(layout!.colBodies).toBeGreaterThan(0);
  expect(layout!.colBodiesScrolling).toBe(layout!.colBodies);
});
