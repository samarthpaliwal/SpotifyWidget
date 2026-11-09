// Bundles the three Electron entry points with esbuild and copies static renderer files.
// main + preload are CommonJS (Electron main-process requirement); renderer is an IIFE.
import { build, context } from 'esbuild';
import { cpSync, mkdirSync } from 'node:fs';

const watch = process.argv.includes('--watch');

const common = { bundle: true, sourcemap: true, logLevel: 'info', target: 'es2022' };

const targets = [
  { entryPoints: ['src/main/main.ts'], outfile: 'dist/main/main.js', platform: 'node', format: 'cjs', external: ['electron'] },
  { entryPoints: ['src/main/preload.ts'], outfile: 'dist/main/preload.js', platform: 'node', format: 'cjs', external: ['electron'] },
  { entryPoints: ['src/renderer/renderer.ts'], outfile: 'dist/renderer/renderer.js', platform: 'browser', format: 'iife' },
];

mkdirSync('dist/renderer', { recursive: true });
cpSync('src/renderer/index.html', 'dist/renderer/index.html');
cpSync('src/renderer/styles.css', 'dist/renderer/styles.css');

if (watch) {
  for (const t of targets) (await context({ ...common, ...t })).watch();
  console.log('watching…');
} else {
  await Promise.all(targets.map((t) => build({ ...common, ...t })));
}
