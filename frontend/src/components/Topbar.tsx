import type { ReactNode } from 'react'
import './Topbar.css'

interface Props {
  title: string
  loading: boolean
  lastUpdated: number | null
  right?: ReactNode
}

export function Topbar({ title, loading, lastUpdated, right }: Props) {
  return (
    <div className="topbar">
      <span className="topbar-title">{title}</span>
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
