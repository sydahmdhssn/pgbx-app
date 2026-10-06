// Local development server: the app, admin panel and dealer app as static files plus the full API on an in-memory
// database with sample data. Providers run in their test modes (login code 123456, sandbox payments and identity checks).
//
//   npm install && npm run dev     ->  http://localhost:8080  (app)   /admin   /dealer
//
// Nothing here is used in production. Data is lost when the server stops.
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createMemoryDb } from '../server/memory-db.mjs';
import { hashPassword, newTotpSecret, totp } from '../server/security.mjs';
import { fetchLiveRates } from '../server/rates.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PORT = Number(process.env.PORT || 8080);
Object.assign(process.env, { NODE_ENV: 'development', OTP_TEST_MODE: '1', PAYMENT_PROVIDER: 'sandbox', KYC_PROVIDER: 'sandbox', CRON_SECRET: 'dev-cron', ...process.env });
const { handle } = await import('../server/api.mjs');
const { default: ratesHandler } = await import('../api/rates.mjs');

const db = await createMemoryDb();
// Live prices when the rate sources are reachable; otherwise clearly marked sample prices so buying can still be tried.
let warned = false;
const fetchRates = async opts => {
  const live = await fetchLiveRates(opts).catch(() => null);
  if (live && live.ok) return live;
  if (!warned) { console.log('Live rate sources unreachable: using SAMPLE prices for development.'); warned = true; }
  const j = n => Math.round(n * (1 + (Math.random() - 0.5) * 0.002));
  return { ok: true, usdPkr: { rate: 280, updatedAt: new Date().toISOString(), source: 'sample (dev)' }, metals: { gold: { buyTola: j(466560), sellTola: j(460000), source: 'sample (dev)', sourceUpdatedAt: new Date().toISOString() }, silver: { buyTola: j(6400), sellTola: j(6240), sourceUpdatedAt: new Date().toISOString() } } };
};
// Sample staff for trying the admin panel and dealer app. Passwords and authenticator secrets are printed below.
const staff = [
  { email: 'admin@pgbx.test', name: 'Sample Admin', role: 'admin', dealer: null },
  { email: 'ops@pgbx.test', name: 'Sample Operations', role: 'ops', dealer: null },
  { email: 'dealer@pgbx.test', name: 'Sample Dealer (Saddar)', role: 'dealer', dealer: 'd1' },
];
for (const s of staff) {
  s.password = 'dev-' + s.role;
  s.secret = newTotpSecret();
  await db.query(`insert into staff (email, name, role, dealer_id, password_hash, totp_secret) values ($1, $2, $3, $4, $5, $6)`, [s.email, s.name, s.role, s.dealer, hashPassword(s.password), s.secret]);
}

const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.json': 'application/json', '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon', '.webmanifest': 'application/manifest+json' };
const BLOCKED = /^\/(server|dev|tests|supabase|node_modules|mobile|scripts|api|\.git|\.[^/]*)(\/|$)|^\/package|\.(md|mjs|sql|sh)$/i;

http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');
  if (url.pathname.startsWith('/api/v1')) return handle(req, res, { db, fetchRates });
  if (url.pathname === '/api/rates') return ratesHandler(req, res);
  let decoded; try { decoded = decodeURIComponent(url.pathname); } catch { res.statusCode = 400; return res.end(); }
  if (BLOCKED.test(decoded) || decoded.includes('\0')) { res.statusCode = 404; return res.end('Not found'); }   // checked after decoding
  let file = path.join(ROOT, decoded);
  if (file !== ROOT && !file.startsWith(ROOT + path.sep)) { res.statusCode = 400; return res.end(); }
  if (fs.existsSync(file) && fs.statSync(file).isDirectory()) file = path.join(file, 'index.html');
  else if (!path.extname(file) && fs.existsSync(file + '.html')) file += '.html';
  if (!fs.existsSync(file)) { res.statusCode = 404; return res.end('Not found'); }
  res.setHeader('Content-Type', TYPES[path.extname(file)] || 'application/octet-stream');
  res.setHeader('Cache-Control', 'no-store');
  fs.createReadStream(file).pipe(res);
}).listen(PORT, process.env.HOST || '127.0.0.1', () => {   // this machine only, unless HOST is set
  console.log(`PGBX dev server  http://localhost:${PORT}   admin: /admin   dealer: /dealer`);
  console.log('Customer login code: 123456 (test mode). Payments and identity checks: sandbox.');
  console.log('Sample staff (authenticator code changes every 30 s; current code shown, or add the secret to an authenticator app):');
  for (const s of staff) console.log(`  ${s.email.padEnd(18)} password ${s.password.padEnd(11)} secret ${s.secret}  code now ${totp(s.secret)}`);
});
