import type { ReactNode } from 'react'

export type Page = 'dashboard' | 'trace' | 'wanted' | 'prototypes'

interface NavItem {
  key: Page
  label: string
  icon: string
}

const NAV_ITEMS: NavItem[] = [
  { key: 'dashboard', label: 'Dashboard', icon: '📊' },
  { key: 'trace', label: 'Trazabilidad', icon: '🔍' },
  { key: 'wanted', label: 'Faltantes', icon: '📥' },
]

const NAV_SYSTEM: NavItem[] = [
  { key: 'prototypes', label: 'Prototipos', icon: '🎨' },
]

interface Props {
  active: Page
  onNavigate: (page: Page) => void
  developer: boolean
  children?: ReactNode
}

export function Sidebar({ active, onNavigate, developer }: Props) {
  return (
    <aside className="sidebar">
      <div className="sb-header">
        <div className="sb-brand">Flow<span>Controller</span></div>
        <div className="sb-version">v0.1.0</div>
      </div>

      <nav className="sb-nav">
        <div className="sb-section">Principal</div>
        {NAV_ITEMS.map((item) => (
          <a
            key={item.key}
            href="#"
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
                href="#"
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
