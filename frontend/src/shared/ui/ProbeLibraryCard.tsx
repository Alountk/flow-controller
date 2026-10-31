import { useEffect, useRef, useState } from 'react'
import { probeLibraryStart, probeLibraryStatus, type ProbeLibraryStatus } from '../api/probe.ts'

/**
 * T5 (S3/S4): «Analizar biblioteca» starts the library sweep and reports its
 * progress — including how many files were skipped because their probe was
 * already persisted («ahorrarnos ffprobe»).
 */
export function ProbeLibraryCard({ intervalMs = 2000 }: { intervalMs?: number } = {}) {
  const [status, setStatus] = useState<ProbeLibraryStatus | null>(null)
  const [problem, setProblem] = useState<string | null>(null)
  const [starting, setStarting] = useState(false)
  const timer = useRef<number | null>(null)

  useEffect(() => {
    return () => {
      if (timer.current !== null) window.clearInterval(timer.current)
    }
  }, [])

  const poll = () => {
    probeLibraryStatus().then((next) => {
      if (!next) return
      setStatus(next)
      if (!next.running && timer.current !== null) {
        window.clearInterval(timer.current)
        timer.current = null
      }
    })
  }

  const start = () => {
    setStarting(true)
    setProblem(null)
    probeLibraryStart().then((result) => {
      setStarting(false)
      if (!result.ok) {
        setProblem(result.detail)
        return
      }
      poll()
      if (timer.current === null) timer.current = window.setInterval(poll, intervalMs)
    })
  }

  return (
    <div className="sec-probe-library">
      <button
        type="button"
        className="sec-analyze"
        disabled={starting || Boolean(status?.running)}
        onClick={start}
      >
        Analizar biblioteca
      </button>
      {status && (status.running || status.total > 0) && (
        <p className="sec-probe-library-progress">
          {status.running ? 'Analizando biblioteca…' : 'Biblioteca analizada'} ·{' '}
          {status.analyzed} de {status.total} analizados · {status.skipped} ya estaban
          analizados
          {status.failed > 0 && ` · ${status.failed} con error`}
        </p>
      )}
      {problem && (
        <p className="wanted-error" role="alert">
          {problem}
        </p>
      )}
    </div>
  )
}
