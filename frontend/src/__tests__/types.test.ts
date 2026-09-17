import { describe, it, expect } from 'vitest'
import { STAGE_LABELS } from '../types'

describe('STAGE_LABELS', () => {
  it('has labels for all stages', () => {
    expect(STAGE_LABELS).toBeDefined()
    expect(typeof STAGE_LABELS).toBe('object')
    const keys = Object.keys(STAGE_LABELS)
    expect(keys.length).toBeGreaterThan(0)
  })

  it('each label is a non-empty string', () => {
    for (const [, label] of Object.entries(STAGE_LABELS)) {
      expect(typeof label).toBe('string')
      expect(label.length).toBeGreaterThan(0)
    }
  })
})
