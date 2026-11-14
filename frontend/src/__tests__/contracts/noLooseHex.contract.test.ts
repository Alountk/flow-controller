import { describe, it, expect } from 'vitest'

/**
 * Colour is declared once, in `styles/global.css`, where the dark palette
 * overrides it. A hex written in a component sheet — or as the fallback of
 * `var(--x, #hex)` — is a light-only colour that dark mode never reaches: it
 * is what painted the white boxes of the dark theme, and it hid tokens that
 * nobody had declared (`--text-muted`, `--danger`).
 */
const SHEETS = import.meta.glob('/src/**/*.css', {
  query: '?raw',
  import: 'default',
  eager: true,
}) as Record<string, string>

const withoutComments = (css: string) => css.replace(/\/\*[\s\S]*?\*\//g, '')

describe('component stylesheets', () => {
  it('declare no hex colour outside global.css', () => {
    const offenders = Object.entries(SHEETS)
      .filter(([path]) => !path.endsWith('/styles/global.css'))
      .flatMap(([path, css]) =>
        withoutComments(css)
          .split('\n')
          .map((line, i) => ({ path, line: i + 1, text: line.trim() }))
          .filter(({ text }) => /#[0-9a-fA-F]{3,8}\b/.test(text)),
      )
      .map(({ path, line, text }) => `${path}:${line}  ${text}`)

    expect(offenders).toEqual([])
  })

  it('only use var(--token) names that some sheet declares', () => {
    const all = Object.values(SHEETS).join('\n')
    const used = new Set([...all.matchAll(/var\((--[a-z0-9-]+)/g)].map((m) => m[1]))
    const declared = new Set([...all.matchAll(/(--[a-z0-9-]+)\s*:/g)].map((m) => m[1]))

    expect([...used].filter((name) => !declared.has(name)).sort()).toEqual([])
  })
})
