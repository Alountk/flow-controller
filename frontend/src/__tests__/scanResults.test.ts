import { describe, it, expect } from 'vitest'
import {
  areAllVisibleSelected,
  filterScanMatches,
  toggleVisibleSelection,
} from '../utils/scanResults'
import type { ScanMatch } from '../types'

function makeMatch(overrides: Partial<ScanMatch> = {}): ScanMatch {
  return {
    file_path: '/mnt/storage/downloads/file.mkv',
    file_name: 'file.mkv',
    movie_id: 813,
    movie_title: 'Your Name.',
    movie_year: 2016,
    target_path: '/mnt/storage/movies/Your Name. (2016)',
    score: 0.87,
    matched_title: 'Your Name.',
    ...overrides,
  }
}

const tonNom = makeMatch({
  file_path: '/mnt/storage/downloads/Ton Nom (2016).mkv',
  file_name: 'Ton Nom (2016).mkv',
  matched_title: 'Ton Nom',
})

const seuNome = makeMatch({
  file_path: '/mnt/storage/downloads/Seu Nome (2016).mkv',
  file_name: 'Seu Nome (2016).mkv',
  matched_title: 'Seu Nome',
})

const primary = makeMatch()

const all = [primary, tonNom, seuNome]

describe('filterScanMatches', () => {
  it('returns everything for an empty or blank query', () => {
    expect(filterScanMatches(all, '')).toHaveLength(3)
    expect(filterScanMatches(all, '   ')).toHaveLength(3)
  })

  it('matches on the file name', () => {
    expect(filterScanMatches(all, 'Ton Nom')).toEqual([tonNom])
  })

  it('matches on the alternate title even when the file name differs', () => {
    expect(filterScanMatches(all, 'seu nome')).toEqual([seuNome])
  })

  it('matches the item title shared by every result', () => {
    // All three results belong to the same movie, so its title matches them all.
    expect(filterScanMatches(all, 'Your Name')).toHaveLength(3)
  })

  it('matches the parent folder of the path', () => {
    expect(filterScanMatches(all, 'downloads')).toHaveLength(3)
  })

  it('ignores case', () => {
    expect(filterScanMatches(all, 'TON nOM')).toEqual([tonNom])
  })

  it('ignores accents in both the query and the field', () => {
    const accented = makeMatch({
      file_path: '/mnt/storage/downloads/Ámélie.mkv',
      file_name: 'Ámélie.mkv',
    })

    expect(filterScanMatches([accented], 'amelie')).toEqual([accented])
    expect(filterScanMatches([accented], 'ámélie')).toEqual([accented])
  })

  it('matches CJK titles', () => {
    const cjk = makeMatch({
      file_path: '/mnt/storage/downloads/你的名字 (2016).mkv',
      file_name: '你的名字 (2016).mkv',
      matched_title: '你的名字',
    })

    expect(filterScanMatches([cjk], '你的名字')).toEqual([cjk])
  })

  it('returns nothing when nothing matches', () => {
    expect(filterScanMatches(all, 'zzzzz')).toEqual([])
  })
})

describe('areAllVisibleSelected', () => {
  it('is false when nothing is visible', () => {
    expect(areAllVisibleSelected(new Set(), [])).toBe(false)
  })

  it('is false when only some visible matches are selected', () => {
    expect(areAllVisibleSelected(new Set([primary.file_path]), all)).toBe(false)
  })

  it('is true when every visible match is selected', () => {
    const selected = new Set(all.map((m) => m.file_path))

    expect(areAllVisibleSelected(selected, all)).toBe(true)
  })

  it('ignores selection outside the visible set', () => {
    const selected = new Set([tonNom.file_path])
    const visible = [tonNom]

    expect(areAllVisibleSelected(selected, visible)).toBe(true)
  })
})

describe('toggleVisibleSelection', () => {
  it('selects every visible match', () => {
    const result = toggleVisibleSelection(new Set(), [tonNom, seuNome])

    expect([...result].sort()).toEqual([seuNome.file_path, tonNom.file_path].sort())
  })

  it('deselects every visible match when they are all selected', () => {
    const selected = new Set([tonNom.file_path, seuNome.file_path])

    expect(toggleVisibleSelection(selected, [tonNom, seuNome]).size).toBe(0)
  })

  it('never touches matches hidden by the filter', () => {
    // `primary` stays selected even though it is not part of the visible set.
    const selected = new Set([primary.file_path])

    const result = toggleVisibleSelection(selected, [tonNom, seuNome])

    expect(result.has(primary.file_path)).toBe(true)
    expect(result.has(tonNom.file_path)).toBe(true)
    expect(result.has(seuNome.file_path)).toBe(true)
  })

  it('deselecting the visible subset keeps hidden selections', () => {
    const selected = new Set([primary.file_path, tonNom.file_path, seuNome.file_path])

    const result = toggleVisibleSelection(selected, [tonNom, seuNome])

    expect(result.has(primary.file_path)).toBe(true)
    expect(result.has(tonNom.file_path)).toBe(false)
    expect(result.has(seuNome.file_path)).toBe(false)
  })

  it('round-trips: select then deselect restores the original selection', () => {
    const original = new Set([primary.file_path])

    const selectedAll = toggleVisibleSelection(original, [tonNom, seuNome])
    const back = toggleVisibleSelection(selectedAll, [tonNom, seuNome])

    expect([...back]).toEqual([...original])
  })
})
