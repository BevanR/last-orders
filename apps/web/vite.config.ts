import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

// In development the app server runs on :8080 and Vite proxies the API to it.
export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    proxy: {
      '/api': { target: process.env.API_URL ?? 'http://localhost:8080', changeOrigin: false },
    },
  },
  build: { outDir: 'dist', sourcemap: true },
});
