// Builds one self-contained HTML file: the real front end + an in-page mock of the API, with sample data.
//   npm run demo   →   dist/eventpass-preview.html   (open it in any browser, no server needed)
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const out = process.argv[2] || path.join(root, 'dist', 'eventpass-preview.html');

const { outputFiles } = await build({ entryPoints: [path.join(root, 'demo', 'entry.js')], bundle: true, minify: true, format: 'iife', target: 'es2020', write: false, legalComments: 'none', logLevel: 'warning' });
const js = outputFiles[0].text.replace(/<\/script/gi, '<\\/script');
const css = fs.readFileSync(path.join(root, 'public', 'css', 'app.css'), 'utf8');
let html = fs.readFileSync(path.join(root, 'public', 'index.html'), 'utf8');
html = html.replace('<link rel="stylesheet" href="/css/app.css">', () => `<style>${css}</style>`)
  .replace('<script type="module" src="/js/main.js"></script>', () => `<script>${js}</script>`)
  .replace('<title>EventPass</title>', '<title>EventPass preview</title>');
if (html.includes('/js/main.js') || html.includes('/css/app.css')) throw new Error('the page still points at files that will not exist');
fs.mkdirSync(path.dirname(out), { recursive: true });
fs.writeFileSync(out, html);
console.log(`${out}  ${(html.length / 1024).toFixed(0)} KB`);
