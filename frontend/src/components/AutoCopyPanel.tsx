import { useState } from 'react'
import type {
  AutoCopyAction,
  AutoCopySweepEntry,
  AutoCopySweepResult,
} from '../types'
import { runAutoCopySweep } from '../api/autoCopy'
import './AutoCopyPanel.css'

/**
 * The "Revisar descargas" sweep and its decision log, as a component of their
 * own.
 *
 * This block used to live inside TraceView, which made Trazabilidad the only
 * door to the feature: retiring the page (F-09) would have silently retired
 * the sweep with it. Extracted first, rendered by both views during the
 * transition — and by Seguimiento for good.
 *
 * The DECISION LOG is gone from here by choice (2026-10-08): the band is the
 * kanban's tail, not an archive, and the log is heading for a page of its
 * own — logs only — when that page exists. The endpoint behind it
 * (`/api/auto-copy/history`) stays; this component simply stopped asking.
 *
 * The sweep is an explicit POST: the endpoint must never run as a side effect
 * of a polled GET. `safeMode` is the app's `actions.safe_mode` — the same
 * signal the rest of the UI trusts — not a second source read from the sweep
 * response.
 */

interface Props {
  safeMode: boolean
  /** Called after a sweep finished, for callers that must refresh their data. */
  onDone?: () => void
}

const AUTO_COPY_ACTION_LABELS: Record<AutoCopyAction, string> = {
  copied: 'Copiada',
  proposed: 'Propuesta',
  failed: 'Falló',
}

function AutoCopyErrors({ errors }: { errors: string[] }) {
  if (errors.length === 0) return null
  return (
    <div className="auto-copy-errors">
      <span className="auto-copy-errors-label">Errores</span>
      {errors.map((e, i) => (
        <div key={i} className="auto-copy-error">{e}</div>
      ))}
    </div>
  )
}

/**
 * Result of the last sweep, as returned by POST /api/auto-copy/sweep.
 */
function AutoCopyResult({
  result,
  safeMode,
}: {
  result: AutoCopySweepResult
  safeMode: boolean
}) {
  // `counts` can be `{}` in the route's last-resort error body, so read every
  // field defensively instead of trusting the type at runtime.
  const counts = result.counts ?? {}
  const actionable = result.entries.filter(
    (e): e is AutoCopySweepEntry & { action: AutoCopyAction } => e.action !== null,
  )

  if (result.running) {
    // A sweep was already in flight. Showing the zero counts of that refusal
    // would look like "nothing needed doing", which is not what happened.
    return (
      <div className="auto-copy-result">
        <p className="auto-copy-running">
          Ya hay un barrido en curso. Espera a que termine y vuelve a intentarlo.
        </p>
        <AutoCopyErrors errors={result.errors} />
      </div>
    )
  }

  return (
    <div className="auto-copy-result">
      {safeMode && (
        <p className="auto-copy-safe-banner">
          Modo seguro activo: no se ha copiado nada. Lo que sigue es lo que el
          barrido haría.
        </p>
      )}
      <AutoCopyErrors errors={result.errors} />

      {!result.ok ? (
        !result.errors.length && result.detail && (
          <p className="auto-copy-running">{result.detail}</p>
        )
      ) : (
        <>
          <div className="auto-copy-counts">
            <div className="auto-copy-count">
              <span className="auto-copy-count-value">{counts.traces ?? 0}</span>
              <span className="auto-copy-count-label">Trazas revisadas</span>
            </div>
            <div className="auto-copy-count">
              <span className="auto-copy-count-value">{counts.copied ?? 0}</span>
              <span className="auto-copy-count-label">Copiadas</span>
            </div>
            <div className="auto-copy-count">
              <span className="auto-copy-count-value">{counts.proposed ?? 0}</span>
              <span className="auto-copy-count-label">Propuestas</span>
            </div>
            <div className="auto-copy-count">
              <span className="auto-copy-count-value">{counts.wait ?? 0}</span>
              <span className="auto-copy-count-label">En espera</span>
            </div>
          </div>

          {actionable.length === 0 ? (
            <p className="auto-copy-empty">
              No hay nada que copiar: ninguna descarga necesita intervención.
            </p>
          ) : (
            <ul className="auto-copy-entries">
              {actionable.map((e, i) => (
                <li key={`${e.source}-${e.key}-${i}`} className="auto-copy-entry">
                  <div className="auto-copy-entry-head">
                    <span className={`auto-copy-badge ${e.action}`}>
                      {AUTO_COPY_ACTION_LABELS[e.action]}
                    </span>
                    <span className="auto-copy-entry-title" title={e.title}>
                      {e.title}
                    </span>
                  </div>
                  <p className="auto-copy-entry-reason">{e.reason}</p>
                  {e.detail && <p className="auto-copy-entry-detail">{e.detail}</p>}
                </li>
              ))}
            </ul>
          )}
        </>
      )}
    </div>
  )
}

export function AutoCopyPanel({ safeMode, onDone }: Props) {
  const [sweepResult, setSweepResult] = useState<AutoCopySweepResult | null>(null)
  const [sweeping, setSweeping] = useState(false)

  async function runSweep() {
    setSweeping(true)
    try {
      // The api module turns a rejected fetch into a failed summary, so this
      // never throws and the button can never get stuck on "Revisando…".
      setSweepResult(await runAutoCopySweep())
      onDone?.()
    } finally {
      setSweeping(false)
    }
  }

  return (
    <div className="auto-copy">
      <div className="auto-copy-bar">
        <button
          className="auto-copy-btn"
          onClick={() => void runSweep()}
          disabled={sweeping}
        >
          {sweeping ? 'Revisando…' : 'Revisar descargas'}
        </button>
        <span className="auto-copy-hint">
          Revisa las descargas completadas que Sonarr/Radarr no hayan importado.
        </span>
      </div>
      {sweepResult && <AutoCopyResult result={sweepResult} safeMode={safeMode} />}
    </div>
  )
}
