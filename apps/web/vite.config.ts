import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    strictPort: true,
    proxy: {
      '/events': {
        target: 'http://127.0.0.1:4321',
        changeOrigin: true,
        // SSE requires streaming; do not buffer.
        ws: false,
      },
      '/healthz': 'http://127.0.0.1:4321',
    },
  },
});
