// The site-wide password screen (middleware.js).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import middleware from '../middleware.js';

const B = 'https://pgbx-app.vercel.app';
const passes = r => r.headers.get('x-middleware-next') === '1';
const req = (path, init = {}) => new Request(B + path, init);

test('without SITE_PASSWORD the site is open', async () => {
  delete process.env.SITE_PASSWORD;
  assert.ok(passes(await middleware(req('/admin'))));
});

test('with SITE_PASSWORD: locked until the right password, then a cookie lets you in', async () => {
  process.env.SITE_PASSWORD = 'correct horse battery staple';
  const page = await middleware(req('/'));
  assert.equal(page.status, 401);
  assert.match(await page.text(), /Private preview/);
  assert.equal(page.headers.get('x-robots-tag'), 'noindex, nofollow');
  const api = await middleware(req('/api/v1/me'));
  assert.equal(api.status, 401); assert.equal((await api.json()).error, 'PRIVATE');

  const wrong = await middleware(req('/__gate', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ password: 'nope' }) }));
  assert.equal(wrong.status, 400); assert.equal(wrong.headers.get('set-cookie'), null);
  const right = await middleware(req('/__gate', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ password: 'correct horse battery staple' }) }));
  assert.equal(right.status, 200);
  const cookie = right.headers.get('set-cookie');
  assert.match(cookie, /HttpOnly/); assert.match(cookie, /Secure/); assert.doesNotMatch(cookie, /correct horse/);
  const value = cookie.split(';')[0];
  assert.ok(passes(await middleware(req('/live/', { headers: { cookie: value } }))));
  assert.ok(passes(await middleware(req('/api/v1/me', { headers: { cookie: 'other=1; ' + value } }))));

  process.env.SITE_PASSWORD = 'a new password';                       // changing it signs everyone out
  assert.equal((await middleware(req('/', { headers: { cookie: value } }))).status, 401);
});

test('webhooks, the scheduled job and the screen itself stay reachable', async () => {
  process.env.SITE_PASSWORD = 'x-secret';
  for (const p of ['/api/v1/payments/webhook', '/api/v1/cron/sweep', '/favicon.svg', '/robots.txt']) assert.ok(passes(await middleware(req(p))), p);
  const js = await middleware(req('/__gate.js'));
  assert.equal(js.status, 200); assert.match(js.headers.get('content-type'), /javascript/);
  assert.equal((await middleware(req('/api/v1/payments/webhook/../../me'))).status, 401);   // no path tricks
  // the phone apps call the API from their own origin and have no password cookie; the website stays locked to them
  for (const o of ['capacitor://localhost', 'https://localhost']) assert.ok(passes(await middleware(req('/api/v1/me', { headers: { origin: o } }))), o);
  assert.equal((await middleware(req('/live/', { headers: { origin: 'capacitor://localhost' } }))).status, 401);
  assert.equal((await middleware(req('/api/v1/me', { headers: { origin: 'https://localhost.evil.com' } }))).status, 401);
  for (const p of ['/legal/privacy', '/legal/terms', '/legal/delete-account', '/legal/_style.css', '/manifest.webmanifest', '/live/manifest.webmanifest']) assert.ok(passes(await middleware(req(p))), p);
  delete process.env.SITE_PASSWORD;
});
