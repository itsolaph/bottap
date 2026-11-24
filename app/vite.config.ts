import { defineConfig } from 'vite'

export default defineConfig(({ mode }) => ({
  define: {
    'import.meta.env.VITE_BOTTAP_SANDBOX': JSON.stringify(mode === 'sandbox' ? '1' : ''),
  },
  server: {
    host: '127.0.0.1',
    port: 5173,
    proxy: {
      '/api': {
        target: 'http://127.0.0.1:8788',
        changeOrigin: false,
        rewrite: (path) => path.replace(/^\/api/, ''),
      },
    },
  },
  build: {
    target: 'esnext',
  },
}))
