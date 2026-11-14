import type { ReactNode } from 'react'
import { PAGE_PATHS, type Page } from '../shared/hooks/usePageRoute.ts'
import './Sidebar.css'

const BUILD = import.meta.env.VITE_APP_BUILD
const APP_VERSION_LABEL = `v${__APP_VERSION__}${BUILD ? ` · ${BUILD.slice(0, 7)}` : ''}`

// `Page` is owned by hooks/usePageRoute.ts (the router needs it too). Re-exported
// here so existing `import type { Page } from './Sidebar.tsx'` keeps compiling.
export type { Page }

interface NavItem {
  key: Page
  label: string
  icon: string
}

const NAV_ITEMS: NavItem[] = [
  { key: 'dashboard', label: 'Dashboard', icon: '📊' },
  { key: 'peliculasV2', label: 'Películas V2', icon: '🧪' },
  { key: 'series', label: 'Series', icon: '📺' },
  { key: 'estrenos', label: 'Estrenos', icon: '🗓️' },
  { key: 'seguimiento', label: 'Seguimiento', icon: '📡' },
  { key: 'descargas', label: 'Descargas', icon: '📥' },
  { key: 'disk', label: 'Disco', icon: '💾' },
  { key: 'files', label: 'Archivos', icon: '📂' },
  { key: 'renombrar', label: 'Renombrar', icon: '🏷️' },
  { key: 'duplicados', label: 'Duplicados', icon: '🧬' },
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
        <div className="sb-tagline">Gestor Multimedia</div>
        <div className="sb-version">{APP_VERSION_LABEL}</div>
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
