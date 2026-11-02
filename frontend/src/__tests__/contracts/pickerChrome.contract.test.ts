import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'

/**
 * Picker chrome travels with the component that renders it.
 *
 * The `.scan-*` modal, region list and file rows are composed by every picker
 * caller around `FileNavigator`, so their styles live in `FileNavigator.css`.
 * They used to live in the media-pane stylesheet, and the per-view chunking
 * (#271) turned that into a per-route asset: any page that opened a picker
 * without also loading the media pane (Media Mixer, release search) got an
 * unstyled modal — the CSS was right, it simply was never linked.
 *
 * Vitest runs from the frontend package root, so sources resolve from `src/`.
 */

const CHROME_CLASSES = ['scan-modal-backdrop', 'scan-modal-body', 'scan-path-list', 'scan-file-item']

// Every component, resolved by the bundler: no directory walking, no glob lib.
const COMPONENTS = import.meta.glob('/src/**/*.tsx', {
  query: '?raw',
  import: 'default',
  eager: true,
}) as Record<string, string>

function defines(source: string, className: string): boolean {
  const withoutComments = source.replace(/\/\*[\s\S]*?\*\//g, '')
  return new RegExp(`\\.${className}(?![a-z0-9-])`).test(withoutComments)
}

describe('el chrome del selector de archivos', () => {
  it('vive en la hoja del componente que lo dibuja, y solo ahí', () => {
    const navigator = readFileSync('src/shared/ui/FileNavigator.css', 'utf8')
    const mediaPane = readFileSync('src/features/media-pane/MissingContent.css', 'utf8')
    for (const className of CHROME_CLASSES) {
      expect(defines(navigator, className), `${className} en FileNavigator.css`).toBe(true)
      expect(defines(mediaPane, className), `${className} duplicado en MissingContent.css`).toBe(false)
    }
  })

  it('solo lo dibuja quien carga la hoja que lo estiliza', () => {
    const offenders = Object.entries(COMPONENTS)
      .filter(([path]) => !path.includes('__tests__'))
      .filter(([, source]) => CHROME_CLASSES.some((className) => source.includes(className)))
      .map(([path]) => path)
      .filter((path) => !COMPONENTS[path].includes('FileNavigator'))
    expect(offenders).toEqual([])
  })
})
