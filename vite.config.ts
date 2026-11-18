import { createHash } from 'node:crypto';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { defineConfig, type Plugin } from 'vitest/config';
import basicSsl from '@vitejs/plugin-basic-ssl';

/** Recursively list files in `dir`, as paths relative to `root` with forward slashes. */
function listFiles(dir: string, root = dir): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    return statSync(path).isDirectory() ? listFiles(path, root) : [relative(root, path).split('\\').join('/')];
  });
}

/**
 * Emits dist/sw.js from src/pwa/sw.template.js with the list of every built
 * file, so the app works offline after the first visit.
 */
function serviceWorker(): Plugin {
  return {
    name: 'phase0-service-worker',
    apply: 'build',
    generateBundle(_options, bundle) {
      const files = ['./', ...Object.keys(bundle), ...listFiles('public')].filter((f) => f !== 'sw.js');
      const version = createHash('sha256').update(files.join('\n')).digest('hex').slice(0, 12);
      const source = readFileSync('src/pwa/sw.template.js', 'utf8')
        .replace('__CACHE_VERSION__', version)
        .replace('__PRECACHE_MANIFEST__', JSON.stringify(files, null, 2));
      this.emitFile({ type: 'asset', fileName: 'sw.js', source });
    },
  };
}

// `base` is configurable so the same build can be served from a GitHub Pages
// sub-path (https://<user>.github.io/<repo>/). Locally it stays at "/".
export default defineConfig({
  base: process.env.BASE_PATH ?? '/',
  plugins: [
    // Self-signed HTTPS so an iPad on the LAN gets a secure context (needed
    // for WebGPU). Set NO_HTTPS=1 to serve plain HTTP (fine on localhost).
    ...(process.env.NO_HTTPS ? [] : [basicSsl()]),
    serviceWorker(),
  ],
  server: { host: true },
  preview: { host: true },
  build: { target: 'es2022' },
  test: {
    include: ['src/**/*.test.ts'],
    environment: 'node',
  },
});
