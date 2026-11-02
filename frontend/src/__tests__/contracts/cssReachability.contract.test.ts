import { describe, it, expect } from 'vitest'

/**
 * A component must be able to load the stylesheet that styles what it draws.
 *
 * The per-view chunking (#271) turned each page stylesheet into a per-route
 * asset. A shared module that borrowed classes from another page's sheet —the
 * mixer's picker from the media pane, `Renombrar` from `FileManager.css`— kept
 * rendering, but its rules were not in the chunk that loaded it: unstyled
 * markup, no error, no test failure.
 *
 * So this walks the real import graph the bundler uses and checks every class a
 * component names against the sheets it can actually reach. A sheet imported by
 * a page that renders the component counts too: that is how a page styles the
 * children it composes.
 *
 * Vitest runs from the frontend package root, so modules resolve from `/src`.
 */

type Sources = Record<string, string>

const SOURCES = import.meta.glob('/src/**/*.{ts,tsx,css}', {
  query: '?raw',
  import: 'default',
  eager: true,
}) as Sources

const ENTRY = '/src/main.tsx'
const isProduction = (path: string) => !path.includes('__tests__') && !path.includes('/test/')
const isComponent = (path: string) => isProduction(path) && /\.tsx$/.test(path)

/** Relative imports only: the bundler resolves the rest, we only need the edges. */
function importsOf(path: string): string[] {
  const source = SOURCES[path] ?? ''
  const dir = path.slice(0, path.lastIndexOf('/'))
  const found: string[] = []
  // CSS `@import` is an edge too: `index.css` is how the always-loaded atoms arrive.
  const edges = path.endsWith('.css')
    ? [...source.matchAll(/@import\s+(?:url\()?['"]([^'"]+)['"]/g)]
    : [...source.matchAll(/(?:from|import)\s*['"](\.[^'"]+)['"]/g)]
  for (const match of edges) {
    const spec = match[1].replace(/\?.*$/, '')
    // A sentinel origin: `file:///src` would parse `src` as the host.
    const base = new URL(spec, `https://local${dir}/`).pathname
    for (const candidate of [base, `${base}.ts`, `${base}.tsx`, `${base}.css`, `${base}/index.ts`, `${base}/index.tsx`]) {
      if (SOURCES[candidate]) {
        found.push(candidate)
        break
      }
    }
  }
  return found
}


const GRAPH = new Map(Object.keys(SOURCES).map((path) => [path, importsOf(path)]))
const REACHABLE = new Map<string, Set<string>>()

function reach(path: string): Set<string> {
  let cached = REACHABLE.get(path)
  if (!cached) {
    const seen = new Set<string>([path])
    const queue = [path]
    while (queue.length) {
      for (const next of GRAPH.get(queue.pop()!) ?? []) {
        if (seen.has(next)) continue
        seen.add(next)
        queue.push(next)
      }
    }
    cached = seen
    REACHABLE.set(path, cached)
  }
  return cached
}

/** class name → the sheets that define a rule for it. */
const DEFINED = new Map<string, Set<string>>()

for (const [path, source] of Object.entries(SOURCES)) {
  if (!path.endsWith('.css')) continue
  const css = source.replace(/\/\*[\s\S]*?\*\//g, '')
  for (const match of css.matchAll(/\.(-?[A-Za-z_][\w-]*)/g)) {
    const name = match[1]
    if (!DEFINED.has(name)) DEFINED.set(name, new Set())
    DEFINED.get(name)!.add(path)
  }
}

/** The classes a component names in its own `className` props. */
function classesOf(path: string): Set<string> {
  const source = SOURCES[path]
  const used = new Set<string>()
  for (const match of source.matchAll(/className=(?:"([^"]*)"|\{`([^`]*)`\})/g)) {
    const literal = (match[1] ?? match[2] ?? '').replace(/\$\{[^}]*\}/g, ' ')
    for (const token of literal.split(/\s+/)) {
      if (/^-?[A-Za-z_][\w-]*$/.test(token)) used.add(token)
    }
  }
  return used
}

const COMPONENTS = Object.keys(SOURCES).filter(isComponent)

/** Whoever pulls the component in: a page, or the page's own child component. */
function hosts(component: string): string[] {
  return COMPONENTS.filter((other) => other !== component && reach(other).has(component))
}

const ALWAYS_LOADED = reach(ENTRY)

/**
 * Debt that predates this check, kept explicit so the test can fail on the
 * *next* one instead of on the backlog. Each family is a rule that a page
 * sheet defines for markup another page draws — the same fault as #279 and
 * #281, still to be burnt down per page (visual checks per route).
 */
const KNOWN_ORPHANS = new Set([
  'wanted-empty', // App/DiskSpace/Settings borrow the media pane's states
  'wanted-error',
  'wanted-loading',
  'search-all',
  'error-box', // settings sections borrow the dashboard's message box
  'action-btn', // settings sections borrow a button the picker defines
  'sec-tab-note', // the quality threshold borrows the sections' note
  'mixer-progress-bar', // Seguimiento borrows the mixer's progress bar
  'mixer-progress-fill',
  'mixer-progress-pct',
  'mixer-task-status',
  'service-test', // Setup borrows the settings page's service probe
  'service-test-head',
  'service-test-name',
  'service-test-url',
  'modal', // the bulk search flow borrows the trace actions' modal
  'modal-backdrop',
  'modal-buttons',
  'destructive',
])

function styled(component: string, className: string): boolean {
  const sheets = DEFINED.get(className)
  if (!sheets) return true // not ours: a browser default, an external widget, a dynamic name
  if ([...sheets].some((sheet) => ALWAYS_LOADED.has(sheet))) return true
  if ([...sheets].some((sheet) => reach(component).has(sheet))) return true
  return hosts(component).some((page) => [...sheets].some((sheet) => reach(page).has(sheet)))
}

describe('los estilos viajan con quien los dibuja', () => {
  it('ningún componente dibuja una clase que su trozo no puede cargar', () => {
    const orphans: string[] = []
    for (const component of COMPONENTS) {
      for (const className of classesOf(component)) {
        if (KNOWN_ORPHANS.has(className)) continue
        if (!styled(component, className)) {
          orphans.push(`${component.replace('/src', 'src')} → .${className} (${[...(DEFINED.get(className) ?? [])].join(', ')})`)
        }
      }
    }
    expect(orphans.sort()).toEqual([])
  })
})
