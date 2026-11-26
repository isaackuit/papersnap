import { defineConfig } from 'vite';
import preact from '@preact/preset-vite';

// base './' so the same build works on any static host sub-path (GitHub Pages)
// and inside the Capacitor WebView.
export default defineConfig({
  base: './',
  plugins: [preact()],
  build: {
    outDir: 'dist',
    target: 'es2020',
    chunkSizeWarningLimit: 1500,
  },
  worker: { format: 'es' },
});
