/**
 * sse-events T3 — server events → react-query invalidations.
 *
 * Opens ONE `EventSource` against `/api/events` and maps each event kind to
 * the query key that surface actually uses. The polling fallback stays the
 * safety net for every query SSE does not cover — this hook accelerates a
 * refresh first (nginx buffering burned this deployment once, so the net
 * stays until SSE is proven in prod), and B1 only lets the TASK queries
 * covered in full sleep while the stream reports connected (see below).
 *
 * Auth: `EventSource` cannot send headers, but the browser sends the login's
 * HttpOnly session cookie by itself, so the URL carries nothing secret.
 *
 * GATE: the stream opens only once the page is signed in. Before that a
 * connection would 401 and EventSource would retry ~every 3 s, filling C-05's
 * AUTH_FAILURE_LIMIT (10/60 s per address) and 429-ing the browser's OTHER
 * requests — a broken stream must cost nothing. `enabled` is part of the
 * effect deps, so signing out closes the stream and signing in opens it.
 *
 * Feature detection: jsdom has no `EventSource`, and a hardened browser may
 * have it blocked. Either way this hook must no-op — an app that crashes
 * because push failed would defeat the fallback it is accelerating.
 *
 * B1 — connection status: this hook OWNS the EventSource, so it is the only
 * place that knows whether the stream is up, and it reports that through
 * `EventStreamContext`. `open` → connected (a reconnect after an error is an
 * `open` too, and counts as connected), `error`/cleanup → disconnected. The
 * context's DEFAULT is `disconnected`, so a component rendered with no
 * provider around it — every existing test, every early-return screen — keeps
 * today's polling exactly as it is. Consumers flip their task
 * `refetchInterval` to `false` only while `connected` is true.
 *
 * B2 — ambient events: `status` invalidates `['status']` the same way
 * `trace` invalidates `['trace']`, so App's own 5 s/15 s polls can sleep on
 * the stream too — the backend announces both (the health check publishes
 * after every check, the trace refresher on the TTL).
 */

import { createContext, useEffect, useMemo, useState } from 'react'
import { useQueryClient } from '@tanstack/react-query'

export interface EventStreamStatus {
  connected: boolean
}

/** Default `disconnected`: no provider mounted → every poll stays as today. */
export const EventStreamContext = createContext<EventStreamStatus>({ connected: false })

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

export function useEventStream(enabled: boolean): EventStreamStatus {
  const queryClient = useQueryClient()
  // B1: the latest stream event wins — `open` true, `error`/close false.
  const [connected, setConnected] = useState(false)

  useEffect(() => {
    if (!enabled) return // auth pending: polling fallback covers everything
    if (typeof EventSource === 'undefined') return // blocked or non-browser: polling stands

    const source = new EventSource('/api/events')

    const onOpen = () => setConnected(true)
    const onError = () => setConnected(false)

    const onTask = (event: MessageEvent) => {
      const payload = parsePayload(event.data)
      if (!payload?.channel) return
      const keyOf = CHANNEL_KEYS[payload.channel]
      if (!keyOf) return // no query key exists for this channel
      // The activity table follows operations, which move with tasks (S6).
      void queryClient.invalidateQueries({ queryKey: ['activity'] })
      void queryClient.invalidateQueries({ queryKey: keyOf(payload) })
      // A completed file op rewrites folder contents: refresh every listing
      // surface (panes, FileNavigator modals, panel tabs) over /api/files/browse.
      if (payload.channel === 'copy') {
        void queryClient.invalidateQueries({ queryKey: ['browse'] })
        void queryClient.invalidateQueries({ queryKey: ['files-browse'] })
        void queryClient.invalidateQueries({ queryKey: ['panel-browse'] })
      }
    }

    const onTrace = () => {
      void queryClient.invalidateQueries({ queryKey: ['trace'] })
    }

    const onStatus = () => {
      // B2: `check_all` publishes after every tick and every refresh —
      // this is what lets App's 5 s ['status'] poll sleep on the stream.
      void queryClient.invalidateQueries({ queryKey: ['status'] })
    }

    const onDownloads = () => {
      // The dashboard card reads ['downloads'] and the activity table follows
      // the same snapshot (S6) — both keys accelerate, the polls are fallback.
      void queryClient.invalidateQueries({ queryKey: ['downloads'] })
      void queryClient.invalidateQueries({ queryKey: ['activity'] })
    }

    source.addEventListener('open', onOpen)
    source.addEventListener('error', onError)
    source.addEventListener('task', onTask)
    source.addEventListener('trace', onTrace)
    source.addEventListener('status', onStatus)
    source.addEventListener('downloads', onDownloads)

    return () => {
      source.removeEventListener('open', onOpen)
      source.removeEventListener('error', onError)
      source.removeEventListener('task', onTask)
      source.removeEventListener('trace', onTrace)
      source.removeEventListener('status', onStatus)
      source.removeEventListener('downloads', onDownloads)
      source.close() // native EventSource retry only helps a connection it holds
      // This effect's stream is gone (logout, key change, unmount): nothing
      // covers task events until a replacement stream reports `open`.
      setConnected(false)
    }
  }, [queryClient, enabled])

  // Memoized so a re-render of App that does not flip `connected` hands the
  // provider the same object and the gated consumers do not re-render.
  return useMemo(() => ({ connected }), [connected])
}
