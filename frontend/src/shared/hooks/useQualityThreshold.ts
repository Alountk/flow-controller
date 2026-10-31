import { useQuery } from '@tanstack/react-query'
import { apiFetch } from '../api/auth.ts'

/** The saved quality threshold, as Settings writes it («umbral-calidad» S2). */
export interface QualityThreshold {
  minClass: string
  minWidth: number
}

/** Defaults match the backend's own (DEFAULTS `quality`), so a first paint
 *  before the settings answer behaves exactly like a saved 1080p threshold. */
export const DEFAULT_THRESHOLD: QualityThreshold = { minClass: '1080p', minWidth: 0 }

async function fetchThreshold(): Promise<QualityThreshold> {
  const res = await apiFetch('/api/settings', {})
  if (!res.ok) throw new Error(`HTTP ${res.status}`)
  const body = (await res.json()) as { quality?: { min_class?: string; min_width?: number } }
  return {
    minClass: (body.quality?.min_class ?? '').trim() || DEFAULT_THRESHOLD.minClass,
    minWidth: Number(body.quality?.min_width ?? 0) || 0,
  }
}

/** Shared ['quality-threshold'] key: the chip and the list read one document. */
export function useQualityThreshold(): QualityThreshold {
  const query = useQuery({
    queryKey: ['quality-threshold'],
    queryFn: fetchThreshold,
    // Settings, not live data: a save invalidates the page anyway.
    staleTime: 5 * 60_000,
  })
  return query.data ?? DEFAULT_THRESHOLD
}
