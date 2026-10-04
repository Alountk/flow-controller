import { describe, it, expect } from 'vitest'
import { looksThreeD } from '../../utils/threeD'

/**
 * The suggestion the UI shows before anyone touches it. Its only hard
 * requirement is that it must not fire on ordinary words — a false positive
 * sends a film to the wrong folder, and the operator has to notice.
 */
describe('looksThreeD', () => {
  it.each([
    'Movie.2020.3D.HSBS.1080p.BluRay',
    'Otra Pelicula 2019 2160p 3D HTAB',
    'Película 2021 SBS 1080p',
    'Show 3DTV 720p',
  ])('recognises %s as 3D', (title) => {
    expect(looksThreeD(title)).toBe(true)
  })

  it.each([
    'Everything Everywhere All at Once 2022 1080p BluRay',
    'Todo a la vez en todas partes 2022 1080p',
    'Absorb The Light 2023 2160p WEB-DL',
    'Movie 3Dish but not really 1080p',
  ])('does not recognise %s as 3D', (title) => {
    expect(looksThreeD(title)).toBe(false)
  })

  it('is case insensitive', () => {
    expect(looksThreeD('PELICULA 3d 1080p')).toBe(true)
  })
})
