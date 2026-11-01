import { describe, it, expect } from 'vitest'
import { nextSort, sortReleases, type SortState } from '../../../shared/utils/releaseTable.ts'

/**
 * S3 («buscador-tabla»): the results table sorts by name, size, language and
 * seeders, both directions, deterministically — and a fact a row does not
 * carry sinks to the bottom instead of pretending to be zero.
 */

const row = (title: string, over: Record<string, unknown> = {}) => ({
  guid: title,
  title,
  size: 1_000,
  languages: ['Castellano'],
  seeders: 10,
  ...over,
})

const titles = (rows: Array<{ title: string }>) => rows.map((r) => r.title)

describe('S3 · ordenación de la tabla', () => {
  it('leaves the rows untouched while no column is chosen', () => {
    const rows = [row('b'), row('a')]
    expect(sortReleases(rows, { key: null, dir: 'asc' })).toBe(rows)
  })

  it('sorts by name in both directions', () => {
    const rows = [row('Dune'), row('Alien'), row('Coraline')]
    expect(titles(sortReleases(rows, { key: 'name', dir: 'asc' }))).toEqual(['Alien', 'Coraline', 'Dune'])
    expect(titles(sortReleases(rows, { key: 'name', dir: 'desc' }))).toEqual(['Dune', 'Coraline', 'Alien'])
  })

  it('sorts by size numerically, not as text', () => {
    const rows = [row('small', { size: 900 }), row('big', { size: 10_000 }), row('mid', { size: 2_000 })]
    expect(titles(sortReleases(rows, { key: 'size', dir: 'asc' }))).toEqual(['small', 'mid', 'big'])
  })

  it('sorts by seeders and keeps rows without seeders at the bottom', () => {
    const rows = [row('unknown', { seeders: undefined }), row('low', { seeders: 2 }), row('high', { seeders: 300 })]
    expect(titles(sortReleases(rows, { key: 'seeders', dir: 'desc' }))).toEqual(['high', 'low', 'unknown'])
    expect(titles(sortReleases(rows, { key: 'seeders', dir: 'asc' }))).toEqual(['low', 'high', 'unknown'])
  })

  it('sorts by language label and keeps rows without languages at the bottom', () => {
    const rows = [
      row('none', { languages: [] }),
      row('ingles', { languages: ['Inglés'] }),
      row('castellano', { languages: ['Castellano'] }),
    ]
    expect(titles(sortReleases(rows, { key: 'language', dir: 'asc' }))).toEqual([
      'castellano', 'ingles', 'none',
    ])
  })

  it('is stable: equal values keep a deterministic title order', () => {
    const rows = [row('zz', { seeders: 5 }), row('aa', { seeders: 5 })]
    expect(titles(sortReleases(rows, { key: 'seeders', dir: 'desc' }))).toEqual(['aa', 'zz'])
  })

  it('never mutates the array it is given', () => {
    const rows = [row('Dune'), row('Alien')]
    sortReleases(rows, { key: 'name', dir: 'asc' })
    expect(titles(rows)).toEqual(['Dune', 'Alien'])
  })

  it('toggles direction on the same column and resets it on a new one', () => {
    const first = nextSort({ key: null, dir: 'asc' }, 'size')
    expect(first).toEqual<SortState>({ key: 'size', dir: 'asc' })
    expect(nextSort(first, 'size')).toEqual<SortState>({ key: 'size', dir: 'desc' })
    expect(nextSort({ key: 'size', dir: 'desc' }, 'name')).toEqual<SortState>({ key: 'name', dir: 'asc' })
  })
})
