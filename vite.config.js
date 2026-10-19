import { defineConfig } from 'vite';
import { cloudflareMultiplayer } from './server/signaling.js';
import { resolve } from 'node:path';

const customHosts = (process.env.KOKOPLA_ALLOWED_HOSTS || '')
  .split(',')
  .map((host) => host.trim())
  .filter(Boolean);

export default defineConfig({
  plugins: [cloudflareMultiplayer()],
  build: {
    rollupOptions: {
      input: {
        main: resolve(import.meta.dirname, 'index.html'),
        avatarImageTest: resolve(import.meta.dirname, 'avatar-image-test.html'),
      },
    },
    chunkSizeWarningLimit: 550,
  },
  preview: {
    allowedHosts: ['.trycloudflare.com', ...customHosts],
  },
});
