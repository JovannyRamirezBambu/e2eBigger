import path from 'node:path';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

// Servidor de desarrollo del panel (HMR). El backend real —el que ejecuta
// ./e2e y expone /api/*— sigue siendo ui/server.js; acá solo se proxea.
//   uso:  ./e2e ui <flujo>   (backend en :7777, sirviendo el build de ui/dist)
//         pnpm --dir ui dev  (en paralelo, para iterar el panel con recarga en vivo)
const BACKEND = process.env.E2E_UI_BACKEND ?? 'http://localhost:7777';

export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: { '@': path.resolve(__dirname, 'src') },
  },
  server: {
    proxy: {
      '/api': { target: BACKEND, changeOrigin: true },
    },
  },
  build: {
    outDir: 'dist',
    emptyOutDir: true,
  },
});
