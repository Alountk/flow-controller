import { Component, type ReactNode } from 'react'

interface Props {
  children: ReactNode
}

interface State {
  hasError: boolean
  error: Error | null
}

export class ErrorBoundary extends Component<Props, State> {
  constructor(props: Props) {
    super(props)
    this.state = { hasError: false, error: null }
  }

  static getDerivedStateFromError(error: Error): State {
    return { hasError: true, error }
  }

  render() {
    if (this.state.hasError) {
      return (
        <div style={{
          display: 'flex',
          flexDirection: 'column',
          alignItems: 'center',
          justifyContent: 'center',
          height: '100vh',
          background: 'var(--bg)',
          color: 'var(--text)',
          fontFamily: 'monospace',
          padding: '24px',
          textAlign: 'center',
        }}>
          <h1 style={{ fontSize: '18px', marginBottom: '12px' }}>Algo salió mal</h1>
          <p style={{ fontSize: '13px', color: 'var(--text-dim)', marginBottom: '16px', maxWidth: '500px' }}>
            {this.state.error?.message || 'Error desconocido'}
          </p>
          <button
            onClick={() => { this.setState({ hasError: false, error: null }); window.location.reload() }}
            style={{
              padding: '8px 20px',
              borderRadius: '8px',
              border: '1px solid var(--border)',
              background: 'var(--bg-elev)',
              color: 'var(--text)',
              cursor: 'pointer',
              fontSize: '13px',
            }}
          >
            Recargar
          </button>
        </div>
      )
    }

    return this.props.children
  }
}
