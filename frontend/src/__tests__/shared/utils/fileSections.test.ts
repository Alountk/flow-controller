import { describe, it, expect } from 'vitest'
import { classifyFile } from '../../../shared/utils/fileSections.ts'

/**
 * T3 (S1/S4): every file lands in EXACTLY one section — 3D > 4K > 1080 >
 * Otros — from proofs only (name tokens, routing-folder membership), and a
 * tokenless file in the movie's own folder is the library default (1080),
 * never dropped (S4 honesty: unclassifiable stays visible under Otros).
 */

const folders = { path4k: '/mnt/4k', path3d: '/mnt/3d' }
const base = '/peliculas/Film (2012)'

const entry = (name: string, path?: string, extra: Record<string, unknown> = {}) => ({
  name,
  path: path ?? `${base}/${name}`,
  is_dir: false,
  is_video: true,
  ...extra,
})

describe('classifyFile', () => {
  it('files the tokenless movie copy under 1080 — the library default', () => {
    expect(classifyFile(entry('ParaNorman.mkv'), folders, base)).toBe('1080')
  })

  it('reads the 1080p token when the name carries it', () => {
    expect(classifyFile(entry('Film.2012.1080p.BluRay.x264.mkv'), folders, base)).toBe('1080')
  })

  it('reads the 2160p/4k token as 4K, in the base folder too', () => {
    expect(classifyFile(entry('Film.2012.2160p.WEB-DL.mkv'), folders, base)).toBe('4k')
    expect(classifyFile(entry('Film.4K.BluRay.mkv'), folders, base)).toBe('4k')
  })

  it('files any other stated resolution under Otros — it proves neither 1080 nor 4K', () => {
    expect(classifyFile(entry('Film.2012.720p.BluRay.mkv'), folders, base)).toBe('otros')
    expect(classifyFile(entry('Film.DVDRip.mkv'), folders, base)).toBe('otros')
  })

  it('a 3D name token outranks everything else (S1 precedence 3D > 4K)', () => {
    expect(classifyFile(entry('Film.2012.3D.SBS.1080p.mkv'), folders, base)).toBe('3d')
    expect(classifyFile(entry('Film.Full.SBS.mkv'), folders, base)).toBe('3d')
  })

  it('a substring that is not a word edge never claims 3D', () => {
    // ABSORB contains "sbs"; an unbounded match would ship it to the 3D folder.
    expect(classifyFile(entry('Absorb.mkv'), folders, base)).toBe('1080')
  })

  it('membership in the routing folders proves the class', () => {
    expect(classifyFile(entry('Film.mkv', '/mnt/3d/Film (2012)/Film.mkv'), folders, base)).toBe('3d')
    expect(classifyFile(entry('Film.mkv', '/mnt/4k/Film (2012)/Film.mkv'), folders, base)).toBe('4k')
  })

  it('a subtitle proves nothing: non-video entries always land under Otros', () => {
    expect(
      classifyFile(entry('Film.srt', '/mnt/3d/Film (2012)/Film.srt', { is_video: false }), folders, base),
    ).toBe('otros')
    expect(classifyFile(entry('Film.srt', undefined, { is_video: false }), folders, base)).toBe('otros')
  })

  it('directories never claim a class — the panel lists them, ffprobe cannot read them', () => {
    expect(classifyFile(entry('subs', undefined, { is_dir: true }), folders, base)).toBe('otros')
  })
})
