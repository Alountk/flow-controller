import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'

// Vitest runs from the frontend package root (cwd); jsdom rewrites
// import.meta.url to a non-file URL, so resolve the real file via cwd.
const css = readFileSync('src/pages/Sections.css', 'utf8')

/** Drop comments so commented-out CSS cannot satisfy the contract. */
function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, '')
}

const clean = stripComments(css)

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/** Body of the first top-level rule for `selector`. */
function topLevelRuleBody(selector: string): string {
  const re = new RegExp(`(?:^|[\\s}])${escapeRegExp(selector)}\\s*\\{`, 'g')
  const match = re.exec(clean)
  if (!match) return ''
  const open = clean.indexOf('{', match.index)
  let depth = 1
  let i = open + 1
  while (i < clean.length && depth > 0) {
    if (clean[i] === '{') depth++
    else if (clean[i] === '}') depth--
    i++
  }
  return clean.slice(open + 1, depth === 0 ? i - 1 : i)
}

/**
 * Stitch-03 card redesign (S7): the section row stops being a dense hairline
 * line and becomes the design's CARD — 64×96 poster, big title, card border
 * with an accent frame on the selected one, and the hairline filete over the
 * footer row.
 */
describe('Section cards (design 03, S7)', () => {
  it('draws the section row as a card: border, 8px radius and padding', () => {
    const body = topLevelRuleBody('.sec-master .sec-row')
    expect(body).toMatch(/border:\s*1px solid var\(--border\)/)
    expect(body).toMatch(/border-radius:\s*8px/)
    expect(body).toMatch(/padding:\s*12px/)
    expect(body).toMatch(/background:\s*var\(--bg-elev\)/)
  })

  it('gives the cards the design poster box (64×96)', () => {
    const body = topLevelRuleBody('.sec-row-poster')
    expect(body).toMatch(/width:\s*64px/)
    expect(body).toMatch(/height:\s*96px/)
  })

  it('sizes the title like the design headline (18px bold)', () => {
    const body = topLevelRuleBody('.sec-row-name')
    expect(body).toMatch(/font-size:\s*18px/)
    expect(body).toMatch(/font-weight:\s*700/)
  })

  it('frames the selected card with a 2px accent border', () => {
    const body = topLevelRuleBody(".sec-master .sec-row[aria-current='true']")
    expect(body).toMatch(/border:\s*2px solid var\(--accent\)/)
    // The old dense-list marker (left bar only) is gone.
    expect(body).not.toMatch(/border-left-color/)
  })

  it('separates the cards with a gap instead of stacking them hairline-tight', () => {
    const body = topLevelRuleBody('.sec-master .wanted-grid')
    expect(body).toMatch(/gap:\s*\d+px/)
    expect(body).not.toMatch(/gap:\s*0/)
  })

  it('draws the design filete over the footer row', () => {
    const body = topLevelRuleBody('.sec-row-bottom')
    expect(body).toMatch(/border-top:\s*1px solid/)
  })
})

/**
 * S2 (user decision, stitch-series-tree): the cards leave the Series view —
 * the series node inside the tree is FLAT (no frame, no fill, no radius) and
 * its title shrinks to the prototype's summary-line size. The card rules
 * above stay untouched (movies still wear them); these read the TREE-scoped
 * rules only, so a flat node cannot be reintroduced as a card by accident,
 * and the selected node keeps its accent frame (master–detail stays visible).
 */
describe('Series tree node (stitch-series-tree, S2)', () => {
  it('flattens the node: no card frame, no fill, no radius', () => {
    const body = topLevelRuleBody('.st-tree .sec-row')
    expect(body).toMatch(/border:\s*none/)
    expect(body).toMatch(/background:\s*transparent/)
    expect(body).toMatch(/border-radius:\s*0/)
  })

  it('still frames the selected node with the accent border', () => {
    const body = topLevelRuleBody(".st-tree .sec-row[aria-current='true']")
    expect(body).toMatch(/border:\s*2px solid var\(--accent\)/)
  })

  it('sizes the title like the prototype summary line (13.5px)', () => {
    const body = topLevelRuleBody('.st-tree .sec-row-name')
    expect(body).toMatch(/font-size:\s*13\.5px/)
  })
})
