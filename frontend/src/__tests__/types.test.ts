import { describe, it, expect } from 'vitest'
import { STAGE_LABELS, parseStatus } from '../types'

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


describe('parseStatus', () => {
  it('parses the known states', () => {
    expect(parseStatus('online:todo bien')).toEqual({ state: 'online', reason: 'todo bien' })
    expect(parseStatus('offline:no responde')).toEqual({ state: 'offline', reason: 'no responde' })
  })

  it('keeps a rejected key distinguishable from a down service', () => {
    // Without this the dashboard would show "unknown", losing the distinction
    // between "the container is down" and "the key is wrong".
    const parsed = parseStatus('misconfigured:API key rechazada (HTTP 401)')

    expect(parsed.state).toBe('misconfigured')
    expect(parsed.reason).toContain('401')
  })

  it('keeps colons inside the reason', () => {
    expect(parseStatus('offline:a:b').reason).toBe('a:b')
  })

  it('falls back to unknown for anything unrecognised', () => {
    expect(parseStatus('weird:thing').state).toBe('unknown')
    expect(parseStatus('').state).toBe('unknown')
    expect(parseStatus(null).state).toBe('unknown')
  })
})
