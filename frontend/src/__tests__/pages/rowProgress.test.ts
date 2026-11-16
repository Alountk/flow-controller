import { describe, expect, it } from 'vitest'
import { rowProgress } from '../../pages/rowProgress.ts'
import type { Trace } from '../../shared/types.ts'
import type { TaskProgress } from '../../features/trace-actions/TraceActions.tsx'

const trace = { torrent: { progress: 100, size: 2000 } } as unknown as Trace
const task = (over: Partial<TaskProgress>): TaskProgress => ({
  task_id: 't', src_path: '', dst_path: '', status: 'running',
  copied_bytes: 500, total_bytes: 2000, files_done: 0, files_total: 1, detail: '', ...over,
})

describe('rowProgress — the one bar of a trace row', () => {
  it('follows the download when nothing is being copied', () => {
    expect(rowProgress(trace, null)).toEqual({ pct: 100, label: '100% — 2.0 KB / 2.0 KB' })
  })

  it('follows the copy while bytes move', () => {
    const p = rowProgress(trace, task({}))
    expect(p.pct).toBe(25)
    expect(p.label).toMatch(/^25% — /)
  })

  it('stays full and says it waits for the arr while importing', () => {
    expect(rowProgress(trace, task({ status: 'importing' }))).toEqual({ pct: 100, label: 'Importando…' })
  })

  it('shows 0% for a copy that has not reported a size yet', () => {
    expect(rowProgress(trace, task({ total_bytes: 0, copied_bytes: 0 })).pct).toBe(0)
  })
})
