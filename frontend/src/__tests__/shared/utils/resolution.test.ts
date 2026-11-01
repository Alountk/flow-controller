import { describe, it, expect } from 'vitest'
import { classRank, isBelowThreshold, resolutionClass } from '../../../shared/utils/resolution.ts'

/**
 * S1/S3 («umbral-calidad»): the class comes from the WIDTH, so a 1080p
 * transfer with cropped black bars (1920×800) is still a 1080p file and must
 * never be flagged as low quality.
 */

describe('S1 · clase por ancho', () => {
  it.each([
    [1920, '1080p'],
    [3840, '4k'],
    [1280, '720p'],
    [720, 'sd'],
    [0, 'desconocido'],
  ])('%i wide → %s', (width, expected) => {
    expect(resolutionClass(width)).toBe(expected)
  })

  it('ranks the classes and sinks the unknown one', () => {
    expect(classRank('sd')).toBeLessThan(classRank('720p'))
    expect(classRank('720p')).toBeLessThan(classRank('1080p'))
    expect(classRank('1080p')).toBeLessThan(classRank('4k'))
    expect(classRank('desconocido')).toBeLessThan(classRank('sd'))
  })
})

describe('S3 · comparación con el umbral', () => {
  it('never flags a cropped 1080p file under the default threshold', () => {
    expect(isBelowThreshold(1920, '1080p', 0)).toBe(false)
  })

  it('flags a 720p file under a 1080p threshold', () => {
    expect(isBelowThreshold(1280, '1080p', 0)).toBe(true)
  })

  it('keeps a 720p file when the operator accepts 720p', () => {
    expect(isBelowThreshold(1280, '720p', 0)).toBe(false)
  })

  it('lets a manual width override the class', () => {
    expect(isBelowThreshold(1920, '1080p', 2000)).toBe(true)
    expect(isBelowThreshold(2560, '1080p', 2000)).toBe(false)
  })

  it('never flags an unmeasured file', () => {
    expect(isBelowThreshold(0, '1080p', 2000)).toBe(false)
  })
})
