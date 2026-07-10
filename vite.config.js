import { defineConfig, loadEnv } from 'vite'
import react from '@vitejs/plugin-react'

// Dev-прокси: запросы /api/* в режиме разработки уходят на реальный backend Vercel.
// Укажи прод-URL в .env.local: API_PROXY_TARGET=https://<твой-проект>.vercel.app
export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), '')
  const target = env.API_PROXY_TARGET || 'https://hunters-path.vercel.app'
  return {
    plugins: [react()],
    server: {
      port: 5173,
      proxy: {
        '/api': {
          target,
          changeOrigin: true,
          secure: true,
        },
      },
    },
    build: {
      outDir: 'dist',
      emptyOutDir: true,
    },
  }
})
