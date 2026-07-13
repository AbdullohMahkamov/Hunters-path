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
      target: 'es2020', // современные браузеры — меньше полифилов/транспиляции
      rollupOptions: {
        output: {
          // React/ReactDOM в отдельный vendor-чанк: он не меняется между деплоями →
          // кэшируется у пользователя, правки кода приложения его не инвалидируют.
          manualChunks: { react: ['react', 'react-dom'] },
        },
      },
    },
  }
})
