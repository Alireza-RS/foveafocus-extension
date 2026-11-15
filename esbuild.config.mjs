// Builds the extension into dist/, the folder the browser loads.
//
//   node esbuild.config.mjs              a build to try out, with source maps
//   node esbuild.config.mjs production   the build that is released
//   node esbuild.config.mjs --watch      builds again whenever a source file changes

import esbuild from 'esbuild';
import fs from 'node:fs/promises';
import { watch } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.dirname(fileURLToPath(import.meta.url));
const out = path.join(root, 'dist');
const production = process.argv.includes('production');
const watching = process.argv.includes('--watch');

const shared = {
  bundle: true,
  format: 'iife',
  target: 'chrome120',
  minify: production,
  sourcemap: production ? false : 'inline',
  legalComments: 'eof',
  logLevel: 'warning',
};

// The reader and its settings are written for the Obsidian app. In the pages of the
// extension, what they take from the app comes from src/host/obsidian.ts instead. Where the
// app runs on a computer they ask the system for its fonts; a browser has no such way, and
// they do without it.
const pages = { ...shared, alias: { obsidian: path.join(root, 'src/host/obsidian.ts') }, external: ['child_process'] };

const bundles = [
  { ...shared, entryPoints: [path.join(root, 'src/background.ts')], outfile: path.join(out, 'background.js') },
  { ...shared, entryPoints: [path.join(root, 'src/content/index.ts')], outfile: path.join(out, 'content.js') },
  { ...pages, entryPoints: [path.join(root, 'src/reader/index.ts')], outfile: path.join(out, 'reader.js') },
  { ...pages, entryPoints: [path.join(root, 'src/viewer/index.ts')], outfile: path.join(out, 'viewer.js') },
  { ...pages, entryPoints: [path.join(root, 'src/options/index.ts')], outfile: path.join(out, 'options.js') },
  { ...shared, entryPoints: [path.join(root, 'src/files/index.ts')], outfile: path.join(out, 'files.js') },
];

// Files and folders that go into dist/ as they are: from, to
const copies = [
  ['manifest.json', 'manifest.json'],
  ['src/reader/reader.html', 'reader.html'],
  ['src/reader/reader.css', 'reader.css'],
  ['src/viewer/viewer.html', 'viewer.html'],
  ['src/viewer/viewer.css', 'viewer.css'],
  ['src/options/options.html', 'options.html'],
  ['src/options/options.css', 'options.css'],
  ['src/files/files.html', 'files.html'],
  ['src/host/base.css', 'base.css'],
  ['core/styles.css', 'core.css'],
  ['assets/icon-16.png', 'icons/icon-16.png'],
  ['assets/icon-32.png', 'icons/icon-32.png'],
  ['assets/icon-48.png', 'icons/icon-48.png'],
  ['assets/icon-128.png', 'icons/icon-128.png'],
  ['node_modules/pdfjs-dist/build/pdf.min.mjs', 'pdfjs/pdf.min.mjs'],
  ['node_modules/pdfjs-dist/build/pdf.worker.min.mjs', 'pdfjs/pdf.worker.min.mjs'],
  // What PDF.js needs to show pages, beyond reading their text: its viewer, and the fonts, character maps, colour profiles and decoders that a file can ask for without bringing them
  ['node_modules/pdfjs-dist/web/pdf_viewer.mjs', 'pdfjs/pdf_viewer.mjs'],
  ['node_modules/pdfjs-dist/web/pdf_viewer.css', 'pdfjs/pdf_viewer.css'],
  ['node_modules/pdfjs-dist/web/images', 'pdfjs/images'],
  ['node_modules/pdfjs-dist/standard_fonts', 'pdfjs/standard_fonts'],
  ['node_modules/pdfjs-dist/cmaps', 'pdfjs/cmaps'],
  ['node_modules/pdfjs-dist/iccs', 'pdfjs/iccs'],
  ['node_modules/pdfjs-dist/wasm', 'pdfjs/wasm'],
  ['node_modules/pdfjs-dist/LICENSE', 'licenses/pdfjs.txt'],
  ['node_modules/@mozilla/readability/LICENSE.md', 'licenses/readability.txt'],
  ['node_modules/lucide/LICENSE', 'licenses/lucide.txt'],
  ['LICENSE', 'licenses/foveafocus.txt'],
];

async function copyAll() {
  for (const [from, to] of copies) {
    const target = path.join(out, to);
    await fs.mkdir(path.dirname(target), { recursive: true });
    await fs.cp(path.join(root, from), target, { recursive: true });
  }
}

async function build() {
  const started = Date.now();
  await Promise.all(bundles.map((bundle) => esbuild.build(bundle)));
  await copyAll();
  console.log(`built into dist/ in ${Date.now() - started} ms`);
}

await fs.rm(out, { recursive: true, force: true });
await build();

if (watching) {
  let pending = null;
  const again = () => {
    clearTimeout(pending);
    pending = setTimeout(() => build().catch((error) => console.error(error.message)), 150);
  };
  for (const folder of ['src', 'core']) watch(path.join(root, folder), { recursive: true }, again);
  watch(path.join(root, 'manifest.json'), again);
  console.log('watching src/, core/ and manifest.json');
}
