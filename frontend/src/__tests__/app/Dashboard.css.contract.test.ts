import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'

// Vitest runs from the frontend package root (cwd); jsdom rewrites
// import.meta.url to a non-file URL, so resolve the real file via cwd.
// The rules moved here from features/pipeline-visual/PipelineVisual.css when
// the flow graph was removed (design 01).
const css = readFileSync('src/app/Dashboard.css', 'utf8')

/** Drop comments so commented-out CSS cannot satisfy the contract. */
function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, '')
}

const clean = stripComments(css)

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/** Read the brace-delimited body that starts at `open` (index of the brace). */
function braceBody(source: string, open: number): string {
  let depth = 1
  let i = open + 1
  while (i < source.length && depth > 0) {
    if (source[i] === '{') depth++
    else if (source[i] === '}') depth--
    i++
  }
  return source.slice(open + 1, depth === 0 ? i - 1 : i)
}

interface MediaBlock {
  condition: string
  body: string
  start: number
  end: number
}

/** All @media blocks in source order, with balanced-brace bodies. */
function mediaBlocks(source: string): MediaBlock[] {
  const blocks: MediaBlock[] = []
  const re = /@media([^{]*)\{/g
  let match: RegExpExecArray | null
  while ((match = re.exec(source)) !== null) {
    const open = re.lastIndex - 1
    const body = braceBody(source, open)
    blocks.push({
      condition: match[1].trim(),
      body,
      start: match.index,
      end: open + 1 + body.length + 1,
    })
  }
  return blocks
}

const blocks = mediaBlocks(clean)

/** Body of the first top-level rule for `selector`, ignoring rules inside @media. */
function topLevelRuleBody(selector: string): string {
  const re = new RegExp(`(?:^|[\\s}])${escapeRegExp(selector)}\\s*\\{`, 'g')
  let match: RegExpExecArray | null
  while ((match = re.exec(clean)) !== null) {
    const open = clean.indexOf('{', match.index)
    if (blocks.some((b) => open >= b.start && open < b.end)) continue
    return braceBody(clean, open)
  }
  return ''
}

/** Body of the first rule for `selector` inside `source` (a media block body). */
function ruleBodyIn(source: string, selector: string): string {
  const re = new RegExp(`(?:^|[\\s}])${escapeRegExp(selector)}\\s*\\{`)
  const match = re.exec(source)
  if (!match) return ''
  return braceBody(source, source.indexOf('{', match.index))
}

function gridColumns(body: string): string {
  const match = /grid-template-columns:\s*([^;}]+)/.exec(body)
  return match ? match[1].replace(/\s+/g, ' ').trim() : ''
}

/** Column count for `repeat(N, ...)` or a plain space/comma-separated track list. */
function countColumns(value: string): number {
  const repeat = /^repeat\(\s*(\d+)\s*,/.exec(value)
  if (repeat) return Number(repeat[1])
  return value.split(/[\s,]+/).filter(Boolean).length
}

function blockAt(maxWidth: number): MediaBlock | undefined {
  return blocks.find((b) => new RegExp(`max-width:\\s*${maxWidth}px`).test(b.condition))
}

describe('Dashboard.css responsive contract', () => {
  it('defaults the dashboard grid to four columns', () => {
    expect(countColumns(gridColumns(topLevelRuleBody('.dashboard-grid')))).toBe(4)
  })

  it('collapses the dashboard grid to one column at max-width 640px', () => {
    const block = blockAt(640)
    expect(block, '@media (max-width: 640px) block exists').toBeDefined()
    const columns = gridColumns(ruleBodyIn(block!.body, '.dashboard-grid'))
    expect(countColumns(columns)).toBe(1)
  })

  it('drops the dashboard grid to two columns at max-width 900px', () => {
    const block = blockAt(900)
    expect(block, '@media (max-width: 900px) block exists').toBeDefined()
    const columns = gridColumns(ruleBodyIn(block!.body, '.dashboard-grid'))
    expect(countColumns(columns)).toBe(2)
  })

  it('orders the 640px block after the 900px block so the narrowest rule wins', () => {
    const at900 = blocks.findIndex((b) => b === blockAt(900))
    const at640 = blocks.findIndex((b) => b === blockAt(640))
    expect(at900, '@media (max-width: 900px) block exists').toBeGreaterThan(-1)
    expect(at640, '@media (max-width: 640px) block exists').toBeGreaterThan(-1)
    expect(at640).toBeGreaterThan(at900)
  })

  it('protects the grid and its card children with min-width: 0', () => {
    expect(topLevelRuleBody('.dashboard-grid')).toMatch(/min-width:\s*0(?:px)?\b/)
    expect(topLevelRuleBody('.dash-card')).toMatch(/min-width:\s*0(?:px)?\b/)
  })

  it('keeps long card text inside the card via overflow-wrap or line-clamp', () => {
    const dashTextRules = ['.dash-card', '.dash-label', '.dash-value', '.dash-sub']
      .map(topLevelRuleBody)
      .join('\n')
    expect(dashTextRules).toMatch(/overflow-wrap:\s*[a-z]+|(?:-webkit-)?line-clamp:\s*\d+/)
  })

  it('aligns the dash-card radius with the 8px handoff roundness', () => {
    expect(topLevelRuleBody('.dash-card')).toMatch(/border-radius:\s*8px\b/)
  })
})
