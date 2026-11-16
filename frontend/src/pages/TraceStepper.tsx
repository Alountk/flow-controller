import { Icon } from '../shared/ui/Icon.tsx'
import type { Trace } from '../shared/types.ts'
import './TraceStepper.css'

export type CopyPhase = 'copying' | 'importing' | null

export type StepState = 'done' | 'current' | 'todo' | 'fail'

const STEPS = ['Buscado', 'Descargando', 'Descargado', 'Importado', 'Enviado'] as const

/**
 * Where a trace sits on the five-step lifecycle. The arr never says which step
 * a `failed` trace died on, so a finished torrent means the import failed and
 * anything else means the download did.
 */
export function stepStates(
  trace: Pick<Trace, 'stage' | 'torrent'>,
  phase: CopyPhase = null,
): StepState[] {
  // A copy the operator started is the live step: the import has begun.
  if (phase) return STEPS.map((_, i) => (i < 3 ? 'done' : i === 3 ? 'current' : 'todo'))
  if (trace.stage === 'sent') return STEPS.map(() => 'done')
  const failedAt = (trace.torrent?.progress ?? 0) >= 100 ? 3 : 1
  const at =
    trace.stage === 'downloading' ? 1
    : trace.stage === 'downloaded' ? 2
    : trace.stage === 'importing' ? 3
    : trace.stage === 'import_blocked' ? 3
    : failedAt
  const failed = trace.stage === 'import_blocked' || trace.stage === 'failed'
  return STEPS.map((_, i) =>
    i < at ? 'done' : i > at ? 'todo' : failed ? 'fail' : 'current',
  )
}

export function TraceStepper({ trace, phase = null }: {
  trace: Pick<Trace, 'stage' | 'torrent'>
  phase?: CopyPhase
}) {
  const states = stepStates(trace, phase)
  return (
    <ol className="sg-steps" aria-label="Etapas">
      {STEPS.map((label, i) => (
        <li key={label} className={`sg-step sg-step-${states[i]}`}>
          <span className="sg-step-dot">
            {states[i] === 'done' && <Icon name="check" size={12} />}
            {states[i] === 'fail' && <Icon name="close" size={12} />}
            {(states[i] === 'current' || states[i] === 'todo') && i + 1}
          </span>
          <span className="sg-step-label">
            {i === 3 && phase ? (phase === 'copying' ? 'Copiando' : 'Importando') : label}
          </span>
        </li>
      ))}
    </ol>
  )
}
