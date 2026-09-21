import { describe, it, expect } from 'vitest'
import { episodeTagKey, formatEpisodeLabel, parseEpisodeTag } from '../utils/episodeTag'

describe('parseEpisodeTag', () => {
  it('accepts the common S##E## spellings', () => {
    expect(parseEpisodeTag('Show.S03E07.1080p.mkv')).toEqual({ season: 3, episode: 7 })
    expect(parseEpisodeTag('show.s3e7.mkv')).toEqual({ season: 3, episode: 7 })
    expect(parseEpisodeTag('Show.S03.E07.mkv')).toEqual({ season: 3, episode: 7 })
    expect(parseEpisodeTag('Show.S03-E07.mkv')).toEqual({ season: 3, episode: 7 })
    expect(parseEpisodeTag('Show.S03 E07.mkv')).toEqual({ season: 3, episode: 7 })
  })

  it('accepts the NxNN spelling', () => {
    expect(parseEpisodeTag('Show.3x07.mkv')).toEqual({ season: 3, episode: 7 })
    expect(parseEpisodeTag('Show.03x07.mkv')).toEqual({ season: 3, episode: 7 })
  })

  it('does not mistake a resolution for an episode', () => {
    // 1920x1080 hides a "20x10" that a naive regex would read as an episode.
    expect(parseEpisodeTag('Movie.2026.1920x1080.mkv')).toBeNull()
  })

  it('returns null when there is no tag', () => {
    expect(parseEpisodeTag('Movie.2026.1080p.mkv')).toBeNull()
    expect(parseEpisodeTag('')).toBeNull()
  })
})

describe('formatEpisodeLabel', () => {
  it('uppercases and zero-pads the tag and joins the known parts', () => {
    expect(
      formatEpisodeLabel({ season: 3, episode: 7, title: 'Of Ice Men', air_date: '2006-11-27T00:00:00Z' }),
    ).toBe('S03E07 · Of Ice Men · 2006-11-27')
  })

  it('omits missing parts', () => {
    expect(formatEpisodeLabel({ season: 3, episode: 7 })).toBe('S03E07')
    expect(formatEpisodeLabel({ season: 3, episode: 7, title: 'Of Ice Men' })).toBe('S03E07 · Of Ice Men')
    expect(formatEpisodeLabel({ season: 3, episode: 7, air_date: '2006-11-27T00:00:00Z' })).toBe('S03E07 · 2006-11-27')
  })
})

describe('episodeTagKey', () => {
  it('zero-pads to S##E##', () => {
    expect(episodeTagKey(3, 7)).toBe('S03E07')
    expect(episodeTagKey(12, 11)).toBe('S12E11')
  })
})
