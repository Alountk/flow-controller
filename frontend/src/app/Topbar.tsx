import type { ReactNode } from 'react'
import './Topbar.css'

interface Props {
  title: string
  /** Stitch 01: the design keeps a one-line subtitle under the title. */
  subtitle?: string
  loading: boolean
  lastUpdated: number | null
  right?: ReactNode
}

export function Topbar({ title, subtitle, loading, lastUpdated, right }: Props) {
  return (
    <div className="topbar">
      <div className="topbar-left">
        <h1 className="topbar-title">{title}</h1>
        {subtitle && <p className="topbar-subtitle">{subtitle}</p>}
      </div>
      <div className="topbar-right">
        <span className="topbar-status">
          <span className={`topbar-dot ${loading ? '' : 'live'}`} />
          {loading ? 'Conectando…' : 'En vivo'}
        </span>
        {lastUpdated && (
          <span className="topbar-time">
            {new Date(lastUpdated).toLocaleTimeString()}
          </span>
        )}
        {right}
      </div>
    </div>
  )
}
