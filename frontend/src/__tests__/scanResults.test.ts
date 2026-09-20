import { describe, it, expect } from 'vitest'
import { filterScanMatches } from '../utils/scanResults'
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
