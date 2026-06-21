import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { fileURLToPath } from 'node:url';

// Local-only harness to comb the shipped <PrDashboard> embed live. NOT shipped.
export default defineConfig({
  root: fileURLToPath(new URL('.', import.meta.url)),
  plugins: [react()],
  server: {
    port: 4500,
    proxy: {
      // same-origin /api → the running daemon (avoids cross-origin CORS)
      '/api': 'http://localhost:4400',
    },
  },
});
