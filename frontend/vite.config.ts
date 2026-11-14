import { fileURLToPath, URL } from 'node:url'
import { defineConfig } from 'vite'
import vue from '@vitejs/plugin-vue'

// 开发代理目标可用 VITE_API_TARGET 覆盖（默认本机 8790）
const apiTarget = process.env.VITE_API_TARGET || 'http://127.0.0.1:8790'

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
      '/api': { target: apiTarget, changeOrigin: false },
      '/auth': { target: apiTarget, changeOrigin: false },
    },
  },
  build: {
    outDir: 'dist',
    emptyOutDir: true,
  },
})
