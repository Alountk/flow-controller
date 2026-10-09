import { describe, it, expect } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import type { ActionKey, ActionMeta, Trace } from '../../../shared/types.ts'
import { TraceActions } from '../../../features/trace-actions/TraceActions.tsx'

/**
 * "Cancelar descarga" on an in-flight download.
 *
 * Pause was the only thing a downloading trace could do: cancelling — the
 * arr stops tracking it AND the client drops it with its partial files —
 * did not exist. Destructive, so safe mode blocks it like every other
 * destructive action, and it asks for the confirmation that names the files.
 */

const CANCEL_META: ActionMeta = {
  key: 'cancel_download',
  label: 'Cancelar descarga',
  description: 'Quita la descarga en curso del cliente (con sus ficheros) y de la cola del arr',
  destructive: true,
  scope: 'amutorrent+arr',
}

const meta = { cancel_download: CANCEL_META } as Record<ActionKey, ActionMeta>

function trace(overrides: Partial<Trace> = {}): Trace {
  return {
    source: 'radarr',
    title: 'Some Movie',
    date: null,
    indexer: null,
    download_client: null,
    download_client_host: null,
    download_id: 'abc123',
    matched_hash: 'abc123def456abc123def456abc123def456abcd',
    stage: 'downloading',
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

function renderActions(t: Trace, safeMode = false) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return render(
    <QueryClientProvider client={client}>
      <TraceActions trace={t} meta={meta} safeMode={safeMode} onDone={() => {}} />
    </QueryClientProvider>,
  )
}

describe('"Cancelar descarga" visibility', () => {
  it('is offered on a downloading trace that has a client hash', () => {
    renderActions(trace())

    expect(screen.getByRole('button', { name: 'Cancelar descarga' })).toBeInTheDocument()
  })

  it('is not offered without a client hash — there would be nothing to cancel in the client', () => {
    renderActions(trace({ matched_hash: null }))

    expect(screen.queryByRole('button', { name: 'Cancelar descarga' })).not.toBeInTheDocument()
  })

  it('is not offered on stages that are no longer in flight', () => {
    renderActions(trace({ stage: 'sent' }))

    expect(screen.queryByRole('button', { name: 'Cancelar descarga' })).not.toBeInTheDocument()
  })

  it('is blocked in safe mode, like every destructive action', () => {
    renderActions(trace(), true)

    expect(screen.getByRole('button', { name: 'Cancelar descarga' })).toBeDisabled()
  })

  it('asks for the confirmation that names the files before acting', () => {
    renderActions(trace())

    fireEvent.click(screen.getByRole('button', { name: 'Cancelar descarga' }))

    const modal = document.querySelector('.modal')
    expect(modal).not.toBeNull()
    // The dialog names the action it is about to run (the trigger button on
    // screen says the same words — a document-wide query would be ambiguous).
    expect(modal).toHaveTextContent('Cancelar descarga')
  })
})
