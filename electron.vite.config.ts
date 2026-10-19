import { fileURLToPath } from 'node:url';

import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'electron-vite';

export default defineConfig({
  main: { build: { outDir: 'dist/main', externalizeDeps: false } },
  preload: {
    build: {
      outDir: 'dist/preload',
      rollupOptions: { output: { format: 'cjs', entryFileNames: 'index.cjs' } },
    },
  },
  renderer: {
    resolve: { alias: { '@': fileURLToPath(new URL('./src/renderer', import.meta.url)) } },
    plugins: [react(), tailwindcss()],
    build: { outDir: 'dist/renderer' },
    server: { host: '127.0.0.1', strictPort: true, port: 5173 },
  },
});
