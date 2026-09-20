import { describe, it, expect } from 'vitest'
import { areAllVisibleSelected, toggleVisibleSelection } from '../utils/selection'

interface Item {
  id: string
}

const keyOf = (item: Item) => item.id

const a: Item = { id: 'a' }
const b: Item = { id: 'b' }
const c: Item = { id: 'c' }

describe('areAllVisibleSelected', () => {
  it('is false when nothing is visible', () => {
    expect(areAllVisibleSelected(new Set(), [], keyOf)).toBe(false)
  })

  it('is false when only some visible items are selected', () => {
    expect(areAllVisibleSelected(new Set(['a']), [a, b, c], keyOf)).toBe(false)
  })

  it('is true when every visible item is selected', () => {
    expect(areAllVisibleSelected(new Set(['a', 'b', 'c']), [a, b, c], keyOf)).toBe(true)
  })

  it('ignores selection outside the visible set', () => {
    expect(areAllVisibleSelected(new Set(['a', 'hidden']), [a], keyOf)).toBe(true)
  })

  it('is false for a non-empty visible set with an empty selection', () => {
    expect(areAllVisibleSelected(new Set(), [a], keyOf)).toBe(false)
  })
})

describe('toggleVisibleSelection', () => {
  it('selects every visible item', () => {
    const result = toggleVisibleSelection(new Set(), [a, b], keyOf)

    expect([...result].sort()).toEqual(['a', 'b'])
  })

  it('deselects every visible item when they are all selected', () => {
    const result = toggleVisibleSelection(new Set(['a', 'b']), [a, b], keyOf)

    expect(result.size).toBe(0)
  })

  it('never touches items hidden by the filter', () => {
    // `c` stays selected even though it is not part of the visible set.
    const result = toggleVisibleSelection(new Set(['c']), [a, b], keyOf)

    expect(result.has('c')).toBe(true)
    expect(result.has('a')).toBe(true)
    expect(result.has('b')).toBe(true)
  })

  it('deselecting the visible subset keeps hidden selections', () => {
    const result = toggleVisibleSelection(new Set(['a', 'b', 'c']), [a, b], keyOf)

    expect(result.has('c')).toBe(true)
    expect(result.has('a')).toBe(false)
    expect(result.has('b')).toBe(false)
  })

  it('round-trips: select then deselect restores the original selection', () => {
    const original = new Set(['c'])

    const selectedAll = toggleVisibleSelection(original, [a, b], keyOf)
    const back = toggleVisibleSelection(selectedAll, [a, b], keyOf)

    expect([...back]).toEqual([...original])
  })

  it('toggling an empty visible set changes nothing', () => {
    const original = new Set(['c'])

    expect([...toggleVisibleSelection(original, [], keyOf)]).toEqual(['c'])
  })
})
