/**
 * sse-events T3 — server events → react-query invalidations.
 *
 * Opens ONE `EventSource` against `/api/events` and maps each event kind to
 * the query key that surface actually uses. The polling fallback is
 * deliberately untouched: this hook accelerates a refresh, it never replaces
 * `refetchInterval` (documented exclusion — nginx buffering burned this
 * deployment once, and the safety net stays until SSE is proven in prod).
 *
 * Auth: `EventSource` cannot send headers, so the key rides as `?key=` —
 * the same key `apiFetch` would put in `X-Api-Key`, read through the same
 * `getApiKey`.
 *
 * GATE: the stream opens only when auth is already satisfied — a key is
 * stored, OR auth is disabled (`authRequired === false`, the same
 * `auth_required` config `AuthGate` and `apiFetch` act on). Before login
 * (auth required, no key) a connection would 401 and EventSource would retry
 * ~every 3 s, filling C-05's AUTH_FAILURE_LIMIT (10/60 s per address) and
 * 429-ing the browser's OTHER requests — a broken stream must cost nothing.
 * `enabled` is part of the effect deps, so flipping auth closed the stream
 * (logout) and appearing key opens it (login): the key stays the secondary
 * trigger it always was.
 *
 * Feature detection: jsdom has no `EventSource`, and a hardened browser may
 * have it blocked. Either way this hook must no-op — an app that crashes
 * because push failed would defeat the fallback it is accelerating.
 */

import { useEffect } from 'react'
import { useQueryClient } from '@tanstack/react-query'
import { getApiKey } from '../api/auth.ts'

interface TaskEvent {
  kind?: string
  channel?: string
  task_id?: string
  status?: string
  detail?: string | null
}

/**
 * Channel → the query key that surface polls today (grep-verified).
 *
 * A channel absent from this map has no query key in use, so there is
 * nothing to invalidate — skip it rather than invent a key.
 */
const CHANNEL_KEYS: Record<string, (event: TaskEvent) => unknown[]> = {
  grab: (event) => ['grab-task', event.task_id],
  release: (event) => ['release-task', event.task_id],
  copy: (event) => ['task', event.task_id],
  mixer: () => ['mixer-tasks'],
}

function parsePayload(data: string): TaskEvent | null {
  try {
    const parsed: unknown = JSON.parse(data)
    if (parsed && typeof parsed === 'object') return parsed as TaskEvent
  } catch {
    // A malformed frame is the server's bug, never a reason to break the page.
  }
  return null
}

export function useEventStream(authRequired: boolean): void {
  const queryClient = useQueryClient()
  // Read at render time: logging in re-renders App, which re-runs the effect
  // and reopens the stream WITH the key the first connection never had.
  const apiKey = getApiKey()
  // Condition (a) a key exists, or (b) auth is disabled — nothing else may
  // open the stream (see the GATE note above).
  const enabled = Boolean(apiKey) || !authRequired

  useEffect(() => {
    if (!enabled) return // auth pending: polling fallback covers everything
    if (typeof EventSource === 'undefined') return // blocked or non-browser: polling stands

    const url = apiKey ? `/api/events?key=${encodeURIComponent(apiKey)}` : '/api/events'
    const source = new EventSource(url)

    const onTask = (event: MessageEvent) => {
      const payload = parsePayload(event.data)
      if (!payload?.channel) return
      const keyOf = CHANNEL_KEYS[payload.channel]
      if (!keyOf) return // no query key exists for this channel
      void queryClient.invalidateQueries({ queryKey: keyOf(payload) })
    }

    const onTrace = () => {
      void queryClient.invalidateQueries({ queryKey: ['trace'] })
    }

    const onDownloads = () => {
      // Documented exclusion: nothing in the frontend polls /api/downloads
      // yet, so there is no key to invalidate. Do not invent one here.
    }

    source.addEventListener('task', onTask)
    source.addEventListener('trace', onTrace)
    source.addEventListener('downloads', onDownloads)

    return () => {
      source.removeEventListener('task', onTask)
      source.removeEventListener('trace', onTrace)
      source.removeEventListener('downloads', onDownloads)
      source.close() // native EventSource retry only helps a connection it holds
    }
  }, [queryClient, apiKey, enabled])
}
