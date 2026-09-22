import { describe, it, expect } from 'vitest'
import { render, screen } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import type { ActionKey, ActionMeta, Trace } from '../types'
import { TraceActions } from '../components/TraceActions'

/**
 * "Reintentar import" must show even when the arr queue item is gone.
 *
 * The action sends ProcessMonitoredDownloads — a command with no arguments —
 * so it needs no `queue_id`. It used to be guarded by `if (queueId)`, which
 * hid it exactly when the queue item had vanished and the retry mattered most.
 */

const RETRY_META: ActionMeta = {
  key: 'retry_import',
  label: 'Reintentar import',
  description: 'Vuelve a lanzar el import en el arr',
  destructive: false,
  scope: 'import',
}

const meta = { retry_import: RETRY_META } as Record<ActionKey, ActionMeta>

function trace(overrides: Partial<Trace> = {}): Trace {
  return {
    source: 'radarr',
    title: 'Some Movie',
    date: null,
    indexer: null,
    download_client: null,
    download_client_host: null,
    download_id: 'abc123',
    matched_hash: null,
    stage: 'import_blocked',
    torrent: null,
    expected_category: null,
    category_ok: null,
    paused: false,
    ids: { queue_id: null, episode_id: null, movie_id: 1, series_id: null },
    destination: null,
    queue: null,
    ...overrides,
  }
}

function renderActions(t: Trace) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return render(
    <QueryClientProvider client={client}>
      <TraceActions trace={t} meta={meta} safeMode={false} onDone={() => {}} />
    </QueryClientProvider>,
  )
}

describe('"Reintentar import" visibility', () => {
  it('is shown on an import_blocked trace whose queue_id is null', () => {
    renderActions(trace())

    expect(screen.getByRole('button', { name: 'Reintentar import' })).toBeInTheDocument()
  })

  it('is still shown when the queue item exists', () => {
    renderActions(trace({ ids: { queue_id: 42, episode_id: null, movie_id: 1, series_id: null } }))

    expect(screen.getByRole('button', { name: 'Reintentar import' })).toBeInTheDocument()
  })

  it('is not shown for stages that do not offer it', () => {
    renderActions(trace({ stage: 'sent' }))

    expect(screen.queryByRole('button', { name: 'Reintentar import' })).not.toBeInTheDocument()
  })
})
