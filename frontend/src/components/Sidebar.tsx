import type { ReactNode } from 'react'
import './Sidebar.css'

export type Page = 'dashboard' | 'trace' | 'wanted' | 'calendar' | 'disk' | 'files' | 'mixer' | 'config' | 'prototypes'

const PAGE_PATHS: Record<Page, string> = {
  dashboard: '/dashboard',
  trace: '/trazabilidad',
  wanted: '/faltantes',
  calendar: '/calendario',
  disk: '/disco',
  files: '/archivos',
  mixer: '/mixer',
  config: '/configuracion',
  prototypes: '/prototipos',
}

interface NavItem {
  key: Page
  label: string
  icon: string
}

const NAV_ITEMS: NavItem[] = [
  { key: 'dashboard', label: 'Dashboard', icon: '📊' },
  { key: 'trace', label: 'Trazabilidad', icon: '🔍' },
  { key: 'wanted', label: 'Faltantes', icon: '📥' },
  { key: 'calendar', label: 'Calendario', icon: '📅' },
  { key: 'disk', label: 'Disco', icon: '💾' },
  { key: 'files', label: 'Archivos', icon: '📂' },
  { key: 'mixer', label: 'Media Mixer', icon: '🎬' },
  { key: 'config', label: 'Configuración', icon: '⚙️' },
]

const NAV_SYSTEM: NavItem[] = [
  { key: 'prototypes', label: 'Prototipos', icon: '🎨' },
]

interface Props {
  active: Page
  onNavigate: (page: Page) => void
  developer: boolean
  /** Pages that depend on a service the user has not configured. */
  hidden?: Page[]
  children?: ReactNode
}

export function Sidebar({ active, onNavigate, developer, hidden = [] }: Props) {
  const visibleItems = NAV_ITEMS.filter((item) => !hidden.includes(item.key))
  return (
    <aside className="sidebar">
      <div className="sb-header">
        <div className="sb-brand">Flow<span>Controller</span></div>
        <div className="sb-version">v0.1.0</div>
      </div>

      <nav className="sb-nav">
        <div className="sb-section">Principal</div>
        {visibleItems.map((item) => (
          <a
            key={item.key}
            href={PAGE_PATHS[item.key]}
            className={`sb-link ${active === item.key ? 'active' : ''}`}
            onClick={(e) => { e.preventDefault(); onNavigate(item.key) }}
          >
            <span className="sb-icon">{item.icon}</span>
            {item.label}
          </a>
        ))}

        {developer && (
          <>
            <div className="sb-section">Desarrollo</div>
            {NAV_SYSTEM.map((item) => (
              <a
                key={item.key}
                href={PAGE_PATHS[item.key]}
                className={`sb-link ${active === item.key ? 'active' : ''}`}
                onClick={(e) => { e.preventDefault(); onNavigate(item.key) }}
              >
                <span className="sb-icon">{item.icon}</span>
                {item.label}
              </a>
            ))}
          </>
        )}
      </nav>

      <div className="sb-footer">
        <div className="sb-avatar">FC</div>
        <div className="sb-user-info">
          <div className="sb-user-name">Flow Controller</div>
          <div className="sb-user-role">Home Server</div>
        </div>
      </div>
    </aside>
  )
}
