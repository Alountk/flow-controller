import { useQuery } from '@tanstack/react-query'
import { fetchDownloads, type Download } from '../api/downloads'

/** Poll fast while something is moving, and back off when nothing is. */
const ACTIVE_INTERVAL_MS = 4000
const IDLE_INTERVAL_MS = 20000

export function formatSpeed(bytesPerSecond: number | null): string {
  if (!bytesPerSecond || bytesPerSecond <= 0) return '—'
  const units = ['B/s', 'KB/s', 'MB/s', 'GB/s']
  let value = bytesPerSecond
  let unit = 0
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024
    unit += 1
  }
  return `${value.toFixed(value >= 10 || unit === 0 ? 0 : 1)} ${units[unit]}`
}

export function formatEta(seconds: number | null): string {
  if (seconds === null || seconds === undefined || seconds < 0) return '—'
  if (seconds < 60) return `${seconds}s`
  const minutes = Math.floor(seconds / 60)
  if (minutes < 60) return `${minutes}m`
  const hours = Math.floor(minutes / 60)
  return `${hours}h ${minutes % 60}m`
}

/**
 * The label shown for a download.
 *
 * The arr's tracked state is what matters to the user — "downloading" from the
 * torrent client says nothing about whether the import will succeed.
 */
export function downloadStateLabel(download: Download): string {
  if (download.tracked_state === 'importBlocked') return 'Import bloqueado'
  if (download.tracked_state === 'importing') return 'Importando'
  if (download.tracked_state === 'failed' || download.tracked_state === 'downloadFailed') {
    return 'Fallida'
  }
  if (download.torrent_state === 'paused' || download.torrent_state === 'stalledDL') {
    return 'Pausada'
  }
  if (download.status === 'completed' || download.progress >= 100) return 'Completada'
  return 'Descargando'
}

export function useDownloads() {
  return useQuery({
    queryKey: ['downloads'],
    queryFn: fetchDownloads,
    refetchInterval: (query) => {
      // Null-safe: a response missing `downloads` must not crash the sidebar
      // during a poll, which happens outside any render a caller could guard.
      const downloads = query.state.data?.downloads
      return downloads && downloads.length > 0 ? ACTIVE_INTERVAL_MS : IDLE_INTERVAL_MS
    },
    // A failed poll must not blank the panel: keep showing the last known state.
    retry: false,
  })
}
