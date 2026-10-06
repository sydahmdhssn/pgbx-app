// Site-wide password screen (Vercel Routing Middleware). Keeps the whole site private while PGBX is testing.
//
//   SITE_PASSWORD   set in Vercel → Project → Settings → Environment Variables. Never in the code or a chat.
//                   Not set: the site is open (so a missing setting can't lock everyone out).
//
// After the right password the browser gets an HttpOnly cookie for 30 days. The cookie holds an HMAC of the
// password, so changing SITE_PASSWORD signs everyone out. Payment webhooks and the scheduled job are not behind
// the screen (they have their own signatures and secret), so they keep working.
import { next } from '@vercel/functions';

const COOKIE = 'pgbx_gate';
const DAYS = 30;
const OPEN = [
  /^\/__gate(\.js)?$/,                       // the screen itself
  /^\/api\/v1\/payments\/webhook\/?$/,       // provider callbacks, verified by HMAC signature
  /^\/api\/v1\/cron\//,                      // Vercel Cron, verified by CRON_SECRET
  /^\/(favicon\.svg|favicon\.ico|robots\.txt)$/,
];

const enc = new TextEncoder();
async function hmac(secret, text) {
  const key = await crypto.subtle.importKey('raw', enc.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  return [...new Uint8Array(await crypto.subtle.sign('HMAC', key, enc.encode(text)))].map(b => b.toString(16).padStart(2, '0')).join('');
}
const same = (a, b) => { if (a.length !== b.length) return false; let d = 0; for (let i = 0; i < a.length; i++) d |= a.charCodeAt(i) ^ b.charCodeAt(i); return d === 0; };
const cookieOf = (req, name) => (req.headers.get('cookie') || '').split(';').map(c => c.trim()).find(c => c.startsWith(name + '='))?.slice(name.length + 1) || '';
const token = pw => hmac(pw, 'pgbx-site-gate-v1');

const SECURITY = {
  'Cache-Control': 'no-store',
  'X-Robots-Tag': 'noindex, nofollow',
  'X-Frame-Options': 'DENY',
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'no-referrer',
  'Content-Security-Policy': "default-src 'none'; script-src 'self'; style-src 'unsafe-inline'; connect-src 'self'; img-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
};

const PAGE = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex, nofollow"><meta name="theme-color" content="#052414"><title>PGBX · Private preview</title>
<link rel="icon" href="/favicon.svg" type="image/svg+xml">
<style>
*{box-sizing:border-box}html,body{margin:0;height:100%}
body{display:grid;place-items:center;padding:24px 16px;background:radial-gradient(120% 80% at 50% 0%,#0B4A2C,#052414);color:#17241C;
font:15px/1.45 -apple-system,BlinkMacSystemFont,"SF Pro Text",system-ui,"Segoe UI",Roboto,Arial,sans-serif;-webkit-font-smoothing:antialiased}
.card{width:100%;max-width:360px;background:#fff;border-radius:16px;padding:28px 24px;box-shadow:0 18px 40px -16px rgba(0,0,0,.5)}
.brand{display:flex;align-items:center;gap:10px;margin-bottom:20px}.brand img{width:36px;height:36px}
.brand b{font:600 18px ui-serif,"New York",Georgia,serif}.brand span{display:block;font-size:12px;color:#55635A}
h1{font:600 24px/1.2 ui-serif,"New York",Georgia,serif;margin:0 0 6px}p{margin:0 0 18px;color:#55635A}
label span{display:block;font-size:13px;font-weight:600;margin-bottom:6px}
input{width:100%;min-height:48px;padding:10px 12px;border:1px solid rgba(23,36,28,.18);border-radius:8px;font:inherit}
input:focus{outline:none;border-color:#12603A;box-shadow:0 0 0 3px #DCE9E0}input[aria-invalid=true]{border-color:#AE3A28}
button{margin-top:14px;width:100%;min-height:48px;border:0;border-radius:8px;background:#0B4A2C;color:#fff;font-family:inherit;font-size:15px;font-weight:600;cursor:pointer}
button:hover{background:#12603A}button:disabled{opacity:.6;cursor:default}
.err{min-height:20px;margin-top:8px;font-size:13px;color:#AE3A28}
</style></head><body>
<main class="card"><div class="brand"><img src="/favicon.svg" alt=""><div><b>PGBX</b><span>Pakistan Gold Bullion Exchange</span></div></div>
<h1>Private preview</h1><p>This site is not public yet. Enter the password you were given.</p>
<form id="f" novalidate><label><span>Password</span><input id="pw" type="password" autocomplete="current-password" required autofocus></label>
<button id="go" type="submit">Continue</button><div class="err" id="err" role="alert"></div></form></main>
<script src="/__gate.js"></script></body></html>`;

// No inline script (the policy forbids it): the page loads this to send the password.
const SCRIPT = `document.getElementById('f').addEventListener('submit', async e => {
  e.preventDefault();
  const pw = document.getElementById('pw'), go = document.getElementById('go'), err = document.getElementById('err');
  if (!pw.value) { err.textContent = 'Enter the password.'; pw.setAttribute('aria-invalid', 'true'); return; }
  go.disabled = true; go.textContent = 'Checking…'; err.textContent = '';
  try {
    const r = await fetch('/__gate', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ password: pw.value }) });
    if (r.ok) { location.reload(); return; }
    err.textContent = r.status === 400 ? 'That password isn’t right. Try again.' : 'Something went wrong. Try again.';
  } catch (x) { err.textContent = 'Can’t reach the site. Check your connection.'; }
  pw.value = ''; pw.setAttribute('aria-invalid', 'true'); pw.focus(); go.disabled = false; go.textContent = 'Continue';
});`;

export default async function middleware(request) {
  const password = process.env.SITE_PASSWORD;
  if (!password) return next();                                  // not configured: site stays open
  const url = new URL(request.url);
  const path = url.pathname;

  if (path === '/__gate.js') return new Response(SCRIPT, { headers: { ...SECURITY, 'Content-Type': 'text/javascript; charset=utf-8' } });
  if (path === '/__gate' && request.method === 'POST') {
    let given = '';
    try { given = String((await request.json()).password || '').slice(0, 200); } catch { }
    const [want, got] = await Promise.all([token(password), token(given)]);
    if (!same(want, got)) {
      await new Promise(r => setTimeout(r, 600));                // slows guessing
      return new Response(JSON.stringify({ ok: false }), { status: 400, headers: { ...SECURITY, 'Content-Type': 'application/json' } });
    }
    return new Response(JSON.stringify({ ok: true }), { headers: { ...SECURITY, 'Content-Type': 'application/json',
      'Set-Cookie': `${COOKIE}=${want}; Path=/; Max-Age=${DAYS * 86400}; HttpOnly; Secure; SameSite=Lax` } });
  }
  // A "path" parameter could make an open URL reach a different API route through the rewrite, so it isn't open then.
  if (OPEN.some(re => re.test(path)) && !url.searchParams.has('path')) return next();

  const have = cookieOf(request, COOKIE);
  if (have && same(have, await token(password))) return next();

  // Locked. API calls get JSON; pages get the password screen.
  if (path.startsWith('/api/')) return new Response(JSON.stringify({ error: 'PRIVATE', message: 'This site is private. Enter the password first.' }), { status: 401, headers: { ...SECURITY, 'Content-Type': 'application/json' } });
  return new Response(PAGE, { status: 401, headers: { ...SECURITY, 'Content-Type': 'text/html; charset=utf-8' } });
}
