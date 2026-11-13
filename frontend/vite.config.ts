import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import pkg from './package.json'

export default defineConfig({
  plugins: [react()],
  // The version shown in the UI comes from the build, never from a literal in a component.
  define: {
    __APP_VERSION__: JSON.stringify(pkg.version),
  },
  build: {
    outDir: 'dist',
    emptyOutDir: true,
  },
  server: {
    host: '0.0.0.0',
    port: 5173,
    // No changeOrigin: the session CSRF check compares Origin with Host, and
    // rewriting Host to the backend's would reject every write that has a cookie.
    proxy: {
      '/api': {
        target: 'http://localhost:8000',
      },
      '/prototypes': {
        target: 'http://localhost:8000',
      },
    },
  },
})
