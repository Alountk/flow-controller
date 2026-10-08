import { it, expect, vi, beforeEach, afterEach } from 'vitest'
import { clearToasts, dismissToast, getToasts, toast } from '../../utils/toast'

/**
 * The toast store (F-13): short, tone-tagged, self-dismissing messages with
 * a capped stack — the whole reason react-hot-toast was studied and not
 * installed.
 */

beforeEach(() => {
  vi.useFakeTimers()
  clearToasts()
})

afterEach(() => {
  clearToasts()
  vi.useRealTimers()
})

it('records a message with its tone, ok by default', () => {
  const id = toast('Descarga encolada')

  expect(getToasts()).toEqual([{ id, message: 'Descarga encolada', tone: 'ok' }])
})

it('keeps errors longer than confirmations', () => {
  toast('hecho')
  toast('fallo', 'error')

  vi.advanceTimersByTime(4000)
  expect(getToasts().map((t) => t.message)).toEqual(['fallo'])

  vi.advanceTimersByTime(5000)
  expect(getToasts()).toEqual([])
})

it('caps the stack, stepping aside with the oldest', () => {
  for (let i = 1; i <= 5; i++) toast(`m${i}`)

  const messages = getToasts().map((t) => t.message)
  expect(messages).toHaveLength(4)
  expect(messages).toEqual(['m2', 'm3', 'm4', 'm5'])

  // The evicted one's timer was cleared with it: expiring the live ones
  // later must not throw on the ghost id.
  vi.advanceTimersByTime(4000)
  expect(getToasts()).toEqual([])
  vi.advanceTimersByTime(60_000)
  expect(getToasts()).toEqual([])
})

it('dismisses by id and ignores an unknown one', () => {
  const id = toast('x')
  dismissToast(id)
  expect(getToasts()).toEqual([])

  expect(() => dismissToast(999)).not.toThrow()
})

it('clearToasts empties the stack and cancels pending timers', () => {
  toast('a')
  toast('b', 'error')
  clearToasts()

  expect(getToasts()).toEqual([])
  vi.advanceTimersByTime(60_000)
  expect(getToasts()).toEqual([])
})
