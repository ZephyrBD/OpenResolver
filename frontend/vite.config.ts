import { fileURLToPath, URL } from 'node:url'
import { defineConfig } from 'vite'
import vue from '@vitejs/plugin-vue'

export default defineConfig({
  base: '/panel/',
  plugins: [vue()],
  resolve: {
    alias: { '@': fileURLToPath(new URL('./src', import.meta.url)) },
  },
  server: {
    port: 5173,
    proxy: {
      // 只读代理到运行中的网关：不写 data/、不重启进程（阶段 1 裁定 7）。
      // changeOrigin 必须为 false：Host 改写会触发面板 CSRF 的 Origin 同源校验 403。
      '/api': { target: 'http://127.0.0.1:8790', changeOrigin: false },
      '/auth': { target: 'http://127.0.0.1:8790', changeOrigin: false },
    },
  },
  build: {
    outDir: 'dist',
    emptyOutDir: true,
  },
})
