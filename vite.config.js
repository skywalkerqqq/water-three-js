import { defineConfig } from 'vite';

export default defineConfig({
  base: './',
  server: { host: true, open: true },
  // Disable dependency discovery/pre-bundling so Vite never needs to clean
  // node_modules/.vite/deps — that clean-up step is blocked here during dev startup.
  optimizeDeps: { noDiscovery: true },
  build: {
    target: 'esnext',
    sourcemap: false,
    chunkSizeWarningLimit: 1500,
  },
});
