import { readFileSync } from 'node:fs';
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// the npm package version, stamped into the bundle so the UI can show which
// build a browser is actually running (stale-cache diagnosis at a glance)
const version = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version;

export default defineConfig({
  plugins: [react()],
  define: {
    __APP_VERSION__: JSON.stringify(version),
    // local builds share the npm version; the timestamp tells reloads apart
    __BUILD_TS__: JSON.stringify(new Date().toISOString().slice(0, 16).replace('T', ' ')),
  },
  server: {
    proxy: {
      '/api': { target: 'http://localhost:7777', changeOrigin: true },
      '/ws': { target: 'http://localhost:7777', ws: true, changeOrigin: true },
    },
  },
});
