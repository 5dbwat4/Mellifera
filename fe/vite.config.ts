import tailwindcss from '@tailwindcss/vite'
import vue from '@vitejs/plugin-vue'
import svgLoader from 'vite-svg-loader'
import { defineConfig } from 'vite'

// https://vite.dev/config/
export default defineConfig({
  // 与服务器统一入口 nginx(127.0.0.1:8123) 下的挂载路径保持一致
  base: '/mellifera/',
  plugins: [vue(), tailwindcss(), svgLoader()],
  server: {
    port: 5180,
    strictPort: true,
    proxy: {
      '/mellifera/api': {
        target: 'http://127.0.0.1:9000',
        changeOrigin: true,
        rewrite: (p) => p.replace(/^\/mellifera/, ''),
      },
    },
  },
})
