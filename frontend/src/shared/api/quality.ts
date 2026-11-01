import { apiFetch } from './auth.ts'

/** One measured file below the quality threshold («umbral-calidad» S4). */
export interface BelowThresholdItem {
  path: string
  name: string
  width: number
  height: number
  class: string
  size_bytes: number
  duration: number
}

export interface QualityBelowReport {
  threshold: { min_class: string; min_width: number }
  items: BelowThresholdItem[]
  analyzed: number
  unanalyzed: number
}

/**
 * The below-threshold report. Throws on failure so the panel can show the
 * reason instead of an empty list that would read as «nada que mejorar».
 */
export async function fetchQualityBelow(): Promise<QualityBelowReport> {
  const res = await apiFetch('/api/mixer/quality/below', {})
  if (!res.ok) {
    const body = await res.json().catch(() => ({})) as { detail?: string }
    throw new Error(typeof body.detail === 'string' ? body.detail : `HTTP ${res.status}`)
  }
  const body = await res.json() as Partial<QualityBelowReport>
  // A malformed payload must read as a failure, not crash the page that shows
  // the report above a list of movies.
  if (!body || !Array.isArray(body.items) || !body.threshold) {
    throw new Error('respuesta inesperada del servidor')
  }
  return {
    threshold: {
      min_class: body.threshold.min_class ?? '1080p',
      min_width: Number(body.threshold.min_width ?? 0) || 0,
    },
    items: body.items,
    analyzed: Number(body.analyzed ?? 0) || 0,
    unanalyzed: Number(body.unanalyzed ?? 0) || 0,
  }
}
