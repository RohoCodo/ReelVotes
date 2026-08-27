// @ts-check
import { defineConfig } from 'astro/config';

import react from '@astrojs/react';

import tailwindcss from '@tailwindcss/vite';

// https://astro.build/config
export default defineConfig({
  site: 'https://reelvotes.com',
  output: 'static',
  integrations: [react()],

  vite: {
    plugins: [tailwindcss()],
    build: {
      rollupOptions: {
        output: {
          // Rollup's automatic chunking otherwise merges the tiny shared
          // react/jsx-runtime helper into the same physical chunk as
          // whichever large dependency (full Firestore, Firebase Auth)
          // happens to be co-imported by another island — meaning every
          // island, including ones that never touch Firestore/Auth,
          // transitively downloads that weight just to get JSX support.
          // Pin the truly-shared, small pieces to their own chunk so the
          // heavy pieces only ship to islands that actually import them.
          manualChunks(id) {
            if (id.includes("node_modules/react/") || id.includes("node_modules/react-dom/")) {
              return "react-vendor";
            }
          }
        }
      }
    }
  }
});
