import { describe, it, expect, expectTypeOf } from 'vitest'
import type { Release } from '../../../shared/api/releases.ts'

/**
 * S5 (calendario-directo): the `Release` interface must BE the row our own
 * sources return — `_release_row` in backend/routes/calendar.py maps
 * `{title, guid, link, size, indexer, source, seeders?}` plus the title-declared
 * `quality?`/`languages?` (derived, absent with no token) and NEVER invents
 * `indexerId/leechers/protocol/releaseGroup/indexerFlags`.
 * A type that claims a field the API cannot send is a lie the UI will later
 * paint as "undefined".
 *
 * These assertions are type-level: `tsc -b` runs them (the runtime half is a
 * no-op), which is why this file is verified by the compiler gate.
 */
describe('Release type contract — the direct-source row (S5)', () => {
  it('accepts a row carrying ONLY what the API emits', () => {
    const row: Release = {
      title: 'Película 2020 1080p BluRay',
      guid: 'https://idx.test/details/tl-1',
      link: 'https://idx.test/download/tl-1.torrent',
      size: 4_294_967_296,
      indexer: 'TorrentLeech',
      source: 'torznab',
      seeders: 12,
    }
    expect(row.guid).toBe('https://idx.test/details/tl-1')
  })

  it('types the new keys and the when-stated seeders as optional', () => {
    expectTypeOf<Release['link']>().toEqualTypeOf<string | undefined>()
    expectTypeOf<Release['source']>().toEqualTypeOf<string | undefined>()
    expectTypeOf<Release['seeders']>().toEqualTypeOf<number | undefined>()
  })

  it('keeps the row identity required and honest', () => {
    expectTypeOf<Release['title']>().toEqualTypeOf<string>()
    expectTypeOf<Release['guid']>().toEqualTypeOf<string>()
    expectTypeOf<Release['size']>().toEqualTypeOf<number>()
    expectTypeOf<Release['indexer']>().toEqualTypeOf<string>()
  })
})
