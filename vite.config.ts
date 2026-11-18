import { defineConfig } from 'vitest/config';
import basicSsl from '@vitejs/plugin-basic-ssl';

// `base` is configurable so the same build can be served from a GitHub Pages
// sub-path (https://<user>.github.io/<repo>/). Locally it stays at "/".
export default defineConfig({
  base: process.env.BASE_PATH ?? '/',
  // Self-signed HTTPS so an iPad on the LAN gets a secure context (WebGPU,
  // service workers). Set NO_HTTPS=1 to serve plain HTTP on localhost.
  plugins: process.env.NO_HTTPS ? [] : [basicSsl()],
  server: { host: true },
  preview: { host: true },
  build: { target: 'es2022' },
  test: {
    include: ['src/**/*.test.ts'],
    environment: 'node',
  },
});
