import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { generateSW } from 'workbox-build';

const appDirectory = fileURLToPath(new URL('..', import.meta.url));
await generateSW({
  globDirectory: path.join(appDirectory, 'dist'),
  globPatterns: ['**/*.{html,js,css,svg,png,webmanifest}'],
  swDest: path.join(appDirectory, 'dist', 'sw.js'),
  cleanupOutdatedCaches: true,
  clientsClaim: true,
  skipWaiting: true,
});
