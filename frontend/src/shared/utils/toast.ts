import { useSyncExternalStore } from 'react'

/**
 * Toasts, with zero dependencies — the study (F-13) before building:
 *
 * react-hot-toast (~8 kB) and sonner (~4 kB) buy promises, swipe-down,
 * rich markup and position drags — none of which this app needs. What it
 * needs is a stack of short, tone-tagged messages that announce themselves
 * and go away: ~90 lines on top of React's own `useSyncExternalStore`,
 * keeping the runtime dependency list exactly as it has always been
 * (react, react-dom, @tanstack/react-query).
 *
 * The store is module-global on purpose: toasts are an AMBIENT surface —
 * a grab inside a modal, a sweep inside a page, both must reach one
 * viewport mounted at the app root.
 */

export type ToastTone = 'ok' | 'error'

export interface Toast {
  id: number
  message: string
  tone: ToastTone
}

/** The stack is a summary, not an archive: the oldest steps aside. */
const MAX = 4

/** Errors linger — they are the ones you stopped reading. */
const TTL: Record<ToastTone, number> = { ok: 4000, error: 9000 }

let nextId = 1
let items: Toast[] = []
const listeners = new Set<() => void>()
const timers = new Map<number, ReturnType<typeof setTimeout>>()

function emit(): void {
  for (const listener of listeners) listener()
}

function clearTimer(id: number): void {
  const timer = timers.get(id)
  if (timer !== undefined) {
    clearTimeout(timer)
    timers.delete(id)
  }
}

/** Queue a message. Returns its id so the caller can dismiss it early. */
export function toast(message: string, tone: ToastTone = 'ok'): number {
  const id = nextId++
  const evicted = items.length >= MAX ? items.slice(0, items.length - MAX + 1) : []
  items = [...items.filter((t) => !evicted.includes(t)), { id, message, tone }]
  for (const gone of evicted) clearTimer(gone.id)
  timers.set(id, setTimeout(() => dismissToast(id), TTL[tone]))
  emit()
  return id
}

/** Remove one toast (by click or by id). A no-op for an unknown id. */
export function dismissToast(id: number): void {
  if (!items.some((t) => t.id === id)) return
  items = items.filter((t) => t.id !== id)
  clearTimer(id)
  emit()
}

/** Test teardown — and the honest "forget everything" hook if logout ever needs one. */
export function clearToasts(): void {
  for (const t of items) clearTimer(t.id)
  items = []
  emit()
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

function snapshot(): Toast[] {
  return items
}

/** The current stack; re-renders on every change. */
export function useToasts(): Toast[] {
  return useSyncExternalStore(subscribe, snapshot, snapshot)
}

/** The same truth without a component — what the tests read. */
export function getToasts(): Toast[] {
  return snapshot()
}
