import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';
import { ocrAssets } from './ocrAssets.js';

// The app's tsconfig declares `types: ["vite/client"]`, so Node's ambient
// module declarations are deliberately not in scope here. `import.meta.url`
// plus the WHATWG URL global resolves the alias without pulling @types/node in.
export default defineConfig({
  plugins: [react(), tailwindcss(), ocrAssets()],
  resolve: {
    alias: {
      '@': new URL('./src', import.meta.url).pathname,
    },
  },
  server: {
    port: 5173,
  },
});
