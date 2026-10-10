// Production build of the customer app: same code as the demo, switched to the real API with every demo shortcut,
// sample record and prototype label removed (see BUILD in app.js).
//
//   npm run build:app ->  dist/          self-contained web app for the native projects (mobile/, Capacitor webDir)
//                       live/index.html  the production web app at /live on the same Vercel deployment
//
// The demo stays at / for presentations. Options: --api https://api.example.com  sets the server the native app calls
// (default: apiOrigin in app.config.json).
//
// The production app is one minified file (app.js + live.js + the Preact/htm library) with the build fixed to
// production, so most demo-only code is dropped and the phone loads one small script instead of three.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import * as esbuild from 'esbuild';
import { config } from './apply-config.mjs';            // also writes app.config.json into every file that needs it

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const arg = k => { const i = process.argv.indexOf('--' + k); return i > 0 ? process.argv[i + 1] : undefined; };
const api = arg('api') || config.apiOrigin;
if (!/^https:\/\/[a-z0-9.-]+(:\d+)?$/i.test(api)) { console.error('--api must be an https origin without a path'); process.exit(1); }

// The sources the bundle is made from; their hash is written into the bundle so a test can tell when it's out of date
export const SOURCES = ['app.js', 'live.js', 'vendor/htm-preact-standalone-3.1.1.module.js'];
export const sourceHash = root => crypto.createHash('sha256').update(SOURCES.map(f => fs.readFileSync(path.join(root, f), 'utf8')).join('\0')).digest('hex').slice(0, 16);
async function bundle() {
  const src = fs.readFileSync(path.join(ROOT, 'app.js'), 'utf8');
  // BUILD and LIVE become build-time constants, so every `!LIVE && …` and `LIVE ? … : demo` branch is removed
  const fixed = src.replace(/const BUILD = [^\n]+\nconst LIVE = BUILD === 'production';/, '');
  if (fixed === src) throw new Error('app.js: the BUILD / LIVE lines changed; update scripts/build.mjs');
  const r = await esbuild.build({ stdin: { contents: fixed, resolveDir: ROOT, sourcefile: 'app.js' }, bundle: true, minify: true, format: 'esm',
    define: { LIVE: 'true', BUILD: '"production"' },
    target: ['es2020', 'safari14'], write: false, legalComments: 'none', logLevel: 'warning' });
  if (r.warnings.length) throw new Error('esbuild warnings: fix them in app.js first');
  return `/* PGBX ${config.version} (${config.build}) · production build of app.js, live.js and htm-preact (licences: vendor/LICENSES.txt) · source ${sourceHash(ROOT)} */\n` + r.outputFiles[0].text;
}
const prodJs = await bundle();

function production(html, { assetBase }) {
  let out = html
    .replace('<meta name="pgbx-build" content="demo">', `<meta name="pgbx-build" content="production">\n<meta name="pgbx-api" content="${api}">`)
    .replace(/<meta name="description" content="[^"]*">/, '<meta name="description" content="PGBX: buy Shariah-compliant 999.0 gold and silver at live prices, hold it in your wallet and collect it at PGBX dealers.">')
    .replace(/<div class="page-caption">[^<]*<\/div>\n?/, '')
    .replace('<script type="module" src="app.js"></script>', `<script type="module" src="${assetBase}app.js"></script>`)
    .replace(/<link rel="modulepreload" href="[^"]+">\n?/g, '');                 // everything is in the one bundle
  if (!out.includes('content="production"') || !out.includes(`src="${assetBase}app.js"`)) throw new Error('index.html changed: update scripts/build.mjs');
  return out;
}
const index = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');

// dist/: everything the native app bundles
const dist = path.join(ROOT, 'dist');
fs.rmSync(dist, { recursive: true, force: true });
fs.mkdirSync(path.join(dist, 'vendor'), { recursive: true });
fs.writeFileSync(path.join(dist, 'index.html'), production(index, { assetBase: '' }));
fs.writeFileSync(path.join(dist, 'app.js'), prodJs);
for (const f of ['favicon.svg', 'vendor/LICENSES.txt']) fs.copyFileSync(path.join(ROOT, f), path.join(dist, f));
// PGBX_PUSH lists the platforms whose push setup is complete (e.g. "android,ios"); empty means push stays off.
const push = String(process.env.PGBX_PUSH || '').split(',').map(x => x.trim()).filter(x => ['android', 'ios'].includes(x)).join(',');
fs.writeFileSync(path.join(dist, 'bridge.js'), fs.readFileSync(path.join(ROOT, 'mobile', 'bridge.js'), 'utf8').replace('__PGBX_PUSH__', push));
// The native app has no server to send security headers, so its policy is in the page: scripts only from the app
// itself (plus Cloudflare's human check when PGBX switches it on), network only to the PGBX API.
const csp = `default-src 'self'; script-src 'self' https://challenges.cloudflare.com; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; connect-src ${api}; frame-src https://challenges.cloudflare.com; frame-ancestors 'none'; base-uri 'self'; form-action 'none'; object-src 'none'`;
const withBridge = fs.readFileSync(path.join(dist, 'index.html'), 'utf8')
  .replace('<link rel="icon" href="/favicon.svg"', '<link rel="icon" href="favicon.svg"')
  .replace(/<link rel="manifest"[^>]*>\n?/, '')
  .replace(/<link rel="apple-touch-icon"[^>]*>\n?/, '')
  .replace('<meta charset="utf-8">', `<meta charset="utf-8">\n<meta http-equiv="Content-Security-Policy" content="${csp}">`)
  .replace('<script type="module" src="app.js"></script>', '<script type="module" src="bridge.js"></script>\n<script type="module" src="app.js"></script>');
fs.writeFileSync(path.join(dist, 'index.html'), withBridge);

// live/: the production web app, with its own bundle at /live/app.js
fs.mkdirSync(path.join(ROOT, 'live'), { recursive: true });
fs.writeFileSync(path.join(ROOT, 'live', 'app.js'), prodJs);
fs.writeFileSync(path.join(ROOT, 'live', 'manifest.webmanifest'), JSON.stringify({ ...JSON.parse(fs.readFileSync(path.join(ROOT, 'manifest.webmanifest'), 'utf8')), start_url: '/live/', scope: '/live/' }, null, 2) + '\n');
fs.writeFileSync(path.join(ROOT, 'live', 'index.html'), production(index, { assetBase: '/live/' }).replace('href="/manifest.webmanifest"', 'href="/live/manifest.webmanifest"').replace('<title>PGBX</title>', '<title>PGBX</title>\n<!-- Generated by scripts/build.mjs from index.html. Do not edit. -->'));
console.log(`Built dist/ (native, API ${api}) and live/ (web): ${config.appId} ${config.version} (${config.build}), app ${Math.round(prodJs.length / 1024)} KB`);
