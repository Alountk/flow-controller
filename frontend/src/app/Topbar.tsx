import type { ReactNode } from 'react'
import './Topbar.css'

interface Props {
  title: string
  /** Stitch 01: the design keeps a one-line subtitle under the title. */
  subtitle?: string
  loading: boolean
  lastUpdated: number | null
  right?: ReactNode
  /** Present only when a login account protects the panel. */
  onLogout?: () => void
}

export function Topbar({ title, subtitle, loading, lastUpdated, right, onLogout }: Props) {
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
        {onLogout && (
          <button type="button" className="topbar-logout" onClick={onLogout}>
            Cerrar sesión
          </button>
        )}
      </div>
    </div>
  )
}
