import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  build: { outDir: 'dist', emptyOutDir: true },
  // Never let the dev file server read secrets (tokens, keys, .data/, .git).
  server: {
    fs: {
      deny: ['.env', '.env.*', '*.{crt,pem,key,p12,pfx,cer,der}', '.npmrc', '**/.git/**', '**/.data/**'],
    },
  },
  test: { globals: true, environment: 'node', include: ['test/**/*.test.ts'] },
});
