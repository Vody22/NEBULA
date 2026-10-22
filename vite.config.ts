import { defineConfig } from 'vite';

export default defineConfig({
  server: { host: true, port: 5173 },
  build: {
    target: 'es2022',
    chunkSizeWarningLimit: 1500,
    rollupOptions: { input: { main: 'index.html', hangar: 'hangar.html' } },
  },
  test: { include: ['tests/**/*.test.ts'], environment: 'node' },
} as any);
