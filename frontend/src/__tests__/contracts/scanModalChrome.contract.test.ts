import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const src = (p: string) => readFileSync(`src/${p}`, 'utf8')

// #304 deleted the scan modal's shell with FileNavigator.css and left it drawn
// unframed at the foot of the page; the sheet must ship with the components.
describe('scan modal chrome', () => {
  const css = src('features/media-pane/components/ScanModal.css')

  it.each(['.scan-modal-backdrop', '.scan-modal ', '.scan-modal-header', '.scan-modal-body'])(
    'declares %s',
    (selector) => {
      expect(css).toContain(selector)
    },
  )

  it.each([
    'features/media-pane/components/ScanModal.tsx',
    'features/release-search/ReleaseSearchModal.tsx',
  ])('%s imports the sheet', (file) => {
    expect(src(file)).toContain('ScanModal.css')
  })
})
