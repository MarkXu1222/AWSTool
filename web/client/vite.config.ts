import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import path from 'path';

export default defineConfig({
  plugins: [react()],
  root: path.resolve(__dirname),
  build: {
    outDir: path.resolve(__dirname, '../dist/client'),
    emptyOutDir: true,
    // 依赖按稳定性分包（都在 index.html 里并行加载，不是路由懒加载，不会有"分包超时"问题）：
    // - vendor(react+antd)：几乎不变，配合 immutable 缓存，日常发版用户只需重新下载业务代码块
    // - charts(recharts)：只有运维监控用，独立成块
    rollupOptions: {
      output: {
        manualChunks: {
          vendor: ['react', 'react-dom', 'antd', '@ant-design/icons', 'dayjs'],
          charts: ['recharts'],
        },
      },
    },
    chunkSizeWarningLimit: 1200,
  },
  server: {
    port: 5174,
    proxy: {
      '/api': 'http://localhost:3000',
    },
  },
});
