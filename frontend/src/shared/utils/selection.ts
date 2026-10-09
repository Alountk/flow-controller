/**
 * Keyed selection helpers shared by every filtered list in the app.
 *
 * The rule they exist to enforce: the "select all" control must only ever touch
 * items the user can currently see. Acting on filter-hidden items would act on
 * rows that are not on screen — downloading releases or moving files the user
 * never looked at.
 *
 * Keeping a single implementation matters: two copies of this logic is two
 * chances to drift, and the drift is silent.
 */

/** Whether every visible item is selected. An empty list is never "all selected". */
export function areAllVisibleSelected<T>(
  selected: ReadonlySet<string>,
  visible: readonly T[],
  keyOf: (item: T) => string,
): boolean {
  return visible.length > 0 && visible.every((item) => selected.has(keyOf(item)))
}

/**
 * Compute the next selection when select-all is toggled.
 *
 * Only touches visible items; selections outside the visible set are preserved.
 */
export function toggleVisibleSelection<T>(
  selected: ReadonlySet<string>,
  visible: readonly T[],
  keyOf: (item: T) => string,
): Set<string> {
  const next = new Set(selected)
  const allSelected = areAllVisibleSelected(selected, visible, keyOf)

  for (const item of visible) {
    const key = keyOf(item)
    if (allSelected) next.delete(key)
    else next.add(key)
  }

  return next
}
