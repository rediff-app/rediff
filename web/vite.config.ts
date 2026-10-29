import { defineConfig } from 'vite';
import solid from 'vite-plugin-solid';

// `npm run dev` serves the UI with HMR and proxies the API to a running
// `rediff --port 7777 --no-open` (override with REDIFF_URL).
const backend = process.env.REDIFF_URL ?? 'http://127.0.0.1:7777';

export default defineConfig({
  plugins: [solid()],
  build: {
    target: 'es2022',
    reportCompressedSize: false,
    // shiki grammars are big, but each one is its own lazily loaded chunk
    chunkSizeWarningLimit: 1500,
  },
  worker: { format: 'es' },
  server: {
    proxy: { '/api': backend, '/auth': backend },
  },
});
