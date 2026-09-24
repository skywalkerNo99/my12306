import { defineConfig } from 'vite';
import vue from '@vitejs/plugin-vue';
import path from 'node:path';

export default defineConfig({
  base: './',
  plugins: [vue()],
  resolve: {
    alias: { '@': path.resolve(__dirname, 'src') },
  },
  server: {
    port: 7789,
    proxy: {
      '/api': { target: 'http://127.0.0.1:7788', changeOrigin: false },
      '/ws': { target: 'ws://127.0.0.1:7788', ws: true, changeOrigin: false },
    },
  },
  build: {
    outDir: 'dist',
    chunkSizeWarningLimit: 1500,
  },
});
