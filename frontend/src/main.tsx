import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { ErrorBoundary } from './components/ErrorBoundary'
import { QueryProvider } from './QueryProvider'
import App from './App.tsx'
import './styles/global.css'

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <QueryProvider>
      <ErrorBoundary>
        <App />
      </ErrorBoundary>
    </QueryProvider>
  </StrictMode>,
)
