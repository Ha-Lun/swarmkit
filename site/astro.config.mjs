import { defineConfig } from 'astro/config';
import tailwindcss from '@tailwindcss/vite';

export default defineConfig({
  site: 'https://swarmkit-site.vercel.app',
  output: 'static',
  vite: { plugins: [tailwindcss()], optimizeDeps: { include: ['three'] } },
});
