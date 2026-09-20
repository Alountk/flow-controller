import { describe, it, expect } from 'vitest'
import type { Release } from '../api/calendar'
import {
  NO_RELEASE_FILTERS,
  collectLanguages,
  collectQualities,
  filterReleases,
  hasActiveFilters,
  releaseKey,
  toggleInSet,
} from '../utils/releaseFilters'
import { toggleVisibleSelection } from '../utils/selection'

function makeRelease(overrides: Partial<Release> = {}): Release {
  return {
    guid: 'guid-1',
    title: 'Everything Everywhere All at Once 2022 1080p BluRay',
    size: 10_000_000_000,
    quality: 'Bluray-1080p',
    indexer: 'aMuTorrent',
    indexerId: 1,
    indexerFlags: '',
    seeders: 10,
    leechers: 1,
    protocol: 'torrent',
    releaseGroup: '',
    languages: ['English'],
    ...overrides,
  }
}

// Shapes taken from a real 401-release search.
const english4k = makeRelease({
  guid: 'en-4k',
  title: 'Everything Everywhere All at Once 2022 2160p UHD BluRay',
  quality: 'Remux-2160p',
  seeders: 50,
  languages: ['Ukrainian', 'English', 'Russian', 'Unknown'],
})
const english1080 = makeRelease({ guid: 'en-1080', seeders: 12 })
const spanish = makeRelease({
  guid: 'es',
  title: 'Todo a la vez en todas partes 2022 1080p',
  quality: 'WEBDL-1080p',
  seeders: 3,
  languages: ['Spanish'],
})
const italianEnglish = makeRelease({
  guid: 'it-en',
  title: 'Everything Everywhere All at Once 2022 720p',
  quality: 'WEBDL-720p',
  seeders: 0,
  languages: ['Italian', 'English'],
})
const noSeeders = makeRelease({ guid: 'dead', quality: 'SDTV', seeders: 0, languages: ['Unknown'] })

const all = [english4k, english1080, spanish, italianEnglish, noSeeders]

const withFilters = (overrides: Partial<typeof NO_RELEASE_FILTERS>) => ({
  ...NO_RELEASE_FILTERS,
  ...overrides,
})

describe('filterReleases', () => {
  it('returns everything when no filter is set', () => {
    expect(filterReleases(all, NO_RELEASE_FILTERS)).toHaveLength(5)
  })

  it('filters by title text', () => {
    expect(filterReleases(all, withFilters({ text: 'Todo a la vez' }))).toEqual([spanish])
  })

  it('ignores case in the text filter', () => {
    expect(filterReleases(all, withFilters({ text: 'EVERYTHING' }))).toHaveLength(4)
  })

  it('filters by a single quality', () => {
    expect(filterReleases(all, withFilters({ qualities: new Set(['SDTV']) }))).toEqual([noSeeders])
  })

  it('treats multiple qualities as OR', () => {
    const result = filterReleases(
      all,
      withFilters({ qualities: new Set(['Remux-2160p', 'SDTV']) }),
    )

    expect(result).toEqual([english4k, noSeeders])
  })

  it('matches a release carrying any of the selected languages', () => {
    // `italianEnglish` carries both Italian and English, so it passes either way.
    expect(filterReleases(all, withFilters({ languages: new Set(['Italian']) }))).toEqual([
      italianEnglish,
    ])
    expect(filterReleases(all, withFilters({ languages: new Set(['English']) }))).toEqual([
      english4k,
      english1080,
      italianEnglish,
    ])
  })

  it('filters by minimum seeders', () => {
    expect(filterReleases(all, withFilters({ minSeeders: 10 }))).toEqual([english4k, english1080])
  })

  it('excludes zero-seeder releases with a positive minimum', () => {
    expect(filterReleases(all, withFilters({ minSeeders: 1 }))).toEqual([
      english4k,
      english1080,
      spanish,
    ])
  })

  it('combines dimensions with AND', () => {
    const result = filterReleases(
      all,
      withFilters({
        languages: new Set(['English']),
        qualities: new Set(['Remux-2160p']),
        minSeeders: 20,
      }),
    )

    expect(result).toEqual([english4k])
  })

  it('returns nothing when filters are mutually exclusive', () => {
    expect(
      filterReleases(all, withFilters({ languages: new Set(['Spanish']), qualities: new Set(['SDTV']) })),
    ).toEqual([])
  })

  it('does not mutate the input list', () => {
    const before = [...all]

    filterReleases(all, withFilters({ minSeeders: 999 }))

    expect(all).toEqual(before)
  })
})

describe('collectQualities / collectLanguages', () => {
  it('lists distinct qualities sorted', () => {
    expect(collectQualities(all)).toEqual([
      'Bluray-1080p',
      'Remux-2160p',
      'SDTV',
      'WEBDL-1080p',
      'WEBDL-720p',
    ])
  })

  it('lists distinct languages sorted across multi-language releases', () => {
    expect(collectLanguages(all)).toEqual([
      'English',
      'Italian',
      'Russian',
      'Spanish',
      'Ukrainian',
      'Unknown',
    ])
  })

  it('is derived from the full set, so options survive filtering', () => {
    const filtered = filterReleases(all, withFilters({ languages: new Set(['Spanish']) }))

    // The visible list has one item, but the options must still offer them all.
    expect(filtered).toHaveLength(1)
    expect(collectQualities(all)).toContain('Remux-2160p')
  })

  it('handles an empty list', () => {
    expect(collectQualities([])).toEqual([])
    expect(collectLanguages([])).toEqual([])
  })
})

describe('hasActiveFilters', () => {
  it('is false for the pristine state', () => {
    expect(hasActiveFilters(NO_RELEASE_FILTERS)).toBe(false)
  })

  it('is false for whitespace-only text', () => {
    expect(hasActiveFilters(withFilters({ text: '   ' }))).toBe(false)
  })

  it('is true for each dimension independently', () => {
    expect(hasActiveFilters(withFilters({ text: 'a' }))).toBe(true)
    expect(hasActiveFilters(withFilters({ qualities: new Set(['SDTV']) }))).toBe(true)
    expect(hasActiveFilters(withFilters({ languages: new Set(['English']) }))).toBe(true)
    expect(hasActiveFilters(withFilters({ minSeeders: 1 }))).toBe(true)
  })

  it('is true for a minimum of zero only when text/quality/language are set', () => {
    expect(hasActiveFilters(withFilters({ minSeeders: 0 }))).toBe(false)
  })
})

describe('toggleInSet', () => {
  it('adds an absent value', () => {
    expect([...toggleInSet(new Set(), 'SDTV')]).toEqual(['SDTV'])
  })

  it('removes a present value', () => {
    expect([...toggleInSet(new Set(['SDTV']), 'SDTV')]).toEqual([])
  })

  it('does not mutate the original set', () => {
    const original = new Set(['SDTV'])

    toggleInSet(original, 'WEBDL-1080p')

    expect([...original]).toEqual(['SDTV'])
  })
})

describe('releaseKey', () => {
  it('uses the guid', () => {
    expect(releaseKey(spanish)).toBe('es')
  })
})

describe('select-all integration with the filter', () => {
  it('selects only the filtered releases, never the hidden ones', () => {
    const filters = withFilters({ languages: new Set(['Spanish']) })
    const visible = filterReleases(all, filters)

    const selected = toggleVisibleSelection(new Set<string>(), visible, releaseKey)

    expect([...selected]).toEqual(['es'])
    expect(selected.has('en-1080')).toBe(false)
  })

  it('keeps a hidden selection when toggling the visible subset off', () => {
    const filters = withFilters({ languages: new Set(['Spanish']) })
    const visible = filterReleases(all, filters)
    // The user selected an English release, then narrowed to Spanish.
    const selected = new Set(['en-1080', 'es'])

    const next = toggleVisibleSelection(selected, visible, releaseKey)

    expect(next.has('en-1080')).toBe(true)
    expect(next.has('es')).toBe(false)
  })
})
