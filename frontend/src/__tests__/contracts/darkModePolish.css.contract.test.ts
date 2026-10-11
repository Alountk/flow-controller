import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'

// Contract tests for handoff brief 3 — dark-mode contrast polish (T1–T4).
// Vitest runs from the frontend package root (cwd); jsdom rewrites
// import.meta.url to a non-file URL, so resolve the real files via cwd.

/** Drop comments so commented-out CSS cannot satisfy the contract. */
function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, '')
}

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

/** Body of the first rule for `selector` in `source` ('' when absent). */
function ruleBody(source: string, selector: string): string {
  const re = new RegExp(`(?:^|[\\s}])${escapeRegExp(selector)}\\s*\\{`)
  const match = re.exec(source)
  if (!match) return ''
  return braceBody(source, source.indexOf('{', match.index))
}

/**
 * True when `body` declares `prop: value;`. The `(^|[;\s])` guard keeps
 * `border-color:` / `background-color:` from matching a `color:` query.
 */
function hasDecl(body: string, prop: string, value: string): boolean {
  const re = new RegExp(`(?:^|[;\\s])${escapeRegExp(prop)}:\\s*${escapeRegExp(value)}\\s*(?=;)`)
  return re.test(body)
}

function readCss(relPath: string): string {
  return stripComments(readFileSync(`src/${relPath}`, 'utf8'))
}

/** Body of the `:root` rule inside the first matching @media block. */
function mediaRootBody(source: string, condition: string): string {
  const re = new RegExp(`@media\\s*${escapeRegExp(condition)}\\s*\\{`)
  const match = re.exec(source)
  if (!match) return ''
  const media = braceBody(source, source.indexOf('{', match.index))
  return ruleBody(media, ':root')
}

const globalRaw = readFileSync('src/styles/global.css', 'utf8')
const globalClean = stripComments(globalRaw)

describe('T1 — success fills use --ok-dim instead of --ok', () => {
  it('.settings-toast fills with var(--ok-dim)', () => {
    const body = ruleBody(readCss('features/settings/Settings.css'), '.settings-toast')
    expect(body, '.settings-toast rule exists').not.toBe('')
    expect(hasDecl(body, 'background', 'var(--ok-dim)')).toBe(true)
    expect(hasDecl(body, 'background', 'var(--ok)')).toBe(false)
  })

  it('.settings-toggle.on fills with var(--ok-dim)', () => {
    const body = ruleBody(readCss('shared/ui/Field.css'), '.settings-toggle.on')
    expect(body, '.settings-toggle.on rule exists').not.toBe('')
    expect(hasDecl(body, 'background', 'var(--ok-dim)')).toBe(true)
    expect(hasDecl(body, 'background', 'var(--ok)')).toBe(false)
  })
})

const errorChipSites: Array<[file: string, selector: string]> = [
  ['pages/Sections.css', '.sec-pill-bad'],
  ['pages/Seguimiento.css', '.sg-pill-failed'],
  ['pages/MediaMixer.css', '.mixer-status-error'],
  ['features/pipeline-visual/PipelineVisual.css', '.node-state.offline'],
  ['features/auto-copy/AutoCopyPanel.css', '.auto-copy-badge.failed'],
  ['pages/Prototypes.css', '.proto-badge.discarded'],
]

describe('T2 — error chip text uses the --bad-text token', () => {
  for (const [file, selector] of errorChipSites) {
    it(`${selector} in ${file} colors text with var(--bad-text)`, () => {
      const body = ruleBody(readCss(file), selector)
      expect(body, `${selector} rule exists`).not.toBe('')
      expect(hasDecl(body, 'color', 'var(--bad-text)')).toBe(true)
      expect(hasDecl(body, 'color', 'var(--bad)')).toBe(false)
    })
  }
})

const dimChipSites: Array<[file: string, selector: string]> = [
  ['pages/MediaMixer.css', '.mixer-status-cancelled'],
  ['pages/MediaMixer.css', '.mixer-status-pending'],
  ['features/auto-copy/AutoCopyPanel.css', '.auto-copy-badge.skip'],
  ['features/pipeline-visual/PipelineVisual.css', '.node-state.unknown'],
]

describe('T3 — dim chips over dim tints use 70% --text color-mix', () => {
  it('.proto-badge.selected colors text with var(--info)', () => {
    const body = ruleBody(readCss('pages/Prototypes.css'), '.proto-badge.selected')
    expect(body, '.proto-badge.selected rule exists').not.toBe('')
    expect(hasDecl(body, 'color', 'var(--info)')).toBe(true)
    expect(hasDecl(body, 'color', 'var(--accent)')).toBe(false)
  })

  for (const [file, selector] of dimChipSites) {
    it(`${selector} in ${file} colors text with 70% --text color-mix`, () => {
      const body = ruleBody(readCss(file), selector)
      expect(body, `${selector} rule exists`).not.toBe('')
      expect(
        hasDecl(body, 'color', 'color-mix(in srgb, var(--text) 70%, transparent)')
      ).toBe(true)
      expect(hasDecl(body, 'color', 'var(--text-dim)')).toBe(false)
    })
  }
})

describe('T4 — dark-only --text-dim/--text-dim2 adjustment (C-06)', () => {
  it('the dark :root maps --text-dim and --text-dim2 to #8b8b93', () => {
    const darkRoot = mediaRootBody(globalClean, '(prefers-color-scheme: dark)')
    expect(darkRoot, 'dark :root rule exists').not.toBe('')
    expect(hasDecl(darkRoot, '--text-dim', '#8b8b93')).toBe(true)
    expect(hasDecl(darkRoot, '--text-dim2', '#8b8b93')).toBe(true)
  })

  it('the light :root keeps --text-dim #52525b and --text-dim2 #71717a', () => {
    const open = globalClean.indexOf(':root')
    expect(open, 'light :root rule exists').toBeGreaterThan(-1)
    const lightRoot = braceBody(globalClean, globalClean.indexOf('{', open))
    expect(hasDecl(lightRoot, '--text-dim', '#52525b')).toBe(true)
    expect(hasDecl(lightRoot, '--text-dim2', '#71717a')).toBe(true)
  })

  it('marks the change as a C-06 adjustment pending human visual review', () => {
    expect(globalRaw).toMatch(/\/\*[\s\S]*C-06[\s\S]*?\*\//)
  })
})
