import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { ErrorBoundary } from './ErrorBoundary.tsx'
import { QueryProvider } from './QueryProvider.tsx'
import App from './App.tsx'
import '../styles/global.css'

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <QueryProvider>
      <ErrorBoundary>
        <App />
      </ErrorBoundary>
    </QueryProvider>
  </StrictMode>,
)
