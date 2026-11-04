import { describe, expect, it } from 'vitest'
import casesJson from '../../../../contracts/resolution-cases.json'
import {
  best,
  fromDimensions,
  fromName,
  resolutionClass,
} from '../../shared/utils/resolution.ts'

/**
 * La misma tabla que lee `backend/tests/domain/tests_resolution.py` (S6). Si un
 * lado se mueve y el otro no, es aquí donde se ve.
 */
const CASES = casesJson.cases as Array<{
  why: string
  name: string
  width: number
  height: number
  resolved: string
  bucket: string
}>

/** El bucket de la lista de V2: lo que no se puede demostrar es `otros`. */
function bucketOf(resolved: string): string {
  return ({ '2160': '4K', '1080': '1080', '720': 'SD', '576': 'SD', '480': 'SD' } as Record<string, string>)[resolved] ?? 'otros'
}

describe('la tabla compartida con el backend', () => {
  for (const c of CASES) {
    it(`${c.name.slice(0, 46)} → ${c.bucket} (${c.why.slice(0, 40)}…)`, () => {
      const measured = fromDimensions(c.width, c.height)
      const resolved = best(measured, c.name)

      expect(resolved).toBe(c.resolved)
      expect(bucketOf(measured || resolved)).toBe(c.bucket)
    })
  }
})

describe('fromName', () => {
  it('reads the tokens the backend reads', () => {
    expect(fromName('Bluray-2160p')).toBe('2160')
    expect(fromName('Alien [4K]')).toBe('2160')
    expect(fromName('WEBDL-1080p')).toBe('1080')
    expect(fromName('Bluray-1080i')).toBe('1080')
    expect(fromName('HDTV-720p')).toBe('720')
    expect(fromName('DVD')).toBe('480')
    expect(fromName('sin resolucion')).toBe('')
    expect(fromName(null)).toBe('')
  })
})

describe('resolutionClass', () => {
  it('a 1920×800 file is 1080p, not sd', () => {
    // El umbral de ancho es el que salva al 2.39:1 recortado.
    expect(resolutionClass(1920, 800)).toBe('1080p')
  })

  it('a 4K cinemascope file is 4k', () => {
    expect(resolutionClass(3840, 1606)).toBe('4k')
  })

  it('a pillarboxed transfer is 4k by its height', () => {
    expect(resolutionClass(2880, 2160)).toBe('4k')
  })

  it('an unmeasured file is unknown, never sd', () => {
    expect(resolutionClass(0, 0)).toBe('desconocido')
    expect(resolutionClass(null)).toBe('desconocido')
  })
})
