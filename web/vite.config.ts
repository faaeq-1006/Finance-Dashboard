import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

export default defineConfig({
  root: import.meta.dirname,
  plugins: [react()],
  server: { port: 5173, proxy: { '/api': { target: `http://localhost:${process.env.PORT ?? 4000}`, changeOrigin: false } } },
  build: { outDir: 'dist', emptyOutDir: true, sourcemap: false },
});
