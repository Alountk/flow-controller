import type { Trace } from '../shared/types.ts'
import type { TaskProgress } from '../features/trace-actions/TraceActions.tsx'
import { formatBytes } from '../shared/utils/text.ts'

/** The row's single bar: the download's progress, or the copy's while one runs. */
export function rowProgress(trace: Trace, copy: TaskProgress | null): { pct: number; label: string } {
  if (copy) {
    if (copy.status === 'importing') return { pct: 100, label: 'Importando…' }
    const pct = copy.total_bytes > 0 ? Math.round((copy.copied_bytes / copy.total_bytes) * 100) : 0
    return { pct, label: `${pct}% — ${formatBytes(copy.copied_bytes)} / ${formatBytes(copy.total_bytes)}` }
  }
  const pct = trace.torrent?.progress ?? 0
  const size = trace.torrent?.size
  return { pct, label: size ? `${pct}% — ${formatBytes((size * pct) / 100)} / ${formatBytes(size)}` : `${pct}%` }
}
