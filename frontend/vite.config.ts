import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

export default defineConfig({
  plugins: [react()],
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
