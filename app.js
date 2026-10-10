// htm + Preact, self-hosted (no third-party CDN at runtime); licences in vendor/LICENSES.txt
import { html, render, Component, useState, useEffect, useRef, useMemo, useErrorBoundary } from './vendor/htm-preact-standalone-3.1.1.module.js';
import * as Live from './live.js';

// Two builds from one code base (npm run build:app writes the production one to dist/ and live/):
//   demo        presentations and testing: sample customer data in this browser, demo controls, simulated steps
//   production  the real app: every record comes from the PGBX API, no demo shortcuts, no sample data
const BUILD = document.querySelector('meta[name="pgbx-build"]')?.content === 'production' ? 'production' : 'demo';
const LIVE = BUILD === 'production';

// Fonts: Apple system families (SF Pro, SF Compact, SF Mono, New York) via CSS; nothing is downloaded.
// Requirement IDs (FR-*, NFR-*, CMP-*) live in code comments only; customers never see them.
const TERMS_VERSION = '1.0';                // the terms and privacy policy customers accept (app.config.json termsVersion)
const APP_VERSION = LIVE ? '1.0.0' : '0.9 (prototype)';

/* ============================================================
   Constants (SRS references in comments)
   ============================================================ */
const TOLA = 11.664;                       // 1 tola = 11.664 g in every calculation
const params = new URLSearchParams(location.search);
const START = LIVE ? null : params.get('start');   // demo only: home | login | pin
const FEED_FAIL = !LIVE && params.get('feedFail') === '1';
const FORCE_SIM = !LIVE && params.get('sim') === '1';
const POLL_MS = 10000;                     // FR-R1: update every 5–10 s
const SYNC_MS = 20000;                     // production: the account's records, while the app is open
const MICRO_QUOTE_MS = 20000;              // production: today's $1 price, while a $1 gold screen is open
const PUBLIC_RETRY_MS = 30000;             // production: dealers, products and service settings that didn't load
const SIM_TICK_MS = 5000;
const STALE_MS = 30000;                    // FR-R4: freshness limit (proposed default): no successful update for 30 s
const DATA_STALE_MS = 90000;               // FR-R4: the prices themselves older than 90 s (the source updates about every 30 s)
const FX_STALE_MS = 36 * 3600e3;           // USD/PKR comes from a once-a-day source; older than 36 h is flagged
let LOCK_S = 60;                           // FR-B2: 60 s price lock (production: from the server)
let MAX_UNITS = 10;                        // FR-B6: per-order limit (sample; production: from the server)
let RESERVE_MS = 24 * 3600 * 1000;         // redemption code expiry (24 h; production: from the server)
const AUTOLOCK_MS = 2 * 60 * 1000;         // FR-A4: lock after 2 minutes inactivity
const TBC = '[To be confirmed by PGBX]';
// Live rates come from the prototype's own server endpoint (Rule 1, FR-R3).
// Locally (no /api), it falls back to the deployed endpoint, then to simulated rates.
// Fixed list only: a link must never be able to point the app at another server (phishing / fake prices).
// Same origin first; the production host is the fallback for local static servers that have no /api.
// Production: only the PGBX API, priced with PGBX's own spread and premiums (/api/v1/rates).
const API_BASES = LIVE ? [Live.API_ROOT.replace(/\/api\/v1$/, '')] : [...new Set(['', 'https://pgbx-app.vercel.app'])];
const API_URLS = LIVE ? [Live.API_ROOT + '/rates'] : API_BASES.map(b => b + '/api/rates');
const KYC_START = !LIVE && params.get('kyc') === 'done' ? 'verified' : 'none';   // ?kyc=done skips identity verification
let DAY_LIMIT = 1500000;                   // FR-B6: per-day purchase limit in PKR (sample; production: from the server)
let MIN_PURCHASE = null;
// Every purchase and sale needs a final rate confirmed by PGBX support in chat (production: from the server; demo: ?ratechat=0 shows instant prices)
let RATE_CHAT = LIVE || params.get('ratechat') !== '0';
// Production: limits come from the PGBX settings, so the app and the server always agree
function applyLimits(l) {
  if (!l) return;
  if (Number.isInteger(l.max_units_per_order)) MAX_UNITS = l.max_units_per_order;
  if (Number.isInteger(l.daily_limit_pkr)) DAY_LIMIT = l.daily_limit_pkr;
  if (Number.isInteger(l.price_lock_seconds)) LOCK_S = l.price_lock_seconds;
  if (Number.isInteger(l.redemption_valid_hours)) RESERVE_MS = l.redemption_valid_hours * 3600e3;
  MIN_PURCHASE = Number.isInteger(l.min_purchase_pkr) ? l.min_purchase_pkr : null;
  if (typeof l.rate_chat_required === 'boolean') RATE_CHAT = l.rate_chat_required;
}
const PIN_DEFAULT = '1234';                // prototype PIN (changeable in Account > Change PIN)
// The demo keeps its sample PIN on the phone. Production never stores the PIN on the phone: the server checks it.
// The hash below only reads PINs an older build saved, so they still work once before being dropped.
function sha256(bytes) {
  const K = [0x428a2f98,0x71374491,0xb5c0fbcf,0xe9b5dba5,0x3956c25b,0x59f111f1,0x923f82a4,0xab1c5ed5,0xd807aa98,0x12835b01,0x243185be,0x550c7dc3,0x72be5d74,0x80deb1fe,0x9bdc06a7,0xc19bf174,0xe49b69c1,0xefbe4786,0x0fc19dc6,0x240ca1cc,0x2de92c6f,0x4a7484aa,0x5cb0a9dc,0x76f988da,0x983e5152,0xa831c66d,0xb00327c8,0xbf597fc7,0xc6e00bf3,0xd5a79147,0x06ca6351,0x14292967,0x27b70a85,0x2e1b2138,0x4d2c6dfc,0x53380d13,0x650a7354,0x766a0abb,0x81c2c92e,0x92722c85,0xa2bfe8a1,0xa81a664b,0xc24b8b70,0xc76c51a3,0xd192e819,0xd6990624,0xf40e3585,0x106aa070,0x19a4c116,0x1e376c08,0x2748774c,0x34b0bcb5,0x391c0cb3,0x4ed8aa4a,0x5b9cca4f,0x682e6ff3,0x748f82ee,0x78a5636f,0x84c87814,0x8cc70208,0x90befffa,0xa4506ceb,0xbef9a3f7,0xc67178f2];
  const H = [0x6a09e667,0xbb67ae85,0x3c6ef372,0xa54ff53a,0x510e527f,0x9b05688c,0x1f83d9ab,0x5be0cd19];
  const l = bytes.length, n = ((l + 9 + 63) >> 6) << 6, m = new Uint8Array(n); m.set(bytes); m[l] = 0x80;
  const dv = new DataView(m.buffer); dv.setUint32(n - 4, l * 8); const w = new Uint32Array(64);
  const r = (x, k) => (x >>> k) | (x << (32 - k));
  for (let o = 0; o < n; o += 64) {
    for (let i = 0; i < 16; i++) w[i] = dv.getUint32(o + i * 4);
    for (let i = 16; i < 64; i++) w[i] = (w[i - 16] + (r(w[i - 15], 7) ^ r(w[i - 15], 18) ^ (w[i - 15] >>> 3)) + w[i - 7] + (r(w[i - 2], 17) ^ r(w[i - 2], 19) ^ (w[i - 2] >>> 10))) | 0;
    let [a, b, c, d, e, f, g, h] = H;
    for (let i = 0; i < 64; i++) {
      const t1 = (h + (r(e, 6) ^ r(e, 11) ^ r(e, 25)) + ((e & f) ^ (~e & g)) + K[i] + w[i]) | 0, t2 = ((r(a, 2) ^ r(a, 13) ^ r(a, 22)) + ((a & b) ^ (a & c) ^ (b & c))) | 0;
      h = g; g = f; f = e; e = (d + t1) | 0; d = c; c = b; b = a; a = (t1 + t2) | 0;
    }
    H[0] = (H[0] + a) | 0; H[1] = (H[1] + b) | 0; H[2] = (H[2] + c) | 0; H[3] = (H[3] + d) | 0; H[4] = (H[4] + e) | 0; H[5] = (H[5] + f) | 0; H[6] = (H[6] + g) | 0; H[7] = (H[7] + h) | 0;
  }
  const out = new Uint8Array(32); const ov = new DataView(out.buffer); H.forEach((x, i) => ov.setUint32(i * 4, x)); return out;
}
const hex = b => Array.from(b, x => x.toString(16).padStart(2, '0')).join('');
function pinHash(pin, salt) { let h = new TextEncoder().encode(salt + ':' + pin); for (let i = 0; i < 4000; i++) h = sha256(h); return hex(h); }
const pinStore = pin => pin;              // demo only
function pinOk(input, stored) {
  if (typeof stored !== 'string') return false;
  if (!stored.startsWith('h1$')) return !LIVE && input === stored;
  const [, salt, h] = stored.split('$');
  return pinHash(input, salt) === h;
}
const PIN_COOLDOWN_AT = 3;                 // FR-A4: wrong PINs before a 30 s pause (sample)
const PIN_MAX_FAILS = 5;                   // FR-A4: wrong PINs before the session ends and OTP login is required (sample)
// Pakistani mobile numbers: Jazz 300–309 and 320–329, Zong 310–319, Ufone 330–339, Telenor 340–349, SCOM 355
const PK_MOBILE = /^3(?:[0-4]\d|55)\d{7}$/;
// FR-A1 one-time codes go through the server (/api/otp); the provider keys never reach the app (Rule 6).
// Fetch with a time limit so a slow connection ends in a clear message instead of an endless spinner.
async function fetchT(url, opts = {}, ms = 12000) {
  const ctl = new AbortController(); const t = setTimeout(() => ctl.abort(), ms);
  try { return await fetch(url, { ...opts, signal: ctl.signal }); } finally { clearTimeout(t); }
}
// Production: login codes and number changes go through the PGBX API, which also creates the session.
async function liveOtp(body, purpose) {
  try {
    if (!body) {
      const c = await Live.config(); applyLimits(c.limits);
      return { configured: !!c.live && c.otp.mode !== 'off', channels: c.otp.channels, live: !!c.live };
    }
    if (purpose === 'phone') {
      if (body.action === 'send') await Live.phoneStart(body.phone); else await Live.phoneVerify(body.phone, body.code);
      return { ok: true, approved: true };
    }
    if (body.action === 'send') { const d = await Live.sendCode(body.phone, body.channel); return { ok: true, channel: d.channel }; }
    await Live.verifyCode(body.phone, body.code, TERMS_VERSION);
    return { ok: true, approved: true };
  } catch (e) {
    return e.code === 'NETWORK' ? { ok: false, error: 'unreachable', message: e.message } : { ok: false, message: e.message };
  }
}
async function otpCall(body, purpose = 'login') {
  if (LIVE) return liveOtp(body, purpose);
  for (const b of API_BASES) {
    try {
      const r = await fetchT(`${b}/api/otp`, body ? { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) } : { cache: 'no-store' }, 15000);
      if (r.status === 404 || r.status === 405 || r.status === 501) continue;
      const d = await r.json().catch(() => null);
      if (d) return d;
    } catch (e) { if (e.name === 'AbortError') break; }   // timed out: say so now rather than wait on the next address
  }
  return { ok: false, error: 'unreachable' };
}

// Fallback seed: Pakistan Sarafa 24K rate, 1 Oct 2026 (per tola)
const SEED = { gold: 438636, silver: 6528 };
const SPREAD = { gold: 0.012, silver: 0.025 }; // sample, used only when simulating

// The eleven online products (Section 3). Premiums are SAMPLE values; the server prices products when live.
const PRODUCTS = [
  { id: 'g-10mg',  metal: 'gold',   label: '10 mg',   short: '10mg', grams: 0.01,   premium: 120 },
  { id: 'g-20mg',  metal: 'gold',   label: '20 mg',   short: '20mg', grams: 0.02,   premium: 160 },
  { id: 'g-50mg',  metal: 'gold',   label: '50 mg',   short: '50mg', grams: 0.05,   premium: 250 },
  { id: 'g-100mg', metal: 'gold',   label: '100 mg',  short: '100mg', grams: 0.1,   premium: 350 },
  { id: 'g-500mg', metal: 'gold',   label: '500 mg',  short: '500mg', grams: 0.5,   premium: 800 },
  { id: 'g-1g',    metal: 'gold',   label: '1 gram',  short: '1 g',  grams: 1,      premium: 1200 },
  { id: 'g-5g',    metal: 'gold',   label: '5 gram',  short: '5 g',  grams: 5,      premium: 3500 },
  { id: 's-1t',    metal: 'silver', label: '1 tola',  short: '1 tola', grams: TOLA,      premium: 350 },
  { id: 's-3t',    metal: 'silver', label: '3 tola',  short: '3 tola', grams: 3 * TOLA,  premium: 800 },
  { id: 's-5t',    metal: 'silver', label: '5 tola',  short: '5 tola', grams: 5 * TOLA,  premium: 1200 },
  { id: 's-10t',   metal: 'silver', label: '10 tola', short: '10 tola', grams: 10 * TOLA, premium: 2000 },
];
const P = Object.fromEntries(PRODUCTS.map(p => [p.id, p]));
// Production: a product PGBX adds later is learned from the server instead of breaking the screens that show it.
// Until /products answers, an unknown id gets a placeholder (named by its id, no value).
function learnProduct(x) {
  if (!x || typeof x.id !== 'string') return;
  const p = { id: x.id, metal: x.metal === 'silver' ? 'silver' : 'gold', label: x.label || x.id, short: x.label || x.id, grams: Number(x.grams) || 0, premium: Number(x.premium_pkr) || 0, extra: true };
  if (P[x.id] && !P[x.id].extra) return;
  if (P[x.id]) Object.assign(P[x.id], p); else { PRODUCTS.push(p); P[x.id] = p; }
}
const metalName = m => (m === 'gold' ? 'Gold' : 'Silver');
const pname = p => `${p.label} ${metalName(p.metal)}`;

// Sample dealers (four of the 250). Stock is per product (FR-D2, FR-DL4).
const DEALERS = [
  { id: 'd1', name: 'Saddar Bullion Counter', area: 'Saddar, Karachi',          phone: '+92 21 0000 0101', lat: 24.8566, lng: 67.0272, hours: '10:00 – 20:00', out: [] },
  { id: 'd2', name: 'Clifton Gold Desk',      area: 'Clifton Block 5, Karachi', phone: '+92 21 0000 0102', lat: 24.8170, lng: 67.0300, hours: '11:00 – 21:00', out: ['s-1t', 's-10t', 'g-5g'] },
  { id: 'd3', name: 'Gulshan Sarafa Point',   area: 'Gulshan-e-Iqbal, Karachi', phone: '+92 21 0000 0103', lat: 24.9200, lng: 67.0950, hours: '10:30 – 19:30', out: ['g-1g', 's-3t'] },
  { id: 'd4', name: 'Tariq Road Metals',      area: 'PECHS, Karachi',           phone: '+92 21 0000 0104', lat: 24.8720, lng: 67.0610, hours: '12:00 – 22:00', out: ['g-10mg', 's-5t'] },
];
// Sample customer location for distances and the map (a real app would use the phone's location)
const YOU = { lat: 24.8625, lng: 67.0345 };
const kmTo = d => { const R = 6371, r = x => x * Math.PI / 180, dLat = r(d.lat - YOU.lat), dLng = r(d.lng - YOU.lng);
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(r(YOU.lat)) * Math.cos(r(d.lat)) * Math.sin(dLng / 2) ** 2; return Math.round(2 * R * Math.asin(Math.sqrt(a)) * 10) / 10; };
DEALERS.forEach(d => { d.km = kmTo(d); });
// A collection's dealer, even if the dealer has since been hidden from the list
if (LIVE) DEALERS.length = 0;          // production lists PGBX's own dealers from the server, never these samples
const dealerOf = r => DEALERS.find(x => x.id === r.dealerId) || { id: r.dealerId, name: r.dealerName || 'PGBX dealer', area: '', phone: '', hours: '', lat: YOU.lat, lng: YOU.lng, km: 0, out: [] };
const initialDealerStock = () => Object.fromEntries(DEALERS.map(d => [d.id,
  Object.fromEntries(PRODUCTS.map(p => [p.id, d.out.includes(p.id) ? 0 : 3 + ((p.id.length * 7 + d.km * 10) | 0) % 9]))]));

/* ============================================================
   Helpers
   ============================================================ */
// Formatters are built once: toLocaleString(locale, options) builds a new one on every call, which is up to 30x slower
// (it showed up as the main cost of redrawing long lists)
const F = {
  int: new Intl.NumberFormat('en-US'),
  dec: {},                                                     // by number of decimals
  dt: new Intl.DateTimeFormat('en-GB', { day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' }),
  hm: new Intl.DateTimeFormat('en-GB', { hour: '2-digit', minute: '2-digit' }),
  dayMon: new Intl.DateTimeFormat('en-GB', { day: 'numeric', month: 'short' }),
  wdHm: new Intl.DateTimeFormat('en-GB', { weekday: 'short', hour: '2-digit', minute: '2-digit' }),
  dd2Mon: new Intl.DateTimeFormat('en-GB', { day: '2-digit', month: 'short' }),
  wdDayMonUtc: new Intl.DateTimeFormat('en-GB', { weekday: 'short', day: 'numeric', month: 'short', timeZone: 'UTC' }),
};
const fmtDec = (n, d) => (F.dec[d] || (F.dec[d] = new Intl.NumberFormat('en-US', { minimumFractionDigits: d, maximumFractionDigits: d }))).format(n);
const fmt = n => (Number.isFinite(n) ? 'Rs ' + F.int.format(Math.round(n)) : 'Rs —');   // no price yet: a dash, never NaN or a sample
const fmtW = g => (g < 1 ? `${+(g * 1000).toFixed(0)} mg` : `${+g.toFixed(3)} g`);
const pct = n => (n >= 0 ? '+' : '') + n.toFixed(2) + '%';
const uid = () => Math.random().toString(36).slice(2, 8).toUpperCase();
const dt = ts => F.dt.format(new Date(ts));
const ago = ms => { const s = Math.max(0, Math.round(ms / 1000)); return s < 60 ? `${s}s ago` : `${Math.floor(s / 60)}m ${s % 60}s ago`; };
// Human-readable time for lists: "Just now", "5 min ago", "Today, 14:05", "Yesterday, 09:10", "28 Sept, 16:40"
const rel = (ts, now = Date.now()) => {
  const m = Math.floor((now - ts) / 60000), d = new Date(ts);
  const hm = F.hm.format(d);
  if (m < 1) return 'Just now';
  if (m < 60) return `${m} min ago`;
  if (sameDay(ts, now)) return `Today, ${hm}`;
  if (sameDay(ts, now - 86400e3)) return `Yesterday, ${hm}`;
  return `${F.dayMon.format(d)}, ${hm}`;
};
const dur = ms => { const s = Math.max(0, Math.floor(ms / 1000)); return `${Math.floor(s / 3600)}h ${String(Math.floor(s % 3600 / 60)).padStart(2, '0')}m ${String(s % 60).padStart(2, '0')}s`; };
const buzz = () => { try { navigator.vibrate && navigator.vibrate(6); } catch (e) { } };
function mulberry(seed) { return () => { seed |= 0; seed = seed + 0x6D2B79F5 | 0; let t = Math.imul(seed ^ seed >>> 15, 1 | seed); t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t; return ((t ^ t >>> 14) >>> 0) / 4294967296; }; }

// Rule 1 / FR-R3: when live, buy/sell and product prices come from the server (/api/rates).
// The local formulas below are used only in simulated mode.
function rateOf(rates, metal) {
  // Production never shows the built-in sample prices: until the first live answer every price is unknown
  if (LIVE && rates.mode !== 'live') return { buyTola: NaN, sellTola: NaN, buyGram: NaN, sellGram: NaN, chg: 0 };
  const m = rates[metal];
  const buyTola = m.buy;
  const sellTola = m.sell != null ? m.sell : Math.round(buyTola * (1 - SPREAD[metal]));
  return { buyTola, sellTola, buyGram: buyTola / TOLA, sellGram: sellTola / TOLA, chg: (buyTola / m.open - 1) * 100 };
}
const priceOf = (p, rates) => (rates.products && rates.products[p.id]) || Math.round(rateOf(rates, p.metal).buyGram * p.grams + p.premium);

function seedHistory(end, vol, n = 36, seed = 7) {
  const r = mulberry(seed); const out = [end];
  for (let i = 1; i < n; i++) out.unshift(Math.round(out[0] * (1 + (r() - 0.52) * vol)));
  return out;
}
function initialRates() {
  const now = Date.now();
  const g = seedHistory(SEED.gold, 0.003, 36, 11), s = seedHistory(SEED.silver, 0.005, 36, 23);
  return {
    mode: FEED_FAIL || FORCE_SIM ? 'sim' : 'connecting',
    gold: { buy: SEED.gold, sell: null, open: g[0], hist: g },
    silver: { buy: SEED.silver, sell: null, open: s[0], hist: s },
    products: null, world: [], usdPkr: null, source: null,
    updatedAt: FEED_FAIL ? now - 47000 : now,
    tick: 0,
  };
}
// How old the prices are, not when we polled (FR-R4). Measured on the server's clock so a wrong phone clock can't
// hide or invent staleness: server time of the answer (Date header plus any cache Age) minus the oldest of the
// metal sources' timestamps and the server's own fetch time. Without readable headers, falls back to the difference
// between the server's fetch time and the sources' timestamps.
function dataAge(d, hdr = {}) {
  const fetched = Date.parse(d.fetchedAt);
  const src = ['gold', 'silver'].map(k => Date.parse(d.metals[k] && d.metals[k].sourceUpdatedAt)).filter(Number.isFinite);
  const oldest = Math.min(...[fetched, ...src].filter(Number.isFinite));
  if (!Number.isFinite(oldest)) return 0;
  const served = Date.parse(hdr.date || '') + (Number(hdr.age) || 0) * 1000;
  if (Number.isFinite(served)) return Math.max(0, served - oldest);
  return Math.max(0, (Number.isFinite(fetched) ? fetched : oldest) - oldest) + (Number(hdr.age) || 0) * 1000;
}
function applyLive(s, d, hdr) {
  const first = s.rates.mode !== 'live';
  const metal = k => {
    const prev = s.rates[k], buy = d.metals[k].buyTola;
    return { buy, sell: d.metals[k].sellTola, usdOz: d.metals[k].usdPerOz, open: first ? buy : prev.open, hist: first ? [buy] : [...prev.hist.slice(-59), buy] };
  };
  const gold = metal('gold'), silver = metal('silver');
  const changed = first || gold.buy !== s.rates.gold.buy || silver.buy !== s.rates.silver.buy;
  const world = (d.world || []).map(w => {
    const prev = !first && s.rates.world.find(x => x.symbol === w.symbol);
    return { ...w, open: prev ? prev.open : w.usd, hist: prev ? [...prev.hist.slice(-59), w.usd] : [w.usd] };
  });
  const now = Date.now(), age = dataAge(d, hdr), fxAt = d.usdPkr && Date.parse(d.usdPkr.updatedAt);
  return { rates: { mode: 'live', gold, silver, products: d.products, world, usdPkr: d.usdPkr, source: d.metals.gold.source,
    updatedAt: now - age,                         // when the prices were current
    polledAt: now,                                // when the server last answered
    fxOld: Number.isFinite(fxAt) && now - fxAt > FX_STALE_MS,
    warnings: Array.isArray(d.warnings) ? d.warnings.filter(w => typeof w === 'string').slice(0, 5) : [],
    tick: s.rates.tick + (changed ? 1 : 0) } };
}

// Append-only wallet ledger (FR-W3). Opening sample holdings: 2 × 1 tola silver, 1 × 1 g gold.
function initialLedger() {
  const t = Date.now() - 9 * 24 * 3600e3;
  return [
    { id: 'L-0001', ts: t, pid: 's-1t', delta: 2, reason: 'opening', ref: 'PGBX-R-260923-SMPL01', price: 6610 },
    { id: 'L-0002', ts: t + 3600e3, pid: 'g-1g', delta: 1, reason: 'opening', ref: 'PGBX-R-260923-SMPL02', price: 38900 },
  ];
}

/* ============================================================
   Icons (inline SVG strokes)
   ============================================================ */
const PATHS = {
  rates: 'M3 17l5-5 4 4 8-8M15 8h5v5',
  buy: 'M5 8h14l-1.2 11.1a2 2 0 0 1-2 1.9H8.2a2 2 0 0 1-2-1.9L5 8zM9 8V6a3 3 0 0 1 6 0v2',
  wallet: 'M4 7.5A2.5 2.5 0 0 1 6.5 5H18v3M4 7.5v10A2.5 2.5 0 0 0 6.5 20H20v-5M4 7.5A2.5 2.5 0 0 0 6.5 10H20v5M20 15h-4a2 2 0 0 1 0-4h4',
  account: 'M12 12a4 4 0 1 0 0-8 4 4 0 0 0 0 8zM4.5 20a7.5 7.5 0 0 1 15 0',
  back: 'M15 5l-7 7 7 7',
  chev: 'M9 6l6 6-6 6',
  check: 'M5 12.5l4.5 4.5L19 7.5',
  x: 'M6 6l12 12M18 6L6 18',
  del: 'M9 6h11v12H9l-6-6 6-6zM12.5 9.5l5 5M17.5 9.5l-5 5',
  face: 'M8 3.5H6A2.5 2.5 0 0 0 3.5 6v2M16 3.5h2A2.5 2.5 0 0 1 20.5 6v2M8 20.5H6A2.5 2.5 0 0 1 3.5 18v-2M16 20.5h2a2.5 2.5 0 0 0 2.5-2.5v-2M9 9.5v1M15 9.5v1M12 9.5v3.5h-1M9.5 16a3.5 3.5 0 0 0 5 0',
  lock: 'M6 11h12v9H6zM8.5 11V8a3.5 3.5 0 0 1 7 0v3',
  shield: 'M12 3l7.5 3v5.5c0 4.5-3.2 8-7.5 9.5-4.3-1.5-7.5-5-7.5-9.5V6L12 3zM8.8 12l2.2 2.2 4.3-4.4',
  clock: 'M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18zM12 7.5V12l3 2',
  pin: 'M12 21s-6.5-5.6-6.5-11a6.5 6.5 0 0 1 13 0C18.5 15.4 12 21 12 21zM12 12.3a2.3 2.3 0 1 0 0-4.6 2.3 2.3 0 0 0 0 4.6z',
  alert: 'M12 4l9 16H3l9-16zM12 10v4M12 17.2v.1',
  info: 'M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18zM12 11v5M12 7.8v.1',
  bank: 'M3.5 9.5L12 4l8.5 5.5M5 10v7M9.7 10v7M14.3 10v7M19 10v7M3.5 20h17',
  card: 'M3.5 6.5h17v11h-17zM3.5 10h17M7 14.5h4',
  phone: 'M8 3h8a1.5 1.5 0 0 1 1.5 1.5v15A1.5 1.5 0 0 1 16 21H8a1.5 1.5 0 0 1-1.5-1.5v-15A1.5 1.5 0 0 1 8 3zM11 18h2',
  call: 'M5 4h4l2 5-2.5 1.5a11 11 0 0 0 5 5L15 13l5 2v4a2 2 0 0 1-2 2A16 16 0 0 1 3 6a2 2 0 0 1 2-2z',
  help: 'M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18zM9.5 9.5a2.5 2.5 0 0 1 4.9.7c0 1.8-2.4 2.2-2.4 3.8M12 17v.1',
  flag: 'M5 21V4M5 4h11l-2 4 2 4H5',
  doc: 'M7 3h7l4 4v14H7zM14 3v4h4M9.5 12h6M9.5 15.5h6',
  chat: 'M5 5h14a1 1 0 0 1 1 1v10a1 1 0 0 1-1 1h-9l-4 3.5V17H5a1 1 0 0 1-1-1V6a1 1 0 0 1 1-1zM8.5 9.5h7M8.5 12.5h4.5',
  send: 'M4 12l16-7-6 15-2.5-6.5zM11.5 13.5L20 5',
  clip: 'M20 11.5l-7.8 7.8a4.6 4.6 0 0 1-6.5-6.5l8-8a3 3 0 0 1 4.3 4.3l-8 8a1.5 1.5 0 0 1-2.1-2.1l7.3-7.3',
  receipt: 'M6 3h12v18l-2-1.5-2 1.5-2-1.5-2 1.5-2-1.5L6 21zM9 8h6M9 11.5h6M9 15h4',
  key: 'M14.5 9.5a4 4 0 1 1-8 0 4 4 0 0 1 8 0zM13.4 12.4L20 19M17 16l2-2',
  share: 'M12 3v12M7.5 7.5L12 3l4.5 4.5M5 13v6.5h14V13',
  plus: 'M12 5v14M5 12h14',
  minus: 'M5 12h14',
  store: 'M4 10l1.5-5h13L20 10v10H4zM9 20v-5h6v5M4 10h16',
  refresh: 'M20 11a8 8 0 0 0-14.7-3.5M4 4.5V8h3.5M4 13a8 8 0 0 0 14.7 3.5M20 19.5V16h-3.5',
  box: 'M4 7.5l8-4 8 4v9l-8 4-8-4v-9zM4 7.5l8 4 8-4M12 11.5v9',
  bell: 'M6 16V11a6 6 0 0 1 12 0v5l1.5 2h-15L6 16zM10 20.5a2 2 0 0 0 4 0',
  cart: 'M3 4h2.5l2.2 11h10.6l2-8H7M9.5 20a1 1 0 1 0 0-2 1 1 0 0 0 0 2zM17 20a1 1 0 1 0 0-2 1 1 0 0 0 0 2z',
  idcard: 'M3.5 5.5h17v13h-17zM7 10.5a1.8 1.8 0 1 0 3.6 0 1.8 1.8 0 0 0-3.6 0M5.8 15.5c.5-1.4 1.5-2 3-2s2.5.6 3 2M14 9.5h4M14 12.5h4',
  camera: 'M4 8h3l1.5-2.5h7L17 8h3v11H4zM12 16.5a3.2 3.2 0 1 0 0-6.4 3.2 3.2 0 0 0 0 6.4z',
  user: 'M12 12a4 4 0 1 0 0-8 4 4 0 0 0 0 8zM4.5 20a7.5 7.5 0 0 1 15 0',
  mail: 'M3.5 6h17v12h-17zM3.5 6l8.5 7 8.5-7',
  nav: 'M4 11l16-7-7 16-2-7-7-2z',
  download: 'M12 4v11M7.5 10.5L12 15l4.5-4.5M5 19.5h14',
  trash: 'M5 7h14M10 7V4.5h4V7M7 7l1 13h8l1-13',
  chart: 'M4 19.5h16M6.5 16l3.5-4.5 3 2.5 4.5-6',
  globe: 'M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18zM3.5 9h17M3.5 15h17M12 3c2.5 2.6 3.7 5.6 3.7 9s-1.2 6.4-3.7 9c-2.5-2.6-3.7-5.6-3.7-9S9.5 5.6 12 3z',
  sliders: 'M4 7h9M17 7h3M4 17h3M11 17h9M15 5v4M9 15v4',
  wifiOff: 'M3 3l18 18M8.5 16.5a5 5 0 0 1 7 0M5 12.5a10 10 0 0 1 4.2-2.3M19 12.5a10 10 0 0 0-3-1.9M2 8.8a15 15 0 0 1 4.3-2.6M22 8.8A15 15 0 0 0 10.6 5M12 20h.01',
  gem: 'M6 3h12l3 6-9 12L3 9l3-6zM3 9h18M9 3l3 6 3-6M12 21L9 9M12 21l3-12',
  services: 'M6 3h12l3 6-9 12L3 9l3-6zM3 9h18M9 3l3 6 3-6M12 21L9 9M12 21l3-12',
  calc: 'M6 3h12a1 1 0 0 1 1 1v16a1 1 0 0 1-1 1H6a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1zM8 6h8v4H8zM8.5 14h.01M12 14h.01M15.5 14h.01M8.5 17.5h.01M12 17.5h.01M15.5 17.5h.01',
  home: 'M3 11l9-7 9 7M5 9.5V20h5v-6h4v6h5V9.5',
  gift: 'M4 11h16v9H4zM3 7h18v4H3zM12 7v13M12 7C10.5 4 7 3.5 7 5.8 7 7 9.5 7 12 7zm0 0c1.5-3 5-3.5 5-1.2C17 7 14.5 7 12 7z',
  scale: 'M12 4v16M6 20h12M5 7h14M5 7l-3 6a3 3 0 0 0 6 0L5 7zM19 7l-3 6a3 3 0 0 0 6 0l-3-6z',
  wa: 'M4 20l1.3-4A8 8 0 1 1 8 18.7L4 20zM9 9.5c0 3 2.5 5.5 5.5 5.5l1.2-1.4-1.9-.9-.8.8a3.5 3.5 0 0 1-2.4-2.4l.8-.8-.9-1.9L9 9.5z',
};
// ---------- rendering helpers ----------
// <Keep deps=[...] render=${() => ...}/> redraws its part only when one of deps changes (compared by identity), so the
// app's once-a-second clock doesn't rebuild long lists whose rows can't have changed. Inside, call actions through ACT
// (always the newest set) rather than a captured A.
class Keep extends Component {
  shouldComponentUpdate(n) { const a = this.props.deps, b = n.deps; return a.length !== b.length || a.some((x, i) => x !== b[i]); }
  render() { return this.props.render(); }
}
let ACT = null;
// The minute shown by rel() ("3 min ago") changes once a minute; lists depend on this instead of the 1 s clock
const minuteOf = now => Math.floor(now / 60000);
// Long lists render their first rows at once and the rest as the customer scrolls towards them, so opening a screen
// with hundreds of entries costs the same as one with forty. Returns [rows to draw, element to put after them].
function useGrowing(items, first = 40, step = 60) {
  const [n, setN] = useState(first);
  const ref = useRef(null);
  const more = items.length > n;
  useEffect(() => {
    if (!more || !ref.current || !window.IntersectionObserver) { if (more && !window.IntersectionObserver) setN(items.length); return; }
    const io = new IntersectionObserver(es => { if (es.some(e => e.isIntersecting)) setN(x => x + step); }, { rootMargin: '800px 0px' });
    io.observe(ref.current); return () => io.disconnect();
  }, [more, n]);
  return [more ? items.slice(0, n) : items, more ? html`<div ref=${ref} aria-hidden="true" style="height:1px"></div>` : null];
}
const Icon = ({ n, c = '', s }) => html`<svg class=${'icon ' + c} viewBox="0 0 24 24" style=${s} aria-hidden="true"><path d=${PATHS[n]} /></svg>`;

/* ============================================================
   Motion helpers
   ============================================================ */
// Rolling-digit price: each digit column slides (transform only). Rolls up from 0 on first view.
// The rolling strip is one text block of ten lines (0-9), not ten elements: same look, ~90% fewer elements per price
const DIGIT_STRIP = '0\n1\n2\n3\n4\n5\n6\n7\n8\n9';
function Odo({ value, prefix = 'Rs ', decimals = 0, flash, dir }) {
  const [ready, setReady] = useState(false);
  useEffect(() => { let r2; const r = requestAnimationFrame(() => { r2 = requestAnimationFrame(() => setReady(true)); }); return () => { cancelAnimationFrame(r); cancelAnimationFrame(r2); }; }, []);
  if (!Number.isFinite(Number(value))) return html`<span class="odo">${prefix}—</span>`;
  const s = fmtDec(Number(value), decimals);
  const chars = s.split('');
  // The rolling digits are hidden from screen readers; they read the plain text instead
  return html`<span class="odo"><span class="sr">${prefix + s}</span>
    ${flash != null && html`<span class=${'odo-fl' + (dir ? ' ' + dir : '')} key=${'f' + flash} aria-hidden="true"></span>`}
    <span aria-hidden="true" style=${{ marginRight: /\s$/.test(prefix) ? '.24em' : 0 }}>${prefix.trim()}</span>
    ${chars.map((c, i) => { const k = chars.length - i;
      return /\d/.test(c)
        ? html`<span class="odo-col" key=${'d' + k} aria-hidden="true"><span class="odo-strip" style=${{ transform: `translateY(${ready ? -Number(c) * 10 : 0}%)`, transitionDelay: (i * 35) + 'ms' }}>${DIGIT_STRIP}</span></span>`
        : html`<span key=${'s' + k} aria-hidden="true">${c}</span>`; })}
  </span>`;
}

/* ============================================================
   Brand visuals
   ============================================================ */
// The PGBX mark. `animate` draws it in once (splash and login only); everywhere else it is static.
function Coin({ size = 200, animate = false, label = 'PGBX logo' }) {
  const star = (cx, cy, R, r) => { let pts = []; for (let i = 0; i < 10; i++) { const a = -Math.PI / 2 + i * Math.PI / 5, rr = i % 2 ? r : R; pts.push((cx + rr * Math.cos(a)).toFixed(2) + ',' + (cy + rr * Math.sin(a)).toFixed(2)); } return pts.join(' '); };
  return html`<svg class=${'coin' + (animate ? ' anim' : '')} viewBox="0 0 200 200" width=${size} height=${size} role="img" aria-label=${label}>
    <circle class="dots" cx="100" cy="100" r="97" fill="none" stroke="#E2B65A" stroke-width="2.2" stroke-linecap="round" stroke-dasharray="0.1 7" opacity=".7"/>
    <circle class="face" cx="100" cy="100" r="82" fill="url(#coinFace)"/>
    <circle class="ring" cx="100" cy="100" r="86" fill="none" stroke="url(#goldMetal)" stroke-width="5.5" pathLength="1" transform="rotate(-90 100 100)"/>
    <g class="emblem">
      <circle cx="100" cy="100" r="74" fill="none" stroke="#E2B65A" stroke-width=".8" opacity=".45"/>
      <circle cx="92" cy="80" r="30" fill="url(#goldMetal)" mask="url(#crescentMask)"/>
      <polygon points=${star(124, 62, 10, 4.2)} fill="url(#goldMetal)"/>
      <text x="100" y="146" text-anchor="middle" font-family="ui-serif, 'New York', Georgia, serif" font-weight="700" font-size="34" letter-spacing="3" fill="url(#goldText)">PGBX</text>
    </g>
  </svg>`;
}

// Logo stage for splash, login and lock: the mark draws in, then breathes with a soft glow and a passing light.
// `orbit` adds the original touches from the first version: two slowly rotating rings, a gold ball orbiting the coin
// and the coin's dotted rim turning (splash and sign-in).
// Brand badge. The claim depends on PGBX's written Shariah approval (CMP-3), still to be confirmed.
const Shariah = ({ small }) => html`<span class=${'shariah' + (small ? ' sm' : '')}><${Icon} n="shield" c="xs"/><span class="sh-t">Shariah compliant</span></span>`;

const Logo = ({ size, animate = true, orbit = false }) => html`<div class=${'logo-stage' + (orbit ? ' orbiting' : '')} style=${{ width: size + 'px', height: size + 'px' }}>
  ${orbit && html`<span class="ring r2" aria-hidden="true"></span><span class="ring r1" aria-hidden="true"></span>`}
  <span class="halo" aria-hidden="true"></span>
  <div class="floaty"><${Coin} size=${size} animate=${animate} /><span class="sheen" aria-hidden="true"><i></i></span>
    ${orbit && html`<span class="orbit" aria-hidden="true"><i></i></span>`}</div>
</div>`;

function Ingot({ metal = 'gold', w = 72, label }) {
  const k = metal === 'gold' ? 'G' : 'S';
  const ink = metal === 'gold' ? '#7a5410' : '#59646b';
  return html`<svg viewBox="0 0 120 72" width=${w} height=${w * 0.6} aria-hidden="true" style="display:block;overflow:visible">
    <ellipse cx="60" cy="66" rx="50" ry="4" fill="rgba(0,0,0,.12)"/>
    <polygon points="22,10 98,10 110,26 10,26" fill=${`url(#ingTop${k})`}/>
    <polygon points="10,26 110,26 116,60 4,60" fill=${`url(#ingFront${k})`}/>
    <polygon points="98,10 110,26 116,60 112,40" fill=${`url(#ingSide${k})`} opacity=".6"/>
    <polyline points="12,27 108,27" stroke="rgba(255,255,255,.65)" stroke-width="1.2"/>
    <rect x="34" y="31" width="52" height="24" rx="3" fill="none" stroke=${ink} stroke-opacity=".45" stroke-width="1"/>
    <text x="60" y="42" text-anchor="middle" font-family="-apple-system, system-ui, 'Segoe UI', Roboto, sans-serif" font-weight="900" font-size="8" fill=${ink} fill-opacity=".85" letter-spacing="1">PGBX</text>
    <text x="60" y="52" text-anchor="middle" font-family="-apple-system, system-ui, 'Segoe UI', Roboto, sans-serif" font-weight="700" font-size="7" fill=${ink} fill-opacity=".75">${label || '999.0'}</text>
  </svg>`;
}

function Spark({ data, color, w = 112, h = 40 }) {
  if (!data || !data.length) return null;
  const d = data.length < 2 ? [data[0], data[0]] : data;
  const min = Math.min(...d), max = Math.max(...d), span = max - min || 1;
  const pts = d.map((v, i) => [(i / (d.length - 1)) * w, max === min ? h / 2 : h - 3 - ((v - min) / span) * (h - 6)]);
  const line = pts.map(p => p.map(n => n.toFixed(1)).join(',')).join(' ');
  const last = pts[pts.length - 1];
  return html`<svg class="spark" width=${w} height=${h} viewBox=${`0 0 ${w} ${h}`} aria-hidden="true">
    <polygon class="sa" points=${`0,${h} ${line} ${w},${h}`} fill=${color} fill-opacity=".14"/>
    <polyline class="sl" pathLength="1" points=${line} fill="none" stroke=${color} stroke-width="1.8" stroke-linejoin="round" stroke-linecap="round"/>
    <circle cx=${last[0]} cy=${last[1]} r="3" fill=${color}/>
  </svg>`;
}

const feedLabel = (rates, stale, now) => {
  if (rates.mode === 'connecting') return 'Connecting to live rates';
  if (stale) return `Rates delayed · last update ${ago(now - rates.updatedAt)}`;
  return `${rates.mode === 'live' ? 'Live' : 'Simulated'} · updated ${ago(now - rates.updatedAt)}`;
};
const dotClass = (rates, stale) => 'ldot' + (stale ? ' stale' : rates.mode !== 'live' ? ' sim' : '');

/* ============================================================
   Splash
   ============================================================ */
// First launch: the mark draws in once (about 2 s). Returning customers get a short splash before the PIN.
function Splash({ onDone, rates, quick }) {
  const [out, setOut] = useState(false);
  const finish = () => { if (out) return; setOut(true); setTimeout(onDone, quick ? 250 : 350); };
  // A returning customer is on the PIN pad in about half a second (the brand shows, then gets out of the way)
  useEffect(() => { const t = setTimeout(finish, quick ? 350 : 2100); return () => clearTimeout(t); }, []);
  return html`<div class=${'splash on-dark' + (quick ? ' quick' : '') + (out ? ' out' : '')} onClick=${finish}>
    <${Logo} size=${quick ? 112 : 140} animate=${!quick} orbit=${true} />
    <h1>Pakistan Gold Bullion Exchange</h1>
    ${!quick && html`<p class="tagline">Gold and silver, held for you</p>`}
    <div class="brand-badge"><${Shariah}/></div>
    ${!quick && html`<div class="splash-status" role="status"><span class=${'ldot' + (rates.mode === 'live' ? '' : ' sim')}></span>${rates.mode === 'live' ? 'Live rates connected' : rates.mode === 'sim' ? 'Using simulated rates' : 'Connecting to live rates'}</div>`}
  </div>`;
}

/* ============================================================
   Login: mobile number + one-time code (FR-A1)
   ============================================================ */
function Login({ S, note, intent, hasPin, onDone, onBrowse, onPin, onRetry }) {
  const [step, setStep] = useState('phone');
  const [dir, setDir] = useState('in');
  const [phone, setPhone] = useState(S.phone || '');
  const [otp, setOtp] = useState('');
  const [busy, setBusy] = useState(false);
  const [ok, setOk] = useState(false);
  const [out, setOut] = useState(false);
  const [sentAt, setSentAt] = useState(0);
  const [channel, setChannel] = useState('sms');
  const [sentVia, setSentVia] = useState('sms');
  const [err, setErr] = useState('');
  const [shake, setShake] = useState(0);
  const phoneRef = useRef(null), otpRef = useRef(null);
  const timers = useRef([]); useEffect(() => () => timers.current.forEach(clearTimeout), []);   // nothing fires after the screen closes
  const cfg = S.otpCfg;
  const demo = !LIVE && cfg.checked && !cfg.unreachable && cfg.configured === false;
  const down = cfg.checked && cfg.unreachable;
  const channels = demo ? ['sms', 'whatsapp'] : cfg.channels;
  const valid = PK_MOBILE.test(phone);
  const shown = p => (p.length > 3 ? p.slice(0, 3) + ' ' + p.slice(3) : p);
  useEffect(() => { if (innerWidth > 500) { const t = setTimeout(() => phoneRef.current && phoneRef.current.focus({ preventScroll: true }), 1500); return () => clearTimeout(t); } }, []);
  useEffect(() => { if (!channels.includes(channel)) setChannel('sms'); }, [channels.join()]);
  const toOtp = via => { setBusy(false); setSentVia(via); setDir('in'); setStep('otp'); setOtp(''); setSentAt(Date.now()); setTimeout(() => otpRef.current && otpRef.current.focus({ preventScroll: true }), 400); };
  // FR-A1: a real code goes out by SMS or WhatsApp through /api/otp (Twilio Verify). Demo mode only when no provider is connected.
  const send = async via => {
    via = via || channel;
    if (!valid || busy || !cfg.checked || down) return;
    setBusy(true); setErr('');
    if (demo) { setTimeout(() => toOtp(via), 750); return; }
    const d = await otpCall({ action: 'send', phone, channel: via });
    if (d.ok) { toOtp(d.channel || via); return; }
    setBusy(false);
    setErr(d.error === 'wait' ? `Please wait ${d.retryIn}s before requesting another code.` : d.error === 'unreachable' ? 'Can’t reach the login service. Check your connection and try again.' : d.message || 'Could not send the code. Check your connection and try again.');
  };
  useEffect(() => {
    if (otp.length !== 6 || ok) return;
    let alive = true;
    setBusy(true); setErr('');
    const finish = () => { setBusy(false); setOk(true); timers.current.push(setTimeout(() => { setOut(true); timers.current.push(setTimeout(() => onDone(phone), 620)); }, 700)); };
    if (demo) { const t = setTimeout(finish, 650); return () => clearTimeout(t); }
    otpCall({ action: 'check', phone, code: otp }).then(d => {
      if (!alive) return;
      if (d.ok && d.approved) { finish(); return; }
      setBusy(false); setOtp(''); setShake(x => x + 1);
      setErr(d.error === 'unreachable' ? 'Can’t reach the login service. Check your connection and try again.' : d.message || 'That code is incorrect. Check the message and try again.');
      setTimeout(() => otpRef.current && otpRef.current.focus({ preventScroll: true }), 50);
    });
    return () => { alive = false; };
  }, [otp]);
  const resendIn = Math.max(0, 30 - Math.floor((S.now - sentAt) / 1000));
  const g = rateOf(S.rates, 'gold'), s = rateOf(S.rates, 'silver');
  const connecting = S.rates.mode === 'connecting';
  const viaName = v => (v === 'whatsapp' ? 'WhatsApp' : 'SMS');
  const badNum = phone.length === 10 && !valid;
  return html`<div class=${'login' + (out ? ' out' : '')}>
    <span class="amb-wrap" aria-hidden="true"><span class="amb a"></span><span class="amb b"></span></span>
    <div class="login-top on-dark">
      <${Logo} size=${104} orbit=${true} />
      <h1>Pakistan Gold Bullion Exchange</h1>
      <div class="brand-badge"><${Shariah}/></div>
      <p>Buy 999.0 gold and silver, held for you by PGBX. Collect it at any of ${DEALERS_TEXT}.</p>
      <div class="ticker" aria-label="Current buy rates">
        ${[['gold', g], ['silver', s]].map(([m, r]) => html`<div class="tick">
          <span><span class=${dotClass(S.rates, S.stale)}></span>${metalName(m)} · per tola</span>
          ${connecting ? html`<span class="sk" style="width:96px;height:20px;margin-top:4px"></span>` : html`<b><${Odo} value=${r.buyTola} flash=${S.rates.tick} /></b>`}
        </div>`)}
      </div>
    </div>
    <div class="sheet">
      ${note && html`<div class="notice warning" style="margin:0 0 16px;width:100%" role="alert"><${Icon} n="shield" c="sm"/><span>${note}</span></div>`}
      ${!note && intent && html`<div class="notice" style="margin:0 0 16px;width:100%" role="status"><${Icon} n="info" c="sm"/><span>${intent}</span></div>`}
      ${down && html`<div class="notice danger" style="margin:0 0 16px;width:100%" role="alert"><${Icon} n="alert" c="sm"/><span class="grow">Can’t reach the login service. Check your connection and try again.</span><button class="linkbtn sm act" onClick=${onRetry}>Retry</button></div>`}
      ${step === 'phone' ? html`<div class=${dir === 'in' ? 'step-in' : 'step-back'} key="phone">
        <h2>Log in or sign up</h2>
        <p class="sub">Enter your Pakistani mobile number and we’ll send you a one-time code.</p>
        <label class="field">
          <span class="lbl">Mobile number</span>
          <span class=${'phone' + (badNum ? ' bad' : '')}>
            <span class="cc">+92</span>
            <input ref=${phoneRef} type="tel" inputmode="numeric" autocomplete="tel-national" placeholder="300 1234567" aria-invalid=${badNum} aria-describedby="phone-hint"
              value=${shown(phone)} onInput=${e => { let v = e.target.value.replace(/\D/g, ''); if (v.startsWith('92')) v = v.slice(2); if (v.startsWith('0')) v = v.slice(1); setPhone(v.slice(0, 10)); setErr(''); }}
              onKeyDown=${e => { if (e.key === 'Enter') send(); }} />
            ${valid && html`<span class="ok" aria-hidden="true"><${Icon} n="check"/></span>`}
          </span>
        </label>
        <div id="phone-hint">${badNum ? html`<div class="hint err">This isn’t a Pakistani mobile number. Numbers start with 30–34 or 355.</div>`
          : phone && phone[0] !== '3' ? html`<div class="hint err">Mobile numbers start with 3, for example 300 1234567.</div>` : ''}</div>
        <div class="field">
          <span class="lbl">Send the code by</span>
          <${Seg} label="Send the code by" items=${[['sms', 'SMS'], ['whatsapp', channels.includes('whatsapp') ? 'WhatsApp' : html`WhatsApp <span class="soon">· soon</span>`]]} value=${channel}
            onChange=${v => { if (channels.includes(v)) { setChannel(v); setErr(''); } else setErr('WhatsApp codes aren’t available yet. Use SMS for now.'); }} />
        </div>
        ${err && html`<div class="hint err" role="alert">${err}</div>`}
        <button class="btn btn-primary" style="margin-top:20px" disabled=${!valid || !cfg.checked || down || busy} onClick=${() => send()}>
          ${busy ? html`<span class="spin"></span> Sending code` : !cfg.checked ? html`<span class="spin"></span> Connecting` : `Send code`}</button>
        ${demo && html`<p class="demo-line"><${Icon} n="info" c="sm"/><span>Demo mode: SMS isn’t connected yet, so no message is sent and any 6 digits will work.</span></p>`}
        <p class="tiny muted consent">By continuing you agree to PGBX’s <a href=${LEGAL + '/legal/terms'} target="_blank" rel="noopener">Terms of use</a> and <a href=${LEGAL + '/legal/privacy'} target="_blank" rel="noopener">Privacy policy</a>.</p>
      </div>` : html`<div class="step-in" key="otp">
        <h2>${ok ? 'Verified' : 'Enter the code'}</h2>
        <p class="sub">${demo ? 'Demo mode: no message was sent to' : `We sent a 6-digit code by ${viaName(sentVia)} to`} +92 ${shown(phone)}.${' '}
          <button class="linkbtn sm change-num" disabled=${busy || ok} onClick=${() => { setDir('back'); setStep('phone'); setErr(''); setOtp(''); }}>Change number</button></p>
        <div class=${'otp' + (ok ? ' ok' : '') + (shake ? ' err' : '')} key=${'o' + shake} onClick=${() => otpRef.current && otpRef.current.focus()}>
          ${[0, 1, 2, 3, 4, 5].map(i => html`<div class=${'ob' + (i === otp.length && !ok && !busy ? ' cur' : '')} aria-hidden="true">${otp[i] || ''}</div>`)}
          <input ref=${otpRef} type="text" inputmode="numeric" autocomplete="one-time-code" maxlength="6" aria-label="6-digit code" value=${otp} disabled=${ok || busy}
            onInput=${e => setOtp(e.target.value.replace(/\D/g, '').slice(0, 6))} />
        </div>
        ${err && html`<div class="hint err" role="alert">${err}</div>`}
        <div class="between" style="margin-top:8px">
          <span class="small muted" role="status">${busy ? 'Checking the code…' : ok ? 'Logging you in…' : demo ? 'Any 6 digits will work' : 'The code expires in 10 minutes'}</span>
          <button class="linkbtn sm" disabled=${resendIn > 0 || busy} onClick=${() => send(sentVia)}>${resendIn > 0 ? `Resend in ${resendIn}s` : 'Resend code'}</button>
        </div>
        ${resendIn === 0 && channels.length > 1 && html`<button class="linkbtn sm" disabled=${busy} onClick=${() => { const v = sentVia === 'sms' ? 'whatsapp' : 'sms'; setChannel(v); send(v); }}>Send by ${viaName(sentVia === 'sms' ? 'whatsapp' : 'sms')} instead</button>`}
      </div>`}
      <div class="login-links">
        <button class="linkbtn" onClick=${onBrowse}>Browse rates as a guest</button>
        ${hasPin && html`<button class="linkbtn sm" style="color:var(--text-2);font-weight:500" onClick=${onPin}>Already set up on this phone? Unlock with PIN</button>`}
      </div>
    </div>
  </div>`;
}

/* ============================================================
   PIN pad (lock screen and Change PIN)
   ============================================================ */
// onComplete returns true when the PIN is accepted (dots stay filled), otherwise the pad clears.
// onComplete may answer later (a Promise): the pad waits, with keys off, until it does.
function PinPad({ onComplete, ok, err = 0, showFace, onFace, disabled, faceLabel = 'Face ID' }) {
  const [pin, setPin] = useState('');
  const [wait, setWait] = useState(false);
  const live = useRef(true); useEffect(() => () => { live.current = false; }, []);
  useEffect(() => {
    if (pin.length !== 4) return;
    const t = setTimeout(() => {
      const r = onComplete(pin);
      if (r && typeof r.then === 'function') { setWait(true); r.then(v => { if (!live.current) return; setWait(false); if (v !== true) setPin(''); }, () => { if (live.current) { setWait(false); setPin(''); } }); }
      else if (r !== true) setPin('');
    }, 160);
    return () => clearTimeout(t);
  }, [pin]);
  const off = disabled || wait || ok;
  const press = d => { if (off) return; buzz(); setPin(p => (p.length < 4 ? p + d : p)); };
  const keys = ['1', '2', '3', '4', '5', '6', '7', '8', '9', 'face', '0', 'del'];
  return html`
    <div class=${'dots4' + (ok ? ' ok' : '') + (err ? ' err' : '')} key=${'e' + err} role="status" aria-label=${`${pin.length} of 4 digits entered`}>
      ${[0, 1, 2, 3].map(i => html`<span class=${'dot' + (pin.length > i || ok ? ' on' : '')}></span>`)}
    </div>
    <div class=${'keypad' + (disabled ? ' off' : '')} aria-busy=${wait}>
      ${keys.map(k => {
        if (k === 'face') return showFace ? html`<button class="key plain" onClick=${onFace} disabled=${off} aria-label=${'Unlock with ' + faceLabel}><span><${Icon} n="face"/><span class="kl">${faceLabel}</span></span></button>` : html`<span></span>`;
        if (k === 'del') return html`<button class="key plain" onClick=${() => { if (!off) setPin(p => p.slice(0, -1)); }} aria-label="Delete digit"><${Icon} n="del"/></button>`;
        return html`<button class="key" onClick=${() => press(k)}>${k}</button>`;
      })}
    </div>`;
}

// FR-A3 PIN with face unlock; FR-A4 pause after 3 wrong PINs, end the session after 5.
// Production: the PIN is checked by the server (liveCheck / liveBio answer true when unlocked); the demo checks it here.
function LockScreen({ pin, fails, lockUntil, now, biometric, note, onUnlock, onFail, onBrowse, onLogin, onForgot, liveCheck, liveBio }) {
  const [ok, setOk] = useState(false);
  const [scan, setScan] = useState(false);
  const locked = lockUntil > now;
  const unlock = () => { setOk(true); setTimeout(onUnlock, 650); };
  const check = p => {
    if (locked) return false;
    if (LIVE) return liveCheck(p).then(v => { if (v) unlock(); return v; });
    if (pinOk(p, pin)) { unlock(); return true; } onFail(); return false;
  };
  // Production: Face ID / fingerprint through the phone (native app only); the demo simulates it.
  const bio = LIVE ? window.PGBXNative && window.PGBXNative.biometric : null;
  const canFace = biometric && !locked && (!LIVE || !!(bio && bio.ready));
  const face = async () => {
    if (locked || ok) return;
    if (LIVE) { if (bio && await bio.verify('Unlock PGBX').catch(() => false) && await liveBio()) unlock(); return; }
    setScan(true); setTimeout(() => { setScan(false); unlock(); }, 900);
  };
  const left = PIN_MAX_FAILS - fails;
  const msg = locked ? `Too many wrong PINs. Try again in ${Math.min(30, Math.ceil((lockUntil - now) / 1000))} seconds.`
    : fails ? `Wrong PIN. ${left} attempt${left === 1 ? '' : 's'} left before you need to log in again.` : note;
  return html`<div class="lock">
    <${Logo} size=${72} animate=${false} />
    <h2>${ok ? 'Unlocked' : 'Enter your PIN'}</h2>
    <div class=${'note' + (fails || locked ? ' warn' : '')} role="status">${msg || ''}</div>
    ${!LIVE && pin === PIN_DEFAULT && html`<div class="hint-demo">Demo PIN ${PIN_DEFAULT}</div>`}
    <${PinPad} ok=${ok} err=${fails} onComplete=${check} showFace=${canFace} onFace=${face} disabled=${locked} faceLabel=${bioName()} />
    <div class="lock-links">
      <button class="linkbtn" onClick=${onForgot}>Forgot PIN?</button>
      <div style="display:flex;gap:16px"><button class="linkbtn dim" onClick=${onBrowse}>Browse as guest</button><button class="linkbtn dim" onClick=${onLogin}>Use another number</button></div>
    </div>
    ${scan && html`<div class="scan" role="status" aria-label="Checking Face ID"><div class="scan-box"><${Icon} n="face"/></div></div>`}
  </div>`;
}

// First login (and after "Forgot PIN"): the customer chooses the PIN they'll use to unlock the app on this phone.
const WEAK_PINS = new Set(['0000', '1111', '2222', '3333', '4444', '5555', '6666', '7777', '8888', '9999', '1234', '4321', '0123', '9876', '1212', '2580']);
// The phone's own name for its biometric unlock
function bioName() {
  if (!LIVE) return 'Face ID';
  const b = window.PGBXNative && window.PGBXNative.biometric, ios = /iPhone|iPad/.test(navigator.userAgent);
  const kind = b ? b.kind : 'any';
  return kind === 'face' ? (ios ? 'Face ID' : 'Face unlock') : kind === 'touch' ? (ios ? 'Touch ID' : 'Fingerprint') : (ios ? 'Face ID' : 'Fingerprint or face');
}
function CreatePin({ reset, onDone }) {
  const [step, setStep] = useState(0);
  const [first, setFirst] = useState('');
  const [ok, setOk] = useState(false);
  const [err, setErr] = useState(0);
  const [msg, setMsg] = useState('');
  const done = p => {
    if (step === 0) {
      if (WEAK_PINS.has(p)) { setErr(e => e + 1); setMsg('That PIN is easy to guess. Choose a different one.'); return false; }
      setFirst(p); setMsg(''); setStep(1); return false;
    }
    if (p !== first) { setErr(e => e + 1); setMsg('The PINs didn’t match. Choose your PIN again.'); setStep(0); return false; }
    // onDone may answer with a message (the server refused the PIN): start again with it
    return Promise.resolve(onDone(p)).then(m => {
      if (typeof m === 'string') { setErr(e => e + 1); setMsg(m); setStep(0); return false; }
      setOk(true); return true;
    });
  };
  return html`<div class="lock">
    <${Coin} size=${56} />
    <h2 key=${step}>${step === 0 ? (reset ? 'Choose a new PIN' : 'Create your PIN') : 'Enter the PIN again'}</h2>
    <div class=${'note' + (msg ? ' warn' : '')} role="status">${msg || (step === 0 ? 'You’ll use this 4-digit PIN to unlock PGBX on this phone, instead of a code each time.' : 'To make sure it’s right.')}</div>
    <${PinPad} key=${step} ok=${ok} err=${err} onComplete=${done} showFace=${false} />
  </div>`;
}

/* ============================================================
   Shared bits
   ============================================================ */
// Navigation bar for pushed screens: back, centred title, optional trailing control.
const TopBar = ({ title, onBack, right }) => html`<div class="nav">
  <button class="iconbtn" onClick=${onBack} aria-label="Back"><${Icon} n="back"/></button><h2>${title}</h2><div class="end">${right || ''}</div>
</div>`;
// Large title for the five root tabs.
const TabHead = ({ title, sub, right }) => html`<div class="lt"><div><h1>${title}</h1>${sub && html`<p>${sub}</p>`}</div>${right || ''}</div>`;
// Inline notice: kind = info | warning | danger | plain
const Notice = ({ kind = 'info', icon, title, children, style }) => html`<div class=${'notice ' + kind} role=${kind === 'danger' || kind === 'warning' ? 'alert' : null} style=${style}>
  <${Icon} n=${icon || (kind === 'info' || kind === 'plain' ? 'info' : 'alert')} c="sm"/><div class="grow">${title && html`<b>${title}</b>`}${children}</div></div>`;
const StaleBanner = ({ S }) => (S && S.rates.mode === 'connecting'
  ? html`<${Notice} kind="info" title="Getting live prices">Prices appear in a moment. Buying starts once they arrive.</${Notice}>`
  : html`<${Notice} kind="warning" title="Rates are delayed">Buying is paused until fresh prices arrive. This usually takes a few seconds.</${Notice}>`);
// Empty state: what is missing, why it matters, what to do next.
const Empty = ({ icon, title, body, action, onAction }) => html`<div class="empty rise">
  <div class="ei"><${Icon} n=${icon}/></div><b>${title}</b><p>${body}</p>
  ${action && html`<button class="btn btn-primary" onClick=${onAction}>${action}</button>`}</div>`;
// Demo-only controls, visibly separate from the product.
const Demo = ({ title, body, children }) => LIVE ? null : html`<div class="demo"><div class="demo-h"><${Icon} n="sliders" c="xs"/> Demo · ${title}</div>${body && html`<p>${body}</p>`}${children}</div>`;
// Details PGBX hasn't given yet: marked in the demo; in production the row or sentence is left out instead (see LIVE checks)
const Tbc = () => (LIVE ? null : html`<span class="tbc">${TBC}</span>`);
const DEALERS_TEXT = LIVE ? 'PGBX dealers' : '250 dealers';
const LEGAL = Live.API_ROOT.replace(/\/api\/v1$/, '');   // where the terms and privacy policy pages are (the phone apps open the website)
const Sample = () => (LIVE ? null : html`<span class="tag neutral">Sample</span>`);
const Seg = ({ items, value, onChange, label }) => {
  const idx = Math.max(0, items.findIndex(x => x[0] === value));
  return html`<div class="seg" style=${{ '--n': items.length }} role="radiogroup" aria-label=${label}>
    <span class="knob" style=${{ transform: `translateX(${idx * 100}%)` }}></span>
    ${items.map(([k, l]) => html`<button class=${value === k ? 'on' : ''} onClick=${() => onChange(k)} role="radio" aria-checked=${value === k}>${l}</button>`)}
  </div>`;
};
const Switch = ({ on }) => html`<span class=${'switch' + (on ? ' on' : '')} aria-hidden="true"><i></i></span>`;
const Radio = ({ on }) => html`<span class=${'radio' + (on ? ' on' : '')} aria-hidden="true"></span>`;
// `shine` (seconds) staggers a light sweep across the bar, used on the Buy list and Popular products
const Thumb = ({ p, w = 44, shine }) => html`<span class=${'thumb' + (p.metal === 'silver' ? ' silver' : '') + (shine != null ? ' shine' : '')} style=${shine != null ? { '--shine-delay': shine + 's' } : null}><${Ingot} metal=${p.metal} w=${w} label=${p.short} /></span>`;
const CartButton = ({ S, A }) => {
  const n = S.cart.reduce((a, l) => a + l.units, 0);
  return html`<button class="iconbtn" onClick=${A.openCart} aria-label=${n ? `Cart, ${n} unit${n > 1 ? 's' : ''}` : 'Cart, empty'}><${Icon} n="cart"/>${n > 0 && html`<span class="badge" key=${'n' + n}>${n}</span>`}</button>`;
};
// Sticky bottom actions for checkout screens, with an optional summary line (label + amount).
const ActionBar = ({ label, amount, children }) => html`<div class="actionbar">
  ${label && html`<div class="ab-meta"><span>${label}</span><b>${amount}</b></div>`}${children}</div>`;
const linesTotal = (lines, prices) => lines.reduce((a, l) => a + (prices[l.pid] || 0) * l.units, 0);
const linesUnits = lines => lines.reduce((a, l) => a + l.units, 0);
const linesText = lines => lines.map(l => `${l.units} × ${pname(P[l.pid])}`).join(', ');
const sameDay = (a, b) => new Date(a).toDateString() === new Date(b).toDateString();
const maskCnic = c => (c ? c.slice(0, 5) + '-•••••••-' + c.slice(-1) : '');
const isoDay = ts => { const d = new Date(ts); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; };
const LimitBar = ({ S, add = 0 }) => {
  const used = S.spentToday + add, p = Math.min(1, used / DAY_LIMIT);
  return html`<div class="card" style="margin-top:12px">
    <div class="between small"><span class="muted">Daily purchase limit</span><span><b class=${used > DAY_LIMIT ? 'down' : ''}>${fmt(used)}</b><span class="muted"> of ${fmt(DAY_LIMIT)}</span></span></div>
    <div class=${'meter' + (p > 0.85 ? ' hi' : '')} role="progressbar" aria-valuemin="0" aria-valuemax=${DAY_LIMIT} aria-valuenow=${Math.round(used)} aria-label="Daily purchase limit used"><i style=${{ transform: `scaleX(${p})` }}></i></div>
    <div class="tiny muted" style="margin-top:8px">Up to ${MAX_UNITS} units per order.${LIVE ? '' : ' Sample limits;'} See Fees and limits.</div>
  </div>`;
};

/* ============================================================
   Rates
   ============================================================ */
function RateCard({ rates, metal, onOpen }) {
  const r = rateOf(rates, metal);
  const loading = rates.mode === 'connecting';
  const hist = rates[metal].hist;
  const showChg = !loading && hist.length > 1 && Math.abs(r.chg) >= 0.01;
  const col = metal === 'gold' ? '#C8962B' : '#8C979F';
  // Tint the price green or red for a moment when it moves
  // (only for real moves within the same feed, not the switch from placeholder to live prices)
  const prev = useRef({ v: r.buyTola, mode: rates.mode }); const [dir, setDir] = useState(null);
  useEffect(() => {
    const pv = prev.current;
    if (r.buyTola !== pv.v) setDir(pv.mode === rates.mode ? (r.buyTola > pv.v ? 'up' : 'down') : null);
    prev.current = { v: r.buyTola, mode: rates.mode };
  }, [r.buyTola, rates.mode]);
  const sk = (w, h) => html`<span class="sk" style=${{ width: w + 'px', height: h + 'px', marginTop: '4px' }}></span>`;
  return html`<button class=${"rc " + metal} onClick=${onOpen} aria-label=${`${metalName(metal)}: buy ${fmt(r.buyTola)} per tola. Open history and price alerts`}>
    <span class="rc-sheen" aria-hidden="true"></span>
    <div class="rc-head">
      <span class="shine" style=${{ '--shine-delay': metal === 'gold' ? '1.2s' : '3.6s' }}><${Ingot} metal=${metal} w=${36} /></span>
      <div><div class="rc-name">${metalName(metal)} 24K</div><div class="rc-sub">999.0 · per tola (11.664 g)</div></div>
      <div class="end">
        ${showChg && html`<span class=${'tag ' + (r.chg >= 0 ? 'success' : 'danger')} title="Change since you opened the app">${pct(r.chg)}</span>`}
        <${Icon} n="chev" c="sm chev"/>
      </div>
    </div>
    <div class="rc-main">
      <div><div class="rc-lbl">Buy</div><div class="rc-price">${loading ? sk(160, 30) : html`<${Odo} value=${r.buyTola} flash=${rates.tick} dir=${dir} />`}</div></div>
      ${!loading && hist.length >= 6 && html`<${Spark} data=${hist} color=${col} w=${96} h=${36} />`}
    </div>
    <div class="rc-grid">
      ${[['Sell', r.sellTola], ['Buy per gram', r.buyGram], ['Sell per gram', r.sellGram]].map(([l, v]) => html`<div><div class="rc-lbl">${l}</div>
        <b>${loading ? sk(72, 16) : fmt(v)}</b></div>`)}
    </div>
  </button>`;
}

function WorldMarkets({ rates }) {
  if (rates.mode === 'connecting') return html`<div class="group">${[0, 1, 2].map(() => html`<div class="row"><span class="sk" style="width:120px;height:16px"></span><span class="sk" style="width:64px;height:16px;margin-left:auto"></span></div>`)}</div>`;
  if (rates.mode !== 'live' || !rates.world.length) return html`<div class="group"><div class="row"><span class="ri"><${Icon} n="globe" c="sm"/></span><div class="rt"><span style="margin:0">World prices appear when the live feed is connected.</span></div></div></div>`;
  return html`<div class="group">${rates.world.map(w => { const ch = (w.usd / w.open - 1) * 100;
    return html`<div class="row" style="min-height:52px">
      <div class="rt"><b>${w.name}</b><span>${w.symbol} · per ${w.unit}</span></div>
      <div class="rv" style="flex-direction:column;align-items:flex-end;gap:2px"><b><${Odo} value=${w.usd} prefix="$" decimals=${w.usd < 100 ? 2 : 0} /></b>${Math.abs(ch) >= 0.01 && html`<span class=${'tiny ' + (ch >= 0 ? 'up' : 'down')}>${pct(ch)}</span>`}</div>
    </div>`; })}</div>`;
}

const KycCta = ({ S, A }) => S.guest || S.kyc.status === 'verified' ? null : html`<button class="notice warning" onClick=${() => A.push({ name: 'kyc' })}>
  <${Icon} n="idcard" c="sm"/>
  <div class="grow"><b>${S.kyc.status === 'pending' ? 'Verification in progress' : S.kyc.status === 'reverify' ? 'Verify your identity again' : 'Verify your identity to start buying'}</b>
    ${S.kyc.status === 'reverify' ? 'You changed your identity details. It takes about 2 minutes.' : LIVE ? 'You’ll need your CNIC. It takes about 2 minutes.' : 'You’ll need your CNIC and a selfie. It takes about 2 minutes.'}</div>
  <${Icon} n="chev" c="sm chev"/>
</button>`;

function RatesHome({ S, A }) {
  const { rates, now, stale, guest } = S;
  const featured = ['g-1g', 'g-5g', 'g-100mg', 's-1t', 's-10t'].map(id => P[id]);
  const wv = S.walletValue;
  return html`<div class="scroll">
    <header class="home-head on-dark">
      <div class="hh-top"><${Coin} size=${32} /><span class="wm">PGBX</span><${Shariah} small=${true}/>
        ${!guest && html`<span class="end"><button class="iconbtn on-dark" aria-label=${S.unread ? `Notifications, ${S.unread} unread` : 'Notifications'} onClick=${() => A.push({ name: 'inbox' })}><${Icon} n="bell"/>${S.unread > 0 && html`<span class="badge">${S.unread}</span>`}</button></span>`}</div>
      <p class="hh-greet">${guest ? 'Browsing as a guest' : (S.profile.name.trim() ? `Assalam-o-Alaikum, ${S.profile.name.trim().split(' ')[0]}` : 'Assalam-o-Alaikum')}</p>
      <h1>Today’s rates</h1>
      <div class="hh-live" role="status"><span class=${dotClass(rates, stale)}></span>${feedLabel(rates, stale, now)}</div>
    </header>
    <div class="rates">
      <${RateCard} rates=${rates} metal="gold" onOpen=${() => A.openHistory('gold')} />
      <${RateCard} rates=${rates} metal="silver" onOpen=${() => A.openHistory('silver')} />
    </div>
    ${stale && html`<${StaleBanner} S=${S}/>`}
    ${!S.tips.rates && html`<div class="notice plain" role="note"><${Icon} n="info" c="sm"/><div class="grow"><b>Reading these prices</b>
      <span style="display:block"><b style="display:inline">Buy</b> is what you pay PGBX per tola today. <b style="display:inline">Sell</b> is what your holdings are worth at today’s price. Prices refresh every 10 seconds; tap a card for its history.</span></div>
      <button class="linkbtn sm act" onClick=${() => A.dismissTip('rates')}>Got it</button></div>`}
    ${guest && html`<div class="notice plain"><${Icon} n="lock" c="sm"/><div class="grow"><b>Log in to buy and redeem</b>Rates are free to browse.</div><button class="btn btn-primary btn-sm act" onClick=${A.login}>Log in</button></div>`}
    <${KycCta} S=${S} A=${A} />

    ${!guest && html`<section class="sec">
      <div class="sec-h"><h3>Your wallet</h3></div>
      <button class="brand-card on-dark" onClick=${() => A.tab('wallet')}>
        <div class="between"><span class="bc-label">Value at today’s sell price</span><${Icon} n="chev" c="sm"/></div>
        <div class="bc-value"><${Odo} value=${wv.total} /></div>
        <div class="bc-sub">${fmtW(wv.goldG)} gold · ${(wv.silverG / TOLA).toFixed(2)} tola silver</div>
      </button>
    </section>`}

    <section class="sec">
      <div class="sec-h"><h3>Popular products</h3><button class="linkbtn sm" onClick=${() => A.tab('buy')}>See all</button></div>
      <div class="hscroll">
        ${featured.map((p, i) => html`<button class="pcard" onClick=${() => A.openProduct(p.id)}>
          <${Thumb} p=${p} w=${64} shine=${1.6 + i * 0.35} /><b>${pname(p)}</b><div class="p">${fmt(priceOf(p, rates))}</div>
        </button>`)}
      </div>
    </section>

    <section class="sec">
      <div class="sec-h"><h3>World markets</h3><span class="aside">USD</span></div>
      <${WorldMarkets} rates=${rates} />
    </section>

    <section class="sec"><div class="group"><button class="row" onClick=${() => A.push({ name: 'worth' })}>
      <span class="ri gold"><${Icon} n="calc" c="sm"/></span><div class="rt"><b>What is your jewellery worth?</b><span>Enter the karat and weight for a free buy-back estimate.</span></div><${Icon} n="chev" c="sm chev"/>
    </button><button class="row" onClick=${() => A.tab('services')}>
      <span class="ri gold"><${Icon} n="gem" c="sm"/></span><div class="rt"><b>More from PGBX</b><span>Doorstep appraisal, gift bullion and coins, collection at ${DEALERS_TEXT}.</span></div><${Icon} n="chev" c="sm chev"/>
    </button></div></section>

    <p class="foot">${rates.mode === 'live'
      ? `Indicative prices: international spot converted at USD/PKR ${rates.usdPkr ? rates.usdPkr.rate.toFixed(2) : ''}${rates.usdPkr && rates.usdPkr.updatedAt ? ` (exchange rate of ${dt(Date.parse(rates.usdPkr.updatedAt))}, updated daily)` : ''}, refreshed every 10 seconds. Local Sarafa rates may differ.${LIVE ? '' : ' Sell prices and product premiums are sample values until PGBX sets them.'}`
      : `Live prices are unavailable, so these rates are simulated from the Sarafa 24K rate of 1 Oct 2026. Buying uses PGBX’s server prices in the real app.`}</p>
    ${rates.mode === 'live' && rates.fxOld && html`<${Notice} kind="warning" icon="alert" title="Exchange rate is out of date">The USD/PKR rate hasn’t updated for more than a day, so rupee prices may be off.</${Notice}>`}
    ${rates.mode === 'live' && rates.warnings && rates.warnings.length > 0 && html`<p class="foot" style="margin-top:0" title=${rates.warnings.join(' · ')}>Some price sources didn’t answer; prices come from the backup source.</p>`}
  </div>`;
}

/* ---------- FR-R5 rate history chart, FR-R6 price alerts ---------- */
function Chart({ points, color, range }) {
  const ref = useRef(null);
  const [hover, setHover] = useState(null);
  const pending = useRef(null);
  useEffect(() => () => cancelAnimationFrame(pending.current && pending.current.raf), []);
  const W = 340, H = 180, PT = 12, PB = 6;
  // The line is computed once per set of points, not on every pointer move or clock tick
  const geo = useMemo(() => {
    if (!points || points.length < 2) return null;
    const ys = points.map(p => p[1]); const min = Math.min(...ys), max = Math.max(...ys);
    const pad = (max - min) * 0.15 || max * 0.002, lo = min - pad, hi = max + pad;
    const x = i => (i / (points.length - 1)) * W;
    const y = v => PT + (1 - (v - lo) / (hi - lo)) * (H - PT - PB);
    return { lo, hi, x, y, d: points.map((p, i) => (i ? 'L' : 'M') + x(i).toFixed(1) + ',' + y(p[1]).toFixed(1)).join('') };
  }, [points]);
  if (!geo) return null;
  const { lo, hi, x, y, d } = geo;
  // Pointer moves (up to 120 a second) are coalesced to one update per frame
  const move = e => {
    const cx = e.clientX;
    if (pending.current) { pending.current.cx = cx; return; }
    pending.current = { cx, raf: requestAnimationFrame(() => {
      const r = ref.current && ref.current.getBoundingClientRect(), c = pending.current.cx; pending.current = null;
      if (!r) return;
      setHover(Math.max(0, Math.min(points.length - 1, Math.round((c - r.left) / r.width * (points.length - 1)))));
    }) };
  };
  const tf = t => { const dd = new Date(t); return range === 'day' ? F.hm.format(dd) : range === 'week' ? F.wdHm.format(dd) : F.dd2Mon.format(dd); };
  const grid = [0.25, 0.5, 0.75].map(f => lo + (hi - lo) * f);
  return html`<div class="chart-wrap">
    <svg ref=${ref} class="chart" viewBox=${`0 0 ${W} ${H}`} onPointerMove=${move} onPointerDown=${move} onPointerLeave=${() => { if (pending.current) { cancelAnimationFrame(pending.current.raf); pending.current = null; } setHover(null); }} role="img" aria-label=${`Chart from ${fmt(points[0][1])} to ${fmt(points[points.length - 1][1])}`}>
      <defs><linearGradient id="chFill" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color=${color} stop-opacity=".16"/><stop offset="1" stop-color=${color} stop-opacity="0"/></linearGradient></defs>
      ${grid.map(v => html`<line class="ch-grid" x1="0" x2=${W} y1=${y(v)} y2=${y(v)}/><text class="ch-lbl" x=${W - 2} y=${y(v) - 4} text-anchor="end">${F.int.format(Math.round(v))}</text>`)}
      <path class="ch-area" d=${d + `L${W},${H}L0,${H}Z`} fill="url(#chFill)"/>
      <path class="ch-line" d=${d} stroke=${color} pathLength="1"/>
      ${hover != null && html`<line x1=${x(hover)} x2=${x(hover)} y1="0" y2=${H} stroke="rgba(29,43,34,.25)" stroke-dasharray="3 3"/><circle cx=${x(hover)} cy=${y(points[hover][1])} r="5" fill="#fff" stroke=${color} stroke-width="2.5"/>`}
    </svg>
    ${hover != null && html`<div class="ch-tip" style=${{ left: Math.min(82, Math.max(18, x(hover) / W * 100)) + '%' }}><b>${fmt(points[hover][1])}</b> · ${tf(points[hover][0])}</div>`}
    <div class="ch-x"><span>${tf(points[0][0])}</span><span>${tf(points[Math.floor(points.length / 2)][0])}</span><span>${tf(points[points.length - 1][0])}</span></div>
  </div>`;
}

function HistoryScreen({ S, A, metal: m0 }) {
  const [metal, setMetal] = useState(m0 || 'gold');
  const [range, setRange] = useState('day');
  const [dir, setDir] = useState('above');
  const [target, setTarget] = useState('');
  const key = metal + ':' + range; const h = S.history[key] || {};
  useEffect(() => { A.loadHistory(metal, range); }, [key]);
  const r = rateOf(S.rates, metal);
  const pts = h.points;
  const stats = pts && pts.length > 1 ? (() => { const v = pts.map(p => p[1]); return { open: v[0], high: Math.max(...v), low: Math.min(...v), chg: (v[v.length - 1] / v[0] - 1) * 100 }; })() : null;
  const t = Number(String(target).replace(/\D/g, ''));
  const valid = t > 0 && (dir === 'above' ? t > r.buyTola : t < r.buyTola);
  const preset = f => setTarget(String(Math.round(r.buyTola * (1 + f))));
  const mine = S.alerts.filter(a => a.metal === metal);
  const rangeName = range === 'day' && h.marketClosed ? 'last session' : { day: 'today', week: 'this week', month: 'this month' }[range];
  return html`<div class="page">
    <${TopBar} title="Rate history" onBack=${A.back} />
    <div class="scroll">
      <div class="pad"><${Seg} label="Metal" items=${[['gold', 'Gold'], ['silver', 'Silver']]} value=${metal} onChange=${setMetal} /></div>
      <div class="card" style="margin-top:12px">
        <div class="between" style="align-items:flex-start">
          <div><div class="small muted">${metalName(metal)} buy price per tola</div>
            <div style="font:600 28px/1.2 var(--serif);color:var(--green-900);margin-top:2px"><${Odo} value=${r.buyTola} flash=${S.rates.tick} /></div></div>
          ${stats && html`<span class=${'tag ' + (stats.chg >= 0 ? 'success' : 'danger')}>${pct(stats.chg)} ${rangeName}</span>`}
        </div>
        <div style="margin-top:16px"><${Seg} label="Period" items=${[['day', 'Day'], ['week', 'Week'], ['month', 'Month']]} value=${range} onChange=${setRange} /></div>
        ${pts ? html`<${Chart} key=${key + ':' + pts.length} points=${pts} color=${metal === 'gold' ? '#B8862A' : '#7F8A92'} range=${range} />`
          : h.error ? html`<div style="text-align:center;padding:40px 16px 24px"><b style="display:block">History isn’t available right now</b><p class="small muted" style="margin-top:4px">We couldn’t load past prices. Live rates are unaffected.</p>
              <button class="btn btn-secondary btn-sm" style="margin-top:12px" onClick=${() => A.loadHistory(metal, range, true)}><${Icon} n="refresh" c="sm"/> Try again</button></div>`
          : html`<span class="sk" style="height:180px;margin-top:16px" aria-label="Loading chart"></span>`}
        ${stats && html`<div class="stats4">${[['Open', stats.open], ['High', stats.high], ['Low', stats.low], ['Last', pts[pts.length - 1][1]]].map(([l, v]) => html`<div><span>${l}</span><b>${fmt(v)}</b></div>`)}</div>`}
      </div>
      ${pts && h.marketClosed && html`<p class="foot" style="margin-bottom:0"><b>The market is closed.</b> ${range === 'day' ? 'Showing the last trading session, ' : 'Last price '}${h.lastAt ? dt(h.lastAt) : ''}.</p>`}
      ${pts && html`<p class="foot">Indicative history from ${h.source}, converted at USD/PKR ${h.usdPkr ? h.usdPkr.toFixed(2) : ''}. PGBX’s own buy rate differs slightly.</p>`}

      <section class="sec">
        <div class="sec-h"><h3>Price alert</h3></div>
        <div class="card">
          <div class="small muted">Notify me when the ${metalName(metal).toLowerCase()} buy price per tola goes</div>
          <div style="margin-top:8px"><${Seg} label="Direction" items=${[['above', 'Above'], ['below', 'Below']]} value=${dir} onChange=${v => { setDir(v); setTarget(''); }} /></div>
          <label class="field"><span class="lbl">Target price</span>
            <input class=${'inp' + (target && !valid ? ' bad' : '')} inputmode="numeric" placeholder=${`Now ${fmt(r.buyTola)}`}
              value=${t ? 'Rs ' + t.toLocaleString('en-US') : ''} onInput=${e => setTarget(e.target.value.replace(/\D/g, ''))} /></label>
          <div class="chips" style="margin-top:8px">${(dir === 'above' ? [0.005, 0.01, 0.02] : [-0.005, -0.01, -0.02]).map(f => html`<button class="chipb" onClick=${() => preset(f)}>${f > 0 ? '+' : '−'}${Math.abs(f * 100)}%</button>`)}</div>
          ${target && !valid && html`<div class="hint err">Choose a price ${dir} today’s ${fmt(r.buyTola)}.</div>`}
          <button class="btn btn-primary" style="margin-top:16px" disabled=${!valid} onClick=${() => { A.addAlert(metal, dir, t); setTarget(''); }}>Create alert</button>
        </div>
      </section>
      ${mine.length > 0 && html`<section class="sec"><div class="sec-h"><h3>Your ${metalName(metal).toLowerCase()} alerts</h3></div>
        <div class="group inset">${mine.map(a => html`<div class="row">
          <span class=${'ri' + (a.active ? ' gold' : '')}><${Icon} n="bell" c="sm"/></span>
          <div class="rt"><b>${a.dir === 'above' ? 'Above' : 'Below'} ${fmt(a.target)}</b><span>${a.active ? 'Active' : `Triggered ${rel(a.firedAt, S.now)}`}</span></div>
          <button class="iconbtn" onClick=${() => A.removeAlert(a.id)} aria-label=${`Delete alert ${a.dir} ${fmt(a.target)}`}><${Icon} n="trash" c="sm"/></button>
        </div>`)}</div></section>`}
      <p class="foot">${LIVE ? 'Alerts arrive in your notifications, even when the app is closed.' : 'Alerts arrive in your notifications. In this prototype they’re checked while the app is open.'}</p>
    </div>
  </div>`;
}

/* ============================================================
   Buy
   ============================================================ */
function BuyList({ S, A }) {
  const metal = S.buyMetal;
  const list = PRODUCTS.filter(p => p.metal === metal);
  const r = rateOf(S.rates, metal);
  return html`<div class="scroll">
    <${TabHead} title="Buy" sub="Whole bars only, 999.0 purity" right=${!S.guest && html`<${CartButton} S=${S} A=${A} />`} />
    <div class="pad" style="margin-top:16px"><${Seg} label="Metal" items=${[['gold', 'Gold'], ['silver', 'Silver']]} value=${metal} onChange=${v => A.set({ buyMetal: v })} /></div>
    <div class="pad small muted" style="margin-top:12px;display:flex;align-items:center;gap:8px"><span class=${dotClass(S.rates, S.stale)}></span>${metalName(metal)} ${fmt(r.buyTola)} per tola · ${fmt(r.buyGram)} per gram</div>
    ${S.stale && html`<${StaleBanner} S=${S}/>`}
    <${KycCta} S=${S} A=${A} />
    <${RateNotice} S=${S} A=${A} />
    ${metal === 'gold' && (q => html`<button class="card micro-cta" onClick=${() => A.openMicro()}>
      <span class="ri gold"><${Icon} n="gem" c="sm"/></span>
      <div class="rt"><b>Buy gold one dollar at a time</b><span>${q.unitPkr ? `$1 = ${fmt(q.unitPkr)} · ${fmtG(q.gramsPerUnit)} of gold today` : 'Start with $1. Sell any amount, any time.'}</span></div>
      <${Icon} n="chev" c="sm chev"/></button>`)(microQuote(S))}
    <div class="group inset-thumb" style="margin-top:16px" key=${metal}>
      ${list.map((p, i) => html`<button class="row" onClick=${() => A.openProduct(p.id)}>
        <${Thumb} p=${p} shine=${0.9 + i * 0.22} />
        <div class="rt"><b>${p.label}</b><span>${metalName(p.metal)} · ${p.metal === 'silver' ? fmtW(p.grams) : '999.0'}</span></div>
        <div class="rv"><b>${fmt(priceOf(p, S.rates))}</b><${Icon} n="chev" c="sm chev"/></div>
      </button>`)}
    </div>
    <p class="foot">Prices include the PGBX premium${LIVE ? '' : ' (sample values)'}. You can mix gold and silver in one order. Larger bars are sold at PGBX offline only.</p>
  </div>`;
}

/* ============================================================
   $1 gold: buy one dollar at a time, sell any amount held. Every transaction has its own ID; PGBX clubs everyone's
   transactions into 1-tola lots and keeps the list of IDs in each lot.
   ============================================================ */
const fmtG = g => (Number(g) || 0).toFixed(4) + ' g';
// A Pakistani IBAN: PK, 2 check digits, 4-letter bank code, 16 account characters, and the ISO 13616 mod-97 check
function ibanValid(v) {
  if (!/^PK\d{2}[A-Z]{4}[0-9A-Z]{16}$/.test(v)) return false;
  const r = (v.slice(4) + v.slice(0, 4)).replace(/[A-Z]/g, c => String(c.charCodeAt(0) - 55));
  let m = 0; for (const d of r) m = (m * 10 + Number(d)) % 97;
  return m === 1;
}
const MICRO_STATUS = { credited: ['success', 'In your gold'], pending_payment: ['warning', 'Awaiting payment'], expired: ['', 'Not paid'], refund_due: ['danger', 'Refund due'],
  pending_payout: ['warning', 'Payment on its way'], paid_out: ['success', 'Paid to your bank'] };
// Today's $1 price: from the server in production; from the live rates (or a sample dollar rate) in the demo
function microQuote(S) {
  if (LIVE) return S.microQuote || {};
  const usdPkr = (S.rates.usdPkr && S.rates.usdPkr.rate) || 280;
  const r = rateOf(S.rates, 'gold'), unitPkr = Math.round(usdPkr);
  return { usd: 1, usdPkr, unitPkr, buyGram: r.buyGram, sellGram: r.sellGram, gramsPerUnit: Math.round(unitPkr / r.buyGram * 1e6) / 1e6,
    unitsPerTola: Math.ceil(TOLA / (unitPkr / r.buyGram)), maxUnits: 100, minSellGrams: 0.001, fresh: !S.stale };
}
function MicroScreen({ S, A }) {
  const q = microQuote(S);
  const [units0, setUnits] = useState(1);
  const m = S.micro || { grams: 0, txns: [] };
  const max = q.maxUnits || 100;
  const units = Math.min(units0, max);
  // One request key per purchase: a retry after a lost answer can't buy twice; a new amount or a finished purchase gets a new key
  const key = useMemo(() => 'K' + uid() + uid(), [units, m.txns.length]);
  const value = Math.floor(m.grams * (q.sellGram || 0));
  const total = (q.unitPkr || 0) * units;
  const ready = q.unitPkr && q.fresh && !S.stale && !S.offline;
  const left = Math.max(0, DAY_LIMIT - S.spentToday);
  const over = total > left;
  return html`<div class="page has-actions">
    <${TopBar} title="$1 gold" onBack=${A.back} />
    <div class="scroll">
      <div class="brand-card on-dark" style="margin-top:8px">
        <div class="bc-label">Your $1 gold</div>
        <div class="bc-value">${fmtG(m.grams)}</div>
        <div class="bc-split"><div><span class="bc-label">Worth at today’s sell price</span><b>${fmt(value)}</b></div>
          <div><span class="bc-label">Transactions</span><b>${m.txns.filter(t => t.side === 'buy' && t.status === 'credited').length} bought · ${m.txns.filter(t => t.side === 'sell').length} sold</b></div></div>
      </div>
      ${S.stale && html`<${StaleBanner} S=${S}/>`}
      ${LIVE && !S.stale && !q.unitPkr && html`<div class="pad" style="margin-top:12px"><${Notice} kind="warning" title="Today’s $1 price didn’t load">Check your connection. <button class="linkbtn sm" onClick=${A.microQuote}>Try again</button></${Notice}></div>`}
      <section class="sec"><div class="sec-h"><h3>Buy</h3>${q.usdPkr && html`<span class="aside">$1 = ${fmt(q.unitPkr)} · USD/PKR ${Number(q.usdPkr).toFixed(2)}</span>`}</div>
        <div class="card">
          <div class="small muted">Each dollar is a separate transaction with its own ID. ${q.gramsPerUnit ? `$1 buys ${fmtG(q.gramsPerUnit)} of 24K gold now; about ${q.unitsPerTola.toLocaleString('en-US')} make a tola.` : ''}</div>
          <div class="between" style="margin-top:14px">
            <div class="stepper" role="group" aria-label="Dollars of gold">
              <button aria-label="One dollar less" disabled=${units <= 1} onClick=${() => setUnits(Math.max(1, units - 1))}><${Icon} n="minus" c="sm"/></button>
              <output aria-live="polite">$${units}</output>
              <button aria-label="One dollar more" disabled=${units >= max} onClick=${() => setUnits(Math.min(max, units + 1))}><${Icon} n="plus" c="sm"/></button>
            </div>
            <div style="text-align:right"><b>${q.unitPkr ? fmt(total) : 'Rs —'}</b><div class="small muted">${fmtG((q.gramsPerUnit || 0) * units)}</div></div>
          </div>
          <div class="chips" style="margin-top:12px">${[1, 5, 10, 25, 50].filter(n => n <= max).map(n => html`<button class=${'chipb' + (units === n ? ' on' : '')} onClick=${() => setUnits(n)}>$${n}</button>`)}</div>
          ${over && !S.guest && html`<div class="hint err">You can buy up to ${fmt(left)} more today.</div>`}
        </div>
      </section>
      <${KycCta} S=${S} A=${A} />
      <${RateNotice} S=${S} A=${A} />
      ${m.grams > 0 && html`<div class="pad" style="margin-top:12px"><button class="btn btn-secondary" style="width:100%" onClick=${() => A.push({ name: 'micro-sell' })}><${Icon} n="scale" c="sm"/> Sell gold</button></div>`}
      <section class="sec"><div class="sec-h"><h3>Transactions</h3>${m.txns.length > 0 && html`<span class="aside">Tap one to see its tola lot</span>`}</div>
        ${m.txns.length === 0 ? html`<${Empty} icon="gem" title="No transactions yet" body="Every $1 you buy and every sale appears here with its transaction ID." />`
          : html`<${Keep} deps=${[m.txns, minuteOf(S.now)]} render=${() => html`<div class="group">${m.txns.slice(0, 100).map(t => html`<button class="row" onClick=${() => ACT.push({ name: 'micro-txn', ref: t.ref })}>
            <span class=${'ri' + (t.side === 'buy' ? ' gold' : '')}><${Icon} n=${t.side === 'buy' ? 'plus' : 'minus'} c="sm"/></span>
            <div class="rt"><b class="mono" style="font-size:13px">${t.ref}</b><span>${t.side === 'buy' ? 'Bought' : 'Sold'} ${fmtG(t.grams)} · ${fmt(t.amount)} · ${rel(t.ts, S.now)}</span></div>
            <span class=${'tag ' + (MICRO_STATUS[t.status] || ['', ''])[0]}>${(MICRO_STATUS[t.status] || ['', t.status])[1]}</span></button>`)}</div>`} />`}
        ${m.txns.length > 100 && html`<p class="foot">Showing your latest 100 transactions. The full list is in your statement from PGBX.</p>`}
      </section>
      <p class="foot">Your gold is pooled with other customers’ in whole 1-tola bars PGBX buys and holds; each bar’s record lists every transaction ID in it. ${LIVE ? '' : 'Demo: transactions are simulated on this phone.'}</p>
    </div>
    <div class="actionbar"><button class="btn btn-primary" disabled=${!S.guest && (!ready || over || S.paying)} onClick=${() => (RATE_CHAT && !S.guest ? A.rateChat('buy_micro', { units }, total) : A.microBuy(units, key))}>${S.guest ? 'Log in to buy' : RATE_CHAT ? `Get final rate for $${units} of gold` : `Buy $${units} of gold · ${fmt(total)}`}</button></div>
  </div>`;
}
function MicroSell({ S, A }) {
  const q = microQuote(S); const m = S.micro || { grams: 0 };
  const [g, setG] = useState('');
  const [iban, setIban] = useState(S.lastIban || '');
  const grams = Number(g) || 0;
  const amount = Math.floor(grams * (q.sellGram || 0));
  const cleanIban = iban.replace(/\s/g, '').toUpperCase();
  const ibanOk = ibanValid(cleanIban);
  const key = useMemo(() => 'S' + uid() + uid(), [g, cleanIban, m.txns && m.txns.length]);
  const tooMuch = grams > m.grams + 1e-9, tooSmall = g !== '' && grams < (q.minSellGrams || 0.001);
  const ok = grams > 0 && !tooMuch && !tooSmall && ibanOk && amount >= 1 && q.fresh && !S.stale && !S.offline && !S.paying;
  const go = RATE_CHAT ? () => { A.set({ lastIban: cleanIban }); A.rateChat('sell_micro', { grams: Math.round(grams * 1e6) / 1e6 }, amount); } : () => A.confirm({ title: `Sell ${fmtG(grams)} for ${fmt(amount)}?`, body: `PGBX pays ${fmt(amount)} to the account ending ${cleanIban.slice(-4)}. The price is today’s sell price of ${fmt(q.sellGram)} per gram.`,
    confirm: 'Sell', onConfirm: () => A.microSell(Math.round(grams * 1e6) / 1e6, cleanIban, key, amount) });
  return html`<div class="page has-actions">
    <${TopBar} title="Sell gold" onBack=${A.back} />
    <div class="scroll"><div class="pad">
      <p class="muted">You have <b>${fmtG(m.grams)}</b>. Sell any amount; the sale gets its own transaction ID.</p>
      <label class="field"><span class="lbl">Grams to sell</span>
        <input class=${'inp' + (tooMuch || tooSmall ? ' bad' : '')} inputmode="decimal" placeholder="0.0000" value=${g}
          onInput=${e => setG(e.target.value.replace(/,/g, '.').replace(/[^\d.]/g, '').replace(/(\..*)\./g, '$1').slice(0, 10))} /></label>
      <div class="chips" style="margin-top:8px">${[[0.25, '¼'], [0.5, '½'], [1, 'All']].map(([f, l]) => html`<button class="chipb" onClick=${() => setG(String(Math.floor(m.grams * f * 1e6) / 1e6))}>${l}</button>`)}</div>
      ${tooMuch && html`<div class="hint err">That’s more than you have.</div>`}
      ${tooSmall && html`<div class="hint err">The smallest sale is ${q.minSellGrams || 0.001} g.</div>`}
      <div class="card" style="margin-top:16px"><div class="between"><span class="muted">You receive${RATE_CHAT ? ' (indicative)' : ''}</span><b style="font-size:20px;white-space:nowrap">${fmt(amount)}</b></div>
        <div class="small muted" style="margin-top:4px">At ${q.sellGram ? fmt(q.sellGram) : '—'} per gram, today’s PGBX sell price</div></div>
      <label class="field"><span class="lbl">Pay to (your bank IBAN)</span>
        <input class=${'inp mono' + (iban && !ibanOk ? ' bad' : '')} autocapitalize="characters" autocorrect="off" autocomplete="off" spellcheck=${false} placeholder="PK36 SCBL 0000 0011 2345 6702" value=${iban} onInput=${e => setIban(e.target.value.slice(0, 34))} /></label>
      ${iban && !ibanOk && html`<div class="hint err">${/^PK\d{2}[A-Z]{4}[0-9A-Z]{16}$/.test(cleanIban) ? 'That IBAN isn’t valid. Check it against your bank details.' : 'An IBAN is 24 characters and starts with PK.'}</div>`}
      <p class="foot" style="padding:0">The account must be in your name. PGBX sends the payment by bank transfer, usually the same working day.</p>
    </div><${RateNotice} S=${S} A=${A} /></div>
    <div class="actionbar"><button class="btn btn-primary" disabled=${!ok} onClick=${go}>${S.paying ? 'Selling…' : RATE_CHAT ? 'Get final rate via chat' : amount ? `Sell for ${fmt(amount)}` : 'Sell'}</button></div>
  </div>`;
}
/* ============================================================
   Rate chat: app prices are indicative. The final rate for each purchase or sale is confirmed by PGBX support in a
   private chat about that request; the order is placed at that rate, once, before it expires.
   ============================================================ */
const RATE_TEXT = 'The prices shown on this app are for informational purposes only. Final buying and selling rates will be confirmed by our support team through live chat. Please open the chat to get the final rate before proceeding.';
const CHAT_KIND = { buy_bars: 'Buy bars', sell_bars: 'Sell bars back', buy_micro: 'Buy $1 gold', sell_micro: 'Sell $1 gold', gift: 'Gift order' };
const CHAT_STATUS = { open: ['warning', 'Waiting for rate'], confirmed: ['success', 'Rate confirmed'], completed: ['neutral', 'Done'], closed: ['neutral', 'Closed'] };
// The same request always has the same details, so a second tap opens the chat already asking about it
function normDetails(kind, d) {
  d = d || {};
  if (kind === 'buy_bars' || kind === 'sell_bars') return { lines: (d.lines || []).map(l => ({ product_id: String(l.product_id), units: Math.floor(Number(l.units)) })).sort((a, b) => (a.product_id < b.product_id ? -1 : a.product_id > b.product_id ? 1 : 0)) };
  if (kind === 'buy_micro') return { units: Math.floor(Number(d.units)) };
  if (kind === 'sell_micro') return { grams: Math.round(Number(d.grams) * 1e6) / 1e6 };
  return { item: d.item, shape: d.shape, design: d.design, engraving: String(d.engraving || '').trim(), packaging: d.packaging };
}
function chatSummary(kind, d, svc) {
  const lines = () => d.lines.map(l => `${l.units} × ${P[l.product_id] ? pname(P[l.product_id]) : l.product_id}`).join(', ');
  if (kind === 'buy_bars') return 'Buy ' + lines();
  if (kind === 'sell_bars') return 'Sell back ' + lines();
  if (kind === 'buy_micro') return `Buy $${d.units} of gold ($1 gold)`;
  if (kind === 'sell_micro') return `Sell ${d.grams.toFixed(4)} g of $1 gold`;
  const it = svc && svc.gift.items.find(i => i.id === d.item);
  return `Gift: ${it ? `${it.label} ${metalName(it.metal).toLowerCase()}` : d.item} ${d.shape}`;
}
// The notice on every buying and selling screen. action: { label, fn } opens the chat for what's on the screen.
function RateNotice({ S, A, action, confirmed }) {
  if (!RATE_CHAT) return null;
  if (confirmed) return html`<div class="rate-note ok" role="note"><span class="ri"><${Icon} n="check" c="sm"/></span>
    <div class="grow"><b>Final rate confirmed by PGBX support</b><span>App prices are indicative; this uses the rate agreed in your chat ${confirmed}.</span></div></div>`;
  const open = (S.chats || []).filter(c => c.status === 'open' || c.status === 'confirmed').length;
  return html`<div class="rate-note" role="note"><span class="ri"><${Icon} n="chat" c="sm"/></span>
    <div class="grow"><b>Prices are indicative</b><span>${RATE_TEXT}</span>
      <div class="rate-note-btns">
        ${action && html`<button class="btn btn-primary btn-sm" onClick=${action.fn} disabled=${action.disabled}><${Icon} n="chat" c="sm"/> ${action.label || 'Get final rate via chat'}</button>`}
        ${!S.guest && open > 0 && html`<button class="btn btn-secondary btn-sm" onClick=${() => A.push({ name: 'chats' })}>Your rate chats (${open})</button>`}
      </div></div></div>`;
}
// Photos are made smaller before sending (long side 1600 px, JPEG; iPhone HEIC photos are converted); PDFs go as they are.
// The server accepts up to FILE_MAX_BYTES of JPEG, PNG, WebP or PDF.
const FILE_PICK_MAX = 12e6, FILE_SHRINK_OVER = 600e3, FILE_MAX_BYTES = 2621440, PHOTO_SIDE = 1600, PHOTO_QUALITY = 0.85;
const FILE_TYPES = ['image/jpeg', 'image/png', 'image/webp', 'application/pdf'];
const toB64 = blob => new Promise((ok, bad) => { const r = new FileReader(); r.onload = () => ok(String(r.result).split(',')[1]); r.onerror = bad; r.readAsDataURL(blob); });
async function fileForUpload(file) {
  if (file.size > FILE_PICK_MAX) throw new Error('That file is too large.');
  if (/^image\//.test(file.type) && (file.size > FILE_SHRINK_OVER || !FILE_TYPES.includes(file.type))) {
    const img = await createImageBitmap(file).catch(() => null);
    if (img) {
      const k = Math.min(1, PHOTO_SIDE / Math.max(img.width, img.height)), c = document.createElement('canvas');
      c.width = Math.round(img.width * k); c.height = Math.round(img.height * k); c.getContext('2d').drawImage(img, 0, 0, c.width, c.height);
      img.close();                                          // the full-size decoded photo can be tens of MB
      const blob = await new Promise(r => c.toBlob(r, 'image/jpeg', PHOTO_QUALITY));
      c.width = c.height = 0;
      if (!blob || blob.size > FILE_MAX_BYTES) throw new Error('That photo is too large. Try a smaller one.');
      return { name: file.name.replace(/\.\w+$/, '') + '.jpg', mime: 'image/jpeg', data: await toB64(blob), blob };
    }
  }
  if (!FILE_TYPES.includes(file.type)) throw new Error('Send a photo (JPEG, PNG or WebP) or a PDF.');
  if (file.size > FILE_MAX_BYTES) throw new Error('Files can be up to 2.5 MB.');
  return { name: file.name, mime: file.type, data: await toB64(file), blob: file };
}
// Chat files: fetched when they scroll into view, kept for the session (an attachment never changes), at most 40 at once
const FILE_URLS = new Map();                 // attachment id -> object URL, oldest first
const FILE_KEEP = 40;
function keepFile(id, blob) {
  if (FILE_URLS.has(id)) { const u = FILE_URLS.get(id); FILE_URLS.delete(id); FILE_URLS.set(id, u); return u; }
  const url = URL.createObjectURL(blob); FILE_URLS.set(id, url);
  while (FILE_URLS.size > FILE_KEEP) { const [k, u] = FILE_URLS.entries().next().value; FILE_URLS.delete(k); URL.revokeObjectURL(u); }
  return url;
}
function b64Blob(data, mime) {               // a plain loop: several times faster than Uint8Array.from with a callback
  const bin = atob(data), out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return new Blob([out], { type: mime });
}
function ChatFile({ chatId, a, onLoad }) {
  const [url, setUrl] = useState(a.url || (FILE_URLS.has(a.id) ? keepFile(a.id) : null));
  const [err, setErr] = useState(false);
  const [big, setBig] = useState(false);
  const box = useRef(null);
  useEffect(() => {
    if (url || !LIVE) return;
    let live = true, io = null;
    const get = () => Live.chatFile(chatId, a.id).then(d => { if (live) setUrl(keepFile(a.id, b64Blob(d.data, d.mime))); }, () => live && setErr(true));
    if (typeof IntersectionObserver === 'function' && box.current) {
      io = new IntersectionObserver(es => { if (es.some(e => e.isIntersecting)) { io.disconnect(); io = null; get(); } }, { rootMargin: '400px 0px' });
      io.observe(box.current);
    } else get();
    return () => { live = false; io && io.disconnect(); };
  }, [a.id]);
  if (err || (!url && !LIVE)) return html`<span class="small muted">${a.name} (no longer available)</span>`;
  if (!url) return html`<span class="chat-file-wait small muted" ref=${box}>Loading ${a.name}…</span>`;
  // The phone apps can't open a file in a new window: photos open full screen here, PDFs go to the share sheet
  const N = typeof window !== 'undefined' && window.PGBXNative;
  if (a.mime.startsWith('image/')) {
    const img = html`<img class="chat-img" src=${url} alt=${a.name} onLoad=${onLoad} />`;
    return N ? html`<button type="button" class="chat-img-btn" aria-label=${'View ' + a.name} onClick=${() => setBig(true)}>${img}</button>
      ${big && html`<${PhotoView} url=${url} name=${a.name} onClose=${() => setBig(false)} />`}`
      : html`<a href=${url} target="_blank" rel="noopener">${img}</a>`;
  }
  if (N && N.shareFile) return html`<button type="button" class="chat-pdf" onClick=${() => fetch(url).then(r => r.blob()).then(toB64).then(d => N.shareFile(a.name, d)).catch(() => { })}><${Icon} n="doc" c="sm"/> ${a.name}</button>`;
  return html`<a class="chat-pdf" href=${url} download=${a.name}><${Icon} n="doc" c="sm"/> ${a.name}</a>`;
}
function PhotoView({ url, name, onClose }) {
  const btn = useRef(null);
  useEffect(() => {
    btn.current && btn.current.focus();
    const k = e => { if (e.key === 'Escape') onClose(); };
    addEventListener('keydown', k); return () => removeEventListener('keydown', k);
  }, []);
  return html`<div class="photo-view" role="dialog" aria-modal="true" aria-label=${name} onClick=${onClose}>
    <img src=${url} alt=${name} />
    <button type="button" class="btn btn-secondary btn-sm" ref=${btn} onClick=${onClose}>Close</button></div>`;
}
// What a chat's tag says: a confirmed rate that has run out is "Rate expired", not "Rate confirmed"
const rateEnds = c => (c.confirmation && c.confirmation.status === 'valid' ? c.confirmation.expiresAt : c.rateExpiresAt || null);
const chatState = (c, expiresAt, now) => (c.status === 'confirmed' && expiresAt && expiresAt <= now ? ['neutral', 'Rate expired'] : CHAT_STATUS[c.status] || ['', c.status]);
const CHAT_POLL_MS = 3000, CHAT_POLL_DONE_MS = 15000;     // while a rate is being agreed; after the order (support may still write)
// Production: the chat's messages come from the server while it's on screen (one request at a time; an older answer
// never replaces a newer one). Demo: kept in S.chats.
function useChatThread(S, A, id) {
  const local = (S.chats || []).find(c => c.id === id);
  const [t, setT] = useState(null);
  const [err, setErr] = useState(null);
  const lastId = useRef(0), get = useRef(() => Promise.resolve());
  const tRef = useRef(null); tRef.current = t;
  useEffect(() => {
    if (!LIVE) return;
    let live = true, busy = false, seq = 0, applied = 0, timer = null;
    const merge = (d, n) => setT(prev => {
      if (n < applied) return prev;                       // an older answer that arrived late
      applied = n;
      const have = prev ? prev.messages : [];
      const fresh = d.messages.filter(m => !have.some(x => x.id === m.id));
      const same = prev && !fresh.length && prev.chat.status === d.chat.status && JSON.stringify(prev.confirmation) === JSON.stringify(d.confirmation);
      if (same) return prev;                              // nothing changed: no redraw
      const messages = fresh.length ? [...have, ...fresh].sort((a, b) => a.id - b.id) : have;
      if (messages.length) lastId.current = messages[messages.length - 1].id;
      return { chat: d.chat, messages, confirmation: d.confirmation };
    });
    const pull = () => {
      if (busy) return Promise.resolve();
      busy = true; const n = ++seq;
      return Live.chatThread(id, lastId.current).then(d => { if (live) { merge(d, n); setErr(null); } }, e => { if (live) { if (Live.signedOut(e)) ACT.liveFail(e); else setErr(e); } })
        .finally(() => { busy = false; });
    };
    get.current = pull;
    // the next check is planned after each answer: often while the rate is being agreed, rarely once it's done, never once closed
    const next = () => { timer = setTimeout(() => {
      const st = tRef.current && tRef.current.chat && tRef.current.chat.status;
      if (st === 'closed') return;
      (document.visibilityState === 'visible' ? pull() : Promise.resolve()).then(() => live && next());
    }, tRef.current && tRef.current.chat && tRef.current.chat.status === 'completed' ? CHAT_POLL_DONE_MS : CHAT_POLL_MS); };
    pull().then(() => live && next());
    const vis = () => document.visibilityState === 'visible' && pull();
    document.addEventListener('visibilitychange', vis);
    return () => { live = false; clearTimeout(timer); document.removeEventListener('visibilitychange', vis); };
  }, [id]);
  useEffect(() => { if (local && local.unread) A.set(s => ({ chats: s.chats.map(c => (c.id === id ? { ...c, unread: 0 } : c)) })); }, [id, local && local.unread]);
  if (!LIVE) return { chat: local, messages: local ? local.messages : [], confirmation: local ? local.confirmation : null, loading: false };
  const add = m => setT(prev => (prev && !prev.messages.some(x => x.id === m.id) ? { ...prev, messages: [...prev.messages, m].sort((a, b) => a.id - b.id) } : prev));
  return { chat: t ? t.chat : local, messages: t ? t.messages : [], confirmation: t ? t.confirmation : null, loading: !t && !err, error: err, add, refresh: () => get.current() };
}
function ChatScreen({ S, A, id }) {
  const th = useChatThread(S, A, id);
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const scroller = useRef(null), fileRef = useRef(null), box = useRef(null);
  // Follow new messages (and photos as they load) only while the customer is at the bottom; reading older ones isn't interrupted
  const stick = useRef(true);
  const toEnd = () => { const el = scroller.current; if (el && stick.current) el.scrollTop = el.scrollHeight; };
  useEffect(toEnd, [th.messages.length, !!th.confirmation]);
  const c = th.chat, conf = th.confirmation;
  // demo: a sample reply and rate; again if the last one ran out
  const confDead = conf && (conf.status !== 'valid' || conf.expiresAt <= S.now);
  useEffect(() => { if (!LIVE && c && ['open', 'confirmed'].includes(c.status) && (!conf || confDead)) A.demoSupport(c.id); }, [c && c.id, conf && conf.id, !!confDead]);
  if (!c && th.loading) return html`<div class="page"><${TopBar} title="Final rate" onBack=${A.back} /><div class="scroll"><div class="pad"><span class="sk" style="height:200px"></span></div></div></div>`;
  if (!c) return html`<div class="page"><${TopBar} title="Final rate" onBack=${A.back} /><div class="scroll"><${Empty} icon="chat" title="Chat not found" body=${th.error ? th.error.message : 'It may have been removed from this phone.'} /></div></div>`;
  const closed = c.status === 'closed';
  const fit = () => {                       // the message box grows to 120px; the chat keeps its last message above it
    const el = box.current; if (!el) return;
    el.style.height = 'auto'; const h = Math.min(120, el.scrollHeight); el.style.height = h + 'px';
    const page = el.closest('.chat-page'); if (page) page.style.setProperty('--compose-h', h + 'px');
    toEnd();
  };
  const sent = body => { setText(v => (v.trim() === body ? '' : v)); requestAnimationFrame(fit); stick.current = true; };   // text typed meanwhile is kept
  const send = async () => {
    const body = text.trim(); if (!body || busy) return;
    setBusy(true);
    try { await A.chatSend(c.id, body, th.add); sent(body); } catch (e) { A.toast(e.message); } finally { setBusy(false); }
  };
  const attach = async e => {
    const f = e.target.files && e.target.files[0]; e.target.value = ''; if (!f) return;
    setBusy(true);
    const caption = text.trim();
    try { const up = await fileForUpload(f); await A.chatAttach(c.id, up, caption, th.add); sent(caption); } catch (x) { A.toast(x.message); } finally { setBusy(false); }
  };
  const close = () => A.confirm({ title: 'Close this request?', body: 'You can still read it, but its rate can’t be used. You can start a new request any time.', confirm: 'Close request', cancel: 'Keep it', danger: true, onConfirm: () => A.chatClose(c.id, th.refresh) });
  const [tone, label] = chatState(c, conf && conf.status === 'valid' ? conf.expiresAt : null, S.now);
  return html`<div class="page has-actions chat-page">
    <${TopBar} title="Final rate" onBack=${A.back} right=${!closed && html`<button class="linkbtn sm" onClick=${close}>Close</button>`} />
    <div class="scroll" ref=${scroller} onScroll=${e => { const el = e.currentTarget; stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < 80; }}>
      <div class="card chat-req">
        <div class="between"><span class="small muted">${CHAT_KIND[c.kind]} · <span class="mono">${c.ref}</span></span><span class=${'tag ' + tone}>${label}</span></div>
        <b style="display:block;margin-top:6px">${c.summary}</b>
        ${c.indicative ? html`<div class="small muted" style="margin-top:2px">App price when you asked: ${fmt(c.indicative)} (indicative)</div>` : ''}
      </div>
      <div class="chat-msgs" aria-live="polite">
        ${th.messages.map(m => html`<div class=${'msg ' + m.sender + (m.confirmationId ? ' rate' : '')} key=${m.id}>
          ${m.sender === 'system' ? html`<span>${m.body}</span>` : html`<div class="bubble">
            ${m.attachment && html`<${ChatFile} chatId=${c.id} a=${m.attachment} onLoad=${toEnd} />`}
            ${m.body && html`<div style="white-space:pre-wrap">${m.body}</div>`}
            <div class="meta">${m.sender === 'staff' ? (m.staffName ? m.staffName + ' · PGBX' : 'PGBX support') : 'You'} · ${F.hm.format(new Date(m.ts))}</div></div>`}
        </div>`)}
        ${c.status === 'open' && !conf && html`<div class="msg system"><span>PGBX support usually replies within a few minutes during working hours.</span></div>`}
      </div>
      ${conf && html`<${ConfirmedRate} S=${S} A=${A} chat=${c} conf=${conf} />`}
      ${!LIVE && html`<${Demo} title="Support" body="In the real app a PGBX team member replies and confirms the rate. Here a sample reply arrives automatically."></${Demo}>`}
    </div>
    ${closed ? html`<div class="actionbar"><div class="small muted" style="text-align:center">This request is closed. Start a new one from the product or checkout.</div></div>`
      : html`<div class="actionbar chat-compose">
        <input type="file" ref=${fileRef} accept="image/jpeg,image/png,image/webp,image/heic,application/pdf" style="display:none" onChange=${attach} />
        <button class="iconbtn" onClick=${() => fileRef.current.click()} disabled=${busy || S.offline} aria-label="Attach a photo or PDF"><${Icon} n="clip"/></button>
        <textarea class="inp" rows="1" ref=${box} placeholder="Message" value=${text} maxlength="2000" aria-label="Message to PGBX support"
          onInput=${e => { setText(e.target.value); fit(); }}
          onKeyDown=${e => { if (e.key === 'Enter' && !e.shiftKey && !e.isComposing && matchMedia('(hover:hover) and (pointer:fine)').matches) { e.preventDefault(); send(); } }}></textarea>
        <button class="iconbtn send" onClick=${send} disabled=${busy || !text.trim() || S.offline} aria-label="Send"><${Icon} n="send"/></button>
      </div>`}
  </div>`;
}
// The agreed rate, with its time left and the one button that uses it
function ConfirmedRate({ S, A, chat, conf }) {
  const [iban, setIban] = useState(S.lastIban || '');
  const left = Math.max(0, Math.ceil((conf.expiresAt - S.now) / 1000));
  const cleanIban = iban.replace(/\s/g, '').toUpperCase();
  const needsIban = chat.kind === 'sell_micro' || chat.kind === 'sell_bars';
  if (conf.status === 'used') return html`<div class="conf-card used"><${Icon} n="check" c="sm"/><span>Done at the confirmed rate${conf.usedRef ? html` · <span class="mono">${conf.usedRef}</span>` : ''}.</span></div>`;
  if (conf.status !== 'valid') return null;
  if (!left) return html`<div class="conf-card expired"><${Icon} n="clock" c="sm"/><span>The confirmed rate (${fmt(conf.total)}) has expired. Ask here for a new one.</span></div>`;
  const label = { buy_bars: `Pay ${fmt(conf.total)}`, buy_micro: `Pay ${fmt(conf.total)}`, gift: `Pay ${fmt(conf.total)}`, sell_micro: `Sell for ${fmt(conf.total)}`, sell_bars: `Sell for ${fmt(conf.total)}` }[chat.kind];
  const go = () => A.useRate(chat, conf, cleanIban);
  return html`<div class="conf-card" role="region" aria-label="Confirmed rate">
    <div class="between"><span class="small"><b>Final rate confirmed</b>${conf.note ? ' · ' + conf.note : ''}</span><span class="tag success" role="timer">${Math.floor(left / 60)}:${String(left % 60).padStart(2, '0')} left</span></div>
    <div class="conf-total">${fmt(conf.total)}</div>
    ${needsIban && html`<label class="field" style="margin-top:8px"><span class="lbl">Pay to (your bank IBAN)</span>
      <input class=${'inp mono' + (iban && !ibanValid(cleanIban) ? ' bad' : '')} autocapitalize="characters" autocorrect="off" autocomplete="off" spellcheck=${false} placeholder="PK36 SCBL 0000 0011 2345 6702" value=${iban} onInput=${e => setIban(e.target.value.slice(0, 34))} /></label>`}
    <button class="btn btn-primary" style="margin-top:10px" disabled=${S.paying || S.offline || (needsIban && !ibanValid(cleanIban))} onClick=${go}>${S.paying ? html`<span class="spin"></span> Working` : label}</button>
  </div>`;
}
function ChatsScreen({ S, A }) {
  const chats = [...(S.chats || [])].sort((a, b) => b.lastAt - a.lastAt);
  return html`<div class="page">
    <${TopBar} title="Rate chats" onBack=${A.back} />
    <div class="scroll">
      <div class="pad"><p class="muted">Your requests for a final rate. Each chat is private between you and PGBX support.</p></div>
      ${chats.length === 0 ? html`<${Empty} icon="chat" title="No rate chats yet" body="When you buy or sell, open a chat from the product, cart or checkout to get the final rate." />`
        : html`<div class="group chat-list">${chats.map(c => { const [tone, label] = chatState(c, rateEnds(c), S.now); return html`<button class="row" onClick=${() => A.push({ name: 'chat', id: c.id })}>
          <span class="ri gold"><${Icon} n="chat" c="sm"/></span>
          <div class="rt"><b>${c.summary}</b>
            <span class="chat-prev">${c.lastBody || CHAT_KIND[c.kind]}</span>
            <span class="chat-when"><span class=${'tag ' + tone}>${label}</span> ${rel(c.lastAt, S.now)}</span></div>
          ${c.unread > 0 && html`<span class="badge-dot" aria-label=${c.unread + ' new'}>${c.unread}</span>`}</button>`; })}</div>`}
    </div>
  </div>`;
}
// Selling bars back to PGBX: choose what to sell, then agree the rate in chat
function SellBarsScreen({ S, A }) {
  const free = PRODUCTS.map(p => ({ p, n: (S.holdings[p.id] || 0) - (S.reserved[p.id] || 0) })).filter(x => x.n > 0);
  const [pid, setPid] = useState(free[0] ? free[0].p.id : null);
  const [units, setUnits] = useState(1);
  const max = (free.find(x => x.p.id === pid) || { n: 0 }).n;
  const p = P[pid];
  const value = p ? Math.round(rateOf(S.rates, p.metal).sellGram * p.grams) * units : 0;
  return html`<div class="page has-actions">
    <${TopBar} title="Sell bars to PGBX" onBack=${A.back} />
    <div class="scroll">
      <${RateNotice} S=${S} A=${A} />
      ${free.length === 0 ? html`<${Empty} icon="wallet" title="No bars to sell" body="Bars you hold (and haven’t reserved for collection) can be sold back to PGBX here." />` : html`
        <section class="sec"><div class="sec-h"><h3>What to sell</h3></div>
          <div class="group inset-thumb" role="radiogroup" aria-label="Product to sell">
            ${free.map(({ p: q, n }) => html`<button class="row" onClick=${() => { setPid(q.id); setUnits(1); }} role="radio" aria-checked=${pid === q.id}>
              <${Thumb} p=${q} /><div class="rt"><b>${pname(q)}</b><span>${n} you can sell</span></div><${Radio} on=${pid === q.id} /></button>`)}
          </div>
          <div class="group" style="margin-top:8px"><div class="row"><div class="rt"><b>Quantity</b></div>
            <div class="stepper" role="group" aria-label="Quantity to sell">
              <button disabled=${units <= 1} onClick=${() => setUnits(u => u - 1)} aria-label="Decrease quantity"><${Icon} n="minus" c="sm"/></button>
              <output aria-live="polite"><span key=${units}>${units}</span></output>
              <button disabled=${units >= max} onClick=${() => setUnits(u => u + 1)} aria-label="Increase quantity"><${Icon} n="plus" c="sm"/></button>
            </div></div></div>
        </section>
        <p class="foot">PGBX pays the agreed amount to your bank account by transfer, usually the same working day. The bars leave your wallet when you confirm the sale.</p>`}
    </div>
    ${free.length > 0 && html`<${ActionBar} label="Indicative value" amount=${fmt(value)}>
      <button class="btn btn-primary" disabled=${!pid || S.offline} onClick=${() => A.rateChat('sell_bars', { lines: [{ product_id: pid, units }] }, value)}><${Icon} n="chat" c="sm"/> Get final rate via chat</button>
    </${ActionBar}>`}
  </div>`;
}

function MicroTxn({ S, A, ref_ }) {
  const t = ((S.micro && S.micro.txns) || []).find(x => x.ref === ref_);
  if (!t) return html`<div class="page"><${TopBar} title="Transaction" onBack=${A.back} /><div class="scroll"><${Empty} icon="gem" title="Transaction not found" body="It may still be loading. Try again in a moment." /></div></div>`;
  const [tone, label] = MICRO_STATUS[t.status] || ['', t.status];
  const copy = () => { try { navigator.clipboard.writeText(t.ref).then(() => A.toast('Transaction ID copied'), () => A.toast('Couldn’t copy. Press and hold the ID to copy it.')); } catch (e) { } };
  return html`<div class="page">
    <${TopBar} title=${t.side === 'buy' ? 'Gold bought' : 'Gold sold'} onBack=${A.back} />
    <div class="scroll"><div class="pad">
      <div class="card" style="text-align:center;padding:20px 16px">
        <span class=${'tag ' + tone}>${label}</span>
        <div class="small muted" style="margin-top:12px">Transaction ID</div>
        <div class="mono" style="font-size:18px;font-weight:600;margin-top:4px;overflow-wrap:anywhere">${t.ref}</div>
        <button class="btn btn-tertiary btn-sm" style="margin-top:8px" onClick=${copy}><${Icon} n="share" c="sm"/> Copy ID</button>
      </div>
      <div class="card" style="margin-top:12px">
        <div class="kv"><span>${t.side === 'buy' ? 'Gold bought' : 'Gold sold'}</span><b>${fmtG(t.grams)}</b></div>
        <div class="kv"><span>${t.side === 'buy' ? 'Paid' : 'You receive'}</span><b>${fmt(t.amount)}${t.usd ? ` ($${t.usd})` : ''}</b></div>
        <div class="kv"><span>Price per gram</span><b>${fmt(t.price)}</b></div>
        <div class="kv"><span>When</span><b>${dt(t.ts)}</b></div>
        ${t.orderRef && html`<div class="kv"><span>Payment</span><b class="mono" style="font-size:12px">${t.orderRef}</b></div>`}
        ${t.payoutTo && html`<div class="kv"><span>Paid to</span><b>${t.payoutTo}</b></div>`}
      </div>
      <section class="sec" style="padding:0"><div class="sec-h" style="padding:0"><h3>Tola lot</h3></div>
        ${t.lots && t.lots.length ? html`<div class="group">${t.lots.map(l => html`<div class="row"><span class="ri gold"><${Icon} n="box" c="sm"/></span>
            <div class="rt"><b class="mono" style="font-size:13px">${l.ref}</b><span>${fmtG(l.grams)} of this transaction · ${l.status === 'filling' ? 'lot still filling' : l.status === 'full' ? 'lot complete: 1 tola' : 'tola bar ' + (t.side === 'buy' ? 'bought' : 'sold')}</span></div></div>`)}</div>
          <p class="foot" style="padding:0">${t.side === 'buy' ? 'PGBX clubs paid $1 transactions from all customers into 1-tola lots and buys a tola bar for each full lot.' : 'Sales are clubbed into 1-tola lots the same way.'}${t.lots.length > 1 ? ' This one crossed the end of a lot, so it is split between two.' : ''}</p>`
          : html`<p class="small muted">${t.status === 'pending_payment' ? 'Added to a lot once your payment is confirmed.' : 'Not part of a lot (not paid).'}</p>`}
      </section>
    </div></div>
  </div>`;
}

// Price lock shown on product, cart and payment (60 s, then refreshed to the latest rate)
const LockLine = ({ S }) => {
  const remain = S.lock ? Math.min(LOCK_S, Math.max(0, Math.ceil((S.lock.expiresAt - S.now) / 1000))) : LOCK_S;
  // Production: until the server has locked the price, say so instead of counting down
  if (LIVE && (!S.lock || S.lock.pending)) return html`<div><div class="lockline" role="status"><span class="spin dark" aria-hidden="true"></span><span>Locking today’s price…</span></div></div>`;
  return html`<div>
    <div class="lockline" role="timer" aria-live="off"><${Icon} n="lock" c="xs"/><span>Price locked for <b style="color:var(--text)">${remain}s</b>, then updated to the latest rate</span></div>
    <div class=${'lockbar' + (remain <= 10 ? ' low' : '')}><i style=${{ transform: `scaleX(${remain / LOCK_S})` }}></i></div>
  </div>`;
};

function ProductScreen({ S, A, pid }) {
  const p = P[pid]; const unit = S.lock && S.lock.prices[pid];
  const total = (unit || 0) * S.qty;
  return html`<div class="page has-actions">
    <${TopBar} title=${pname(p)} onBack=${A.back} right=${html`<${CartButton} S=${S} A=${A} />`} />
    <div class="scroll">
      <div class=${'p-hero' + (p.metal === 'silver' ? ' silver' : '')}>
        <span class="shadow" aria-hidden="true"></span>
        <span class="bar"><span class="shine" style="border-radius:12px"><${Ingot} metal=${p.metal} w=${168} label=${p.short} /></span></span>
      </div>
      <div class="specs">
        <div><span>Metal</span><b>${metalName(p.metal)}</b></div>
        <div><span>Weight</span><b>${p.metal === 'silver' ? p.label : fmtW(p.grams)}</b></div>
        <div><span>Purity</span><b>999.0</b></div>
      </div>
      ${S.stale && html`<${StaleBanner} S=${S}/>`}
      <div class="card" style="margin-top:12px">
        <div class="between"><span class="muted">Price per bar</span><b style="font-size:17px">${unit ? html`<${Odo} value=${unit} flash=${S.lock.expiresAt} />` : '—'}</b></div>
        ${!RATE_CHAT && html`<div style="margin-top:12px"><${LockLine} S=${S} /></div>`}
        <div class="between" style="margin-top:16px;padding-top:16px;border-top:1px solid var(--border)">
          <div><b style="display:block">Quantity</b><span class="small muted">Up to ${MAX_UNITS} per order</span></div>
          <div class="stepper" role="group" aria-label="Quantity">
            <button disabled=${S.qty <= 1} onClick=${() => A.set({ qty: Math.max(1, S.qty - 1) })} aria-label="Decrease quantity"><${Icon} n="minus" c="sm"/></button>
            <output aria-live="polite"><span key=${S.qty}>${S.qty}</span></output>
            <button disabled=${S.qty >= MAX_UNITS} onClick=${() => A.set({ qty: Math.min(MAX_UNITS, S.qty + 1) })} aria-label="Increase quantity"><${Icon} n="plus" c="sm"/></button>
          </div>
        </div>
      </div>
      <${RateNotice} S=${S} A=${A} />
      <p class="foot">Each bar is backed one-to-one by metal held by PGBX. Collect it at a dealer whenever you like.</p>
    </div>
    <${ActionBar} label=${`Total for ${S.qty} bar${S.qty > 1 ? 's' : ''}${RATE_CHAT ? ' (indicative)' : ''}`} amount=${html`<${Odo} value=${total} />`}>
      <div class="ab-btns">
        <button class="btn btn-secondary" disabled=${S.stale} onClick=${() => A.addToCart(pid, S.qty)}>Add to cart</button>
        <button class="btn btn-primary" disabled=${S.stale} onClick=${() => A.checkout('now')}>${RATE_CHAT ? 'Get final rate' : 'Buy now'}</button>
      </div>
    </${ActionBar}>
  </div>`;
}

/* ---------- FR-B8 cart: gold and silver in one order ---------- */
function CartScreen({ S, A }) {
  const lines = S.cart; const prices = (S.lock && S.lock.prices) || {};
  const total = linesTotal(lines, prices); const units = linesUnits(lines);
  const over = S.spentToday + total > DAY_LIMIT;
  if (lines.length === 0) return html`<div class="page">
    <${TopBar} title="Cart" onBack=${A.back} />
    <div class="scroll"><${Empty} icon="cart" title="Your cart is empty" body="Add gold and silver bars to buy them together in one payment." action="Browse products" onAction=${() => A.tab('buy')} /></div>
  </div>`;
  return html`<div class="page has-actions">
    <${TopBar} title="Cart" onBack=${A.back} />
    <div class="scroll">
      ${RATE_CHAT ? html`<${RateNotice} S=${S} A=${A} />` : html`<div class="pad"><${LockLine} S=${S} /></div>`}
      <div class="group" style="margin-top:16px">
        ${lines.map(l => { const p = P[l.pid]; return html`<div class="row" key=${l.pid} style="align-items:flex-start">
          <${Thumb} p=${p} />
          <div class="rt"><b>${pname(p)}</b><span>${fmt(prices[l.pid] || 0)} each</span>
            <div class="stepper" role="group" aria-label=${`Quantity of ${pname(p)}`} style="margin-top:8px">
              <button disabled=${l.units <= 1} onClick=${() => A.cartUnits(l.pid, l.units - 1)} aria-label="Decrease quantity"><${Icon} n="minus" c="sm"/></button>
              <output aria-live="polite"><span key=${l.units}>${l.units}</span></output>
              <button disabled=${units >= MAX_UNITS} onClick=${() => A.cartUnits(l.pid, l.units + 1)} aria-label="Increase quantity"><${Icon} n="plus" c="sm"/></button>
            </div></div>
          <div style="text-align:right"><b>${fmt((prices[l.pid] || 0) * l.units)}</b>
            <button class="iconbtn" style="margin:4px -10px 0 auto;color:var(--text-2)" onClick=${() => A.removeLine(l.pid)} aria-label=${`Remove ${pname(p)}`}><${Icon} n="trash" c="sm"/></button></div>
        </div>`; })}
      </div>
      <${LimitBar} S=${S} add=${total} />
      ${over && html`<${Notice} kind="warning" title="Over today’s limit">You can buy up to ${fmt(Math.max(0, DAY_LIMIT - S.spentToday))} more today. Remove a bar to continue.</${Notice}>`}
      ${S.stale && html`<${StaleBanner} S=${S}/>`}
    </div>
    <${ActionBar} label=${`${units} bar${units > 1 ? 's' : ''} · ${new Set(lines.map(l => P[l.pid].metal)).size > 1 ? 'gold and silver' : metalName(P[lines[0].pid].metal).toLowerCase()}`} amount=${html`<${Odo} value=${total} />`}>
      <button class="btn btn-primary" disabled=${S.stale || over || units > MAX_UNITS} onClick=${() => A.checkout('cart')}>${RATE_CHAT ? html`<${Icon} n="chat" c="sm"/> Get final rate via chat` : 'Continue to payment'}</button>
    </${ActionBar}>
  </div>`;
}

const METHODS = [
  { id: 'bank', icon: 'bank', name: 'Bank transfer', sub: 'Pay instantly from your bank app' },
  { id: 'card', icon: 'card', name: 'Debit or credit card', sub: 'Card details are never stored in the app' },
  { id: 'mwallet', icon: 'phone', name: 'Mobile wallet', sub: 'Pay from your mobile wallet' },
];
function PayScreen({ S, A }) {
  const lines = S.checkout; const prices = S.lock.prices;
  const total = linesTotal(lines, prices);
  const over = S.spentToday + total > DAY_LIMIT;
  const conf = S.lock.confirmed, left = conf ? Math.max(0, Math.ceil((S.lock.expiresAt - S.now) / 1000)) : 1;
  return html`<div class="page has-actions">
    <${TopBar} title="Payment" onBack=${A.back} />
    <div class="scroll">
      <div class="sec-h"><h3>Order</h3></div>
      <div class="card">
        ${lines.map(l => { const p = P[l.pid]; return html`<div class="kv"><span>${l.units} × ${pname(p)}</span><b>${fmt(prices[l.pid] * l.units)}</b></div>`; })}
        <div class="kv total"><span>Total</span><b><${Odo} value=${total} /></b></div>
        <div style="margin-top:12px">${conf ? html`<div class="lockline" role="timer" aria-live="off"><${Icon} n="lock" c="xs"/><span>${left ? html`Confirmed rate valid for <b style="color:var(--text)">${Math.floor(left / 60)}:${String(left % 60).padStart(2, '0')}</b>` : 'The confirmed rate has expired. Ask in the chat for a new one.'}</span></div>` : html`<${LockLine} S=${S} />`}</div>
      </div>
      ${conf && html`<${RateNotice} S=${S} A=${A} confirmed=${conf} />`}
      <section class="sec">
        <div class="sec-h"><h3>Pay with</h3></div>
        <div class="group inset" role="radiogroup" aria-label="Payment method">
          ${METHODS.map(m => html`<button class="row" onClick=${() => A.set({ method: m.id })} role="radio" aria-checked=${S.method === m.id}>
            <span class="ri"><${Icon} n=${m.icon} c="sm"/></span><div class="rt"><b>${m.name}</b><span>${m.sub}</span></div><${Radio} on=${S.method === m.id} />
          </button>`)}
        </div>
      </section>
      <${Notice} kind="plain" icon="shield">Metal is added to your wallet as soon as PGBX confirms your payment. If anything goes wrong, PGBX completes the order or refunds you.</${Notice}>
      ${S.offline && html`<${Notice} kind="warning" icon="wifiOff" title="You’re offline">Connect to the internet to pay. Your order is kept on this screen.</${Notice}>`}
      ${over && html`<${Notice} kind="warning" title="Over today’s limit">This order would take you over today’s limit of ${fmt(DAY_LIMIT)}.</${Notice}>`}
      ${S.stale && html`<${StaleBanner} S=${S}/>`}
      <${Demo} title="Simulate a problem">
        <button class="row" onClick=${() => A.set({ simCreditFail: !S.simCreditFail })} role="switch" aria-checked=${S.simCreditFail}>
          <div class="rt"><b>Payment succeeds, crediting fails</b><span>Shows retries and hand-off to PGBX operations</span></div><${Switch} on=${S.simCreditFail} />
        </button>
      </${Demo}>
    </div>
    <${ActionBar}>
      <button class="btn btn-primary" disabled=${(S.stale && !conf) || S.paying || over || S.offline || S.lock.pending || !left} onClick=${A.pay}>${S.paying ? html`<span class="spin"></span> Processing` : S.lock.pending ? html`<span class="spin"></span> Getting the latest price` : html`<${Icon} n="lock" c="sm"/> Pay ${fmt(total)}`}</button>
    </${ActionBar}>
  </div>`;
}

function Processing({ fail, kind }) {
  const steps = kind === 'appraisal' ? [['ok', 'Payment confirmed'], ['ok', 'Booking your visit'], ['ok', 'Sending your confirmation']]
    : kind === 'gift' ? [['ok', 'Payment confirmed'], ['ok', 'Sending your design to the refinery'], ['ok', 'Issuing your receipt']]
    : kind === 'micro' ? [['ok', 'Payment confirmed'], ['ok', 'Adding gold to your account'], ['ok', 'Placing it in a tola lot']]
    : fail
    ? [['ok', 'Payment received'], ['bad', 'Couldn’t add the metal to your wallet'], ['ok', 'Retrying (1 of 3)'], ['ok', 'Retrying (2 of 3)'], ['ok', 'Retrying (3 of 3)'], ['flag', 'Passed to PGBX operations']]
    : [['ok', 'Payment confirmed'], ['ok', 'Adding metal to your wallet'], ['ok', 'Issuing your receipt']];
  const [n, setN] = useState(0);
  useEffect(() => { if (LIVE) return; const t = setInterval(() => setN(v => Math.min(v + 1, steps.length - 1)), fail ? 800 : 550); return () => clearInterval(t); }, []);
  // Production: no made-up progress. The next screen shows what the server says happened.
  if (LIVE) return html`<div class="center-screen" role="status" aria-live="polite">
    <div class="spinner" aria-hidden="true"></div>
    <h2 style="margin-top:24px;font-size:22px">Processing your payment</h2>
    <p class="small muted" style="margin-top:4px">Please keep the app open.</p>
  </div>`;
  return html`<div class="center-screen" role="status" aria-live="polite">
    <div class="spinner" aria-hidden="true"></div>
    <h2 style="margin-top:24px;font-size:22px">${fail ? 'Processing your order' : 'Confirming your payment'}</h2>
    <p class="small muted" style="margin-top:4px">Please keep the app open.</p>
    <div class="proc-steps">
      ${steps.slice(0, n + 1).map(([k, t]) => html`<div><span style=${{ color: k === 'bad' ? 'var(--danger)' : k === 'flag' ? 'var(--warning)' : 'var(--success)', display: 'flex' }}><${Icon} n=${k === 'bad' ? 'x' : k === 'flag' ? 'flag' : 'check'} c="sm"/></span>${t}</div>`)}
    </div>
  </div>`;
}

function Receipt({ S, A, oid, showBack }) {
  const o = S.orders.find(x => x.id === oid);
  if (!o) return html`<div class="page"><${TopBar} title="Receipt" onBack=${A.back} /><div class="scroll"><${Empty} icon="receipt" title="Receipt not found" body="It may still be loading. Pull to refresh your wallet or try again in a moment." /></div></div>`;
  // credited | flagged (with operations) | pending (waiting for the payment) | refunded | failed | expired
  const flagged = o.status === 'flagged' || o.status === 'pending';
  const ended = ['refunded', 'failed', 'expired'].includes(o.status);
  const paid = o.status === 'credited' || o.status === 'flagged';
  const HEAD = { pending: ['Waiting for your payment', 'Your order is reserved while you complete the payment. The metal is added as soon as PGBX receives it.'],
    refunded: ['Order refunded', 'PGBX refunded this order to your payment method.'], failed: ['Payment didn’t go through', 'No money was taken. You can try again from the product.'],
    expired: ['Order expired', 'The payment wasn’t completed in time, so the order was cancelled.'] };
  const share = async () => {
    const text = `PGBX receipt ${o.receipt}: ${linesText(o.lines)}, ${fmt(o.total)}, ${dt(o.ts)}`;
    try { if (navigator.share) await navigator.share({ title: 'PGBX receipt', text }); else { await navigator.clipboard.writeText(text); A.toast('Receipt details copied'); } } catch (e) { }
  };
  const body = html`
    <div class="result">
      <div class=${'mark' + (flagged || ended ? ' warning' : '')}>${flagged || ended
        ? html`<${Icon} n="clock"/>`
        : html`<svg width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d=${PATHS.check} pathLength="1"/></svg>`}</div>
      <h1>${HEAD[o.status] ? HEAD[o.status][0] : flagged ? 'Payment received' : 'Payment confirmed'}</h1>
      <p>${HEAD[o.status] ? HEAD[o.status][1] : flagged ? 'We couldn’t add the metal to your wallet yet. PGBX operations will complete your order or refund you. Your money is safe.' : `${linesText(o.lines)} ${o.lines.length > 1 || o.lines[0].units > 1 ? 'are' : 'is'} now in your wallet.`}</p>
    </div>
    <div class="card" style="margin-top:24px">
      <div class="kv"><span>Receipt</span><b class="mono">${o.receipt}</b></div>
      ${o.lines.map(l => html`<div class="kv"><span>${l.units} × ${pname(P[l.pid])}</span><b>${fmt(l.unit * l.units)}</b></div>`)}
      <div class="kv"><span>Paid with</span><b>${(METHODS.find(m => m.id === o.method) || { name: o.method }).name}</b></div>
      <div class="kv"><span>Date</span><b>${dt(o.ts)}</b></div>
      <div class="kv"><span>Status</span><span class=${'tag ' + (ended ? 'neutral' : flagged ? 'warning' : 'success')}>${o.status === 'pending' ? 'Awaiting payment' : ended ? HEAD[o.status][0] : flagged ? 'With operations' : 'In your wallet'}</span></div>
      <div class="kv total"><span>${paid ? 'Total paid' : 'Total'}</span><b>${fmt(o.total)}</b></div>
      ${!LIVE && html`<div class="small muted" style="margin-top:8px">Tax and legal details: <${Tbc}/></div>`}
    </div>
    <div class="pad stack-btns" style="margin-top:24px">
      <button class="btn btn-primary" onClick=${() => A.tab('wallet')}>View wallet</button>
      ${paid && html`<button class="btn btn-secondary" onClick=${share}><${Icon} n="share" c="sm"/> Share receipt</button>`}
      ${!showBack && html`<button class="btn btn-tertiary" onClick=${() => A.tab('rates')}>Done</button>`}
    </div>`;
  return showBack ? html`<div class="page"><${TopBar} title="Receipt" onBack=${A.back} /><div class="scroll from-inbox">${body}</div></div>` : html`<div class="scroll">${body}</div>`;
}

/* ============================================================
   Identity verification (FR-A2) and profile (FR-N2)
   ============================================================ */
const fmtCnic = v => { const d = v.replace(/\D/g, '').slice(0, 13); return d.length > 12 ? `${d.slice(0, 5)}-${d.slice(5, 12)}-${d.slice(12)}` : d.length > 5 ? `${d.slice(0, 5)}-${d.slice(5)}` : d; };
const IdCardArt = ({ back }) => html`<svg class="idcard" viewBox="0 0 250 156" aria-hidden="true">
  <rect width="250" height="156" rx="12" fill="#e8efe6"/><rect width="250" height="30" rx="12" fill="#0B4A2C"/><rect y="18" width="250" height="12" fill="#0B4A2C"/>
  <text x="14" y="20" font-size="10" font-weight="900" fill="#E2B65A" font-family="-apple-system, system-ui, 'Segoe UI', Roboto, sans-serif">${back ? 'CNIC · BACK (SAMPLE)' : 'CNIC · FRONT (SAMPLE)'}</text>
  ${back ? html`<rect x="14" y="44" width="222" height="10" rx="3" fill="#c5d3c6"/><rect x="14" y="62" width="180" height="10" rx="3" fill="#c5d3c6"/><rect x="14" y="98" width="222" height="40" rx="4" fill="#fff"/>${Array.from({ length: 40 }, (_, i) => html`<rect x=${18 + i * 5.4} y="102" width=${i % 3 ? 2 : 3.5} height="32" fill="#1D2B22"/>`)}`
    : html`<rect x="14" y="42" width="62" height="78" rx="6" fill="#c5d3c6"/><circle cx="45" cy="70" r="14" fill="#9fb3a2"/><path d="M24 116a21 21 0 0 1 42 0" fill="#9fb3a2"/>
      <rect x="90" y="46" width="120" height="10" rx="3" fill="#c5d3c6"/><rect x="90" y="66" width="90" height="10" rx="3" fill="#c5d3c6"/><rect x="90" y="86" width="140" height="10" rx="3" fill="#c5d3c6"/><rect x="90" y="106" width="70" height="10" rx="3" fill="#c5d3c6"/>`}
</svg>`;

function KycScreen({ S, A, next }) {
  const re = S.kyc.status === 'reverify';
  // A check already with PGBX opens on its status instead of starting again
  const [step, setStep] = useState(LIVE && S.kyc.status === 'pending' ? 7 : 0);
  const timers = useRef([]); useEffect(() => () => timers.current.forEach(clearTimeout), []);
  const later = (fn, ms) => timers.current.push(setTimeout(fn, ms));
  const [f, setF] = useState({ cnic: S.profile.cnic || '', name: S.profile.name || '', dob: S.profile.dob || '', expiry: S.kyc.expiry || '' });
  const [touched, setTouched] = useState({});
  const [shot, setShot] = useState({ front: false, back: false, selfie: false });
  const [busy, setBusy] = useState(false);
  const age = f.dob ? (Date.now() - Date.parse(f.dob)) / (365.25 * 86400e3) : 0;
  const errs = { cnic: f.cnic.replace(/\D/g, '').length !== 13, name: f.name.trim().length < 3, dob: !(age >= 18 && age < 120), expiry: f.expiry !== 'lifetime' && !(Date.parse(f.expiry) > Date.now()) };
  const msgs = { cnic: 'Enter all 13 digits of your CNIC.', name: 'Enter your full name as printed on your CNIC.', dob: f.dob ? 'You must be 18 or older.' : 'Enter your date of birth.', expiry: f.expiry ? 'This CNIC has expired.' : 'Enter the expiry date.' };
  const ok = !Object.values(errs).some(Boolean);
  const show = k => (touched[k] || touched.all) && errs[k];
  const capture = k => { setBusy(true); later(() => { setShot(s => ({ ...s, [k]: true })); setBusy(false); }, 1500); };
  const [result, setResult] = useState(null);
  // Production: the details go to the server and the identity provider decides. The provider's own capture screens
  // (CNIC photos and selfie) open here once PGBX chooses a provider; the demo build simulates them.
  const submit = LIVE
    ? async () => { setStep(5); try { const r = await A.submitKycLive(f); setResult(r); setStep(r.status === 'verified' ? 6 : 7); } catch (e) { setResult({ status: 'error', reason: e.message }); setStep(7); } }
    : () => { setStep(5); A.submitKyc(f); later(() => { A.kycVerified(); setStep(6); }, 2600); };
  const titles = [re ? 'Verify your identity again' : 'Verify your identity', 'Your CNIC details', 'Front of your CNIC', 'Back of your CNIC', 'Take a selfie', 'Checking your details', 'You’re verified',
    result && result.status === 'failed' ? 'We couldn’t verify you' : result && result.status === 'error' ? 'Something went wrong' : 'We’re checking your details'];
  const Frame = (k, back) => html`<div class="idframe">
    <span class="cn a"></span><span class="cn b"></span><span class="cn c"></span><span class="cn d"></span>
    ${shot[k] ? html`<${IdCardArt} back=${back} /><span class="okmark"><${Icon} n="check" c="sm"/></span>`
      : busy ? html`<span class="scanline"></span><span>Hold steady…</span>` : html`<span>Place the ${back ? 'back' : 'front'} of your CNIC inside the frame</span>`}
  </div>`;
  // The phone's back gesture goes to the previous step, like the back button, instead of abandoning the check
  useEffect(() => { A.guard(step > 0 && step < 5 ? () => setStep(x => Math.max(0, x - 1)) : null); return () => A.guard(null); }, [step]);
  const F = (k, label, input) => html`<label class="field"><span class="lbl">${label}</span>${input}${show(k) && html`<div class="hint err">${msgs[k]}</div>`}</label>`;
  return html`<div class="page">
    <${TopBar} title=${step < 5 ? (LIVE ? `Step ${Math.min(step + 1, 2)} of 2` : `Step ${Math.min(step + 1, 5)} of 5`) : 'Identity'} onBack=${step > 0 && step < 5 ? () => setStep(step - 1) : A.back} />
    <div class="scroll">
      <div class="kprog" role="progressbar" aria-valuemin="0" aria-valuemax="6" aria-valuenow=${step}><i style=${{ transform: `scaleX(${Math.min(1, step / 6)})` }}></i></div>
      <div class="pad step-in" key=${step} style="margin-top:24px">
        <h2 style="font-size:24px">${titles[step]}</h2>
        ${step === 0 && html`<p class="muted" style="margin-top:8px">${re ? 'You changed your identity details, so PGBX needs to check them again before your next purchase.' : 'PGBX checks your identity once, before your first purchase. It takes about 2 minutes.'}</p>
          <div class="group" style="margin:20px 0 0">${[['Your CNIC details', 'Number, name, date of birth and expiry'], ...(LIVE ? [] : [['Photos of your CNIC', 'Front and back'], ['A selfie', 'Matched to your CNIC photo']])].map(([t, d], i) => html`<div class="row"><span class="kn">${i + 1}</span><div class="rt"><b>${t}</b><span>${d}</span></div></div>`)}</div>
          <p class="small muted" style="margin-top:12px">Your details are encrypted and used only to verify your identity.${LIVE ? '' : ' We’ll ask to use your camera for the photos.'}</p>
          <button class="btn btn-primary" style="margin-top:24px" onClick=${() => setStep(1)}>Start</button>`}
        ${step === 1 && html`<div>
          ${F('cnic', 'CNIC number', html`<input class=${'inp' + (show('cnic') ? ' bad' : '')} inputmode="numeric" autocomplete="off" placeholder="00000-0000000-0" value=${fmtCnic(f.cnic)} onBlur=${() => setTouched(t => ({ ...t, cnic: true }))} onInput=${e => setF({ ...f, cnic: fmtCnic(e.target.value) })} />`)}
          ${F('name', 'Full name, as on your CNIC', html`<input class=${'inp' + (show('name') ? ' bad' : '')} autocomplete="name" value=${f.name} onBlur=${() => setTouched(t => ({ ...t, name: true }))} onInput=${e => setF({ ...f, name: e.target.value })} />`)}
          <div class="grid2">
            ${F('dob', 'Date of birth', html`<input class=${'inp' + (show('dob') ? ' bad' : '')} type="date" autocomplete="bday" value=${f.dob} onBlur=${() => setTouched(t => ({ ...t, dob: true }))} onInput=${e => setF({ ...f, dob: e.target.value })} />`)}
            ${F('expiry', 'CNIC expiry', f.expiry === 'lifetime' ? html`<div class="inp" style="display:flex;align-items:center">Lifetime</div>`
              : html`<input class=${'inp' + (show('expiry') ? ' bad' : '')} type="date" value=${f.expiry} onBlur=${() => setTouched(t => ({ ...t, expiry: true }))} onInput=${e => setF({ ...f, expiry: e.target.value })} />`)}
          </div>
          <button class="check" style="margin-top:8px" onClick=${() => setF({ ...f, expiry: f.expiry === 'lifetime' ? '' : 'lifetime' })} role="checkbox" aria-checked=${f.expiry === 'lifetime'}>
            <span class=${'cbox' + (f.expiry === 'lifetime' ? ' on' : '')} aria-hidden="true"><${Icon} n="check"/></span> My CNIC has no expiry date (lifetime)</button>
          <button class="btn btn-primary" style="margin-top:24px" onClick=${() => (!ok ? setTouched({ all: true }) : LIVE ? submit() : setStep(2))}>${LIVE ? 'Submit for verification' : 'Continue'}</button></div>`}
        ${(step === 2 || step === 3) && html`<p class="muted" style="margin-top:8px">Use good light and avoid glare. All four corners should be visible.</p>
          ${Frame(step === 2 ? 'front' : 'back', step === 3)}
          ${!LIVE && html`<p class="tiny muted" style="text-align:center;margin-top:8px">Demo: the camera is simulated and no photo is taken.</p>`}
          <div style="margin-top:16px">${shot[step === 2 ? 'front' : 'back']
            ? html`<button class="btn btn-primary" onClick=${() => setStep(step + 1)}>Continue</button>`
            : html`<button class="btn btn-primary" disabled=${busy} onClick=${() => capture(step === 2 ? 'front' : 'back')}>${busy ? html`<span class="spin"></span> Capturing` : html`<${Icon} n="camera" c="sm"/> Capture`}</button>`}</div>`}
        ${step === 4 && html`<p class="muted" style="margin-top:8px">Fit your face inside the circle. Remove glasses and look at the camera.</p>
          <div class=${'selfie' + (shot.selfie ? ' ok' : '')}>
            ${busy && html`<svg class="ring" viewBox="0 0 200 200"><circle cx="100" cy="100" r="96" stroke="rgba(255,255,255,.12)"/><circle class="pr" cx="100" cy="100" r="96" pathLength="1"/></svg>`}
            ${shot.selfie ? html`<span style="color:#7FD8A4"><svg width="72" height="72" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><path d=${PATHS.check}/></svg></span>`
              : html`<svg width="112" height="132" viewBox="0 0 120 140" fill="none" stroke="#E2B65A" stroke-width="2" stroke-dasharray="5 6" opacity=".7"><ellipse cx="60" cy="62" rx="40" ry="52"/><path d="M20 140c4-18 20-26 40-26s36 8 40 26"/></svg>`}
          </div>
          <p class="small muted" style="text-align:center;margin-top:12px" role="status">${shot.selfie ? 'Selfie captured' : busy ? 'Hold still…' : ''}</p>
          <div style="margin-top:16px">${shot.selfie ? html`<button class="btn btn-primary" onClick=${submit}>Submit for verification</button>`
            : html`<button class="btn btn-primary" disabled=${busy} onClick=${() => capture('selfie')}>${busy ? html`<span class="spin"></span> Capturing` : html`<${Icon} n="camera" c="sm"/> Take selfie`}</button>`}</div>`}
        ${step === 5 && html`<div style="text-align:center;padding-top:40px" role="status"><div class="spinner" style="margin:0 auto"></div>
          <p class="muted" style="margin-top:16px">Checking your CNIC and selfie. This usually takes less than a minute.</p></div>`}
        ${step === 7 && html`<div style="text-align:center;padding-top:24px">
          <div class=${'mark' + (result && result.status === 'failed' ? ' danger' : ' warning')}><${Icon} n=${result && result.status === 'failed' ? 'x' : 'clock'}/></div>
          <p class="muted" style="margin-top:16px">${(result && result.reason) || 'A PGBX team member will review your check, usually within one working day. We’ll notify you.'}</p></div>
          ${result && (result.status === 'failed' || result.status === 'error')
            ? html`<button class="btn btn-primary" style="margin-top:24px" onClick=${() => setStep(1)}>Check my details</button><button class="btn btn-tertiary" onClick=${A.back}>Not now</button>`
            : html`<button class="btn btn-primary" style="margin-top:24px" onClick=${A.back}>Done</button>`}`}
        ${step === 6 && html`<div style="text-align:center;padding-top:24px">
          <div class="mark"><svg width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d=${PATHS.check} pathLength="1"/></svg></div>
          <p class="muted" style="margin-top:16px">${next === 'pay' ? 'You can now complete your purchase.' : 'You can now buy gold and silver.'}</p>
          ${!LIVE && html`<p class="tiny muted" style="margin-top:8px">Demo: verification always passes. A real check can also fail or go to manual review.</p>`}</div>
          <button class="btn btn-primary" style="margin-top:24px" onClick=${() => A.kycFinish(next)}>${next === 'pay' ? 'Continue to payment' : 'Done'}</button>`}
      </div>
    </div>
  </div>`;
}

function ProfileScreen({ S, A }) {
  const [f, setF] = useState({ ...S.profile });
  const [ph, setPh] = useState({ open: false, num: '', sent: false, code: '', busy: false, err: '' });
  const demo = !LIVE && S.otpCfg.checked && !S.otpCfg.unreachable && S.otpCfg.configured === false;
  const phSend = async () => {
    setPh(p => ({ ...p, busy: true, err: '' }));
    const d = demo ? { ok: true } : await otpCall({ action: 'send', phone: ph.num, channel: 'sms' }, 'phone');
    setPh(p => ({ ...p, busy: false, sent: !!d.ok, err: d.ok ? '' : d.error === 'wait' ? `Please wait ${d.retryIn} seconds before trying again.` : d.error === 'unreachable' ? 'Can’t reach the login service. Check your connection and try again.' : d.message || 'We couldn’t send the code. Try again.' }));
  };
  const phCheck = async () => {
    setPh(p => ({ ...p, busy: true, err: '' }));
    const d = demo ? { ok: true, approved: true } : await otpCall({ action: 'check', phone: ph.num, code: ph.code }, 'phone');
    if (d.ok && d.approved) { A.changePhone(ph.num); setPh({ open: false, num: '', sent: false, code: '', busy: false, err: '' }); return; }
    setPh(p => ({ ...p, busy: false, code: '', err: d.message || 'That code is incorrect. Check the SMS and try again.' }));
  };
  const idChanged = ['name', 'cnic', 'dob'].some(k => (f[k] || '') !== (S.profile[k] || ''));
  const dirty = idChanged || ['email', 'address'].some(k => (f[k] || '') !== (S.profile[k] || ''));
  const emailBad = f.email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(f.email);
  const nameBad = f.name.trim().length < 3;
  const cnicBad = !!f.cnic && f.cnic.replace(/\D/g, '').length !== 13;
  const age = f.dob ? (Date.now() - Date.parse(f.dob)) / (365.25 * 86400e3) : null;
  const dobBad = !!f.dob && !(age >= 18 && age < 120);
  const numOk = PK_MOBILE.test(ph.num);
  // Leaving with unsaved edits asks first, whichever way the customer leaves (back, tab bar or the phone's back gesture)
  useEffect(() => {
    A.guard(dirty ? cont => A.confirm({ title: 'Discard your changes?', body: 'Your edits to personal details haven’t been saved.', confirm: 'Discard changes', cancel: 'Keep editing', danger: true, onConfirm: cont }) : null);
    return () => A.guard(null);
  }, [dirty]);
  return html`<div class="page">
    <${TopBar} title="Personal details" onBack=${A.back} />
    <div class="scroll">
      <div class="sec-h"><h3>Identity</h3></div>
      <div class="card">
        <label class="field" style="margin-top:0"><span class="lbl">Full name</span><input class=${'inp' + (nameBad ? ' bad' : '')} autocomplete="name" value=${f.name} onInput=${e => setF({ ...f, name: e.target.value })} />
          ${nameBad && html`<div class="hint err">Enter your full name.</div>`}</label>
        <label class="field"><span class="lbl">CNIC number</span><input class=${'inp' + (cnicBad ? ' bad' : '')} inputmode="numeric" placeholder="Added during verification" value=${fmtCnic(f.cnic || '')} onInput=${e => setF({ ...f, cnic: fmtCnic(e.target.value) })} />
          ${cnicBad && html`<div class="hint err">Enter all 13 digits of your CNIC.</div>`}</label>
        <label class="field"><span class="lbl">Date of birth</span><input class=${'inp' + (dobBad ? ' bad' : '')} type="date" autocomplete="bday" value=${f.dob || ''} onInput=${e => setF({ ...f, dob: e.target.value })} />
          ${dobBad && html`<div class="hint err">${age < 18 ? 'You must be 18 or older.' : 'Check your date of birth.'}</div>`}</label>
        ${idChanged && S.kyc.status === 'verified' && html`<div class="notice warning" style="margin:16px 0 0;width:100%"><${Icon} n="alert" c="sm"/><span>Changing your identity details means PGBX must verify you again. Buying is paused until then.</span></div>`}
      </div>
      <section class="sec">
        <div class="sec-h"><h3>Contact</h3></div>
        <div class="card">
          <div class="between"><div><span class="small muted">Mobile number</span><b style="display:block;margin-top:2px">+92 ${S.phone ? S.phone.slice(0, 3) + ' ' + S.phone.slice(3) : '3•• ••• 4521'}</b></div>
            <button class="btn btn-secondary btn-sm" onClick=${() => setPh({ open: !ph.open, num: '', sent: false, code: '', busy: false, err: '' })}>${ph.open ? 'Cancel' : 'Change'}</button></div>
          ${ph.open && html`<div class="step-in" style="margin-top:16px;padding-top:16px;border-top:1px solid var(--border)">
            <label class="field" style="margin-top:0"><span class="lbl">New mobile number</span>
              <span class=${'phone' + (ph.num.length === 10 && !numOk ? ' bad' : '')}><span class="cc">+92</span><input inputmode="numeric" autocomplete="tel-national" placeholder="300 1234567" value=${ph.num} onInput=${e => setPh({ ...ph, num: e.target.value.replace(/\D/g, '').replace(/^92/, '').replace(/^0/, '').slice(0, 10), sent: false, err: '' })} /></span></label>
            ${ph.num.length === 10 && !numOk && html`<div class="hint err">Enter a valid Pakistani mobile number, for example 300 1234567.</div>`}
            ${!ph.sent ? html`<button class="btn btn-primary" style="margin-top:12px" disabled=${!numOk || ph.busy} onClick=${phSend}>${ph.busy ? html`<span class="spin"></span> Sending code` : 'Send code by SMS'}</button>`
              : html`<label class="field"><span class="lbl">6-digit code</span><input class="inp" inputmode="numeric" autocomplete="one-time-code" placeholder=${demo ? 'Demo: any 6 digits' : 'From the SMS'} value=${ph.code} onInput=${e => setPh({ ...ph, code: e.target.value.replace(/\D/g, '').slice(0, 6), err: '' })} /></label>
                <button class="btn btn-primary" style="margin-top:12px" disabled=${ph.code.length !== 6 || ph.busy} onClick=${phCheck}>${ph.busy ? html`<span class="spin"></span> Checking` : 'Verify and update number'}</button>`}
            ${ph.err && html`<div class="hint err" role="alert">${ph.err}</div>`}
          </div>`}
          <label class="field"><span class="lbl">Email (optional)</span><input class=${'inp' + (emailBad ? ' bad' : '')} type="email" autocomplete="email" placeholder="name@example.com" value=${f.email || ''} onInput=${e => setF({ ...f, email: e.target.value })} />
            ${emailBad && html`<div class="hint err">Enter a valid email address, for example name@example.com.</div>`}</label>
          <label class="field"><span class="lbl">Address (optional)</span><textarea class="inp" rows="2" autocomplete="street-address" placeholder="House, street, area, city" value=${f.address || ''} onInput=${e => setF({ ...f, address: e.target.value })}></textarea></label>
        </div>
      </section>
      <div class="pad" style="margin-top:24px"><button class="btn btn-primary" disabled=${!dirty || emailBad || nameBad || cnicBad || dobBad || S.sending} aria-busy=${!!S.sending} onClick=${() => A.saveProfile(f)}>${S.sending ? 'Saving…' : 'Save changes'}</button></div>
    </div>
  </div>`;
}

/* ============================================================
   Wallet
   ============================================================ */
function WalletScreen({ S, A }) {
  const { holdings, reserved, walletValue: wv } = S;
  const held = PRODUCTS.filter(p => holdings[p.id] > 0);
  const history = useMemo(() => [...S.ledger].reverse(), [S.ledger]);
  const [shown, moreRows] = useGrowing(history);
  const pending = S.orders.filter(o => o.status === 'flagged');
  return html`<div class="scroll">
    <${TabHead} title="Wallet" sub="Every bar is backed one-to-one by metal PGBX holds" />
    ${LIVE && S.missing && S.missing.length > 0 && html`<div class="pad" style="margin-top:12px"><${Notice} kind="warning" title="Some of your account didn’t load">What’s shown may be incomplete. <button class="linkbtn sm" onClick=${A.sync}>Try again</button></${Notice}></div>`}
    <div class="brand-card on-dark" style="margin-top:16px">
      <div class="bc-label">Value at today’s sell price</div>
      <div class="bc-value"><${Odo} value=${wv.total} flash=${S.rates.tick} /></div>
      <div class="bc-split">
        <div><span class="bc-label">Gold</span><b>${fmtW(wv.goldG)}</b><small>${fmt(wv.gold)}</small></div>
        <div><span class="bc-label">Silver</span><b>${(wv.silverG / TOLA).toFixed(2)} tola</b><small>${fmt(wv.silver)}</small></div>
      </div>
    </div>
    <div class="qa">
      <button onClick=${() => A.tab('buy')}><${Icon} n="plus"/>Buy</button>
      <button onClick=${() => A.push({ name: 'collect' })}><${Icon} n="store"/>Collect</button>
      <button onClick=${() => A.push({ name: 'statement' })}><${Icon} n="doc"/>Statement</button>
    </div>

    ${pending.length > 0 && html`<section class="sec"><div class="sec-h"><h3>Being completed</h3></div>
      ${pending.map(o => html`<div class="card" style="margin-bottom:8px">
        <div class="between" style="align-items:flex-start"><b>${linesText(o.lines)}</b><span class="tag warning">With operations</span></div>
        <div class="small muted" style="margin-top:4px">Paid ${fmt(o.total)} · ${rel(o.ts, S.now)} · <span class="mono">${o.receipt}</span></div>
        <div class="small muted" style="margin-top:4px">This appears in your holdings once PGBX completes the order.</div>
      </div>`)}
      <${Demo} title="Operations" body="In the real system PGBX operations completes flagged orders.">
        ${pending.map(o => html`<button class="btn btn-secondary btn-sm" style="width:100%;margin-top:4px" onClick=${() => A.resolveOrder(o.id)}>Complete order ${o.receipt.slice(-6)}</button>`)}
      </${Demo}>
    </section>`}

    ${(S.micro.grams > 0 || S.micro.txns.length > 0) && html`<section class="sec"><div class="group"><button class="row" onClick=${() => A.openMicro()}>
      <span class="ri gold"><${Icon} n="gem" c="sm"/></span>
      <div class="rt"><b>$1 gold</b><span>${fmtG(S.micro.grams)} · in pooled 1-tola bars</span></div>
      <div class="rv"><b>${fmt(wv.micro)}</b><${Icon} n="chev" c="sm chev"/></div></button></div></section>`}
    <section class="sec">
      <div class="sec-h"><h3>Holdings</h3>${held.length > 0 && (n => html`<span class="aside">${n} bar${n === 1 ? '' : 's'}</span>`)(held.reduce((a, p) => a + holdings[p.id], 0))}</div>
      ${held.length === 0 ? html`<${Empty} icon="wallet" title="No holdings yet" body="Bars you buy appear here, backed by metal PGBX holds for you." action="Buy your first bar" onAction=${() => A.tab('buy')} />` :
        html`<div class="group inset-thumb">${held.map(p => html`<div class="row">
          <${Thumb} p=${p} />
          <div class="rt"><b>${holdings[p.id]} × ${pname(p)}</b><span>${fmtW(p.grams * holdings[p.id])}${reserved[p.id] ? html` · <span style="color:var(--gold-700)">${reserved[p.id]} reserved for collection</span>` : ''}</span></div>
          <div class="rv"><b>${fmt(holdings[p.id] * p.grams * rateOf(S.rates, p.metal).sellGram)}</b></div>
        </div>`)}</div>`}
    </section>

    <section class="sec">
      <div class="group"><button class="row" onClick=${() => A.push({ name: 'sell-bars' })}>
        <span class="ri"><${Icon} n="refresh" c="sm"/></span>
        <div class="rt"><b>Sell bars back to PGBX</b><span>At a rate PGBX support confirms in chat</span></div><${Icon} n="chev" c="sm chev"/>
      </button>
      ${(S.barSales || []).slice(0, 5).map(b => html`<div class="row">
        <span class="ri gold"><${Icon} n="bank" c="sm"/></span>
        <div class="rt"><b>Sold ${b.lines.map(l => `${l.units} × ${P[l.pid] ? pname(P[l.pid]) : l.pid}`).join(', ')}</b><span>${fmt(b.total)} · ${rel(b.ts, S.now)} · <span class="mono">${b.ref}</span></span></div>
        <span class=${'tag ' + (b.status === 'paid_out' ? 'success' : 'warning')}>${b.status === 'paid_out' ? 'Paid' : 'Payment on its way'}</span></div>`)}</div>
    </section>

    <section class="sec">
      <div class="sec-h"><h3>Activity</h3></div>
      ${!history.length && html`<p class="foot" style="margin-top:0">Purchases and collections appear here.</p>`}
      <${Keep} deps=${[shown, minuteOf(S.now)]} render=${() => html`<div class="group inset">
        ${shown.map(e => { const p = P[e.pid]; const kind = e.reason === 'purchase' ? 'plus' : e.reason === 'redemption' || e.reason === 'sale' ? 'minus' : 'open';
          const title = kind === 'plus' ? 'Bought' : e.reason === 'sale' ? 'Sold to PGBX' : kind === 'minus' ? 'Collected' : 'Opening balance';
          return html`<div class="row" style="align-items:flex-start">
            <span class=${'ri' + (kind === 'minus' ? ' gold' : '')}><${Icon} n=${kind === 'minus' ? 'store' : kind === 'plus' ? 'buy' : 'box'} c="sm"/></span>
            <div class="rt"><b>${title} ${Math.abs(e.delta)} × ${pname(p)}</b>
              <span>${rel(e.ts, S.now)}${e.dealer ? ' · ' + e.dealer : ''}${e.price ? ' · ' + fmt(e.price) + ' each' : ''}</span>
              <span class="mono" style="font-size:12px">${e.ref}${e.reason === 'opening' ? ' · sample' : ''}</span>
              ${e.serials && html`<span>Serial ${e.serials.join(', ')}</span>`}</div>
            <b class=${e.delta > 0 ? 'up' : ''} style="font-size:15px;white-space:nowrap">${e.delta > 0 ? '+' : '−'}${Math.abs(e.delta)}</b>
          </div>`; })}
      </div>`} />${moreRows}
    </section>
    <p class="foot">Your balance is calculated from this activity record, which can’t be edited.</p>
  </div>`;
}

/* ---------- FR-W4 statement for a chosen period ---------- */
function holdingsAt(ledger, untilTs) { const h = {}; ledger.forEach(e => { if (e.ts < untilTs) h[e.pid] = (h[e.pid] || 0) + e.delta; }); return h; }
const holdText = h => PRODUCTS.filter(p => h[p.id] > 0).map(p => `${h[p.id]} × ${pname(p)}`).join(', ') || 'None';
function statementData(S, from, to) {
  const a = Date.parse(from + 'T00:00:00'), b = Date.parse(to + 'T23:59:59.999');
  return { a, b, opening: holdingsAt(S.ledger, a), closing: holdingsAt(S.ledger, b + 1), entries: S.ledger.filter(e => e.ts >= a && e.ts <= b),
    // $1 gold: paid purchases and sales in the period, and today's balance (it counts towards the wallet total)
    micro: ((S.micro && S.micro.txns) || []).filter(t => t.ts >= a && t.ts <= b && ['credited', 'pending_payout', 'paid_out'].includes(t.status)).sort((x, y) => x.ts - y.ts),
    microGrams: (S.micro && S.micro.grams) || 0 };
}
const microType = t => (t.side === 'buy' ? '$1 gold purchase' : '$1 gold sale');
const entryType = e => (e.reason === 'purchase' ? 'Purchase' : e.reason === 'redemption' ? 'Redemption' : e.reason === 'sale' ? 'Sold to PGBX' : 'Opening balance (sample)');
function downloadBlob(name, type, text) {
  const url = URL.createObjectURL(new Blob([text], { type }));
  const a = document.createElement('a'); a.href = url; a.download = name; document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 4000);
}
// Saves a file the customer can keep: the phone's share sheet in the native app (Files, Drive, email...), a download
// in a browser. Answers how it went: 'shared', 'downloaded', 'cancelled' or 'failed'.
async function saveText(name, type, text) {
  const nat = window.PGBXNative;
  if (nat && nat.saveFile) { try { return (await nat.saveFile(name, type, text)) ? 'shared' : 'cancelled'; } catch (e) { return 'failed'; } }
  if (Live.NATIVE) {
    try { const f = new File([text], name, { type }); if (navigator.canShare && navigator.canShare({ files: [f] })) { await navigator.share({ files: [f], title: name }); return 'shared'; } }
    catch (e) { return e && e.name === 'AbortError' ? 'cancelled' : 'failed'; }
    return 'failed';
  }
  downloadBlob(name, type, text); return 'downloaded';
}
function statementHtml(S, d, from, to) {
  const esc = x => String(x).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  const rows = d.entries.map(e => `<tr><td>${esc(dt(e.ts))}</td><td>${esc(entryType(e))}</td><td>${esc(pname(P[e.pid]))}</td><td style="text-align:right">${e.delta > 0 ? '+' : '−'}${Math.abs(e.delta)}</td><td style="text-align:right">${e.price ? esc(fmt(e.price)) : ''}</td><td>${esc(e.ref)}</td></tr>`).join('') || '<tr><td colspan="6">No activity in this period.</td></tr>';
  return `<!doctype html><html><head><meta charset="utf-8"><title>PGBX statement ${from} to ${to}</title>
<style>body{font:13px/1.5 -apple-system,BlinkMacSystemFont,system-ui,'Segoe UI',Roboto,Arial,sans-serif;color:#1D2B22;margin:32px}h1{font-family:ui-serif,'New York',Georgia,serif;color:#0B4A2C;margin:0}table{width:100%;border-collapse:collapse;margin-top:12px}th,td{padding:7px 8px;border-bottom:1px solid #ddd;text-align:left}th{background:#0B4A2C;color:#fff;font-size:11px;text-transform:uppercase}.m{color:#5F6D64}.box{border:1px solid #C8962B;border-radius:8px;padding:10px 12px;margin-top:12px}</style></head>
<body><h1>PGBX wallet statement</h1><div class="m">Pakistan Gold Bullion Exchange · Shariah compliant · Office 1211, 12th Floor, Gold Tower, Saddar, Karachi</div>
<div class="box"><b>${esc(S.profile.name)}</b> · CNIC ${esc(maskCnic(S.profile.cnic) || 'not verified')} · ${S.phone ? '+92 ' + esc(S.phone) : ''}<br>Period: ${from} to ${to} · Generated ${esc(dt(Date.now()))}</div>
<p><b>Opening holdings:</b> ${esc(holdText(d.opening))}<br><b>Closing holdings:</b> ${esc(holdText(d.closing))}</p>
<table><tr><th>Date</th><th>Type</th><th>Product</th><th>Units</th><th>Price / unit</th><th>Receipt / reference</th></tr>${rows}</table>
<h2 style="font-size:15px;margin-top:24px;color:#0B4A2C">$1 gold</h2><p><b>Balance today:</b> ${esc(fmtG(d.microGrams))} of 24K gold, pooled in 1-tola bars</p>
<table><tr><th>Date</th><th>Type</th><th>Grams</th><th>Price / gram</th><th>Amount</th><th>Transaction ID</th></tr>${d.micro.map(t => `<tr><td>${esc(dt(t.ts))}</td><td>${esc(microType(t))}</td><td style="text-align:right">${t.side === 'buy' ? '+' : '−'}${esc(fmtG(t.grams))}</td><td style="text-align:right">${esc(fmt(t.price))}</td><td style="text-align:right">${esc(fmt(t.amount))}</td><td>${esc(t.ref)}</td></tr>`).join('') || '<tr><td colspan="6">No $1 gold activity in this period.</td></tr>'}</table>
<p class="m">Holdings are calculated from your wallet activity record. Tax and legal details: [To be confirmed by PGBX].${LIVE ? '' : ' Prototype statement with sample data.'}</p></body></html>`;
}
const SAVED_MSG = { shared: w => `Statement ready to save as ${w}`, downloaded: w => `Statement downloaded as ${w}`, cancelled: () => 'Not saved', failed: () => 'This phone couldn’t save the statement. Try again, or contact PGBX for a copy.' };
function StatementScreen({ S, A }) {
  const today = isoDay(S.now);
  const PRESETS = { month: [isoDay(new Date(new Date().getFullYear(), new Date().getMonth(), 1)), today], d30: [isoDay(S.now - 29 * 86400e3), today], d90: [isoDay(S.now - 89 * 86400e3), today] };
  const [preset, setPreset] = useState('d30');
  const [from, setFrom] = useState(PRESETS.d30[0]); const [to, setTo] = useState(today);
  const pick = k => { setPreset(k); if (PRESETS[k]) { setFrom(PRESETS[k][0]); setTo(PRESETS[k][1]); } };
  const bad = !from || !to || from > to;
  const d = bad ? null : statementData(S, from, to);
  const csv = () => {
    const q = v => `"${String(v).replace(/"/g, '""')}"`;
    const lines = [['Date', 'Type', 'Product', 'Units', 'Price per unit (PKR)', 'Receipt / reference'].map(q).join(','),
      ...d.entries.map(e => [new Date(e.ts).toISOString(), entryType(e), pname(P[e.pid]), e.delta, e.price || '', e.ref].map(q).join(',')),
      ...d.micro.map(t => [new Date(t.ts).toISOString(), microType(t), '24K gold, grams (pooled)', (t.side === 'buy' ? 1 : -1) * t.grams, t.price, t.ref].map(q).join(','))];
    saveText(`PGBX-statement-${from}-to-${to}.csv`, 'text/csv', lines.join('\n')).then(r => A.toast(SAVED_MSG[r]('CSV')));
  };
  const pdf = () => {
    const h = statementHtml(S, d, from, to);
    if (Live.NATIVE) { saveText(`PGBX-statement-${from}-to-${to}.html`, 'text/html', h).then(r => A.toast(SAVED_MSG[r]('printable statement'))); return; }
    const url = URL.createObjectURL(new Blob([h], { type: 'text/html' }));
    const w = window.open(url, '_blank');
    setTimeout(() => URL.revokeObjectURL(url), 60000);                // the new tab has loaded it by then
    if (w) w.addEventListener('load', () => setTimeout(() => w.print(), 300));
    if (!w) { downloadBlob(`PGBX-statement-${from}-to-${to}.html`, 'text/html', h); A.toast('Statement downloaded. Open it and print to PDF.'); }
  };
  return html`<div class="page">
    <${TopBar} title="Statement" onBack=${A.back} />
    <div class="scroll">
      <div class="pad">
        <div class="chips" role="radiogroup" aria-label="Period">${[['month', 'This month'], ['d30', 'Last 30 days'], ['d90', 'Last 3 months'], ['custom', 'Custom']].map(([k, l]) => html`<button class=${'chipb' + (preset === k ? ' on' : '')} role="radio" aria-checked=${preset === k} onClick=${() => pick(k)}>${l}</button>`)}</div>
        <div class="grid2">
          <label class="field"><span class="lbl">From</span><input class=${'inp' + (bad ? ' bad' : '')} type="date" max=${today} value=${from} onInput=${e => { setPreset('custom'); setFrom(e.target.value); }} /></label>
          <label class="field"><span class="lbl">To</span><input class=${'inp' + (bad ? ' bad' : '')} type="date" max=${today} value=${to} onInput=${e => { setPreset('custom'); setTo(e.target.value); }} /></label>
        </div>
        ${bad && html`<div class="hint err">The start date must be on or before the end date.</div>`}
      </div>
      ${d && html`<div class="card" style="margin-top:16px">
        <div class="kv"><span>Transactions</span><b>${d.entries.length}</b></div>
        ${d.entries.length === 0 && html`<div class="hint" style="margin:0 0 4px">No activity in this period. Choose a longer period to include more.</div>`}
        <div class="kv"><span>Opening holdings</span><b style="max-width:60%">${holdText(d.opening)}</b></div>
        <div class="kv"><span>Closing holdings</span><b style="max-width:60%">${holdText(d.closing)}</b></div>
        ${(d.micro.length > 0 || d.microGrams > 0) && html`<div class="kv"><span>$1 gold</span><b style="max-width:60%">${d.micro.length} transaction${d.micro.length === 1 ? '' : 's'} · ${fmtG(d.microGrams)} today</b></div>`}
      </div>
      <div class="pad stack-btns" style="margin-top:24px">
        <button class="btn btn-primary" onClick=${pdf}><${Icon} n="doc" c="sm"/> Save as PDF</button>
        <button class="btn btn-secondary" onClick=${csv}><${Icon} n="download" c="sm"/> Download CSV</button>
      </div>`}
      <p class="foot">Save as PDF opens a printable statement. Choose “Save as PDF” in the print dialog. ${!LIVE && html`Tax and legal details on statements: <${Tbc}/>`}</p>
    </div>
  </div>`;
}

/* ============================================================
   Redeem (FR-D1 map, phone, distance)
   ============================================================ */
const MAPBOX = { minLat: 24.795, maxLat: 24.95, minLng: 66.985, maxLng: 67.115, W: 340, H: 190 };
const proj = (lat, lng) => [(lng - MAPBOX.minLng) / (MAPBOX.maxLng - MAPBOX.minLng) * MAPBOX.W, (1 - (lat - MAPBOX.minLat) / (MAPBOX.maxLat - MAPBOX.minLat)) * MAPBOX.H];
function DealerMap({ selected, isOk, onSelect }) {
  const [yx, yy] = proj(YOU.lat, YOU.lng);
  return html`<div class="map">
    <svg viewBox=${`0 0 ${MAPBOX.W} ${MAPBOX.H}`} role="img" aria-label="Map of nearby dealers">
      <path d="M0 140 C40 150 70 165 95 176 S150 190 175 190 L0 190 Z" fill="#C4DCE5"/>
      <ellipse cx="250" cy="70" rx="34" ry="18" fill="#D7E6CF"/><ellipse cx="120" cy="120" rx="22" ry="12" fill="#D7E6CF"/>
      ${['M0 95 C80 90 160 98 340 80', 'M60 0 C80 60 100 120 120 190', 'M150 190 C170 120 210 60 260 0', 'M0 40 C120 52 220 46 340 30', 'M200 190 C230 150 280 130 340 128'].map(dd => html`<path d=${dd} fill="none" stroke="#fff" stroke-width="5" stroke-linecap="round"/>`)}
      <g transform=${`translate(${yx} ${yy})`}><circle r="9" fill="rgba(31,120,200,.2)"/><circle r="5" fill="#1F78C8" stroke="#fff" stroke-width="2"/></g>
      ${DEALERS.map(d => { const [x, y] = proj(d.lat, d.lng); const ok = isOk(d); return html`<g class=${'pin' + (selected === d.id ? ' on' : '') + (ok ? '' : ' off')} transform=${`translate(${x} ${y})`} onClick=${() => ok && onSelect(d.id)}>
        <g class="pg"><path d="M0 0 C-9 -12 -9 -24 0 -24 S9 -12 0 0Z" fill=${selected === d.id ? '#C8962B' : '#0B4A2C'} stroke="#fff" stroke-width="1.5"/><circle cy="-15" r="3.2" fill="#fff"/></g>
        <text y="12" text-anchor="middle" font-size="9" font-weight="600" fill="#17241C" font-family="-apple-system, system-ui, 'Segoe UI', Roboto, sans-serif">${d.name.split(' ')[0]}</text></g>`; })}
    </svg>
    <span class="cap">Schematic · sample dealers</span>
  </div>`;
}
const DealerActions = ({ d }) => html`<div class="dact" onClick=${e => e.stopPropagation()}>
  ${d.phone && html`<a class="btn btn-secondary btn-sm" href=${'tel:' + String(d.phone).replace(/[^\d+]/g, '')}><${Icon} n="call" c="sm"/> Call</a>`}
  <a class="btn btn-secondary btn-sm" href=${Number.isFinite(d.lat) && Number.isFinite(d.lng) ? `https://www.google.com/maps/search/?api=1&query=${d.lat},${d.lng}` : `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent((d.name || '') + ' ' + (d.address || d.area || ''))}`} target="_blank" rel="noopener"><${Icon} n="nav" c="sm"/> Directions</a>
</div>`;

function RedeemScreen({ S, A, pushed }) {
  const avail = id => (S.holdings[id] || 0) - (S.reserved[id] || 0);
  const held = PRODUCTS.filter(p => avail(p.id) > 0);
  const [pid, setPid] = useState(held[0] ? held[0].id : null);
  const [units, setUnits] = useState(1);
  const [did, setDid] = useState(null);
  useEffect(() => { if (pid && avail(pid) <= 0) setPid(held[0] ? held[0].id : null); }, [S.holdings, S.reserved]);
  useEffect(() => { setUnits(1); if (did && pid && S.dealerFree(did, pid) <= 0) setDid(null); }, [pid]);
  const active = S.redemptions.filter(r => ['requested', 'ready'].includes(S.statusOf(r)));
  const past = S.redemptions.filter(r => !['requested', 'ready'].includes(S.statusOf(r)));
  const canConfirm = pid && did && units >= 1 && units <= avail(pid) && S.dealerFree(did, pid) >= units;
  const dealerOk = d => S.dealerFree(d.id, pid) >= units;
  // Production: no sample location, so dealers are listed by area until PGBX chooses a map provider
  const sorted = [...DEALERS].sort((a, b) => (LIVE ? (a.area + a.name).localeCompare(b.area + b.name) : a.km - b.km));
  const pickDealer = id => setDid(id);
  const body = html`
    ${!pushed && html`<${TabHead} title="Collect" sub="Collect your bars at a PGBX dealer" />`}
    ${pushed && html`<div class="pad"><p class="muted">Swap your holdings for the physical bar at a PGBX dealer.</p></div>`}
    ${active.length > 0 && html`<section class="sec"><div class="sec-h"><h3>Ready to collect</h3></div>
      <div class="group inset-thumb">${active.map(r => html`<${RedemptionRow} r=${r} S=${S} A=${A}/>`)}</div></section>`}

    ${held.length === 0 ? html`<section class="sec"><${Empty} icon="store" title="Nothing to collect yet" body=${S.ledger.length ? 'All your bars are already reserved for collection.' : `Buy a bar first. You can then collect it at any of ${LIVE ? 'the PGBX dealers' : 'the 250 PGBX dealers'}.`} action=${S.ledger.length ? null : 'Buy a bar'} onAction=${() => A.tab('buy')} /></section>` : html`
    <section class="sec">
      <div class="sec-h"><h3>What to collect</h3></div>
      <div class="group inset-thumb" role="radiogroup" aria-label="Product to collect">
        ${held.map(p => html`<button class="row" onClick=${() => setPid(p.id)} role="radio" aria-checked=${pid === p.id}>
          <${Thumb} p=${p} />
          <div class="rt"><b>${pname(p)}</b><span>${avail(p.id)} available${S.reserved[p.id] ? ` · ${S.reserved[p.id]} reserved` : ''}</span></div>
          <${Radio} on=${pid === p.id} />
        </button>`)}
      </div>
      <div class="group" style="margin-top:8px"><div class="row">
        <div class="rt"><b>Quantity</b></div>
        <div class="stepper" role="group" aria-label="Quantity to collect">
          <button disabled=${units <= 1} onClick=${() => setUnits(u => u - 1)} aria-label="Decrease quantity"><${Icon} n="minus" c="sm"/></button>
          <output aria-live="polite"><span key=${units}>${units}</span></output>
          <button disabled=${!pid || units >= avail(pid)} onClick=${() => setUnits(u => u + 1)} aria-label="Increase quantity"><${Icon} n="plus" c="sm"/></button>
        </div>
      </div></div>
    </section>

    <section class="sec">
      <div class="sec-h"><h3>Where</h3><span class="aside">${LIVE ? 'By area' : 'Nearest first'}</span></div>
      ${!LIVE && html`<${DealerMap} selected=${did} isOk=${dealerOk} onSelect=${pickDealer} />`}
      ${LIVE && !sorted.length && (S.dealersFailed ? html`<${Notice} kind="warning" title="Dealers didn’t load">Check your connection. <button class="linkbtn sm" onClick=${A.reloadPublic}>Try again</button></${Notice}>`
        : html`<div class="group"><div class="row"><span class="sk" style="width:180px;height:16px"></span></div></div>`)}
      <div class="group inset" role="radiogroup" aria-label="Dealer">
        ${sorted.map(d => { const ok = dealerOk(d); const on = did === d.id;
          return html`<div class=${'row' + (ok ? '' : ' off')} style="align-items:flex-start" tabindex=${ok ? 0 : -1} onClick=${() => ok && pickDealer(d.id)} onKeyDown=${e => { if (ok && (e.key === 'Enter' || e.key === ' ')) { e.preventDefault(); pickDealer(d.id); } }} role="radio" aria-checked=${on} aria-disabled=${!ok}>
            <span class=${'ri' + (on ? ' gold' : '')}><${Icon} n="pin" c="sm"/></span>
            <div class="rt"><b>${d.name}</b><span>${LIVE ? d.area : `${d.area} · ${d.km} km`}</span><span>${d.hours ? `Open ${d.hours.replace(' – ', '–')}` : 'Hours not listed'}${ok ? '' : ' · Out of stock'}</span>
              ${on && html`<${DealerActions} d=${d} />`}</div>
            <${Radio} on=${on} />
          </div>`; })}
      </div>
      <p class="foot">${LIVE ? 'Dealers without stock for this product can’t be selected.' : 'Showing 4 sample dealers near a sample location in Saddar. Dealers without stock can’t be selected.'}</p>
    </section>

    <section class="sec">
      <div class="sec-h"><h3>Before you confirm</h3></div>
      <div class="card">
        ${!LIVE && html`<div class="kv"><span>Collection fee</span><${Tbc}/></div>
        <div class="kv"><span>Gold and silver rules</span><${Tbc}/></div>`}
        <div class="kv"><span>Code valid for</span><b>${Math.round(RESERVE_MS / 3600e3)} hours</b></div>
      </div>
      <${Notice} kind="plain" icon="idcard"><b>Bring your original CNIC</b>The dealer checks it against your account. Your code works once, and only at the dealer you choose.</${Notice}>
    </section>
    ${S.offline && html`<${Notice} kind="warning" icon="wifiOff" title="You’re offline">Connect to the internet to reserve a collection.</${Notice}>`}
    <div class="pad" style="margin-top:24px"><button class="btn btn-primary" disabled=${!canConfirm || S.offline || S.paying} aria-busy=${!!S.paying} onClick=${() => A.redeem(pid, units, did)}>${S.paying ? html`<span class="spin"></span> Reserving` : did ? `Reserve ${units} bar${units > 1 ? 's' : ''} for collection` : 'Choose a dealer'}</button></div>
    `}
    ${past.length > 0 && html`<section class="sec"><div class="sec-h"><h3>Past collections</h3></div><div class="group inset-thumb">${past.map(r => html`<${RedemptionRow} r=${r} S=${S} A=${A}/>`)}</div></section>`}`;
  return pushed ? html`<div class="page"><${TopBar} title="Collect your bars" onBack=${A.back} /><div class="scroll">${body}</div></div>` : html`<div class="scroll">${body}</div>`;
}
const STATUS_LABEL = { requested: 'Reserved', ready: 'Ready to collect', completed: 'Collected', cancelled: 'Cancelled', expired: 'Expired' };
const STATUS_TAG = { requested: 'gold', ready: 'success', completed: 'neutral', cancelled: 'neutral', expired: 'neutral' };
function RedemptionRow({ r, S, A }) {
  const p = P[r.pid]; const d = dealerOf(r); const st = S.statusOf(r);
  return html`<button class="row" onClick=${() => A.push({ name: 'code', rid: r.id })}>
    <${Thumb} p=${p} />
    <div class="rt"><b>${r.units} × ${pname(p)}</b><span>${d.name}</span></div>
    <span class=${'tag ' + STATUS_TAG[st]}>${STATUS_LABEL[st]}</span>
  </button>`;
}

function CodeScreen({ S, A, rid }) {
  const r = S.redemptions.find(x => x.id === rid);
  const [idOk, setIdOk] = useState(false);
  if (!r || !P[r.pid] || !dealerOf(r)) return html`<div class="page"><${TopBar} title="Collection" onBack=${A.back} /><div class="scroll"><${Empty} icon="pin" title="Collection not found" body="It may still be loading. Try again in a moment." /></div></div>`;
  const p = P[r.pid]; const d = dealerOf(r);
  const st = S.statusOf(r);
  const order = ['requested', 'ready', 'completed'];
  const idx = order.indexOf(st);
  const live = st === 'requested' || st === 'ready';
  const cancel = () => A.confirm({ title: 'Cancel this collection?', body: `Your ${r.units} × ${pname(p)} will be released back to your wallet and this code will stop working.`, confirm: 'Cancel collection', cancel: 'Keep it', danger: true, onConfirm: () => A.cancelRedemption(r.id) });
  return html`<div class="page">
    <${TopBar} title="Collection" onBack=${A.back} />
    <div class="scroll">
      <div class="card" style="text-align:center;padding:24px 16px">
        <span class=${'tag ' + STATUS_TAG[st]}>${STATUS_LABEL[st]}</span>
        <div class="small muted" style="margin-top:12px">Collection code</div>
        ${r.code ? html`<div class=${'code' + (live ? '' : ' dim')}><span class="sr">${`Code ${r.code.split('').join(' ')}`}</span>${r.code.split('').map(c => html`<span aria-hidden="true">${c}</span>`)}</div>`
          : html`<div class="code dim"><span class="sr">Code no longer valid</span>${'••••••'.split('').map(c => html`<span aria-hidden="true">${c}</span>`)}</div>`}
        <div class="small" style="margin-top:12px;font-weight:600;color:${live ? 'var(--text)' : 'var(--text-2)'}">
          ${live ? `Expires in ${dur(r.expiresAt - S.now)}` : st === 'completed' ? `Collected ${rel(r.completedAt, S.now)}` : st === 'cancelled' ? 'Cancelled. The bars are back in your wallet.' : 'Expired. The bars are back in your wallet.'}
        </div>
        ${st !== 'cancelled' && st !== 'expired' && html`<div class="steps">
          ${order.map((k, i) => html`<div class=${'step' + (i < idx || st === 'completed' ? ' done' : i === idx ? ' cur' : '')}><div class="sd">${i < idx || st === 'completed' ? html`<${Icon} n="check"/>` : i + 1}</div>${STATUS_LABEL[k]}</div>`)}
        </div>`}
      </div>
      <div class="card" style="margin-top:12px">
        <div class="kv"><span>Item</span><b>${r.units} × ${pname(p)}</b></div>
        <div class="kv"><span>Dealer</span><b>${d.name}</b></div>
        <div class="kv"><span>Area</span><b>${d.area}</b></div>
        <div class="kv"><span>Opening hours</span><b>${d.hours}</b></div>
        ${!LIVE && html`<div class="kv"><span>Collection fee</span><${Tbc}/></div>`}
        ${r.serials && html`<div class="kv"><span>Serial number${r.serials.length > 1 ? 's' : ''}</span><b class="mono">${r.serials.join(', ')}</b></div>`}
        <${DealerActions} d=${d} />
      </div>
      ${live && html`<${Notice} kind="plain" icon="idcard">Show this code and your original CNIC at <b style="display:inline">${d.name}</b>. Your bar${r.units > 1 ? 's are' : ' is'} reserved until the code expires.</${Notice}>`}
      ${live && html`<div class="pad" style="margin-top:24px"><button class="btn btn-danger" onClick=${cancel}>Cancel collection</button></div>`}

      <${Demo} title="Dealer steps" body="In the real system the dealer does this in the PGBX dealer app.">
        <div class="stack-btns">
          <button class="btn btn-secondary btn-sm" style="width:100%" disabled=${st !== 'requested'} onClick=${() => A.markReady(r.id)}>Mark ready for collection</button>
          <button class="check" disabled=${st !== 'ready'} onClick=${() => setIdOk(v => !v)} role="checkbox" aria-checked=${idOk}>
            <span class=${'cbox' + (idOk ? ' on' : '')}><${Icon} n="check"/></span> Customer’s CNIC matches the account
          </button>
          <button class="btn btn-secondary btn-sm" style="width:100%" disabled=${st !== 'ready' || !idOk} onClick=${() => A.handOver(r.id)}>Hand over and record serial numbers</button>
        </div>
      </${Demo}>
    </div>
  </div>`;
}

/* ============================================================
   Notifications (FR-N1)
   ============================================================ */
const N_ICON = { purchase: 'buy', redemption: 'store', security: 'shield', account: 'user', alert: 'bell', service: 'gem', chat: 'chat' };
const N_TONE = { purchase: '', redemption: ' gold', security: ' danger', account: '', alert: ' gold', service: ' gold', chat: ' gold' };
function PushBanner({ n, onOpen }) {
  return html`<button class="push" key=${n.id} onClick=${onOpen} role="status">
    <${Coin} size=${32} label="PGBX" />
    <div class="rt"><div class="pt"><span>PGBX</span><span>now</span></div><b>${n.title}</b><div class="small muted">${n.body}</div></div>
  </button>`;
}
function InboxScreen({ S, A }) {
  const [unreadAtOpen] = useState(() => new Set(S.notifications.filter(n => !n.read).map(n => n.id)));
  useEffect(() => { A.markAllRead(); }, []);
  return html`<div class="page">
    <${TopBar} title="Notifications" onBack=${A.back} right=${html`<button class="iconbtn" onClick=${() => A.push({ name: 'notifsettings' })} aria-label="Notification settings"><${Icon} n="sliders"/></button>`} />
    <div class="scroll">
      ${S.notifications.length === 0 ? html`<${Empty} icon="bell" title="No notifications yet" body="Purchases, collections, price alerts and security notices will appear here." />`
        : html`<${Keep} deps=${[S.notifications, minuteOf(S.now), unreadAtOpen]} render=${() => html`<div class="group inset">${S.notifications.map(n => { const inner = html`
          <span class=${'ri' + (N_TONE[n.kind] || '')}><${Icon} n=${N_ICON[n.kind] || 'bell'} c="sm"/></span>
          <div class="rt"><b>${n.title}</b><span>${n.body}</span><span class="tiny" style="margin-top:4px">${rel(n.ts, S.now)}</span></div>
          ${unreadAtOpen.has(n.id) && html`<span class="ldot unread" aria-label="Unread"></span>`}
          ${n.link && html`<${Icon} n="chev" c="sm chev"/>`}`;
          return n.link ? html`<button class="row" style="align-items:flex-start" onClick=${() => ACT.openLink(n.link)}>${inner}</button>` : html`<div class="row" style="align-items:flex-start">${inner}</div>`; })}</div>`} />`}
    </div>
  </div>`;
}
function NotifSettings({ S, A }) {
  const prefs = S.notifPrefs;
  return html`<div class="page">
    <${TopBar} title="Notification settings" onBack=${A.back} />
    <div class="scroll">
      <div class="group inset">
        ${[['push', 'Push notifications', LIVE ? 'On your phones' : 'On this phone', 'bell'], ...(LIVE ? [] : [['sms', 'SMS', 'To your mobile number', 'phone'], ['email', 'Email', S.profile.email || 'Add an email in Personal details', 'mail']])].map(([k, l, d, ic]) => html`<button class="row" onClick=${() => A.setNotif(k, !prefs[k])} role="switch" aria-checked=${prefs[k]}>
          <span class="ri"><${Icon} n=${ic} c="sm"/></span><div class="rt"><b>${l}</b><span>${d}</span></div><${Switch} on=${prefs[k]} /></button>`)}
      </div>
      <p class="foot">${LIVE ? 'Notifications always appear in the app’s inbox. Security notices are always sent to your phone.' : 'Where we send notifications, besides the app.'}</p>
      <section class="sec"><div class="sec-h"><h3>What we notify you about</h3></div>
        <div class="group">
          <button class="row" onClick=${() => A.setNotif('alerts', prefs.alerts === false)} role="switch" aria-checked=${prefs.alerts !== false}>
            <div class="rt"><b>Price alerts</b><span>When a price reaches a target you set</span></div><${Switch} on=${prefs.alerts !== false} /></button>
          <div class="row"><div class="rt"><b>Purchases and collections</b><span>Receipts, collection codes and dealer updates. Always on, because they’re about your money and metal.</span></div><span class="tag neutral">Always on</span></div>
          <div class="row"><div class="rt"><b>Security</b><span>New logins, PIN and number changes. Always on to protect your account.</span></div><span class="tag neutral">Always on</span></div>
        </div>
        <p class="foot">PGBX doesn’t send marketing messages from this app.</p>
      </section>
    </div>
  </div>`;
}

/* ============================================================
   Account
   ============================================================ */
const KYC_LABEL = { verified: 'Verified', none: 'Not verified', pending: 'Checking', reverify: 'Verify again', failed: 'Try again' };
const KYC_TAG = { verified: 'success', none: 'warning', pending: 'neutral', reverify: 'warning', failed: 'danger' };
function AccountScreen({ S, A }) {
  const masked = S.phone ? `+92 ${S.phone.slice(0, 3)} ••• ${S.phone.slice(-4)}` : '+92 3•• ••• 4521';
  const initials = S.profile.name.split(' ').filter(Boolean).slice(0, 2).map(w => w[0].toUpperCase()).join('');
  const activeAlerts = S.alerts.filter(a => a.active).length;
  // Plain function (not a component defined in render) so rows keep their identity across the app's 1 s re-renders
  const R = ({ icon, label, value, go, tone }) => html`<button class="row" onClick=${go}><span class=${'ri' + (tone ? ' ' + tone : '')}><${Icon} n=${icon} c="sm"/></span><div class="rt"><b>${label}</b></div><span class="rv">${value || ''}<${Icon} n="chev" c="sm chev"/></span></button>`;
  const info = kind => () => A.push({ name: 'info', kind });
  const logout = () => A.confirm({ title: 'Log out of PGBX?', body: 'You’ll need your mobile number and a one-time code to log in again. Your holdings stay safe.', confirm: 'Log out', danger: true, onConfirm: A.logout });
  return html`<div class="scroll">
    <${TabHead} title="Account" />
    <button class="profile-card" onClick=${() => A.push({ name: 'profile' })}>
      <span class="avatar" aria-hidden="true">${initials}</span>
      <div class="rt"><b style="font-size:17px">${S.profile.name}</b><span>${masked}</span></div>
      <${Icon} n="chev" c="sm chev"/>
    </button>

    <section class="sec"><div class="sec-h"><h3>Profile</h3></div>
      <div class="group inset">
        ${R({ icon: 'user', label: 'Personal details', go: () => A.push({ name: 'profile' }) })}
        ${R({ icon: 'idcard', label: 'Identity verification', value: html`<span class=${'tag ' + KYC_TAG[S.kyc.status]}>${KYC_LABEL[S.kyc.status]}</span>`, go: () => S.kyc.status === 'verified' ? A.toast(`Verified${S.kyc.at ? ' ' + rel(S.kyc.at, S.now).toLowerCase() : ''} · CNIC ${maskCnic(S.profile.cnic)}`) : A.push({ name: 'kyc' }) })}
      </div></section>

    <section class="sec"><div class="sec-h"><h3>Security</h3></div>
      <div class="group inset">
        ${R({ icon: 'key', label: 'Change PIN', go: () => A.push({ name: 'changepin' }) })}
        ${(!LIVE || (window.PGBXNative && window.PGBXNative.biometric && window.PGBXNative.biometric.ready)) && html`<button class="row" onClick=${() => A.setBio(!S.biometric)} role="switch" aria-checked=${S.biometric}>
          <span class="ri"><${Icon} n="face" c="sm"/></span><div class="rt"><b>Unlock with ${bioName()}</b></div><${Switch} on=${S.biometric} /></button>`}
        <div class="row"><span class="ri"><${Icon} n="clock" c="sm"/></span><div class="rt"><b>Auto-lock</b><span>After 2 minutes without activity</span></div></div>
      </div></section>

    <section class="sec"><div class="sec-h"><h3>Preferences</h3></div>
      <div class="group inset">
        ${R({ icon: 'bell', label: 'Notifications', value: S.unread ? `${S.unread} new` : '', go: () => A.push({ name: 'inbox' }) })}
        ${R({ icon: 'chat', label: 'Rate chats with PGBX', value: (n => (n ? `${n} new` : ''))((S.chats || []).reduce((t, c) => t + (c.unread || 0), 0)), go: () => A.push({ name: 'chats' }) })}
        ${R({ icon: 'chart', label: 'Price alerts', value: activeAlerts ? `${activeAlerts} active` : '', go: () => A.openHistory('gold') })}
      </div></section>

    <section class="sec"><div class="sec-h"><h3>Help</h3></div>
      <div class="group inset">
        ${R({ icon: 'help', label: 'Questions and answers', go: info('faq') })}
        ${R({ icon: 'call', label: 'Contact PGBX', go: info('contact') })}
        ${R({ icon: 'flag', label: 'Report a problem', go: info('report') })}
      </div></section>

    <section class="sec"><div class="sec-h"><h3>Legal</h3></div>
      <div class="group inset">
        ${R({ icon: 'receipt', label: 'Fees and limits', go: info('fees') })}
        ${R({ icon: 'doc', label: 'Terms and privacy', go: info('terms') })}
        ${R({ icon: 'info', label: LIVE ? 'About PGBX' : 'About this prototype', value: APP_VERSION.split(' ')[0], go: info('about') })}
      </div></section>

    <section class="sec"><div class="sec-h"><h3>Your data</h3></div>
      <div class="group inset">
        ${R({ icon: 'download', label: 'Download your statement', go: () => A.push({ name: 'statement' }) })}
        ${R({ icon: 'x', label: 'Close account', tone: 'danger', go: () => A.push({ name: 'closeaccount' }) })}
      </div></section>

    <div class="pad stack-btns" style="margin-top:32px">
      <button class="btn btn-secondary" onClick=${A.lockNow}><${Icon} n="lock" c="sm"/> Lock app</button>
      <button class="btn btn-tertiary" style="color:var(--danger)" onClick=${logout}>Log out</button>
    </div>
    <p class="foot" style="text-align:center">PGBX ${APP_VERSION}</p>
  </div>`;
}

// Closing an account: easy to find, clear about consequences, and guided when something must happen first.
function CloseAccount({ S, A }) {
  const bars = PRODUCTS.reduce((a, p) => a + (S.holdings[p.id] || 0), 0);
  const active = S.redemptions.filter(r => ['requested', 'ready'].includes(S.statusOf(r))).length;
  const pending = S.orders.filter(o => o.status === 'flagged').length;
  const services = S.appraisals.filter(a => ['booked', 'confirmed'].includes(a.status)).length + S.giftOrders.filter(g => ['placed', 'in_production', 'dispatched'].includes(g.status)).length;
  const blockers = [
    LIVE && (!S.synced || (S.missing && S.missing.length > 0)) && { t: 'Your account hasn’t fully loaded', d: 'We need your latest holdings and orders before the account can be closed.', act: 'Try again', go: A.sync },
    bars > 0 && { t: `You still hold ${bars} bar${bars > 1 ? 's' : ''} worth ${fmt(S.walletValue.total - S.walletValue.micro)}`, d: 'Collect them at a dealer, or sell them back to PGBX from your wallet.', act: 'Go to wallet', go: () => A.tab('wallet') },
    active > 0 && { t: `${active} collection${active > 1 ? 's are' : ' is'} still open`, d: 'Collect or cancel them first.', act: 'View collections', go: () => A.push({ name: 'collect' }) },
    services > 0 && { t: `${services} service booking${services > 1 ? 's are' : ' is'} still open`, d: 'Wait until your appraisal visit or gift delivery is done, or cancel it.', act: 'View services', go: () => A.tab('services') },
    pending > 0 && { t: `${pending} order${pending > 1 ? 's are' : ' is'} still being completed`, d: 'Wait until PGBX operations completes it.', act: 'View wallet', go: () => A.tab('wallet') },
    S.micro.grams > 0 && { t: `You still have ${fmtG(S.micro.grams)} of $1 gold`, d: 'Sell it first; PGBX pays it to your bank.', act: 'Sell gold', go: () => A.push({ name: 'micro-sell' }) },
    S.micro.txns.some(t => t.status === 'pending_payout') && { t: 'A payment for gold you sold is still on its way', d: 'Wait until PGBX has paid it to your bank.', act: 'View $1 gold', go: () => A.openMicro() },
  ].filter(Boolean);
  const close = () => A.confirm({ title: 'Close your PGBX account?', body: 'You won’t be able to log in or buy with this account again. Your personal details are removed from this phone. This can’t be undone.', confirm: 'Close account', cancel: 'Keep my account', danger: true, onConfirm: A.closeAccount });
  return html`<div class="page">
    <${TopBar} title="Close account" onBack=${A.back} />
    <div class="scroll">
      <div class="pad"><p class="muted">We’re sorry to see you go. Here’s what closing your account means.</p></div>
      ${blockers.length > 0 && html`<section class="sec"><div class="sec-h"><h3>Before you can close it</h3></div>
        <div class="group">${blockers.map(b => html`<div class="row" style="align-items:flex-start"><span class="ri gold"><${Icon} n="alert" c="sm"/></span>
          <div class="rt"><b>${b.t}</b><span>${b.d}</span>
            <button class="btn btn-secondary btn-sm" style="margin-top:8px" onClick=${b.go}>${b.act}</button></div></div>`)}</div></section>`}
      <section class="sec"><div class="sec-h"><h3>What happens</h3></div>
        <div class="card prose" style="padding:16px">
          <ul style="margin:0"><li>You can’t log in, buy or collect with this account again.</li>
          <li>Your PIN, saved details and settings are removed from this phone.</li>
          <li>PGBX keeps transaction records for as long as the law requires${LIVE ? '.' : html`: <${Tbc}/>`}</li>
          <li>You can download your statement first from Account › Your data.</li></ul>
        </div></section>
      <div class="pad" style="margin-top:24px">
        <button class="btn btn-danger" disabled=${blockers.length > 0} onClick=${close}>Close account</button>
        ${blockers.length > 0 && html`<p class="hint" style="text-align:center">Available once the items above are done.</p>`}
      </div>
    </div>
  </div>`;
}

function ChangePin({ S, A }) {
  const steps = ['Enter your current PIN', 'Choose a new PIN', 'Enter the new PIN again'];
  const [step, setStep] = useState(0);
  const [first, setFirst] = useState('');
  const [ok, setOk] = useState(false);
  const [err, setErr] = useState(0);
  const [msg, setMsg] = useState('');
  const [cur, setCur] = useState('');
  const paused = !LIVE && step === 0 && S.pinLockUntil > S.now;
  const timer = useRef(null); useEffect(() => () => clearTimeout(timer.current), []);
  const finish = () => { setOk(true); timer.current = setTimeout(() => A.back(), 600); return true; };
  const done = p => {
    // Production: the server checks the current PIN when the new one is saved (wrong ones count towards the limit)
    if (step === 0) {
      if (!LIVE && !pinOk(p, S.pin)) { setErr(e => e + 1); setMsg('That isn’t your current PIN.'); A.pinWrong(); return false; }
      setCur(p); setMsg(''); setStep(1); return false;
    }
    if (step === 1) {
      if (p === cur) { setErr(e => e + 1); setMsg('Choose a PIN that’s different from your current one.'); return false; }
      if (WEAK_PINS.has(p)) { setErr(e => e + 1); setMsg('That PIN is easy to guess. Choose a different one.'); return false; }
      setFirst(p); setMsg(''); setStep(2); return false;
    }
    if (p !== first) { setErr(e => e + 1); setMsg('The PINs didn’t match. Choose your new PIN again.'); setStep(1); return false; }
    if (!LIVE) { A.setPin(p); return finish(); }
    return A.setPin(p, cur).then(r => {
      if (r === true) return finish();
      setErr(e => e + 1); setMsg(r.message); setStep(r.code === 'WEAK_PIN' ? 1 : 0); return false;
    });
  };
  return html`<div class="lock">
    <div style="position:absolute;left:8px;top:calc(var(--top) + 4px)"><button class="iconbtn on-dark" onClick=${A.back} aria-label="Cancel"><${Icon} n="x"/></button></div>
    <${Coin} size=${56} />
    <h2 key=${step}>${steps[step]}</h2>
    <div class=${'note' + (msg ? ' warn' : '')} role="status">${msg || (step === 0 ? '' : 'Avoid easy PINs like 1234 or your birth year.')}</div>
    ${!LIVE && step === 0 && S.pin === PIN_DEFAULT && html`<div class="hint-demo">Demo PIN ${PIN_DEFAULT}</div>`}
    ${paused && html`<div class="note warn" role="status">Too many wrong PINs. Try again in ${Math.ceil((S.pinLockUntil - S.now) / 1000)} seconds.</div>`}
    <${PinPad} key=${step} ok=${ok} err=${err} onComplete=${done} showFace=${false} disabled=${paused} />
  </div>`;
}

function InfoScreen({ S, A, kind }) {
  const titles = { faq: 'Questions and answers', contact: 'Contact PGBX', report: 'Report a problem', fees: 'Fees and limits', terms: 'Terms and privacy', about: LIVE ? 'About PGBX' : 'About this prototype' };
  let body;
  if (kind === 'faq') body = html`<${Faqs}/>`;
  else if (kind === 'contact') body = html`<div class="group inset">
      ${[['pin', 'Head office', 'Office 1211, 12th Floor, Gold Tower, Saddar, Karachi'], ['call', 'Phone', '+92 21 35215555', 'tel:+922135215555'], ['wa', 'WhatsApp', '+92 303 3521555', 'https://wa.me/923033521555'], ['globe', 'Website', 'pgbx.com.pk', 'https://pgbx.com.pk']].map(([ic, l, v, href]) =>
        href ? html`<a class="row" href=${href} target="_blank" rel="noopener"><span class="ri"><${Icon} n=${ic} c="sm"/></span><div class="rt"><span style="margin:0">${l}</span><b>${v}</b></div><${Icon} n="chev" c="sm chev"/></a>`
          : html`<div class="row"><span class="ri"><${Icon} n=${ic} c="sm"/></span><div class="rt"><span style="margin:0">${l}</span><b>${v}</b></div></div>`)}
    </div>
    ${!LIVE && html`<div class="group" style="margin-top:12px"><div class="row"><div class="rt"><b>Support hours</b><small><${Tbc}/></small></div></div></div>`}`;
  else if (kind === 'report') body = html`<${Report} S=${S} A=${A}/>`;
  else if (kind === 'fees') body = html`
    <div class="sec-h"><h3>Product premiums</h3><${Sample}/></div>
    <div class="group">${PRODUCTS.map(p => html`<div class="row" style="min-height:48px"><div class="rt"><b style="font-weight:500">${pname(p)}</b></div><span class="rv"><b>${fmt((S.premiums && S.premiums[p.id]) ?? p.premium)}</b></span></div>`)}</div>
    <p class="foot">The premium is added to the metal value of each bar. It’s already included in every price you see.</p>
    <section class="sec"><div class="sec-h"><h3>Other charges</h3></div>
      <div class="group">${[['Buy and sell spread'], ['Collection fee'], ['Storage fee or time limit'], ['Minimum purchase', MIN_PURCHASE]].filter(([, v]) => v || !LIVE).map(([l, v]) => v ? html`<div class="row"><div class="rt"><b style="font-weight:500">${l}</b></div><span class="rv"><b>${fmt(v)}</b></span></div>` : html`<div class="row"><div class="rt"><b style="font-weight:500">${l}</b><small><${Tbc}/></small></div></div>`)}</div></section>
    <section class="sec"><div class="sec-h"><h3>Limits</h3><${Sample}/></div>
      <div class="group">
        <div class="row"><div class="rt"><b style="font-weight:500">Per order</b></div><span class="rv"><b>${MAX_UNITS} bars</b></span></div>
        <div class="row"><div class="rt"><b style="font-weight:500">Per day</b></div><span class="rv"><b>${fmt(DAY_LIMIT)}</b></span></div>
        ${!LIVE && html`<div class="row"><div class="rt"><b style="font-weight:500">Limits by verification level</b><small><${Tbc}/></small></div></div>`}
      </div></section>
    <p class="foot">Every fee is shown before you confirm a purchase or collection.</p>`;
  else if (kind === 'about' && LIVE) body = html`<div class="prose">
      <h3>Pakistan Gold Bullion Exchange</h3>
      <p>Buy 999.0 gold and silver at live prices. PGBX holds your bars for you until you collect them at a PGBX dealer.</p>
      <p>Prices are set by PGBX from international spot prices converted at the live USD/PKR rate, plus the premium for each bar shown in Fees and limits.</p>
      <p class="small" style="margin-top:16px">Version ${APP_VERSION}</p>
    </div>`;
  else if (kind === 'about' && !LIVE) body = html`<div class="prose">
      <h3>What this is</h3>
      <p>A working prototype of the PGBX customer app, built to test the experience before launch. Rates are live; everything else uses sample data stored only in this browser.</p>
      <h3>Live</h3>
      <ul><li>Gold, silver, platinum, palladium and copper prices, converted at the live USD/PKR rate</li><li>Login codes by SMS, once PGBX connects its SMS provider</li></ul>
      <h3>Sample or simulated</h3>
      <ul><li>The customer, wallet, orders and four dealers</li><li>Product premiums, sell spread and purchase limits</li><li>Payments, identity checks and the camera</li><li>The dealer map and the customer’s location</li><li>Notifications, which appear in the app only</li></ul>
      <h3>Still to be decided by PGBX</h3>
      <ul><li>Payment channels and providers: <${Tbc}/></li><li>Identity verification provider: <${Tbc}/></li><li>Push, SMS and email providers: <${Tbc}/></li><li>Map provider: <${Tbc}/></li><li>Urdu at launch: <${Tbc}/></li><li>Written Shariah approval behind the “Shariah compliant” badge: <${Tbc}/></li></ul>
      <h3>Demo controls</h3>
      <p>The PIN is ${PIN_DEFAULT} until you change it. Boxes marked “Demo” let you simulate payment problems, PGBX operations and the dealer’s steps.</p>
      <p class="small" style="margin-top:16px">Version ${APP_VERSION}</p>
    </div>
    <div class="pad" style="margin-top:24px"><button class="btn btn-danger" onClick=${() => A.confirm({ title: 'Reset demo data?', body: 'This erases the sample wallet, orders, collections, alerts and settings in this browser and starts the demo again.', confirm: 'Reset demo data', danger: true, onConfirm: A.resetDemo })}><${Icon} n="refresh" c="sm"/> Reset demo data</button></div>`;
  else body = html`<div class="prose">
      ${[['Ownership of the metal in your wallet', 'How the wallet is classified and which approvals apply.'], ['Fees and charges', 'Spread, collection fee and any storage fee.'], ['How long you can hold', 'How long holdings can be kept and collected.'], ['Refunds and disputes', 'What happens if something goes wrong.'], ['Shariah approval', 'Written approval of the product, wallet and collection process.'], ['Privacy policy', 'How your personal data is collected, stored and deleted.']].map(([h, d]) =>
        html`<h3>${h}</h3><p>${d}</p>${!LIVE && html`<p style="margin-top:4px"><${Tbc}/></p>`}`)}
      ${LIVE ? html`<div class="stack-btns" style="margin-top:24px"><a class="btn btn-secondary" href=${LEGAL + '/legal/terms'} target="_blank" rel="noopener">Read the full terms</a>
        <a class="btn btn-secondary" href=${LEGAL + '/legal/privacy'} target="_blank" rel="noopener">Read the privacy policy</a></div>`
        : html`<p class="small" style="margin-top:24px">You’ll be asked to accept these terms before your first purchase.</p>`}
    </div>`;
  return html`<div class="page">
    <${TopBar} title=${titles[kind]} onBack=${A.back} />
    <div class="scroll">${body}</div>
  </div>`;
}
function Faqs() {
  const [open, setOpen] = useState(0);
  const qs = [
    ['What do I own when I buy?', 'A whole bar, for example a 1 gram gold bar, held for you by PGBX. Every bar in your wallet is backed one-to-one by metal PGBX holds. With $1 gold you own grams of gold in whole 1-tola bars PGBX holds for its customers.'],
    ['What purity are the bars?', 'All eleven products are 999.0 purity.'],
    ['Can I buy part of a bar?', 'Bars are always whole, and smaller bars can’t be combined into a larger one. To buy a small amount, use $1 gold: from US$1 at a time, recorded in grams.'],
    ['Can I buy gold and silver together?', 'Yes. Add bars to your cart and pay for them in one order.'],
    ['Why can’t I buy larger bars?', 'Larger bars are sold at PGBX offline only.'],
    ['How is the final price set?', 'Prices in the app are indicative. Before you buy or sell, PGBX support confirms the final rate in a private chat about your request. It’s valid for a few minutes and can be used once.'],
    ['Why do I need to verify my identity?', 'PGBX must check your CNIC and a selfie before your first purchase.'],
    ['Where do I collect my metal?', `At any ${LIVE ? 'PGBX dealer' : 'of the 250 PGBX dealers'} that has your bar in stock. Bring your original CNIC. Your collection code is valid for 24 hours.`],
    ['Is there a collection fee?', null],
    ['Can I sell back to PGBX?', 'Yes. In Wallet, tap Sell bars back to PGBX. Support confirms the rate in chat, the bars leave your wallet, and PGBX pays your bank account, usually the same working day.'],
    ['Is there a storage fee or time limit?', null],
    ['Is collecting gold different from silver?', null],
  ];
  return html`<div class="group">${qs.filter(([, a]) => a || !LIVE).map(([q, a], i) => html`<div class=${'faq' + (open === i ? ' open' : '')}>
    <button class="faq-q" onClick=${() => setOpen(open === i ? -1 : i)} aria-expanded=${open === i}>${q}<${Icon} n="chev" c="sm chev"/></button>
    ${open === i && html`<div class="ans">${a || html`<${Tbc}/>`}</div>`}
  </div>`)}</div>`;
}
function Report({ S, A }) {
  const opts = [...S.orders.map(o => ['o:' + o.id, `Order ${o.receipt}`]), ...S.redemptions.map(r => ['r:' + r.id, r.code ? `Collection, code ${r.code}` : `Collection of ${r.units} × ${pname(P[r.pid])}`])];
  const [ref, setRef] = useState(opts[0] ? opts[0][0] : 'general');
  const [text, setText] = useState('');
  useEffect(() => {
    A.guard(text.trim() ? cont => A.confirm({ title: 'Discard this report?', body: 'What you’ve written won’t be sent.', confirm: 'Discard report', cancel: 'Keep writing', danger: true, onConfirm: cont }) : null);
    return () => A.guard(null);
  }, [!!text.trim()]);
  return html`<div class="pad">
    <p class="muted">Tell us what went wrong. PGBX support will see the order or collection you choose.</p>
    <label class="field"><span class="lbl">What is it about?</span>
      <select class="inp" value=${ref} onChange=${e => setRef(e.target.value)}>
        ${opts.map(([v, l]) => html`<option value=${v}>${l}</option>`)}<option value="general">Something else</option>
      </select></label>
    <label class="field"><span class="lbl">What happened?</span>
      <textarea class="inp" rows="5" maxlength="1000" placeholder="For example: I paid but the bar isn’t in my wallet" value=${text} onInput=${e => setText(e.target.value)}></textarea></label>
    <div class="hint">${text.trim().length < 10 ? 'Please add a few more details.' : `${1000 - text.length} characters left`}</div>
    <button class="btn btn-primary" style="margin-top:24px" disabled=${text.trim().length < 10 || S.sending} aria-busy=${!!S.sending} onClick=${() => A.report(ref, text)}>${S.sending ? 'Sending…' : 'Send report'}</button>
  </div>`;
}

/* ============================================================
   Services: jewellery worth, doorstep appraisal, gift bullion and coins
   ============================================================ */
// SAMPLE values for the demo; the production build reads PGBX's settings from /api/v1/services/config.
const SVC_SAMPLE = {
  purity: { gold: { '24K': 0.999, '22K': 0.916, '21K': 0.875, '20K': 0.833, '18K': 0.750, '14K': 0.585 }, silver: { '999': 0.999, '925': 0.925, '900': 0.900, '800': 0.800 } },
  buybackDeductionPct: { gold: 4, silver: 6 },
  appraisal: { feePkr: 2500, cities: ['Karachi'], slots: ['10:00-12:00', '12:00-14:00', '14:00-16:00', '16:00-18:00', '18:00-20:00'], freeCancelHours: 24 },
  gift: {
    making: { plain: 1500, themed: 2500, engraving: 1000 }, packaging: { standard: 0, premium: 1500 }, deliveryPkr: 1500, leadDays: 5,
    cities: ['Karachi', 'Lahore', 'Islamabad', 'Rawalpindi', 'Faisalabad', 'Multan', 'Peshawar', 'Quetta', 'Hyderabad', 'Sialkot'],
    items: [
      { id: 'gg-1g', metal: 'gold', label: '1 gram', grams: 1, shapes: ['bar', 'coin'] }, { id: 'gg-2g', metal: 'gold', label: '2 gram', grams: 2, shapes: ['bar', 'coin'] },
      { id: 'gg-5g', metal: 'gold', label: '5 gram', grams: 5, shapes: ['bar', 'coin'] }, { id: 'gg-1t', metal: 'gold', label: '1 tola', grams: TOLA, shapes: ['bar', 'coin'] },
      { id: 'gg-10g', metal: 'gold', label: '10 gram', grams: 10, shapes: ['bar'] },
      { id: 'gs-1t', metal: 'silver', label: '1 tola', grams: TOLA, shapes: ['bar', 'coin'] }, { id: 'gs-5t', metal: 'silver', label: '5 tola', grams: 5 * TOLA, shapes: ['bar', 'coin'] },
      { id: 'gs-10t', metal: 'silver', label: '10 tola', grams: 10 * TOLA, shapes: ['bar'] },
    ],
  },
};
// Screens a notification link may open
const LINK_NAMES = ['receipt', 'code', 'appraisal', 'gift', 'history', 'product', 'wallet', 'statement', 'micro', 'chat'];
const KARATS_ALL = { gold: ['24K', '22K', '21K', '20K', '18K', '14K'], silver: ['999', '925', '900', '800'] };
const KARAT_NAME = { '999': '999 fine', '925': '925 sterling', '900': '900', '800': '800' };
const DESIGNS = [['plain', 'Plain', ''], ['eid', 'Eid Mubarak', 'EID MUBARAK'], ['wedding', 'Wedding', 'SHAADI MUBARAK'], ['birthday', 'Birthday', 'HAPPY BIRTHDAY'],
  ['newborn', 'New baby', 'WELCOME LITTLE ONE'], ['graduation', 'Graduation', 'CONGRATULATIONS']];
const MASHA = TOLA / 12, RATTI = TOLA / 96;            // 1 tola = 12 masha = 96 ratti
const num = v => { const n = Number(String(v || '').replace(/[^\d.]/g, '')); return Number.isFinite(n) ? n : 0; };
const ymd = d => { const x = new Date(d); return `${x.getFullYear()}-${String(x.getMonth() + 1).padStart(2, '0')}-${String(x.getDate()).padStart(2, '0')}`; };
const dayName = s => F.wdDayMonUtc.format(new Date(s + 'T12:00:00Z'));
// Visits and deliveries are in Pakistan (UTC+5, no daylight saving), like the server, wherever the phone's clock is set
// After a form is checked, bring its first message into view (it may be above or below the screen)
const showFirstError = () => setTimeout(() => { const e = document.querySelector('.page .hint.err'); if (e) e.scrollIntoView({ block: 'center', behavior: 'smooth' }); }, 50);
const pkDay = ms => new Date(ms + 5 * 3600e3).toISOString().slice(0, 10);
const pkTime = (day, hhmm) => Date.parse(`${day}T${hhmm}:00+05:00`);
const slotName = s => s.replace('-', '–');
const newPiece = (metal = 'gold') => ({ id: uid(), metal, karat: metal === 'gold' ? '22K' : '925', unit: 'g', g: '', tola: '', t: '', m: '', r: '', stones: '' });
const pieceGrams = p => Math.max(0, (p.unit === 'tola' ? num(p.tola) * TOLA : p.unit === 'tmr' ? num(p.t) * TOLA + num(p.m) * MASHA + num(p.r) * RATTI : num(p.g)) - num(p.stones));
function pieceValue(p, svc, rates) {
  const purity = (svc.purity[p.metal] || {})[p.karat] || 0, net = pieceGrams(p);
  const fine = net * purity, perFineGram = rateOf(rates, p.metal).sellGram / 0.999;
  const gross = fine * perFineGram, ded = (svc.buybackDeductionPct[p.metal] || 0) / 100;
  return { net, fine, gross: Math.round(gross), estimate: Math.round(gross * (1 - ded)), dedPct: ded * 100 };
}
const giftItemPrice = (it, rates) => Math.round(it.grams * rateOf(rates, it.metal).buyGram);
function giftPrice(d, svc, rates) {
  const it = svc.gift.items.find(i => i.id === d.item); if (!it) return null;
  const metal = giftItemPrice(it, rates), m = svc.gift.making;
  const making = (d.design === 'plain' ? m.plain : m.themed) + (d.engraving.trim() ? m.engraving : 0);
  const packaging = svc.gift.packaging[d.packaging] || 0, delivery = svc.gift.deliveryPkr;
  return { it, metal, making, packaging, delivery, total: metal + making + packaging + delivery };
}
const APPR_LABEL = { pending_payment: 'Awaiting payment', booked: 'Booked', confirmed: 'Goldsmith assigned', completed: 'Report ready', cancelled: 'Cancelled' };
const APPR_TAG = { pending_payment: 'warning', booked: 'gold', confirmed: 'success', completed: 'neutral', cancelled: 'neutral' };
const GIFT_LABEL = { pending_payment: 'Awaiting payment', placed: 'Order placed', in_production: 'Being made', dispatched: 'On its way', delivered: 'Delivered', cancelled: 'Cancelled' };
const GIFT_TAG = { pending_payment: 'warning', placed: 'gold', in_production: 'gold', dispatched: 'success', delivered: 'neutral', cancelled: 'neutral' };
const giftTitle = (g, svc) => { const it = svc.gift.items.find(i => i.id === g.item); return it ? `${it.label} ${metalName(it.metal).toLowerCase()} ${g.shape}` : 'Gift'; };

// Live preview of a made-to-order coin or bar
function GiftPreview({ d, svc, size = 168 }) {
  const it = svc.gift.items.find(i => i.id === d.item) || svc.gift.items[0];
  const silver = it.metal === 'silver', coin = d.shape === 'coin';
  const motif = (DESIGNS.find(x => x[0] === d.design) || DESIGNS[0])[2];
  const eng = d.engraving.trim();
  const c = silver ? ['#F5F7F8', '#B9C2C8', '#7E8A92'] : ['#F7DE9A', '#C8962B', '#8A6414'];
  const ink = silver ? '#4C5860' : '#6A4B0C', id = 'gp' + (silver ? 's' : 'g') + (coin ? 'c' : 'b');
  // Text that would run off the piece is squeezed to fit inside its frame (coin face or bar)
  const room = coin ? 128 : 92;
  const text = (y, s, w, t, extra = {}) => {
    const est = String(t).length * (s * 0.62 + (Number(extra['letter-spacing']) || 0));
    const fit = est > room ? { textLength: room, lengthAdjust: 'spacingAndGlyphs' } : {};
    return html`<text x="100" y=${y} text-anchor="middle" font-size=${s} font-weight=${w} fill=${ink} font-family="ui-serif, 'New York', Georgia, serif" ...${extra} ...${fit}>${t}</text>`;
  };
  return html`<svg viewBox="0 0 200 200" width=${size} height=${size} role="img" aria-label=${`Preview: ${it.label} ${it.metal} ${d.shape}${motif ? ', ' + motif.toLowerCase() : ''}${eng ? ', engraved ' + eng : ''}`}>
    <defs><linearGradient id=${id} x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color=${c[0]}/><stop offset=".55" stop-color=${c[1]}/><stop offset="1" stop-color=${c[2]}/></linearGradient></defs>
    ${coin ? html`<circle cx="100" cy="100" r="92" fill=${`url(#${id})`}/><circle cx="100" cy="100" r="82" fill="none" stroke=${ink} stroke-opacity=".35" stroke-width="1.5" stroke-dasharray="2 3"/>`
      : html`<rect x="42" y="14" width="116" height="172" rx="14" fill=${`url(#${id})`}/><rect x="50" y="22" width="100" height="156" rx="9" fill="none" stroke=${ink} stroke-opacity=".35" stroke-width="1.2"/>`}
    ${text(coin ? 52 : 46, 10, 700, 'PGBX', { 'letter-spacing': 3 })}
    ${motif && text(coin ? 76 : 76, motif.length > 14 ? 8.5 : 10, 700, motif, { 'letter-spacing': 1.2 })}
    ${eng ? text(coin ? 108 : 110, eng.length > 14 ? 11 : 15, 600, eng) : text(coin ? 108 : 110, 13, 600, '✦', { 'fill-opacity': .6 })}
    ${text(coin ? 140 : 150, 11, 700, it.label.toUpperCase())}
    ${text(coin ? 156 : 166, 9, 600, '999.0 ' + (silver ? 'SILVER' : 'GOLD'), { 'letter-spacing': 1.5 })}
  </svg>`;
}

function ServicesScreen({ S, A }) {
  const svc = S.svc;
  // Bookings and gift orders still waiting for their payment are in progress too (and can be cancelled)
  const activeA = S.appraisals.filter(a => ['pending_payment', 'booked', 'confirmed'].includes(a.status));
  const activeG = S.giftOrders.filter(g => ['pending_payment', 'placed', 'in_production', 'dispatched'].includes(g.status));
  const readyN = S.redemptions.filter(r => S.statusOf(r) === 'ready').length, heldN = S.redemptions.filter(r => S.statusOf(r) === 'requested').length;
  const Svc = ({ icon, title, sub, onClick, badge }) => html`<button class="row" onClick=${onClick}>
    <span class="ri gold"><${Icon} n=${icon} c="sm"/></span><div class="rt"><b>${title}</b><span>${sub}</span></div>
    ${badge ? html`<span class="tag gold">${badge}</span>` : ''}<${Icon} n="chev" c="sm chev"/></button>`;
  return html`<div class="scroll">
    <${TabHead} title="Services" sub="Everything for your gold and silver, in one place" />
    <button class="brand-card on-dark svc-hero" onClick=${() => A.push({ name: 'worth' })}>
      <div class="between"><span class="bc-label">Free · no login needed</span><${Icon} n="chev" c="sm"/></div>
      <div class="svc-hero-t">What is your jewellery worth today?</div>
      <div class="bc-sub">Enter the karat and weight. Get PGBX’s buy-back estimate at today’s price, without leaving home.</div>
    </button>
    <section class="sec">
      <div class="sec-h"><h3>PGBX services</h3></div>
      <div class="group">
        ${Svc({ icon: 'gem', title: '$1 gold', sub: (q => (q.unitPkr ? `Buy gold one dollar at a time · $1 = ${fmt(q.unitPkr)}` : 'Buy gold one dollar at a time'))(microQuote(S)), onClick: () => A.openMicro(), badge: S.micro.grams > 0 ? fmtG(S.micro.grams) : '' })}
        ${Svc({ icon: 'calc', title: 'Jewellery worth', sub: 'Buy-back estimate by karat and weight', onClick: () => A.push({ name: 'worth' }) })}
        ${Svc({ icon: 'home', title: 'Doorstep appraisal', sub: `A PGBX goldsmith tests your pieces at home · ${svc ? fmt(svc.appraisal.feePkr) : '…'}`, onClick: () => A.startAppraisal(), badge: activeA.length ? `${activeA.length} active` : '' })}
        ${Svc({ icon: 'gift', title: 'Gift gold and silver', sub: 'Bars and coins made to order, delivered to loved ones', onClick: () => A.startGift(), badge: activeG.length ? `${activeG.length} on the way` : '' })}
        ${Svc({ icon: 'store', title: 'Collect your bars', sub: 'Swap your holdings for the bar at a PGBX dealer', onClick: () => A.push({ name: 'collect' }), badge: readyN ? `${readyN} ready` : heldN ? `${heldN} reserved` : '' })}
      </div>
    </section>
    ${(activeA.length > 0 || activeG.length > 0) && html`<section class="sec"><div class="sec-h"><h3>In progress</h3></div><div class="group">
      ${activeA.map(a => html`<button class="row" onClick=${() => A.push({ name: 'appraisal', id: a.id })}><span class="ri"><${Icon} n="home" c="sm"/></span>
        <div class="rt"><b>Appraisal · ${dayName(a.date)}, ${slotName(a.slot)}</b><span>${a.area}, ${a.city}</span></div><span class=${'tag ' + APPR_TAG[a.status]}>${APPR_LABEL[a.status]}</span></button>`)}
      ${activeG.map(g => html`<button class="row" onClick=${() => A.push({ name: 'gift', id: g.id })}><span class="ri"><${Icon} n="gift" c="sm"/></span>
        <div class="rt"><b>${svc ? giftTitle(g, svc) : 'Gift'} for ${g.recipient.name.split(' ')[0]}</b><span>By ${dayName(g.deliverBy)} · ${g.recipient.city}</span></div><span class=${'tag ' + GIFT_TAG[g.status]}>${GIFT_LABEL[g.status]}</span></button>`)}
    </div></section>`}
    ${(S.appraisals.length > activeA.length || S.giftOrders.length > activeG.length) && html`<section class="sec"><div class="sec-h"><h3>Past</h3></div><div class="group">
      ${S.appraisals.filter(a => !activeA.includes(a)).map(a => html`<button class="row" onClick=${() => A.push({ name: 'appraisal', id: a.id })}><span class="ri"><${Icon} n="home" c="sm"/></span>
        <div class="rt"><b>Appraisal · ${dayName(a.date)}</b><span>${a.ref}</span></div><span class=${'tag ' + APPR_TAG[a.status]}>${APPR_LABEL[a.status]}</span></button>`)}
      ${S.giftOrders.filter(g => !activeG.includes(g)).map(g => html`<button class="row" onClick=${() => A.push({ name: 'gift', id: g.id })}><span class="ri"><${Icon} n="gift" c="sm"/></span>
        <div class="rt"><b>${svc ? giftTitle(g, svc) : 'Gift'}</b><span>${g.ref}</span></div><span class=${'tag ' + GIFT_TAG[g.status]}>${GIFT_LABEL[g.status]}</span></button>`)}
    </div></section>`}
    <p class="foot">Estimates use PGBX’s live sell price. Fees, deductions and service cities are ${LIVE ? 'set by PGBX' : 'sample values until PGBX confirms them'}.</p>
  </div>`;
}

// ---------- jewellery worth (free, for everyone) ----------
function WorthScreen({ S, A }) {
  const svc = S.svc;
  // One default piece for the life of the screen: a new one on every redraw (the app redraws every second for the
  // live prices) would get a new key each time, rebuilding the card and making it flicker.
  const blank = useRef(null);
  if (!blank.current) blank.current = newPiece();
  const pieces = S.worth && S.worth.length ? S.worth : [blank.current];
  const set = list => A.set({ worth: list });
  const upd = (i, patch) => set(pieces.map((p, j) => (j === i ? { ...p, ...patch } : p)));
  if (!svc || S.rates.mode === 'connecting') return html`<div class="page"><${TopBar} title="Jewellery worth" onBack=${A.back} /><div class="scroll"><div class="pad"><span class="sk" style="height:240px"></span></div></div></div>`;
  const vals = pieces.map(p => pieceValue(p, svc, S.rates));
  const total = vals.reduce((a, v) => a + v.estimate, 0), any = vals.some(v => v.net > 0);
  const num4 = (v, f, label) => html`<input class="inp" inputmode="decimal" placeholder="0" aria-label=${label} value=${v} onInput=${e => f(e.target.value.replace(/,/g, '.').replace(/[^\d.]/g, '').replace(/(\..*)\./g, '$1').slice(0, 9))} />`;   // "12,5" is 12.5; one decimal point
  return html`<div class="page has-actions">
    <${TopBar} title="Jewellery worth" onBack=${A.back} />
    <div class="scroll">
      <div class="pad"><p class="muted">Enter each piece’s karat and weight. We work out its gold or silver content and what PGBX would pay for it at today’s price.</p></div>
      ${S.stale && html`<${StaleBanner} S=${S}/>`}
      ${pieces.map((p, i) => { const v = vals[i]; const karats = Object.keys(svc.purity[p.metal] || {}); return html`<section class="card worth-piece" key=${p.id}>
        <div class="between"><b>Piece ${i + 1}</b>${pieces.length > 1 && html`<button class="linkbtn sm" onClick=${() => set(pieces.filter((_, j) => j !== i))} aria-label=${`Remove piece ${i + 1}`}>Remove</button>`}</div>
        <div style="margin-top:12px"><${Seg} label="Metal" items=${[['gold', 'Gold'], ['silver', 'Silver']]} value=${p.metal} onChange=${m => upd(i, { metal: m, karat: m === 'gold' ? '22K' : '925' })} /></div>
        <div class="field"><span class="lbl">${p.metal === 'gold' ? 'Karat' : 'Silver standard'}</span>
          <div class="chips" role="radiogroup" aria-label="Karat">${karats.map(k => html`<button class=${'chipb' + (p.karat === k ? ' on' : '')} role="radio" aria-checked=${p.karat === k} onClick=${() => upd(i, { karat: k })}>${p.metal === 'gold' ? k : KARAT_NAME[k] || k}</button>`)}</div>
          <div class="hint">${p.metal === 'gold' ? `${svc.purity.gold[p.karat] ? `${p.karat} is ${(svc.purity.gold[p.karat] * 100).toFixed(1)}% gold.` : 'Choose the karat.'} Most jewellery in Pakistan is 21K or 22K; the stamp is usually inside the band or clasp.` : 'Silver jewellery is usually 925 (sterling).'}</div></div>
        <div class="field"><span class="lbl">Weight</span>
          <${Seg} label="Weight unit" items=${[['g', 'Grams'], ['tola', 'Tola'], ['tmr', 'T · M · R']]} value=${p.unit} onChange=${u => upd(i, { unit: u })} />
          <div style="margin-top:8px">${p.unit === 'tmr' ? html`<div class="grid3">
              <label><span class="tiny muted">Tola</span>${num4(p.t, v => upd(i, { t: v }))}</label><label><span class="tiny muted">Masha</span>${num4(p.m, v => upd(i, { m: v }))}</label><label><span class="tiny muted">Ratti</span>${num4(p.r, v => upd(i, { r: v }))}</label></div>`
            : num4(p.unit === 'tola' ? p.tola : p.g, v => upd(i, p.unit === 'tola' ? { tola: v } : { g: v }), p.unit === 'tola' ? 'Weight in tola' : 'Weight in grams')}</div>
          ${p.unit === 'tmr' && html`<div class="hint">Tola, masha and ratti, as a sarafa receipt shows them: 1 tola = 12 masha = 96 ratti.</div>`}</div>
        <label class="field"><span class="lbl">Stones, beads or lac (grams, optional)</span>${num4(p.stones, v => upd(i, { stones: v }))}
          <div class="hint">Their weight isn’t gold or silver, so it’s taken off.</div></label>
        ${v.net > 0 && html`<div class="worth-res">
          <div class="kv"><span>Metal weight</span><b>${fmtW(v.net)}</b></div>
          <div class="kv"><span>Pure ${p.metal} content</span><b>${fmtW(v.fine)}</b></div>
          <div class="kv"><span>Value at today’s sell price</span><b>${fmt(v.gross)}</b></div>
          <div class="kv"><span>Buy-back deduction (${v.dedPct}%)${!LIVE ? html` <${Sample}/>` : ''}</span><b>− ${fmt(v.gross - v.estimate)}</b></div>
          <div class="kv total"><span>Estimate for this piece</span><b>${fmt(v.estimate)}</b></div></div>`}
      </section>`; })}
      <div class="pad"><button class="btn btn-secondary" onClick=${() => set([...pieces, newPiece(pieces[pieces.length - 1].metal)])}><${Icon} n="plus" c="sm"/> Add another piece</button></div>
      <${Notice} kind="plain" icon="scale"><b>This is an estimate</b>The final amount depends on testing the actual pieces: solder, hollow work, stones and wear all change the metal content. A PGBX goldsmith can test them at your home.</${Notice}>
    </div>
    <${ActionBar} label="Estimated buy-back value" amount=${any ? html`<${Odo} value=${total} />` : '—'}>
      <button class="btn btn-primary" disabled=${!any} onClick=${() => A.startAppraisal(pieces.filter((p, i) => vals[i].net > 0).map(p => ({ metal: p.metal, karat: p.karat, approx_g: Math.round(pieceGrams(p) * 10) / 10, note: '' })))}><${Icon} n="home" c="sm"/> Book doorstep appraisal</button>
    </${ActionBar}>
  </div>`;
}

// ---------- doorstep appraisal ----------
function AppraisalBook({ S, A }) {
  const svc = S.svc, d = S.apprDraft;
  const up = patch => A.set(s => ({ apprDraft: { ...s.apprDraft, ...patch } }));
  const [touched, setTouched] = useState(false);
  if (!svc || !d) return html`<div class="page"><${TopBar} title="Doorstep appraisal" onBack=${A.back} /><div class="scroll"><div class="pad"><span class="sk" style="height:240px"></span></div></div></div>`;
  const days = Array.from({ length: 8 }, (_, i) => pkDay(Date.now() + (i + 1) * 86400e3));
  const phone = d.phone.replace(/\D/g, '').replace(/^92/, '').replace(/^0/, '');
  const errs = {
    items: !d.items.length ? 'Add at least one piece.' : '',
    date: !d.date ? 'Choose a day.' : '', slot: !d.slot ? 'Choose a time.' : '',
    area: d.area.trim().length < 2 ? 'Enter your area, for example DHA Phase 6.' : '',
    address: d.address.trim().length < 10 ? 'Enter the full address, including house number and street.' : '',
    phone: !PK_MOBILE.test(phone) ? 'Enter a mobile number the goldsmith can call.' : '',
  };
  const ok = !Object.values(errs).some(Boolean);
  const E = k => touched && errs[k] && html`<div class="hint err">${errs[k]}</div>`;
  const updItem = (i, patch) => up({ items: d.items.map((x, j) => (j === i ? { ...x, ...patch } : x)) });
  const karats = m => Object.keys(svc.purity[m] || {});
  const pay = () => { if (!ok) { setTouched(true); showFirstError(); return; } A.bookAppraisal(); };
  return html`<div class="page has-actions">
    <${TopBar} title="Doorstep appraisal" onBack=${A.back} />
    <div class="scroll">
      <div class="pad"><p class="muted">A PGBX goldsmith visits your home, tests each piece in front of you with a karat meter and scale, and tells you what it is. Nothing leaves your hands.</p></div>
      <section class="sec"><div class="sec-h"><h3>What should we check?</h3></div>
        <div class="group">${d.items.map((it, i) => html`<div class="row" style="flex-wrap:wrap;align-items:flex-start" key=${i}>
          <div class="rt" style="min-width:0">
            <div class="chips" role="radiogroup" aria-label=${`Piece ${i + 1} metal`}>${[['gold', 'Gold'], ['silver', 'Silver']].map(([m, l]) => html`<button class=${'chipb sm' + (it.metal === m ? ' on' : '')} role="radio" aria-checked=${it.metal === m} onClick=${() => updItem(i, { metal: m, karat: '' })}>${l}</button>`)}</div>
            <div class="grid2" style="margin-top:8px">
              <label><span class="tiny muted">Karat (if known)</span><select class="inp" value=${it.karat} onChange=${e => updItem(i, { karat: e.target.value })}><option value="">Not sure</option>${karats(it.metal).map(k => html`<option value=${k}>${it.metal === 'gold' ? k : KARAT_NAME[k]}</option>`)}</select></label>
              <label><span class="tiny muted">Grams (about)</span><input class="inp" inputmode="decimal" value=${it.approx_g || ''} onInput=${e => updItem(i, { approx_g: e.target.value.replace(/[^\d.]/g, '').replace(/(\..*)\./g, '$1').slice(0, 8) })} /></label>
            </div>
            <input class="inp" style="margin-top:8px" maxlength="80" aria-label="What the piece is" placeholder="What is it? e.g. 4 bangles, necklace set" value=${it.note || ''} onInput=${e => updItem(i, { note: e.target.value })} />
          </div>
          ${d.items.length > 1 && html`<button class="iconbtn" onClick=${() => up({ items: d.items.filter((_, j) => j !== i) })} aria-label=${`Remove piece ${i + 1}`}><${Icon} n="trash" c="sm"/></button>`}
        </div>`)}</div>
        ${E('items')}
        <div class="pad" style="margin-top:8px"><button class="btn btn-tertiary btn-sm" onClick=${() => up({ items: [...d.items, { metal: 'gold', karat: '', approx_g: 0, note: '' }] })}><${Icon} n="plus" c="sm"/> Add a piece</button></div>
      </section>
      <section class="sec"><div class="sec-h"><h3>When</h3></div>
        <div class="card">
          <div class="chips hchips" role="radiogroup" aria-label="Day">${days.map(x => html`<button class=${'chipb' + (d.date === x ? ' on' : '')} role="radio" aria-checked=${d.date === x} onClick=${() => up({ date: x })}>${dayName(x)}</button>`)}</div>${E('date')}
          <div class="chips" style="margin-top:12px" role="radiogroup" aria-label="Time">${svc.appraisal.slots.map(x => html`<button class=${'chipb' + (d.slot === x ? ' on' : '')} role="radio" aria-checked=${d.slot === x} onClick=${() => up({ slot: x })}>${slotName(x)}</button>`)}</div>${E('slot')}
        </div></section>
      <section class="sec"><div class="sec-h"><h3>Where</h3></div>
        <div class="card">
          <label class="field" style="margin-top:0"><span class="lbl">City</span><select class="inp" value=${d.city} onChange=${e => up({ city: e.target.value })}>${svc.appraisal.cities.map(c => html`<option value=${c}>${c}</option>`)}</select>
            <div class="hint">Doorstep visits are available in ${svc.appraisal.cities.join(', ')} for now.</div></label>
          <label class="field"><span class="lbl">Area</span><input class=${'inp' + (touched && errs.area ? ' bad' : '')} placeholder="e.g. DHA Phase 6" value=${d.area} onInput=${e => up({ area: e.target.value })} />${E('area')}</label>
          <label class="field"><span class="lbl">Full address</span><textarea class=${'inp' + (touched && errs.address ? ' bad' : '')} rows="2" autocomplete="street-address" placeholder="House, street, block" value=${d.address} onInput=${e => up({ address: e.target.value })}></textarea>${E('address')}</label>
          <label class="field"><span class="lbl">Mobile for the goldsmith</span><span class=${'phone' + (touched && errs.phone ? ' bad' : '')}><span class="cc">+92</span><input inputmode="numeric" autocomplete="tel-national" placeholder="300 1234567" value=${d.phone} onInput=${e => up({ phone: e.target.value.replace(/\D/g, '').slice(0, 11) })} /></span>${E('phone')}</label>
          <label class="field"><span class="lbl">Anything we should know? (optional)</span><input class="inp" maxlength="200" placeholder="e.g. Call when you reach the gate" value=${d.notes} onInput=${e => up({ notes: e.target.value })} /></label>
        </div></section>
      <${Notice} kind="plain" icon="shield"><b>Your safety</b>After booking you get a 4-digit visit code. The goldsmith says it at your door; don’t open for anyone who can’t. They wear a PGBX card and never take your jewellery away.</${Notice}>
      <section class="sec"><div class="sec-h"><h3>Pay the visit fee with</h3></div>
        <div class="group inset" role="radiogroup" aria-label="Payment method">
          ${METHODS.map(m => html`<button class="row" onClick=${() => A.set({ method: m.id })} role="radio" aria-checked=${S.method === m.id}><span class="ri"><${Icon} n=${m.icon} c="sm"/></span><div class="rt"><b>${m.name}</b><span>${m.sub}</span></div><${Radio} on=${S.method === m.id} /></button>`)}
        </div>
        <p class="foot">Free cancellation up to ${svc.appraisal.freeCancelHours} hours before the visit.${LIVE ? '' : ' Fee and cancellation terms are samples.'}</p></section>
      ${S.offline && html`<${Notice} kind="warning" icon="wifiOff" title="You’re offline">Connect to the internet to book.</${Notice}>`}
    </div>
    <${ActionBar} label="Visit fee" amount=${fmt(svc.appraisal.feePkr)}>
      <button class="btn btn-primary" disabled=${S.paying || S.offline} onClick=${pay}>${S.paying ? html`<span class="spin"></span> Booking` : html`<${Icon} n="lock" c="sm"/> Pay ${fmt(svc.appraisal.feePkr)} and book`}</button>
    </${ActionBar}>
  </div>`;
}

function AppraisalDetail({ S, A, id }) {
  const a = S.appraisals.find(x => x.id === id);
  if (!a) return html`<div class="page"><${TopBar} title="Appraisal" onBack=${A.back} /><div class="scroll"><${Empty} icon="home" title="Booking not found" body="It may still be loading. Try again in a moment." /></div></div>`;
  const order = ['booked', 'confirmed', 'completed'], idx = order.indexOf(a.status);
  const live = ['pending_payment', 'booked', 'confirmed'].includes(a.status);
  const start = pkTime(a.date, a.slot.split('-')[0]);
  const freeCancel = start - S.now >= (S.svc ? S.svc.appraisal.freeCancelHours : 24) * 3600e3;
  const cancel = () => A.confirm({ title: 'Cancel this visit?', body: a.status === 'pending_payment' ? 'Nothing has been paid for this visit yet.' : freeCancel ? 'Your visit fee will be refunded to your payment method.' : `It’s less than ${S.svc ? S.svc.appraisal.freeCancelHours : 24} hours before the visit, so the fee isn’t refunded.`,
    confirm: 'Cancel visit', cancel: 'Keep it', danger: true, onConfirm: () => A.cancelAppraisal(a.id) });
  const labels = { booked: 'Booked', confirmed: 'Goldsmith assigned', completed: 'Report ready' };
  return html`<div class="page">
    <${TopBar} title="Doorstep appraisal" onBack=${A.back} />
    <div class="scroll">
      <div class="card" style="text-align:center;padding:24px 16px">
        <span class=${'tag ' + APPR_TAG[a.status]}>${APPR_LABEL[a.status]}</span>
        ${live && html`<div class="small muted" style="margin-top:12px">Visit code</div>
          <div class="code" aria-label=${`Visit code ${a.visitCode.split('').join(' ')}`}>${a.visitCode.split('').map(c => html`<span aria-hidden="true">${c}</span>`)}</div>
          <div class="small" style="margin-top:8px">The goldsmith must say this code at your door.</div>`}
        ${a.status !== 'cancelled' && html`<div class="steps">${order.map((k, i) => html`<div class=${'step' + (i < idx || a.status === 'completed' ? ' done' : i === idx ? ' cur' : '')}><div class="sd">${i < idx || a.status === 'completed' ? html`<${Icon} n="check"/>` : i + 1}</div>${labels[k]}</div>`)}</div>`}
        ${a.status === 'cancelled' && html`<p class="small muted" style="margin-top:12px">${a.refundDue ? 'Cancelled. Your visit fee will be refunded.' : 'Cancelled.'}</p>`}
      </div>
      ${a.status === 'completed' && a.result && html`<section class="sec"><div class="sec-h"><h3>Assay report</h3></div><div class="card">
        ${a.result.karat && html`<div class="kv"><span>Karat found</span><b>${a.result.karat}</b></div>`}
        ${a.result.net_g && html`<div class="kv"><span>Net metal weight</span><b>${fmtW(a.result.net_g)}</b></div>`}
        ${a.result.value_pkr && html`<div class="kv total"><span>PGBX offer</span><b>${fmt(a.result.value_pkr)}</b></div>`}
        <p class="small" style="margin-top:12px">${a.result.summary}</p></div></section>`}
      ${a.goldsmith && live && html`<section class="sec"><div class="sec-h"><h3>Your goldsmith</h3></div><div class="group">
        <a class="row" href=${'tel:' + a.goldsmith.phone.replace(/[^\d+]/g, '')}><span class="ri"><${Icon} n="user" c="sm"/></span><div class="rt"><b>${a.goldsmith.name}</b><span>${a.goldsmith.phone}</span></div><${Icon} n="call" c="sm chev"/></a></div></section>`}
      <section class="sec"><div class="sec-h"><h3>Booking</h3></div><div class="card">
        <div class="kv"><span>Reference</span><b class="mono">${a.ref}</b></div>
        <div class="kv"><span>When</span><b>${dayName(a.date)}, ${slotName(a.slot)}</b></div>
        <div class="kv"><span>Where</span><b style="text-align:right">${a.address}, ${a.area}, ${a.city}</b></div>
        <div class="kv"><span>Pieces</span><b style="text-align:right">${a.items.map(i => `${metalName(i.metal)}${i.karat ? ' ' + i.karat : ''}${i.approx_g ? ` ~${i.approx_g} g` : ''}${i.note ? ` (${i.note})` : ''}`).join(', ')}</b></div>
        <div class="kv"><span>Visit fee</span><b>${fmt(a.fee)}</b></div>
      </div></section>
      ${a.status === 'completed' && html`<div class="pad stack-btns" style="margin-top:16px"><button class="btn btn-secondary" onClick=${() => A.push({ name: 'worth' })}>Estimate other jewellery</button></div>`}
      ${live && html`<div class="pad" style="margin-top:24px"><button class="btn btn-danger" onClick=${cancel}>Cancel visit</button>
        <p class="hint" style="text-align:center">${freeCancel ? `Free until ${S.svc ? S.svc.appraisal.freeCancelHours : 24} hours before the visit.` : 'The fee isn’t refunded this close to the visit.'}</p></div>`}
      ${live && html`<${Demo} title="Operations" body="In the real system PGBX operations assigns the goldsmith and records the result in the admin panel.">
        <div class="stack-btns">
          <button class="btn btn-secondary btn-sm" style="width:100%" disabled=${a.status !== 'booked'} onClick=${() => A.demoAppraisal(a.id, 'assign')}>Assign a goldsmith</button>
          <button class="btn btn-secondary btn-sm" style="width:100%" disabled=${a.status !== 'confirmed'} onClick=${() => A.demoAppraisal(a.id, 'complete')}>Visit done: send the report</button>
        </div></${Demo}>`}
    </div>
  </div>`;
}

// ---------- gift bullion and coins ----------
function GiftNew({ S, A }) {
  const svc = S.svc, d = S.giftDraft;
  const up = patch => A.set(s => ({ giftDraft: { ...s.giftDraft, ...patch } }));
  const [touched, setTouched] = useState(false);
  if (!svc || !d || S.rates.mode === 'connecting') return html`<div class="page"><${TopBar} title="Gift gold and silver" onBack=${A.back} /><div class="scroll"><div class="pad"><span class="sk" style="height:320px"></span></div></div></div>`;
  const items = svc.gift.items.filter(i => i.metal === d.metal);
  const it = svc.gift.items.find(i => i.id === d.item) || items[0] || svc.gift.items[0];
  if (!it) return html`<div class="page"><${TopBar} title="Gift gold and silver" onBack=${A.back} /><div class="scroll"><${Empty} icon="gift" title="Gifts aren’t available right now" body="PGBX isn’t taking gift orders at the moment. Check back soon." /></div></div>`;
  const price = giftPrice({ ...d, item: it.id }, svc, S.rates);
  const minDate = pkDay(Date.now() + svc.gift.leadDays * 86400e3);
  const phone = d.phone.replace(/\D/g, '').replace(/^92/, '').replace(/^0/, '');
  const errs = {
    name: d.name.trim().length < 3 ? 'Enter the recipient’s full name.' : '',
    phone: !PK_MOBILE.test(phone) ? 'Enter the recipient’s mobile number. The courier calls before delivery.' : '',
    address: d.address.trim().length < 10 ? 'Enter the full address, including house number and street.' : '',
    deliverBy: !d.deliverBy || d.deliverBy < minDate ? `Choose ${dayName(minDate)} or later. Each piece is made to order.` : '',
  };
  const ok = !Object.values(errs).some(Boolean);
  const E = k => touched && errs[k] && html`<div class="hint err">${errs[k]}</div>`;
  const pickMetal = m => { const first = svc.gift.items.find(i => i.metal === m); if (!first) { A.toast(`${metalName(m)} gifts aren’t available right now.`); return; } up({ metal: m, item: first.id, shape: first.shapes.includes(d.shape) ? d.shape : first.shapes[0] }); };
  const pickItem = i => up({ item: i.id, shape: i.shapes.includes(d.shape) ? d.shape : i.shapes[0] });
  const pay = () => { if (!ok) { setTouched(true); showFirstError(); return; } if (RATE_CHAT) A.rateChat('gift', { item: it.id, shape: d.shape, design: d.design, engraving: d.engraving, packaging: d.packaging }, price.total); else A.placeGift(); };
  return html`<div class="page has-actions">
    <${TopBar} title="Gift gold and silver" onBack=${A.back} />
    <div class="scroll">
      <div class="gift-stage"><${GiftPreview} d=${{ ...d, item: it.id }} svc=${svc} /></div>
      <div class="pad"><p class="muted" style="text-align:center">Made to order in 999.0 ${d.metal}, packed in a gift box and delivered by insured courier, like sending flowers, but it keeps its value.</p></div>
      <section class="sec"><div class="sec-h"><h3>Choose the piece</h3></div><div class="card">
        <${Seg} label="Metal" items=${[['gold', 'Gold'], ['silver', 'Silver']]} value=${d.metal} onChange=${pickMetal} />
        <div class="chips" style="margin-top:12px" role="radiogroup" aria-label="Weight">${items.map(i => html`<button class=${'chipb' + (it.id === i.id ? ' on' : '')} role="radio" aria-checked=${it.id === i.id} onClick=${() => pickItem(i)}>${i.label}<span class="chip-sub">${fmt(giftItemPrice(i, S.rates))}</span></button>`)}</div>
        <div style="margin-top:12px"><${Seg} label="Shape" items=${[['coin', 'Coin'], ['bar', 'Bar']]} value=${d.shape} onChange=${v => (it.shapes.includes(v) ? up({ shape: v }) : A.toast(`${it.label} is made as a ${it.shapes[0]} only.`))} /></div>
      </div></section>
      <section class="sec"><div class="sec-h"><h3>Design</h3></div><div class="card">
        <div class="chips" role="radiogroup" aria-label="Design">${DESIGNS.map(([k, l]) => html`<button class=${'chipb' + (d.design === k ? ' on' : '')} role="radio" aria-checked=${d.design === k} onClick=${() => up({ design: k })}>${l}</button>`)}</div>
        <label class="field"><span class="lbl">Engraving (optional)</span><input class="inp" maxlength="24" placeholder="e.g. Ayesha · 12.10.2026" value=${d.engraving} onInput=${e => up({ engraving: e.target.value.slice(0, 24) })} />
          <div class="hint">${24 - d.engraving.length} characters left · adds ${fmt(svc.gift.making.engraving)}. Check the spelling; it can’t be changed once the piece is made.</div></label>
        <label class="field"><span class="lbl">Gift card message (optional)</span><textarea class="inp" rows="3" maxlength="200" placeholder="Write a few words for them" value=${d.message} onInput=${e => up({ message: e.target.value.slice(0, 200) })}></textarea></label>
        <div class="field"><span class="lbl">Packaging</span><div class="group" style="margin:0;box-shadow:inset 0 0 0 1px var(--border)" role="radiogroup" aria-label="Packaging">
          ${[['standard', 'Gift box', 'Included'], ['premium', 'Velvet box with ribbon', '+ ' + fmt(svc.gift.packaging.premium)]].map(([k, l, s]) => html`<button class="row" onClick=${() => up({ packaging: k })} role="radio" aria-checked=${d.packaging === k}><div class="rt"><b>${l}</b><span>${s}</span></div><${Radio} on=${d.packaging === k} /></button>`)}
        </div></div>
      </div></section>
      <section class="sec"><div class="sec-h"><h3>Deliver to</h3></div><div class="card">
        <label class="field" style="margin-top:0"><span class="lbl">Recipient’s name</span><input class=${'inp' + (touched && errs.name ? ' bad' : '')} value=${d.name} onInput=${e => up({ name: e.target.value })} />${E('name')}</label>
        <label class="field"><span class="lbl">Recipient’s mobile</span><span class=${'phone' + (touched && errs.phone ? ' bad' : '')}><span class="cc">+92</span><input inputmode="numeric" placeholder="300 1234567" value=${d.phone} onInput=${e => up({ phone: e.target.value.replace(/\D/g, '').slice(0, 11) })} /></span>${E('phone')}</label>
        <label class="field"><span class="lbl">City</span><select class="inp" value=${d.city} onChange=${e => up({ city: e.target.value })}>${svc.gift.cities.map(c => html`<option value=${c}>${c}</option>`)}</select></label>
        <label class="field"><span class="lbl">Full address</span><textarea class=${'inp' + (touched && errs.address ? ' bad' : '')} rows="2" placeholder="House, street, area" value=${d.address} onInput=${e => up({ address: e.target.value })}></textarea>${E('address')}</label>
        <label class="field"><span class="lbl">Deliver by</span><input class=${'inp' + (touched && errs.deliverBy ? ' bad' : '')} type="date" min=${minDate} value=${d.deliverBy} onInput=${e => up({ deliverBy: e.target.value })} />
          ${E('deliverBy') || html`<div class="hint">Earliest ${dayName(minDate)}: each piece is made to order.</div>`}</label>
        <p class="small muted" style="margin-top:12px">The recipient shows their CNIC to the courier. They don’t need the PGBX app.</p>
      </div></section>
      <section class="sec"><div class="sec-h"><h3>Price</h3>${!LIVE && html`<${Sample}/>`}</div><div class="card">
        <div class="kv"><span>${it.label} ${d.metal} at today’s buy price</span><b>${fmt(price.metal)}</b></div>
        <div class="kv"><span>Making${d.design !== 'plain' ? ', themed design' : ''}${d.engraving.trim() ? ' and engraving' : ''}</span><b>${fmt(price.making)}</b></div>
        ${price.packaging > 0 && html`<div class="kv"><span>Velvet box</span><b>${fmt(price.packaging)}</b></div>`}
        <div class="kv"><span>Insured delivery</span><b>${fmt(price.delivery)}</b></div>
        <div class="kv total"><span>Total</span><b><${Odo} value=${price.total} /></b></div>
        <p class="tiny muted" style="margin-top:8px">${RATE_CHAT ? 'Indicative: PGBX support confirms the final price in chat before you pay.' : 'The metal price follows the live rate and is fixed when you pay.'}</p>
      </div></section>
      <${RateNotice} S=${S} A=${A} />
      <section class="sec"><div class="sec-h"><h3>Pay with</h3></div>
        <div class="group inset" role="radiogroup" aria-label="Payment method">
          ${METHODS.map(m => html`<button class="row" onClick=${() => A.set({ method: m.id })} role="radio" aria-checked=${S.method === m.id}><span class="ri"><${Icon} n=${m.icon} c="sm"/></span><div class="rt"><b>${m.name}</b><span>${m.sub}</span></div><${Radio} on=${S.method === m.id} /></button>`)}
        </div></section>
      ${S.stale && html`<${StaleBanner} S=${S}/>`}
      ${S.offline && html`<${Notice} kind="warning" icon="wifiOff" title="You’re offline">Connect to the internet to order.</${Notice}>`}
    </div>
    <${ActionBar} label=${RATE_CHAT ? 'Total (indicative)' : 'Total'} amount=${fmt(price.total)}>
      <button class="btn btn-primary" disabled=${S.paying || S.offline || S.stale} onClick=${pay}>${S.paying ? html`<span class="spin"></span> Placing order` : RATE_CHAT ? html`<${Icon} n="chat" c="sm"/> Get final rate via chat` : html`<${Icon} n="lock" c="sm"/> Pay ${fmt(price.total)}`}</button>
    </${ActionBar}>
  </div>`;
}

function GiftDetail({ S, A, id }) {
  const g = S.giftOrders.find(x => x.id === id), svc = S.svc;
  if (!g || !svc) return html`<div class="page"><${TopBar} title="Gift order" onBack=${A.back} /><div class="scroll"><${Empty} icon="gift" title="Order not found" body="It may still be loading. Try again in a moment." /></div></div>`;
  const order = ['placed', 'in_production', 'dispatched', 'delivered'], idx = order.indexOf(g.status);
  const labels = { placed: 'Placed', in_production: 'Being made', dispatched: 'On its way', delivered: 'Delivered' };
  const it = svc.gift.items.find(i => i.id === g.item);
  const cancel = () => A.confirm({ title: 'Cancel this gift order?', body: g.status === 'pending_payment' ? 'Nothing has been paid for this order yet.' : 'Your payment will be refunded to your payment method.', confirm: 'Cancel order', cancel: 'Keep it', danger: true, onConfirm: () => A.cancelGift(g.id) });
  return html`<div class="page">
    <${TopBar} title="Gift order" onBack=${A.back} />
    <div class="scroll">
      <div class="gift-stage"><${GiftPreview} d=${{ item: g.item, shape: g.shape, design: g.design, engraving: g.engraving || '' }} svc=${svc} size=${132} /></div>
      <div class="card" style="text-align:center;padding:20px 16px">
        <span class=${'tag ' + GIFT_TAG[g.status]}>${GIFT_LABEL[g.status]}</span>
        <div style="font:600 20px/1.25 var(--serif);margin-top:10px">${giftTitle(g, svc)} for ${g.recipient.name}</div>
        ${g.status !== 'cancelled' && html`<div class="steps">${order.map((k, i) => html`<div class=${'step' + (i < idx || g.status === 'delivered' ? ' done' : i === idx ? ' cur' : '')}><div class="sd">${i < idx || g.status === 'delivered' ? html`<${Icon} n="check"/>` : i + 1}</div>${labels[k]}</div>`)}</div>`}
        ${g.status === 'cancelled' && html`<p class="small muted" style="margin-top:12px">${g.refundDue ? 'Cancelled. Your payment will be refunded.' : 'Cancelled.'}</p>`}
        ${g.tracking && html`<p class="small" style="margin-top:12px">Courier tracking <b class="mono">${g.tracking}</b></p>`}
      </div>
      <section class="sec"><div class="sec-h"><h3>Details</h3></div><div class="card">
        <div class="kv"><span>Reference</span><b class="mono">${g.ref}</b></div>
        <div class="kv"><span>Piece</span><b>${it ? `${it.label} ${it.metal}` : g.item}, ${g.shape}</b></div>
        <div class="kv"><span>Design</span><b>${(DESIGNS.find(x => x[0] === g.design) || DESIGNS[0])[1]}</b></div>
        ${g.engraving && html`<div class="kv"><span>Engraving</span><b>“${g.engraving}”</b></div>`}
        ${g.message && html`<div class="kv"><span>Card</span><b style="text-align:right;font-weight:500">${g.message}</b></div>`}
        <div class="kv"><span>Deliver to</span><b style="text-align:right">${g.recipient.name}, ${g.recipient.address}, ${g.recipient.city}</b></div>
        <div class="kv"><span>Deliver by</span><b>${dayName(g.deliverBy)}</b></div>
        <div class="kv"><span>Metal</span><b>${fmt(g.metal_pkr)}</b></div>
        <div class="kv"><span>Making</span><b>${fmt(g.making_pkr)}</b></div>
        ${g.packaging_pkr > 0 && html`<div class="kv"><span>Velvet box</span><b>${fmt(g.packaging_pkr)}</b></div>`}
        <div class="kv"><span>Insured delivery</span><b>${fmt(g.delivery_pkr)}</b></div>
        <div class="kv total"><span>Total paid</span><b>${fmt(g.total)}</b></div>
      </div></section>
      ${(g.status === 'placed' || g.status === 'pending_payment') && html`<div class="pad" style="margin-top:24px"><button class="btn btn-danger" onClick=${cancel}>Cancel order</button>
        <p class="hint" style="text-align:center">You can cancel until the refinery starts making it.</p></div>`}
      ${['placed', 'in_production', 'dispatched'].includes(g.status) && html`<${Demo} title="Refinery and courier" body="In the real system PGBX operations updates this in the admin panel.">
        <button class="btn btn-secondary btn-sm" style="width:100%" onClick=${() => A.demoGift(g.id)}>${{ placed: 'Start making it', in_production: 'Hand to the courier', dispatched: 'Mark delivered' }[g.status]}</button></${Demo}>`}
    </div>
  </div>`;
}

/* ============================================================
   App (shared state)
   ============================================================ */
const TABS = [['rates', 'Rates'], ['buy', 'Buy'], ['services', 'Services'], ['wallet', 'Wallet'], ['account', 'Account']];
const OPEN_TABS = ['rates', 'services'];          // guests can use these (the jewellery worth calculator is free for everyone)
const GUEST_PUSH = ['worth', 'micro'];
const GUEST_REASON = { buy: 'Log in to buy gold and silver.', wallet: 'Log in to see your wallet.', account: 'Log in to manage your account.' };

// Prototype data is kept in this browser so a refresh does not wipe the demo. Sample data only; nothing leaves the device.
const STORE_KEY = LIVE ? 'pgbx-device-v1' : 'pgbx-demo-v1';
const KEEP = LIVE ? ['worth', 'cart', 'pin', 'pinFails', 'pinLockUntil', 'phone', 'biometric', 'notifPrefs', 'tips', 'pinSet', 'loggedIn'] : ['ledger', 'orders', 'redemptions', 'dealerStock', 'cart', 'profile', 'kyc', 'pin', 'pinFails', 'pinLockUntil', 'phone',
  'notifications', 'notifPrefs', 'alerts', 'biometric', 'tab', 'buyMetal', 'loggedIn', 'pinSet', 'tips', 'appraisals', 'giftOrders', 'worth', 'micro', 'chats', 'barSales'];
function loadSaved() { try { const d = JSON.parse(localStorage.getItem(STORE_KEY) || 'null'); return d && d.v === 1 && d.s && typeof d.s === 'object' ? sanitizeSaved(d.s) : null; } catch (e) { return null; } }

// Saved data is untrusted (it may be damaged or from an older app version): keep only well-formed values,
// convert the older single-product order format, and let everything else fall back to defaults.
function sanitizeSaved(s) {
  const out = {};
  const isObj = v => v && typeof v === 'object' && !Array.isArray(v);
  const num = v => typeof v === 'number' && isFinite(v);
  const int = (v, lo, hi) => Number.isInteger(v) && v >= lo && v <= hi;
  const str = v => typeof v === 'string';
  const list = (v, ok) => (Array.isArray(v) ? v.filter(x => isObj(x) && ok(x)) : null);
  const line = l => isObj(l) && P[l.pid] && int(l.units, 1, MAX_UNITS) && (l.unit === undefined || num(l.unit));
  const set = (k, v) => { if (v !== null && v !== undefined) out[k] = v; };
  const serialsOk = v => v === undefined || (Array.isArray(v) && v.every(str));
  set('ledger', list(s.ledger, e => P[e.pid] && Number.isInteger(e.delta) && num(e.ts) && str(e.reason) && str(e.ref) && serialsOk(e.serials)));
  if (Array.isArray(s.orders)) set('orders', s.orders.map(o => {
    if (!isObj(o) || !str(o.id) || !str(o.receipt) || !num(o.ts)) return null;
    const lines = Array.isArray(o.lines) ? o.lines : (P[o.pid] ? [{ pid: o.pid, units: o.units, unit: o.unit }] : null);
    if (!lines || !lines.length || !lines.every(l => line(l) && num(l.unit))) return null;
    return { ...o, lines, total: num(o.total) ? o.total : lines.reduce((a, l) => a + l.unit * l.units, 0), method: METHODS.some(m => m.id === o.method) ? o.method : 'bank', status: o.status === 'flagged' ? 'flagged' : 'credited' };
  }).filter(Boolean));
  set('redemptions', list(s.redemptions, r => str(r.id) && P[r.pid] && int(r.units, 1, 1000) && DEALERS.some(d => d.id === r.dealerId) && /^\d{6}$/.test(r.code) && num(r.expiresAt) && ['requested', 'ready', 'completed', 'cancelled'].includes(r.status) && serialsOk(r.serials)));
  set('cart', list(s.cart, line));
  const notes = list(s.notifications, n => str(n.id) && num(n.ts) && str(n.title) && str(n.body) && str(n.kind));
  set('notifications', notes && notes.map(n => (n.link && !(isObj(n.link) && LINK_NAMES.includes(n.link.name)) ? { ...n, link: undefined } : n)));
  set('alerts', list(s.alerts, a => str(a.id) && (a.metal === 'gold' || a.metal === 'silver') && (a.dir === 'above' || a.dir === 'below') && num(a.target) && a.target > 0));
  if (isObj(s.dealerStock) && DEALERS.every(d => isObj(s.dealerStock[d.id]) && PRODUCTS.every(p => int(s.dealerStock[d.id][p.id], 0, 1e6)))) out.dealerStock = s.dealerStock;
  if (isObj(s.profile) && str(s.profile.name) && s.profile.name.trim().length >= 1)
    out.profile = { name: s.profile.name, cnic: str(s.profile.cnic) ? s.profile.cnic : '', dob: str(s.profile.dob) ? s.profile.dob : '', email: str(s.profile.email) ? s.profile.email : '', address: str(s.profile.address) ? s.profile.address : '' };
  if (isObj(s.kyc) && ['none', 'pending', 'verified', 'reverify'].includes(s.kyc.status)) out.kyc = { status: s.kyc.status === 'pending' ? 'none' : s.kyc.status, at: num(s.kyc.at) ? s.kyc.at : null, expiry: str(s.kyc.expiry) ? s.kyc.expiry : '' };
  if (isObj(s.notifPrefs)) out.notifPrefs = { push: s.notifPrefs.push !== false, sms: s.notifPrefs.sms !== false, email: s.notifPrefs.email === true, alerts: s.notifPrefs.alerts !== false };
  if (typeof s.pinSet === 'boolean') out.pinSet = s.pinSet;
  if (isObj(s.tips)) out.tips = Object.fromEntries(Object.entries(s.tips).filter(([, v]) => typeof v === 'boolean'));
  if (str(s.pin) && (LIVE ? /^h1\$[0-9a-f]{32}\$[0-9a-f]{64}$/ : /^\d{4}$/).test(s.pin)) out.pin = s.pin;
  if (int(s.pinFails, 0, PIN_MAX_FAILS)) out.pinFails = s.pinFails;
  if (num(s.pinLockUntil)) out.pinLockUntil = Math.min(s.pinLockUntil, Date.now() + 30000);
  if (str(s.phone) && (s.phone === '' || PK_MOBILE.test(s.phone))) out.phone = s.phone;
  if (typeof s.biometric === 'boolean') out.biometric = s.biometric;
  const metalOk = m => m === 'gold' || m === 'silver';
  set('appraisals', list(s.appraisals, a => str(a.id) && str(a.ref) && /^\d{4}-\d{2}-\d{2}$/.test(a.date) && str(a.slot) && Array.isArray(a.items) && a.items.every(i => isObj(i) && metalOk(i.metal)) && str(a.status) && str(a.visitCode) && str(a.city) && str(a.area)));
  set('giftOrders', list(s.giftOrders, g => str(g.id) && str(g.ref) && str(g.item) && isObj(g.recipient) && str(g.recipient.name) && str(g.recipient.city) && str(g.status) && num(g.total) && str(g.deliverBy)));
  if (isObj(s.micro) && num(s.micro.grams) && s.micro.grams >= 0 && Array.isArray(s.micro.txns) && isObj(s.micro.lots) && isObj(s.micro.lots.buy) && isObj(s.micro.lots.sell))
    out.micro = { grams: s.micro.grams, lots: s.micro.lots, txns: s.micro.txns.filter(t => isObj(t) && str(t.ref) && (t.side === 'buy' || t.side === 'sell') && num(t.grams) && num(t.amount) && num(t.ts) && str(t.status) && Array.isArray(t.lots)) };
  // rate chats: photos sent in the demo were only on screen (object URLs), so they don't survive a reload
  set('chats', list(s.chats, c => str(c.id) && str(c.ref) && CHAT_KIND[c.kind] && CHAT_STATUS[c.status] && str(c.summary) && num(c.lastAt) && isObj(c.details) && Array.isArray(c.messages))
    ?.map(c => ({ ...c, unread: int(c.unread, 0, 1e4) ? c.unread : 0, messages: c.messages.filter(m => isObj(m) && num(m.ts) && ['customer', 'staff', 'system'].includes(m.sender)).map(m => (m.attachment ? { ...m, attachment: { ...m.attachment, url: undefined } } : m)),
      confirmation: isObj(c.confirmation) && num(c.confirmation.expiresAt) && num(c.confirmation.total) && isObj(c.confirmation.prices) ? c.confirmation : null })));
  set('barSales', list(s.barSales, b => str(b.ref) && num(b.total) && num(b.ts) && Array.isArray(b.lines) && str(b.status)));
  set('worth', list(s.worth, w => str(w.id) && metalOk(w.metal) && str(w.karat) && KARATS_ALL[w.metal].includes(w.karat)));
  if (s.tab === 'redeem') out.tab = 'services';                       // the Redeem tab moved into Services
  else if (TABS.some(t => t[0] === s.tab)) out.tab = s.tab;
  if (s.buyMetal === 'gold' || s.buyMetal === 'silver') out.buyMetal = s.buyMetal;
  if (typeof s.loggedIn === 'boolean') out.loggedIn = s.loggedIn;
  if (LIVE && !out.pinSet) out.loggedIn = false;                      // no PIN chosen on this phone: log in again
  return out;
}
let saveOff = false;                       // set once the phone's data is cleared: a late save must not bring it back
function saveState(st) { if (saveOff) return; try { localStorage.setItem(STORE_KEY, JSON.stringify({ v: 1, s: Object.fromEntries(KEEP.map(k => [k, st[k]])) })); } catch (e) { } }
function clearSaved() { saveOff = true; try { localStorage.removeItem(STORE_KEY); } catch (e) { } }
const SAVED = loadSaved();
// A one-off message carried across a reload (for example after closing an account)
const CARRY_NOTE = (() => { try { const n = sessionStorage.getItem('pgbx-note'); sessionStorage.removeItem('pgbx-note'); return n || ''; } catch (e) { return ''; } })();

// Account data. Cleared on logout and session end; hidden while browsing as a guest.
const ACCOUNT_BLANK = LIVE ? { synced: false, missing: [], lastIban: '', termsVersion: null, ledger: [], orders: [], redemptions: [], notifications: [], alerts: [], appraisals: [], giftOrders: [], chats: [], barSales: [], banner: null, apprDraft: null, giftDraft: null, micro: { grams: 0, txns: [], lots: null },
  profile: { name: '', cnic: '', dob: '', email: '', address: '' }, kyc: { status: 'none', at: null }, checkout: [], lock: null } : {};
const GUEST_VIEW = { ledger: [], orders: [], redemptions: [], notifications: [], alerts: [], appraisals: [], giftOrders: [], chats: [], barSales: [], banner: null, micro: { grams: 0, txns: [], lots: { buy: { no: 1, filled: 0 }, sell: { no: 1, filled: 0 } } } };
// A request key for a draft: the same draft sent twice (a retry after a lost answer) books once; any change makes a new one
const draftKey = (prefix, d) => { const { key, ...rest } = d; return prefix + (key || '') + hex(sha256(new TextEncoder().encode(JSON.stringify(rest)))).slice(0, 24); };
const apprDefaults = s => ({ key: uid() + uid(), items: [{ metal: 'gold', karat: '', approx_g: 0, note: '' }], date: '', slot: '', city: (s.svc && s.svc.appraisal.cities[0]) || 'Karachi', area: '', address: (s.profile && s.profile.address) || '', phone: s.phone || '', notes: '' });
const giftDefaults = s => { const it = (s.svc && s.svc.gift.items[0]) || { id: 'gg-1g', metal: 'gold', shapes: ['coin'] };
  return { key: uid() + uid(), metal: it.metal, item: it.id, shape: (it.shapes || ['coin'])[0], design: 'eid', engraving: '', message: '', packaging: 'premium', name: '', phone: '', city: (s.svc && s.svc.gift.cities && s.svc.gift.cities[0]) || 'Karachi', address: '',
  deliverBy: pkDay(Date.now() + (((s.svc && s.svc.gift.leadDays) || 5) + 2) * 86400e3) }; };

function App() {
  const [phase, setPhase] = useState(START === 'home' ? 'app' : START === 'login' ? 'login' : START === 'pin' ? 'pin' : 'splash');
  const returning = !!(SAVED && SAVED.loggedIn);   // a returning customer unlocks with the PIN instead of logging in again
  const [st, setSt] = useState(() => ({
    guest: false, tab: 'rates', stack: [], navDir: 'fade', buyMetal: 'gold', qty: 1, lock: null, method: 'bank', paying: false, phone: '',
    rates: initialRates(), ledger: LIVE ? [] : initialLedger(), orders: [], redemptions: [], dealerStock: LIVE ? {} : initialDealerStock(), premiums: null,
    biometric: !LIVE, toast: null, lockNote: '', loginNote: '',   // production: only when the customer switches it on
    // loginIntent: why the customer was sent to log in and where to take them afterwards ({ note, go: { tab } | { pid } })
    loginIntent: CARRY_NOTE ? { note: CARRY_NOTE } : null, pinReset: false, tips: {},
    // pinSet: whether this phone has a PIN the customer chose. Demo links that skip login use the demo PIN.
    pinSet: LIVE ? false : !!SAVED || START === 'home' || START === 'pin',
    profile: LIVE ? { name: '', cnic: '', dob: '', email: '', address: '' } : { name: 'Ahmed Khan', cnic: KYC_START === 'verified' ? '42000-0000000-1' : '', dob: KYC_START === 'verified' ? '1990-01-01' : '', email: '', address: '' },
    kyc: { status: KYC_START, at: KYC_START === 'verified' ? Date.now() - 20 * 86400e3 : null },
    pin: LIVE ? null : PIN_DEFAULT, pinFails: 0, pinLockUntil: 0,
    cart: [], checkout: [], checkoutFrom: 'now', simCreditFail: false,
    appraisals: [], giftOrders: [], worth: [], chats: [], barSales: [], apprDraft: null, giftDraft: null, svc: LIVE ? null : SVC_SAMPLE,
    // $1 gold. Demo: the pool already holds other customers' gold, so the open lot isn't empty.
    micro: { grams: 0, txns: [], lots: { buy: { no: 3, filled: 7.912 }, sell: { no: 1, filled: 2.406 } } }, microQuote: null,
    notifications: [], banner: null, notifPrefs: { push: true, sms: true, email: false, alerts: true },
    alerts: [], history: {}, dialog: null, offline: typeof navigator !== 'undefined' && navigator.onLine === false,
    otpCfg: { checked: false, configured: false, channels: ['sms'] },
    loggedIn: false,
    ...(SAVED || {}),
    ...(START === 'home' ? { loggedIn: true } : {}),
    ...(KYC_START === 'verified' ? { kyc: { status: 'verified', at: Date.now() - 20 * 86400e3 }, profile: { ...((SAVED && SAVED.profile) || { name: 'Ahmed Khan', email: '', address: '' }), cnic: (SAVED && SAVED.profile && SAVED.profile.cnic) || '42000-0000000-1', dob: (SAVED && SAVED.profile && SAVED.profile.dob) || '1990-01-01' } } : {}),
  }));
  const [now, setNow] = useState(Date.now());
  const phaseRef = useRef(phase); phaseRef.current = phase;
  const set = patch => setSt(s => ({ ...s, ...(typeof patch === 'function' ? patch(s) : patch) }));
  const lastActive = useRef(Date.now());
  const committed = useRef(new Set(st.orders.map(o => o.id)));       // idempotency (Rule 2 / NFR-1), survives refresh
  const receipts = useRef(new Set(st.orders.map(o => o.receipt)));
  const histLoading = useRef({});
  const lockSeq = useRef(0);
  const aRef = useRef(null);
  const guardRef = useRef(null);          // set by a screen with unsaved work; called with the navigation it would interrupt
  const stRef = useRef(null);             // latest state for the system back handler
  const histDepth = useRef(0), ignorePop = useRef(null);   // ignorePop: depth an app-initiated history.go() is heading to

  // On-screen keyboard: when it takes the bottom of the screen, the tab bar and the action bar's summary step aside so the
  // field being typed in stays visible above the buttons
  useEffect(() => {
    // Some phones shrink only the visible area, others (the Android app) the whole page: the second is caught by
    // comparing with the tallest page seen in this orientation while a text field has focus
    const vv = window.visualViewport; if (!vv) return;
    const tall = {};
    const typing = () => { const e = document.activeElement; return !!e && (e.tagName === 'TEXTAREA' || (e.tagName === 'INPUT' && !/^(checkbox|radio|button|submit|file|range|color)$/.test(e.type))); };
    const f = () => {
      const o = innerWidth > innerHeight ? 'l' : 'p';
      if (!typing()) tall[o] = Math.max(tall[o] || 0, innerHeight);
      document.documentElement.classList.toggle('kb', innerHeight - vv.height > 150 || (typing() && (tall[o] || innerHeight) - innerHeight > 150));
    };
    f();
    vv.addEventListener('resize', f, { passive: true }); addEventListener('resize', f, { passive: true });
    const out = () => setTimeout(f, 50);
    addEventListener('focusin', f); addEventListener('focusout', out);
    return () => { vv.removeEventListener('resize', f); removeEventListener('resize', f); removeEventListener('focusin', f); removeEventListener('focusout', out); };
  }, []);
  // The clock behind countdowns and "x min ago"; it stops while the app is in the background
  useEffect(() => {
    const t = setInterval(() => { if (document.visibilityState !== 'hidden') setNow(Date.now()); }, 1000);
    const back = () => { if (document.visibilityState === 'visible') setNow(Date.now()); };
    document.addEventListener('visibilitychange', back);
    return () => { clearInterval(t); document.removeEventListener('visibilitychange', back); };
  }, []);
  // Network state: tell the customer when they are offline instead of silently showing old prices
  useEffect(() => {
    const on = () => set({ offline: false }), off = () => set({ offline: true });
    addEventListener('online', on); addEventListener('offline', off);
    return () => { removeEventListener('online', on); removeEventListener('offline', off); };
  }, []);

  // FR-A1: ask the server whether a real SMS / WhatsApp provider is connected
  // Demo mode only when the server explicitly answers configured:false; an unreachable server is an error, never a bypass.
  const checkOtp = () => { set({ otpCfg: { checked: false, configured: false, channels: ['sms'] } }); otpCall().then(d => set({ otpCfg: d.error === 'unreachable' || typeof d.configured !== 'boolean' || (LIVE && !d.configured)
    ? { checked: true, unreachable: true, configured: false, channels: [] }
    : { checked: true, configured: d.configured, channels: d.channels && d.channels.length ? d.channels : ['sms'] } })); };
  useEffect(checkOtp, []);

  // Live rates: poll the server every 10 s (FR-R1). If it never answers, fall back to simulation.
  useEffect(() => {
    if (FEED_FAIL || FORCE_SIM) return;
    let alive = true, idx = 0, polling = false;
    const poll = async () => {
      if (polling) return false;                    // a slow answer is still on its way: don't start another
      polling = true;
      try { return await pollOnce(); } finally { polling = false; }
    };
    const pollOnce = async () => {
      for (let k = 0; k < API_URLS.length; k++) {
        const url = API_URLS[(idx + k) % API_URLS.length];
        try {
          const ctl = new AbortController(); const to = setTimeout(() => ctl.abort(), 8000);
          const r = await fetch(url, { cache: 'no-store', signal: ctl.signal }); clearTimeout(to);
          if (!r.ok) continue;
          const d = await r.json();
          if (!d || !d.ok || !d.metals) continue;
          idx = (idx + k) % API_URLS.length;
          const hdr = { date: r.headers.get('date'), age: r.headers.get('age') };
          if (alive) set(s => applyLive(s, d, hdr));
          return true;
        } catch (e) { }
      }
      return false;
    };
    poll().then(ok => { if (!ok && alive) set(s => (s.rates.mode !== 'connecting' ? {} : LIVE
      ? { toast: { msg: 'Live prices are unavailable right now. Buying is paused until they’re back.', id: Math.random() } }
      : { rates: { ...s.rates, mode: 'sim', updatedAt: Date.now() }, toast: { msg: 'Live rates are unavailable. Showing simulated rates.', id: Math.random() } })); });
    // Nothing is fetched while the app is in the background; prices are fetched again the moment it comes back
    const t = setInterval(() => { if (document.visibilityState !== 'hidden') poll(); }, POLL_MS);
    const back = () => { if (document.visibilityState === 'visible') poll(); };
    document.addEventListener('visibilitychange', back);
    return () => { alive = false; clearInterval(t); document.removeEventListener('visibilitychange', back); };
  }, []);

  // Simulated ticks (only when the live feed is unavailable, never with ?feedFail=1)
  useEffect(() => {
    if (FEED_FAIL) return;
    const t = setInterval(() => set(s => {
      if (s.rates.mode !== 'sim') return {};
      const step = (m, vol) => { const b = Math.round(s.rates[m].buy * (1 + (Math.random() - 0.5) * vol)); return { ...s.rates[m], buy: b, hist: [...s.rates[m].hist.slice(1), b] }; };
      return { rates: { ...s.rates, gold: step('gold', 0.003), silver: step('silver', 0.005), updatedAt: Date.now(), tick: s.rates.tick + 1 } };
    }), SIM_TICK_MS);
    return () => clearInterval(t);
  }, []);

  // ---------- production: the server is the source of truth ----------
  const knownNotes = useRef(null);
  const syncSeq = useRef(0);              // only the newest sync's answer is applied
  const readAt = useRef(0);
  const lastSync = useRef(null);          // the newest complete answer, for actions that need what the server now says               // when the customer last marked all notifications read
  const unchanged = (s, d) => { const out = {}; for (const k in d) out[k] = s[k] !== undefined && JSON.stringify(s[k]) === JSON.stringify(d[k]) ? s[k] : d[k]; return out; };
  const sessionEnded = note => { Live.forget(); knownNotes.current = null; syncSeq.current++;
    set({ ...ACCOUNT_BLANK, loggedIn: false, guest: false, stack: [], pinSet: false, pin: null, pinFails: 0, pinLockUntil: 0, biometric: false, loginIntent: null, loginNote: note || 'Your session has ended. Log in again to continue.' }); setPhase('login'); };
  const endedNote = e => (e.code === 'ACCOUNT_INACTIVE' || e.code === 'PIN_LOCKED_OUT' ? e.message : undefined);
  const sync = async () => {
    if (!LIVE) return;
    const n = ++syncSeq.current, n0 = Date.now();
    try {
      const d = await Live.loadAll();
      if (n !== syncSeq.current) return true;                  // a newer sync (or a logout) superseded this one
      lastSync.current = d;
      const ids = [...(d.ledger || []).map(e => e.pid), ...(d.redemptions || []).map(r => r.pid), ...(d.orders || []).flatMap(o => o.lines.map(l => l.pid))];
      if (ids.some(id => !P[id])) { ids.forEach(id => { if (!P[id]) learnProduct({ id }); }); loadProducts(); }
      const fresh = knownNotes.current && d.notifications ? d.notifications.filter(n => !knownNotes.current.has(n.id) && !n.read && !n.quiet) : [];
      if (d.notifications) knownNotes.current = new Set(d.notifications.map(n => n.id));
      // A mark-all-read made while this sync was on its way wins over the older unread flags
      if (d.notifications && readAt.current > n0) d.notifications = d.notifications.map(x => ({ ...x, read: true }));
      // Parts that didn't change keep their old objects, so screens (and Keep lists) don't redraw for nothing
      set(s => {
        const t = s.stack[s.stack.length - 1];
        const reading = fresh.length && fresh[0].link && fresh[0].link.name === 'chat' && t && t.name === 'chat' && t.id === fresh[0].link.id;   // already on screen
        return { ...unchanged(s, d), synced: s.synced || !d.missing.length, banner: fresh.length && !reading && s.notifPrefs.push && !(fresh[0].kind === 'alert' && s.notifPrefs.alerts === false) ? fresh[0] : s.banner };
      });
      return !d.missing.length;
    } catch (e) { if (Live.signedOut(e)) sessionEnded(endedNote(e)); return false; }
  };
  const loadDealers = () => Live.dealers().then(ds => {
    DEALERS.splice(0, DEALERS.length, ...ds.map(d => ({ ...d, km: kmTo(d), out: [] })));
    set({ dealersFailed: false, dealerStock: Object.fromEntries(ds.map(d => [d.id, Object.fromEntries(PRODUCTS.map(p => [p.id, d.available[p.id] || 0]))])) });
  }).catch(() => set({ dealersFailed: true }));
  // Dealers, product premiums and service settings are public. Whatever hasn't loaded is asked for again when the
  // connection comes back, when the app returns to the front, and from the Try again buttons.
  const loadProducts = () => Live.products().then(ps => { ps.forEach(learnProduct); set({ premiums: Object.fromEntries(ps.map(p => [p.id, p.premium_pkr])) }); }).catch(() => {});
  const loadPublic = () => {
    if (!LIVE) return;
    if (!DEALERS.length) loadDealers();
    if (!stRef.current || !stRef.current.premiums) loadProducts();
    // Service fees, deductions and cities from PGBX's settings (public, so guests can use the calculator)
    if (!stRef.current || !stRef.current.svc) Live.servicesConfig().then(c => set({ svc: { purity: c.purity, buybackDeductionPct: c.buybackDeductionPct, appraisal: c.appraisal,
      gift: { ...c.gift, items: c.gift.items.map(i => ({ id: i.id, metal: i.metal, label: i.label, grams: i.grams, shapes: i.shapes })) } } })).catch(() => {});
  };
  useEffect(() => {
    if (!LIVE) return;
    Live.restoreSession();
    loadPublic();
    const again = () => { if (document.visibilityState !== 'hidden') loadPublic(); };
    addEventListener('online', again); document.addEventListener('visibilitychange', again);
    const t = setInterval(again, PUBLIC_RETRY_MS);
    return () => { removeEventListener('online', again); document.removeEventListener('visibilitychange', again); clearInterval(t); };
  }, []);
  const signedIn = phase === 'app' && st.loggedIn && !st.guest;
  // Production: a customer who hasn't accepted the current terms (they changed, or the account is older than the
  // login-screen consent) is asked once per app start; declining logs out.
  const termsAsked = useRef(false);
  useEffect(() => {
    if (!signedIn) { termsAsked.current = false; return; }
    if (!LIVE || !st.synced || termsAsked.current || st.termsVersion === TERMS_VERSION) return;
    termsAsked.current = true;
    set({ dialog: { title: 'Updated terms', body: 'Please read and accept PGBX’s Terms of use and Privacy policy to keep using the app. You can read them in Account › Terms and privacy.',
      confirm: 'I accept', cancel: 'Log out',
      onConfirm: () => Live.acceptTerms(TERMS_VERSION).then(() => set({ termsVersion: TERMS_VERSION }), e => { termsAsked.current = false; liveFail(e); }),
      onCancel: () => ACT.logout() } });
  }, [signedIn, st.synced, st.termsVersion]);
  useEffect(() => {
    if (!LIVE || !signedIn) return;
    sync();
    const t = setInterval(() => { if (document.visibilityState !== 'hidden') sync(); }, SYNC_MS);
    const vis = () => document.visibilityState === 'visible' && sync();
    document.addEventListener('visibilitychange', vis);
    return () => { clearInterval(t); document.removeEventListener('visibilitychange', vis); };
  }, [signedIn]);
  // Native app: register for push once signed in, and open what a tapped notification points to
  useEffect(() => {
    const push = LIVE && window.PGBXNative && window.PGBXNative.push;
    if (!push || !signedIn) return;
    push.register(t => Live.registerPush(t.token, t.platform).catch(() => {}));
    const open = e => { sync().then(() => aRef.current.openLink(e.detail)); };   // the newest actions, with the synced state
    addEventListener('pgbx-open-link', open); return () => removeEventListener('pgbx-open-link', open);
  }, [signedIn]);
  // A failed request shows its plain-language message; an expired session goes back to login.
  const liveFail = e => { if (Live.signedOut(e)) sessionEnded(endedNote(e)); else if (!Live.isLocked(e)) toast(e.message); };
  // Production: the server locked the session (a few minutes without use): show the lock screen, keep the place
  const lockApp = note => {
    if (phaseRef.current !== 'app' || !stRef.current.loggedIn || stRef.current.guest) return;
    set({ lockNote: note || 'Enter your PIN to continue', dialog: null }); setPhase('pin');
  };
  // Whenever the lock screen shows, the server session is locked too, so the session can't be used without the PIN
  useEffect(() => { if (LIVE && phase === 'pin') Live.lockNow(); }, [phase]);
  useEffect(() => {
    if (!LIVE) return;
    const locked = () => lockApp();
    let away = 0, limit = 30000;
    // Paying in the in-app browser pauses the app on Android: allow up to 10 minutes for that before locking
    const pause = () => { away = Date.now(); limit = window.PGBXNative?.browserOpen ? 600000 : 30000; };
    const resume = () => { if (away && Date.now() - away > limit) { Live.lockNow(); lockApp('Locked while PGBX was in the background'); } away = 0; };
    const closed = () => { if (phaseRef.current === 'app') sync(); };    // back from a payment page
    addEventListener('pgbx-locked', locked); addEventListener('pgbx-pause', pause); addEventListener('pgbx-resume', resume); addEventListener('pgbx-browser-closed', closed);
    return () => { removeEventListener('pgbx-locked', locked); removeEventListener('pgbx-pause', pause); removeEventListener('pgbx-resume', resume); removeEventListener('pgbx-browser-closed', closed); };
  }, []);

  // Stale when the server stops answering (30 s) or answers with prices that are themselves old (90 s)
  // Production: no live prices yet counts as stale, so nothing can be bought on a guess
  const stale = (LIVE && st.rates.mode !== 'live') || (st.rates.mode !== 'connecting' && (now - (st.rates.polledAt || st.rates.updatedAt) > STALE_MS || now - st.rates.updatedAt > DATA_STALE_MS));
  const top = st.stack[st.stack.length - 1];

  // action: { label, fn } adds a button such as Undo to the toast
  function toast(msg, action) { set({ toast: { msg, id: Math.random(), action } }); }
  // FR-N1: every notice lands in the inbox. A push banner shows only for things that happen in the background
  // (dealer updates, alerts, operations); `quiet` is for actions the customer just took and can already see confirmed.
  // link: the screen the notification opens (a collection, a receipt, a rate chart), so no notification is a dead end.
  function notify(kind, title, body, quiet, link) {
    const n = { id: uid() + uid(), ts: Date.now(), kind, title, body, read: false, link };
    if (LIVE) { if (!quiet) set(s => ({ banner: s.notifPrefs.push ? n : s.banner })); return; }
    set(s => ({ notifications: [n, ...s.notifications].slice(0, 60), banner: s.notifPrefs.push && !quiet && !(kind === 'alert' && s.notifPrefs.alerts === false) ? n : s.banner }));
  }

  // ---------- demo rate chat: a sample PGBX support reply and confirmation (production: real staff in the admin panel) ----------
  const demoAsked = useRef(new Set());
  function demoMsg(id, msg) {
    const ts = Date.now();
    set(s => ({ chats: s.chats.map(c => {
      if (c.id !== id) return c;
      const top = s.stack[s.stack.length - 1], watching = top && top.name === 'chat' && top.id === id;
      const m = { id: c.messages.reduce((a, x) => Math.max(a, x.id), 0) + 1, ts, body: '', ...msg };
      return { ...c, messages: [...c.messages, m], lastAt: ts, lastBody: m.body || (m.attachment ? m.attachment.name : ''), unread: msg.sender === 'staff' && !watching ? (c.unread || 0) + 1 : c.unread || 0 };
    }) }));
    if (msg.sender === 'customer') setTimeout(() => {
      const c = (stRef.current.chats || []).find(x => x.id === id);
      if (c && c.status !== 'closed') demoMsg(id, { sender: 'staff', staffName: 'Sana', body: msg.attachment ? 'Thanks, we’ve received your file.' : 'Thanks, noted. Anything else I can help with on this request?' });
    }, 1500);
  }
  function demoConfirm(id) {
    const s = stRef.current, c = (s.chats || []).find(x => x.id === id);
    const live = c && c.confirmation && c.confirmation.status === 'valid' && c.confirmation.expiresAt > Date.now();
    if (!c || !['open', 'confirmed'].includes(c.status) || live) return;          // a new rate only when there's none in force
    const d = c.details; let prices, total;
    if (c.kind === 'buy_bars' || c.kind === 'sell_bars') {
      const unit = Object.fromEntries(d.lines.map(l => { const p = P[l.product_id]; return [l.product_id, c.kind === 'buy_bars' ? priceOf(p, s.rates) : Math.round(rateOf(s.rates, p.metal).sellGram * p.grams)]; }));
      prices = { unit }; total = d.lines.reduce((a, l) => a + unit[l.product_id] * l.units, 0);
    } else if (c.kind === 'buy_micro') { const q = microQuote(s); prices = { unit_pkr: q.unitPkr, price_gram: q.buyGram, usd_pkr: q.usdPkr }; total = q.unitPkr * d.units; }
    else if (c.kind === 'sell_micro') { const q = microQuote(s); prices = { price_gram: q.sellGram }; total = Math.max(1, Math.floor(d.grams * q.sellGram)); }
    else { const pr = s.svc && giftPrice(d, s.svc, s.rates); if (!pr) return; prices = { metal_pkr: pr.metal, making_pkr: pr.making, packaging_pkr: pr.packaging, delivery_pkr: pr.delivery }; total = pr.total; }
    const conf = { id: 'RC-' + uid() + uid(), kind: c.kind, details: d, prices, total, note: '', status: 'valid', expiresAt: Date.now() + 15 * 60e3, lockId: 'LK-' + uid() };
    set(x => ({ chats: x.chats.map(y => (y.id === id ? { ...y, status: 'confirmed', confirmation: conf } : y)) }));
    demoMsg(id, { sender: 'staff', staffName: 'Sana', body: `Final rate confirmed: ${fmt(total)}. It’s valid for 15 minutes; tap the button below to go ahead.`, confirmationId: conf.id });
    const t = s.stack[s.stack.length - 1];
    notify('chat', 'Final rate confirmed', `${c.summary}: ${fmt(total)}. Valid for 15 minutes.`, !!(t && t.name === 'chat' && t.id === id), { name: 'chat', id });
  }
  function demoSupport(id) {
    const c = (stRef.current.chats || []).find(x => x.id === id);
    const askKey = id + ':' + (c && c.confirmation ? c.confirmation.id : '');   // once per request, and once more after each rate runs out
    if (LIVE || demoAsked.current.has(askKey)) return;
    demoAsked.current.add(askKey);
    const again = c && c.confirmation;
    setTimeout(() => demoMsg(id, { sender: 'staff', staffName: 'Sana', body: again ? 'That rate has run out. I’m checking today’s rate again for you.' : 'Assalam o alaikum! This is Sana from PGBX support. I’m checking today’s rate for your request now.' }), 1800);
    setTimeout(() => demoConfirm(id), 4200);
  }
  // A confirmed rate is used once: the chat is done and says what it was used for
  function demoUsed(conf, ref) {
    set(s => ({ chats: s.chats.map(c => (!c.confirmation || c.confirmation.id !== conf.id ? c : { ...c, status: 'completed', lastAt: Date.now(), confirmation: { ...c.confirmation, status: 'used', usedRef: ref },
      messages: [...c.messages, { id: c.messages.reduce((a, x) => Math.max(a, x.id), 0) + 1, sender: 'system', body: `Done at the confirmed rate · ${ref}`, ts: Date.now() }] })) }));
  }

  // FR-B2: refresh locked prices at zero while on product, cart or pay
  useEffect(() => {
    if (st.lock && !st.lock.confirmed && top && ['product', 'cart', 'pay'].includes(top.name) && now >= st.lock.expiresAt) {
      if (RATE_CHAT) { set(s => (s.lock && !s.lock.confirmed ? { lock: lockFor(s, Object.keys(s.lock.prices)) } : {})); return; }   // indicative: no toast, no server lock
      if (LIVE) { if (!st.lock.renewing && now >= (st.lock.retryAt || 0)) { set(s => ({ lock: { ...s.lock, renewing: true } })); serverLock(Object.keys(st.lock.prices), true); } return; }
      set(s => ({ lock: { prices: Object.fromEntries(Object.keys(s.lock.prices).map(pid => [pid, priceOf(P[pid], s.rates)])), expiresAt: Date.now() + LOCK_S * 1000 } }));
      toast('Prices updated to the latest rate');
    }
  }, [now]);

  // Every price on product, cart and payment must come from the current lock. Going back from the cart to a product
  // (or any other path) that leaves a needed price out of the lock gets a new lock instead of showing no price.
  const needPids = !top ? [] : top.name === 'product' ? [top.pid] : top.name === 'cart' ? st.cart.map(l => l.pid) : top.name === 'pay' ? st.checkout.map(l => l.pid) : [];
  const needKey = needPids.join(',');
  useEffect(() => {
    // a rate confirmed in chat is only for its checkout: anywhere else gets the ordinary indicative price
    if (!needPids.length || (st.lock && !(st.lock.confirmed && top.name !== 'pay') && needPids.every(pid => pid in st.lock.prices))) return;
    if (LIVE) { set(s => ({ lock: lockFor(s, needPids) })); serverLock(needPids); }
    else set(s => ({ lock: lockFor(s, needPids) }));
  }, [needKey, top && top.name, st.lock && Object.keys(st.lock.prices).join(',')]);

  // $1 gold: refresh the server's quote every 20 s while its screens are open
  const microOpen = !!top && ['micro', 'micro-sell'].includes(top.name);
  useEffect(() => {
    if (!LIVE || !microOpen) return;
    const get = () => Live.microQuote().then(q => set({ microQuote: q }), () => {});
    get(); const t = setInterval(() => { if (document.visibilityState !== 'hidden') get(); }, MICRO_QUOTE_MS); return () => clearInterval(t);
  }, [microOpen]);

  // FR-A4: auto-lock after 2 minutes of inactivity
  useEffect(() => {
    if (phase === 'app' && !st.guest && !(top && ['processing', 'kyc'].includes(top.name)) && now - lastActive.current > AUTOLOCK_MS) {
      if (LIVE) Live.lockNow();
      set({ lockNote: 'Locked after 2 minutes of inactivity' }); setPhase('pin');
    }
  }, [now]);

  // FR-R6: check price alerts on every rate update
  useEffect(() => {
    if (st.rates.mode === 'connecting' || LIVE) return;    // production: the server checks alerts on every rate update
    const fired = st.alerts.filter(a => a.active && (a.dir === 'above' ? st.rates[a.metal].buy >= a.target : st.rates[a.metal].buy <= a.target));
    if (!fired.length) return;
    set(s => ({ alerts: s.alerts.map(a => (fired.some(f => f.id === a.id) ? { ...a, active: false, firedAt: Date.now() } : a)) }));
    fired.forEach(a => notify('alert', `${metalName(a.metal)} is ${a.dir} ${fmt(a.target)}`, `Buy rate is now ${fmt(st.rates[a.metal].buy)} per tola.`, false, { name: 'history', metal: a.metal }));
  }, [st.rates.tick, st.rates.updatedAt, st.alerts.length]);

  // Saving serialises everything kept on the phone (in the demo, every record), so it never runs inside a tap or a
  // screen change: it waits for an idle moment, and is flushed at once if the app is closed or hidden.
  const saveLater = useRef(null);
  useEffect(() => {
    saveLater.current && saveLater.current.cancel();
    const go = () => { saveLater.current = null; saveState(st); };
    const idle = window.requestIdleCallback ? requestIdleCallback(go, { timeout: 1000 }) : setTimeout(go, 300);
    saveLater.current = { go, cancel: () => (window.cancelIdleCallback && window.requestIdleCallback ? cancelIdleCallback(idle) : clearTimeout(idle)) };
  }, KEEP.map(k => st[k]));
  useEffect(() => {
    const flush = () => { const w = saveLater.current; if (w) { w.cancel(); w.go(); } };
    const hide = () => { if (document.visibilityState === 'hidden') flush(); };
    addEventListener('pagehide', flush); document.addEventListener('visibilitychange', hide);
    return () => { removeEventListener('pagehide', flush); document.removeEventListener('visibilitychange', hide); };
  }, []);

  useEffect(() => { if (!st.toast) return; const t = setTimeout(() => set({ toast: null }), st.toast.action ? 5000 : 2800); return () => clearTimeout(t); }, [st.toast]);
  useEffect(() => { if (!st.banner) return; const t = setTimeout(() => set({ banner: null }), 3800); return () => clearTimeout(t); }, [st.banner]);

  // Derived wallet state from the ledger (FR-W3)
  const holdings = useMemo(() => { const h = {}; st.ledger.forEach(e => { h[e.pid] = (h[e.pid] || 0) + e.delta; }); return h; }, [st.ledger]);
  const statusOf = r => ((r.status === 'requested' || r.status === 'ready') && now > r.expiresAt ? 'expired' : r.status);
  const reserved = {}; st.redemptions.forEach(r => { const s = statusOf(r); if (s === 'requested' || s === 'ready') reserved[r.pid] = (reserved[r.pid] || 0) + r.units; });
  // Units a dealer can still promise: stock minus active reservations there (FR-D2). Production gets this from the server.
  const dealerFree = (did, pid) => {
    const stock = (st.dealerStock[did] && st.dealerStock[did][pid]) || 0;
    if (LIVE) return stock;
    const held = st.redemptions.reduce((a, r) => { const s = statusOf(r); return a + (r.dealerId === did && r.pid === pid && (s === 'requested' || s === 'ready') ? r.units : 0); }, 0);
    return Math.max(0, stock - held);
  };
  const walletValue = (() => { let gold = 0, silver = 0, goldG = 0, silverG = 0; PRODUCTS.forEach(p => { const n = holdings[p.id] || 0; if (!n) return; const v = n * p.grams * rateOf(st.rates, p.metal).sellGram;
    if (p.metal === 'gold') { gold += v; goldG += n * p.grams; } else { silver += v; silverG += n * p.grams; } });
    const mg = st.guest ? 0 : st.micro.grams, mv = Math.floor(mg * rateOf(st.rates, 'gold').sellGram);   // $1 gold counts as gold
    return { gold: gold + mv, silver, goldG: goldG + mg, silverG, total: gold + silver + mv, microG: mg, micro: mv }; })();
  // Same rule as the server: today's orders that are paid or still payable, plus gift orders (failed, expired and refunded ones don't count)
  const spentToday = st.orders.filter(o => sameDay(o.ts, now) && (!LIVE || ['pending', 'credited', 'flagged'].includes(o.status))).reduce((a, o) => a + (Number(o.total) || 0), 0)
    + st.giftOrders.filter(g => sameDay(g.createdAt, now) && !['cancelled', 'expired'].includes(g.status)).reduce((a, g) => a + (Number(g.total) || 0), 0)
    + st.micro.txns.filter(t => t.side === 'buy' && sameDay(t.ts, now) && ['credited', 'pending_payment'].includes(t.status)).reduce((a, t) => a + (Number(t.amount) || 0), 0);
  const unread = st.notifications.filter(n => !n.read).length;

  const tabIndex = t => TABS.findIndex(x => x[0] === t);
  const lockFor = (s, pids) => ({ expiresAt: Date.now() + LOCK_S * 1000, prices: Object.fromEntries(pids.map(pid => [pid, priceOf(P[pid], s.rates)])), pending: LIVE && !RATE_CHAT });
  // Production: the price shown on product, cart and payment is the server's lock; nothing can be paid until it arrives.
  // Only the newest request's answer is used, so a slow lock for another product can't replace this one.
  // A server price lock is only needed when prices are paid as shown; with the rate chat the only payable lock is the one
  // support confirms. A late answer never replaces a confirmed lock.
  const serverLock = (pids, renewed) => {
    if (!LIVE || RATE_CHAT || !pids.length) return;
    const n = ++lockSeq.current;
    Live.lock(pids).then(l => { if (n !== lockSeq.current) return; set(s => (s.lock && s.lock.confirmed ? {} : { lock: l })); if (renewed) toast('Prices updated to the latest rate'); },
      e => { if (n !== lockSeq.current) return; set(s => (s.lock && !s.lock.confirmed ? { lock: { ...s.lock, pending: true, renewing: false, retryAt: Date.now() + 15000, error: e.message } } : {})); liveFail(e); });
  };
  const credit = (s, o) => [...s.ledger, ...o.lines.map(l => ({ id: 'L-' + uid(), ts: Date.now(), pid: l.pid, delta: l.units, reason: 'purchase', ref: o.receipt, price: l.unit }))];
  const A = {
    set, toast,
    // Confirmation sheet for consequential actions: { title, body, confirm, cancel, danger, onConfirm }
    confirm: d => set({ dialog: d }),
    closeDialog: () => set({ dialog: null }),
    // Leaving a screen with unsaved work asks first (see `guard`); everything else navigates immediately.
    leave: fn => (guardRef.current ? guardRef.current(fn) : fn()),
    guard: fn => { guardRef.current = fn; },
    tab: t => {
      if (st.guest && !OPEN_TABS.includes(t)) { A.login(GUEST_REASON[t], { tab: t }); return; }
      A.leave(() => set(s => ({ tab: t, stack: [], navDir: s.stack.length ? 'back' : tabIndex(t) > tabIndex(s.tab) ? 'fwd' : tabIndex(t) < tabIndex(s.tab) ? 'back' : 'fade' })));
    },
    push: r => { if (st.guest && !GUEST_PUSH.includes(r.name)) { A.login(r.name === 'collect' ? 'Log in to collect your bars at a dealer.' : 'Log in to continue.', { push: r }); return; } set(s => ({ stack: [...s.stack, r], navDir: 'fwd' })); },
    back: () => A.leave(() => set(s => ({ stack: s.stack.slice(0, -1), navDir: 'back' }))),
    // Open whatever a notification points to; receipts opened this way get a back button.
    openLink: link => {
      // Links come from notifications (saved or from the server): only known screens with valid ids are opened.
      if (!link || typeof link !== 'object' || !LINK_NAMES.includes(link.name)) return;
      if (link.name === 'wallet') { set({ banner: null, tab: 'wallet', stack: [], navDir: 'fade' }); return; }   // a tab, not a pushed screen
      if (link.name === 'product' && !P[link.pid]) return;
      if (link.name === 'history' && link.metal !== 'gold' && link.metal !== 'silver') return; if (link.name === 'receipt' && link.from === undefined) link = { ...link, from: 'inbox' }; if (link.name === 'receipt' && !st.orders.some(o => o.id === link.oid)) return; if (link.name === 'code' && !st.redemptions.some(r => r.id === link.rid)) return; if (link.name === 'appraisal' && !st.appraisals.some(a => a.id === link.id)) return; if (link.name === 'gift' && !st.giftOrders.some(g => g.id === link.id)) return;
      if (link.name === 'chat' && (typeof link.id !== 'string' || (!LIVE && !st.chats.some(c => c.id === link.id)))) return;
      if (link.name === 'chat') { const t = st.stack[st.stack.length - 1]; if (t && t.name === 'chat' && t.id === link.id) { set({ banner: null }); return; } }
      set(s => ({ banner: null, navDir: 'fwd', stack: [...s.stack, link] })); },
    // Guests are told why they need to log in, and taken where they were going afterwards.
    login: (note, go) => { set({ stack: [], loginNote: '', loginIntent: note ? { note, go } : null }); setPhase('login'); },
    logout: () => {
      if (LIVE) { Live.logout(); knownNotes.current = null; syncSeq.current++; }
      set({ ...ACCOUNT_BLANK, ...(LIVE ? { pinSet: false, pin: null, biometric: false, pinFails: 0, pinLockUntil: 0, cart: [] } : {}), stack: [], guest: false, tab: 'rates', loginNote: '', loginIntent: { note: 'You’ve logged out. Your holdings are safe.' }, loggedIn: false });
      setPhase('login');
    },
    forgotPin: () => { set({ pinReset: true, lockNote: '', loginNote: '', loginIntent: { note: 'Log in with your mobile number to choose a new PIN.' } }); setPhase('login'); },
    dismissTip: k => set(s => ({ tips: { ...s.tips, [k]: true } })),
    removeLine: pid => {
      const line = st.cart.find(l => l.pid === pid); if (!line) return;
      set(s => ({ cart: s.cart.filter(l => l.pid !== pid) }));
      toast(`Removed ${pname(P[pid])}`, { label: 'Undo', fn: () => set(s => (s.cart.some(l => l.pid === pid) ? {} : { cart: [...s.cart, line] })) });
    },
    // Closing the account: in a real app the server closes it; here the demo data on this phone is erased.
    closeAccount: () => {
      if (LIVE) {
        Live.closeAccount().then(r => {
          if (!r.closed) { toast('Your account can’t be closed yet. Check the items listed.'); sync(); return; }
          clearSaved();
          try { sessionStorage.setItem('pgbx-note', 'Your PGBX account has been closed and your details were removed from this phone.'); } catch (e) { }
          Live.forget().catch(() => { }).then(() => location.reload());    // the saved login is removed before the reload
        }, liveFail);
        return;
      }
      clearSaved(); try { sessionStorage.setItem('pgbx-note', 'Your PGBX account has been closed and your details were removed from this phone.'); } catch (e) { } location.href = location.pathname + '?start=login'; },
    resetDemo: () => { clearSaved(); location.href = location.pathname; },
    report: (ref, text) => {
      const done = () => { A.guard(null); A.toast('Report sent. PGBX support will reply in your notifications.'); A.back(); };
      if (!LIVE) { A.guard(null); A.toast('Report sent to PGBX support (demo)'); A.back(); return; }
      const about = ref.startsWith('o:') ? 'Order ' + ((st.orders.find(o => o.id === ref.slice(2)) || {}).receipt || '') : ref.startsWith('r:') ? 'Collection' : 'General';
      if (st.sending) return;                                    // one report per tap
      set({ sending: true });
      Live.report(ref.startsWith('o:') ? 'order' : ref.startsWith('r:') ? 'collection' : 'general', `${about}\n\n${text.trim()}`).then(() => { set({ sending: false }); done(); }, e => { set({ sending: false }); liveFail(e); });
    },
    // ---------- rate chat ----------
    // Opens the chat for this request, or the open one already asking about exactly the same thing
    rateChat: (kind, details, indicative) => {
      if (st.guest) { A.login('Log in to get the final rate from PGBX support.'); return; }
      const d = normDetails(kind, details), sig = kind + JSON.stringify(d);
      const same = st.chats.find(c => ['open', 'confirmed'].includes(c.status) && c.kind + JSON.stringify(normDetails(c.kind, c.details)) === sig);
      if (same) { A.push({ name: 'chat', id: same.id }); return; }
      if (LIVE) {
        if (st.sending) return;
        set({ sending: true });
        Live.openChat(kind, d).then(c => set(s => ({ sending: false, chats: [c, ...s.chats.filter(x => x.id !== c.id)], navDir: 'fwd', stack: [...s.stack, { name: 'chat', id: c.id }] })),
          e => { set({ sending: false }); liveFail(e); });
        return;
      }
      const now = Date.now(), id = 'CH-' + uid() + uid(), summary = chatSummary(kind, d, st.svc);
      const c = { id, ref: `PGBX-C-${ymd(now).slice(2).replace(/-/g, '')}-${uid().toUpperCase().slice(0, 6)}`, kind, details: d, summary, indicative: Math.round(indicative) || null, status: 'open',
        createdAt: now, lastAt: now, unread: 0, confirmation: null,
        messages: [{ id: 1, sender: 'system', body: `${summary}${indicative ? ` · app price ${fmt(indicative)} (indicative)` : ''}. PGBX support will confirm the final rate here.`, ts: now }] };
      set(s => ({ chats: [c, ...s.chats], navDir: 'fwd', stack: [...s.stack, { name: 'chat', id }] }));
    },
    chatSend: (id, body, add) => {
      if (LIVE) return Live.chatSend(id, body).then(m => { add && add(m); set(s => ({ chats: s.chats.map(c => (c.id === id ? { ...c, lastAt: m.ts, lastBody: body } : c)) })); });
      demoMsg(id, { sender: 'customer', body });
      return Promise.resolve();
    },
    chatAttach: (id, up, caption, add) => {
      // the customer's own file is shown from the phone, not downloaded back
      if (LIVE) return Live.chatAttach(id, { name: up.name, mime: up.mime, data: up.data, caption }).then(m => { if (m.attachment) keepFile(m.attachment.id, up.blob); add && add(m); });
      const aid = uid() + uid();
      demoMsg(id, { sender: 'customer', body: caption, attachment: { id: aid, name: up.name, mime: up.mime, url: keepFile(aid, up.blob) } });
      return Promise.resolve();
    },
    chatClose: (id, refresh) => {
      if (LIVE) { Live.chatClose(id).then(() => { sync(); refresh && refresh(); toast('Request closed'); }, liveFail); return; }
      set(s => ({ chats: s.chats.map(c => (c.id !== id ? c : { ...c, status: 'closed', lastAt: Date.now(), confirmation: c.confirmation && c.confirmation.status === 'valid' ? { ...c.confirmation, status: 'withdrawn' } : c.confirmation,
        messages: [...c.messages, { id: c.messages.length + 1, sender: 'system', body: 'You closed this request.', ts: Date.now() }] })) }));
      toast('Request closed');
    },
    // Uses the confirmed rate: checkout for bars, or the purchase / sale itself
    useRate: (chat, conf, iban) => {
      if (st.paying || st.offline) return;
      if (conf.expiresAt <= Date.now()) { toast('The confirmed rate has expired. Ask in the chat for a new one.'); return; }
      const d = conf.details;
      if (chat.kind === 'buy_bars') {
        const lines = d.lines.map(l => ({ pid: l.product_id, units: l.units }));
        const fromCart = JSON.stringify(normDetails('buy_bars', { lines: st.cart.map(l => ({ product_id: l.pid, units: l.units })) })) === JSON.stringify(normDetails('buy_bars', d));
        const orderKey = 'K' + conf.id;
        lockSeq.current++;                                     // any price lock still on its way is now out of date
        set(s => ({ checkout: lines, checkoutFrom: fromCart ? 'cart' : 'chat', paying: false, navDir: 'fwd',
          lock: { id: conf.lockId, prices: conf.prices.unit, expiresAt: conf.expiresAt, confirmed: chat.ref, chatId: chat.id, confId: conf.id },
          stack: [...s.stack, s.kyc.status === 'verified' ? { name: 'pay', orderKey } : { name: 'kyc', next: 'pay', orderKey }] }));
        return;
      }
      if (chat.kind === 'buy_micro') { A.microBuy(d.units, 'K' + conf.id, conf); return; }
      if (chat.kind === 'sell_micro') { set({ lastIban: iban }); A.microSell(Number(d.grams), iban, 'S' + conf.id, conf.total, conf); return; }
      if (chat.kind === 'gift') { A.placeGift(conf); return; }
      if (chat.kind === 'sell_bars') { set({ lastIban: iban }); A.sellBars(conf, iban); }
    },
    sellBars: (conf, iban) => {
      if (st.kyc.status !== 'verified') { A.push({ name: 'kyc' }); return; }
      if (LIVE) {
        set({ paying: true });
        Live.sellBars(conf.id, iban, 'B' + conf.id).then(async b => { await sync(); set({ paying: false }); toast(`Sold · ${fmt(b.total)} on its way to your bank`); }, e => { set({ paying: false }); liveFail(e); });
        return;
      }
      const lines = conf.details.lines, ref = `PGBX-BS-${ymd(Date.now()).slice(2).replace(/-/g, '')}-${uid().toUpperCase()}`;
      if (lines.some(l => (holdings[l.product_id] || 0) - (reserved[l.product_id] || 0) < l.units)) { toast('You no longer have those bars to sell.'); return; }
      set(s => ({ ledger: [...s.ledger, ...lines.map(l => ({ id: 'L-' + uid(), ts: Date.now(), pid: l.product_id, delta: -l.units, reason: 'sale', ref, price: conf.prices.unit[l.product_id] }))],
        barSales: [{ id: uid(), ref, lines: lines.map(l => ({ pid: l.product_id, units: l.units, unit: conf.prices.unit[l.product_id] })), total: conf.total, status: 'pending_payout', payoutTo: '•••• ' + iban.slice(-4), ts: Date.now() }, ...(s.barSales || [])] }));
      demoUsed(conf, ref);
      notify('purchase', 'Bars sold to PGBX', `${fmt(conf.total)} · ${ref}. PGBX will pay it to your bank account ending ${iban.slice(-4)}.`, true, { name: 'wallet' });
      toast(`Sold · ${fmt(conf.total)} on its way to your bank`);
    },
    liveFail: e => liveFail(e),
    demoSupport: id => demoSupport(id),
    // ---------- $1 gold ----------
    openMicro: () => { A.push({ name: 'micro' }); if (LIVE) Live.microQuote().then(q => set({ microQuote: q }), () => {}); },
    microQuote: () => Live.microQuote().then(q => set({ microQuote: q }), liveFail),
    microBuy: (units, key, conf) => {
      if (st.guest) { A.login('Log in to buy $1 gold.', { push: { name: 'micro' } }); return; }
      if (st.kyc.status !== 'verified') { A.push({ name: 'kyc' }); return; }
      const q0 = microQuote(st);
      // a confirmed rate replaces today's indicative $1 price
      const q = conf ? { ...q0, unitPkr: conf.prices.unit_pkr, buyGram: conf.prices.price_gram, gramsPerUnit: Math.round(conf.prices.unit_pkr / conf.prices.price_gram * 1e6) / 1e6 } : q0;
      const total = (q.unitPkr || 0) * units;
      if (st.paying || st.offline || !q.unitPkr) return;
      if (spentToday + total > DAY_LIMIT) { toast(`You can buy up to ${fmt(Math.max(0, DAY_LIMIT - spentToday))} more today.`); return; }
      const done = g => toast(`Gold added: $${units} · ${fmtG(g)}`);
      set(s => ({ paying: true, navDir: 'fade', stack: [...s.stack, { name: 'processing', kind: 'micro' }] }));
      const back = s => ({ paying: false, navDir: 'fade', stack: s.stack.filter(r => r.name !== 'processing') });
      if (LIVE) {
        // The toast says what the server says: gold added, or still waiting for the payment (a provider's page)
        Live.microBuy(units, key, conf && conf.id).then(async o => {
          await sync(); set(back);
          const txns = (lastSync.current && lastSync.current.micro && lastSync.current.micro.txns || []).filter(t => t.orderRef === o.ref);
          if (txns.length && txns.every(t => t.status === 'credited')) done(txns.reduce((a, t) => a + t.grams, 0));
          else toast('Waiting for your payment. Your gold is added as soon as PGBX receives it.');
          Live.microQuote().then(x => set({ microQuote: x }), () => {});
        }, e => { set(back); liveFail(e); });
        return;
      }
      setTimeout(() => set(s => {
        const ts = Date.now(), d = ymd(ts).slice(2).replace(/-/g, ''), orderRef = `PGBX-MO-${d}-${uid()}${uid().slice(0, 2)}`;
        const lots = { ...s.micro.lots, buy: { ...s.micro.lots.buy } }; const txns = [];
        for (let i = 0; i < units; i++) {
          let left = q.gramsPerUnit; const parts = [];
          while (left > 1e-9) {                                   // fill the open lot; the transaction that completes it is split
            const take = Math.min(left, TOLA - lots.buy.filled);
            lots.buy.filled = Math.round((lots.buy.filled + take) * 1e6) / 1e6; left = Math.round((left - take) * 1e6) / 1e6;
            parts.push({ ref: 'PGBX-T-' + String(lots.buy.no).padStart(6, '0'), grams: Math.round(take * 1e6) / 1e6, status: lots.buy.filled >= TOLA ? 'full' : 'filling' });
            if (lots.buy.filled >= TOLA) lots.buy = { no: lots.buy.no + 1, filled: 0 };
          }
          txns.push({ ref: `PGBX-M-${d}-${uid()}${uid().slice(0, 2)}`, side: 'buy', grams: q.gramsPerUnit, amount: q.unitPkr, price: q.buyGram, usd: 1, status: 'credited', ts: ts + i, orderRef, lots: parts });
        }
        return { ...back(s), micro: { grams: Math.round((s.micro.grams + q.gramsPerUnit * units) * 1e6) / 1e6, lots, txns: [...txns.reverse(), ...s.micro.txns].slice(0, 500) } };
      }), 1500);
      if (conf) setTimeout(() => demoUsed(conf, (stRef.current.micro.txns[0] || {}).orderRef || 'PGBX-MO'), 1520);
      setTimeout(() => { done(q.gramsPerUnit * units); notify('purchase', 'Gold added', `$${units} of gold (${fmtG(q.gramsPerUnit * units)}) for ${fmt(total)}`, true, { name: 'micro' }); }, 1550);
    },
    microSell: (grams, iban, key, expected, conf) => {
      if (st.paying || st.offline) return;
      const q = conf ? { ...microQuote(st), sellGram: conf.prices.price_gram } : microQuote(st);
      if (LIVE) {
        set({ paying: true });
        Live.microSell(grams, iban, key, expected, conf && conf.id).then(async t => {
          await sync(); set(s => ({ paying: false, lastIban: iban, navDir: 'fwd', stack: [...s.stack.filter(r => r.name !== 'micro-sell'), { name: 'micro-txn', ref: t.ref }] }));
          toast(`Sold ${fmtG(grams)} · ${fmt(t.amount)} on its way to your bank`);
        }, e => {
          set({ paying: false });
          // The price moved since the customer confirmed: show the new price and let them decide again
          if (e.code === 'PRICE_CHANGED') Live.microQuote().then(x => set({ microQuote: x }), () => {});
          liveFail(e);
        });
        return;
      }
      if (grams > st.micro.grams + 1e-9) { toast('That’s more than you have.'); return; }
      const amount = conf ? conf.total : Math.floor(grams * q.sellGram), ts = Date.now(), ref = `PGBX-MS-${ymd(ts).slice(2).replace(/-/g, '')}-${uid()}${uid().slice(0, 2)}`;
      set(s => {
        const lots = { ...s.micro.lots, sell: { ...s.micro.lots.sell } }; const parts = []; let left = grams;
        while (left > 1e-9) {
          const take = Math.min(left, TOLA - lots.sell.filled);
          lots.sell.filled = Math.round((lots.sell.filled + take) * 1e6) / 1e6; left = Math.round((left - take) * 1e6) / 1e6;
          parts.push({ ref: 'PGBX-TS-' + String(lots.sell.no).padStart(6, '0'), grams: Math.round(take * 1e6) / 1e6, status: lots.sell.filled >= TOLA ? 'full' : 'filling' });
          if (lots.sell.filled >= TOLA) lots.sell = { no: lots.sell.no + 1, filled: 0 };
        }
        const t = { ref, side: 'sell', grams, amount, price: q.sellGram, status: 'pending_payout', ts, payoutTo: '•••• ' + iban.slice(-4), lots: parts };
        return { lastIban: iban, micro: { grams: Math.max(0, Math.round((s.micro.grams - grams) * 1e6) / 1e6), lots, txns: [t, ...s.micro.txns].slice(0, 500) },
          navDir: 'fwd', stack: [...s.stack.filter(r => r.name !== 'micro-sell'), { name: 'micro-txn', ref }] };
      });
      if (conf) demoUsed(conf, ref);
      notify('purchase', 'Gold sold', `${fmtG(grams)} for ${fmt(amount)} · ${ref}. PGBX will pay it to your bank account ending ${iban.slice(-4)}.`, true, { name: 'micro' });
      toast(`Sold ${fmtG(grams)} · ${fmt(amount)} on its way to your bank`);
    },
    // ---------- services ----------
    startAppraisal: items => {
      if (st.guest) { A.login('Log in to book a doorstep appraisal.', { push: { name: 'appraisal-book' } }); if (items) set(s => ({ apprDraft: { ...apprDefaults(s), items } })); return; }
      set(s => ({ apprDraft: items ? { ...apprDefaults(s), ...(s.apprDraft || {}), items } : s.apprDraft || apprDefaults(s), navDir: 'fwd', stack: [...s.stack.filter(r => r.name !== 'appraisal-book'), { name: 'appraisal-book' }] }));
    },
    bookAppraisal: () => {
      const d0 = st.apprDraft, svc = st.svc;
      if (!d0 || !svc || st.paying || st.offline) return;
      const d = { ...d0, items: d0.items.map(i => ({ ...i, approx_g: Math.max(0, Number(i.approx_g) || 0) })) };   // typed as text so "2.5" can be entered
      const phone = d.phone.replace(/\D/g, '').replace(/^92/, '').replace(/^0/, '');
      if (LIVE) {
        set(s => ({ paying: true, navDir: 'fade', stack: [...s.stack, { name: 'processing', kind: 'appraisal' }] }));
        Live.bookAppraisal({ ...d, phone, key: draftKey('A', d0) }).then(async a => { await sync(); set(s => ({ paying: false, apprDraft: null, navDir: 'fade', stack: [...s.stack.filter(r => !['processing', 'appraisal-book'].includes(r.name)), { name: 'appraisal', id: a.id }] })); },
          e => { set(s => ({ paying: false, navDir: 'back', stack: s.stack.filter(r => r.name !== 'processing') })); liveFail(e); });
        return;
      }
      const a = { id: 'AP-' + uid(), ref: `PGBX-A-${ymd(Date.now()).slice(2).replace(/-/g, '')}-${uid().slice(0, 5)}`, createdAt: Date.now(), date: d.date, slot: d.slot, city: d.city, area: d.area.trim(),
        address: d.address.trim(), phone, items: d.items, notes: d.notes.trim(), fee: svc.appraisal.feePkr, visitCode: String(Math.floor(1000 + Math.random() * 9000)), status: 'booked', goldsmith: null, result: null, refundDue: false };
      set(s => ({ paying: true, navDir: 'fade', stack: [...s.stack, { name: 'processing', kind: 'appraisal' }] }));
      setTimeout(() => {
        set(s => ({ paying: false, apprDraft: null, appraisals: [a, ...s.appraisals], navDir: 'fade', stack: [...s.stack.filter(r => !['processing', 'appraisal-book'].includes(r.name)), { name: 'appraisal', id: a.id }] }));
        notify('service', 'Appraisal booked', `${a.ref} · ${dayName(a.date)}, ${slotName(a.slot)}. We’ll confirm your goldsmith before the visit.`, true, { name: 'appraisal', id: a.id });
      }, 1600);
    },
    cancelAppraisal: id => {
      if (LIVE) { Live.cancelAppraisal(id).then(() => { sync(); toast('Visit cancelled'); }, liveFail); return; }
      const a = st.appraisals.find(x => x.id === id); if (!a) return;
      const refund = pkTime(a.date, a.slot.split('-')[0]) - Date.now() >= st.svc.appraisal.freeCancelHours * 3600e3;
      set(s => ({ appraisals: s.appraisals.map(x => (x.id === id ? { ...x, status: 'cancelled', refundDue: refund } : x)) }));
      notify('service', 'Appraisal cancelled', refund ? `${a.ref}. Your visit fee will be refunded.` : `${a.ref}. The fee isn’t refunded this close to the visit.`, true, { name: 'appraisal', id });
      toast('Visit cancelled');
    },
    demoAppraisal: (id, step) => {
      const a = st.appraisals.find(x => x.id === id); if (!a || LIVE) return;
      if (step === 'assign') {
        set(s => ({ appraisals: s.appraisals.map(x => (x.id === id ? { ...x, status: 'confirmed', goldsmith: { name: 'Usman Zargar (sample)', phone: '+92 300 0000000' } } : x)) }));
        notify('service', 'Appraisal confirmed', `Usman Zargar will visit on ${dayName(a.date)}, ${slotName(a.slot)}. Ask for your visit code before opening the door.`, false, { name: 'appraisal', id });
      } else {
        const g = a.items.reduce((t, i) => t + (Number(i.approx_g) || 0), 0) || 10, k = (a.items.find(i => i.karat) || {}).karat || '21K', metal = a.items[0].metal;
        const net = Math.round(g * 0.97 * 10) / 10, pur = (st.svc.purity[metal] || {})[k] || 0.875;
        const value = Math.round(net * pur * rateOf(st.rates, metal).sellGram / 0.999 * (1 - st.svc.buybackDeductionPct[metal] / 100));
        set(s => ({ appraisals: s.appraisals.map(x => (x.id === id ? { ...x, status: 'completed', result: { karat: k, net_g: net, value_pkr: value, summary: `Sample report: tested with a karat meter and calibrated scale. ${k} confirmed; ${fmtW(g - net)} of solder and stones deducted.` } } : x)) }));
        notify('service', 'Appraisal report ready', 'Your assay results are in the app.', false, { name: 'appraisal', id });
      }
    },
    startGift: () => {
      if (st.guest) { A.login('Log in to send gold or silver as a gift.', { push: { name: 'gift-new' } }); return; }
      set(s => ({ giftDraft: s.giftDraft || giftDefaults(s), navDir: 'fwd', stack: [...s.stack, { name: 'gift-new' }] }));
    },
    placeGift: conf => {
      // The recipient's details stay on screen only (not saved on the phone). If the app was closed since the rate was
      // confirmed, the gift is set up again from the chat and the customer adds the delivery details.
      if (conf && !st.giftDraft && st.svc) {
        set(s => ({ giftDraft: { ...giftDefaults(s), ...normDetails('gift', conf.details) }, navDir: 'fwd', stack: [...s.stack, { name: 'gift-new' }] }));
        toast('Add the delivery details, then tap Get final rate to pay at your confirmed rate.');
        return;
      }
      const d = st.giftDraft, svc = st.svc;
      if (!svc) { toast('Gift details are still loading. Try again in a moment.'); return; }
      if (!d || st.paying || st.offline || (stale && !conf)) return;
      if (conf && JSON.stringify(normDetails('gift', d)) !== JSON.stringify(normDetails('gift', conf.details))) { toast('The gift was changed after the rate was confirmed. Ask in the chat for a new rate.'); return; }
      if (st.kyc.status !== 'verified') { A.push({ name: 'kyc', next: 'gift' }); return; }
      const phone = d.phone.replace(/\D/g, '').replace(/^92/, '').replace(/^0/, '');
      if (LIVE) {
        set(s => ({ paying: true, navDir: 'fade', stack: [...s.stack, { name: 'processing', kind: 'gift' }] }));
        Live.placeGift({ ...d, phone, key: draftKey('G', d) + (conf ? conf.id.slice(0, 8) : ''), confirmationId: conf ? conf.id : undefined }).then(async g => { await sync(); set(s => ({ paying: false, giftDraft: null, navDir: 'fade', stack: [...s.stack.filter(r => !['processing', 'gift-new'].includes(r.name)), { name: 'gift', id: g.id }] })); },
          e => { set(s => ({ paying: false, navDir: 'back', stack: s.stack.filter(r => r.name !== 'processing') })); liveFail(e); });
        return;
      }
      const pr = conf ? { metal: conf.prices.metal_pkr, making: conf.prices.making_pkr, packaging: conf.prices.packaging_pkr, delivery: conf.prices.delivery_pkr, total: conf.total } : giftPrice(d, svc, st.rates);
      if (spentToday + pr.total > DAY_LIMIT) { toast(`You can spend up to ${fmt(Math.max(0, DAY_LIMIT - spentToday))} more today.`); return; }
      const g = { id: 'GF-' + uid(), ref: `PGBX-G-${ymd(Date.now()).slice(2).replace(/-/g, '')}-${uid().slice(0, 5)}`, createdAt: Date.now(), item: d.item, shape: d.shape, design: d.design,
        engraving: d.engraving.trim(), message: d.message.trim(), packaging: d.packaging, recipient: { name: d.name.trim(), phone, city: d.city, address: d.address.trim() }, deliverBy: d.deliverBy,
        metal_pkr: pr.metal, making_pkr: pr.making, packaging_pkr: pr.packaging, delivery_pkr: pr.delivery, total: pr.total, status: 'placed', tracking: null, refundDue: false };
      set(s => ({ paying: true, navDir: 'fade', stack: [...s.stack, { name: 'processing', kind: 'gift' }] }));
      if (conf) demoUsed(conf, g.ref);
      setTimeout(() => {
        set(s => ({ paying: false, giftDraft: null, giftOrders: [g, ...s.giftOrders], navDir: 'fade', stack: [...s.stack.filter(r => !['processing', 'gift-new'].includes(r.name)), { name: 'gift', id: g.id }] }));
        notify('service', 'Gift order placed', `${g.ref} · ${fmt(g.total)}. Delivery by ${dayName(g.deliverBy)}.`, true, { name: 'gift', id: g.id });
      }, 1800);
    },
    cancelGift: id => {
      if (LIVE) { Live.cancelGift(id).then(() => { sync(); toast('Gift order cancelled'); }, liveFail); return; }
      set(s => ({ giftOrders: s.giftOrders.map(x => (x.id === id && x.status === 'placed' ? { ...x, status: 'cancelled', refundDue: true } : x)) }));
      notify('service', 'Gift order cancelled', 'Your payment will be refunded to your payment method.', true, { name: 'gift', id });
      toast('Gift order cancelled');
    },
    demoGift: id => {
      const g = st.giftOrders.find(x => x.id === id); if (!g || LIVE) return;
      const next = { placed: 'in_production', in_production: 'dispatched', dispatched: 'delivered' }[g.status]; if (!next) return;
      const tracking = next === 'dispatched' ? 'TCS' + Math.floor(100000000 + Math.random() * 900000000) : g.tracking;
      set(s => ({ giftOrders: s.giftOrders.map(x => (x.id === id ? { ...x, status: next, tracking } : x)) }));
      const msg = { in_production: ['Your gift is being made', `${g.ref} is in production at the PGBX refinery.`], dispatched: ['Your gift is on its way', `Insured courier, tracking ${tracking}. The recipient will need their CNIC.`],
        delivered: ['Gift delivered', `${g.ref} was delivered to ${g.recipient.name}.`] }[next];
      notify('service', msg[0], msg[1], false, { name: 'gift', id });
    },
    lockNow: () => { if (LIVE) Live.lockNow(); set({ lockNote: 'App locked', stack: [] }); setPhase('pin'); },
    // Demo: a new PIN is kept on this phone. Production: saved on the server with the current PIN; answers true or the error.
    setPin: (p, current) => {
      if (!LIVE) { set({ pin: pinStore(p) }); notify('security', 'PIN changed', 'Your app PIN was changed on this device.', true); toast('PIN changed'); return; }
      return Live.setPin(p, current).then(() => { toast('PIN changed'); return true; }, e => { if (Live.signedOut(e)) { sessionEnded(endedNote(e)); return { message: e.message }; } return e; });
    },
    pinWrong: () => pinFail(),
    // Production: push and price-alert choices are saved on the server, which applies them when sending
    setNotif: (k, v) => {
      const before = st.notifPrefs;
      set(s => ({ notifPrefs: { ...s.notifPrefs, [k]: v } }));
      if (LIVE && (k === 'push' || k === 'alerts')) Live.saveNotifPrefs({ [k]: v }).catch(e => { set({ notifPrefs: before }); liveFail(e); });
    },
    sync: () => { sync().then(okd => { if (!okd) toast('Your account didn’t fully load. Check your connection and try again.'); }); },
    reloadPublic: () => loadPublic(),
    setBio: on => {
      if (!LIVE) { set({ biometric: on }); return; }
      if (!on) { set({ biometric: false }); Live.disableBio(); return; }
      const b = window.PGBXNative && window.PGBXNative.biometric;
      if (!b) return;
      b.verify('Turn on ' + bioName()).then(okd => okd && Live.enableBio().then(r => { if (r) { set({ biometric: true }); toast(bioName() + ' is on'); } }, liveFail));
    },
    openHistory: metal => set(s => ({ stack: [...s.stack, { name: 'history', metal }], navDir: 'fwd' })),
    openProduct: pid => {
      if (st.guest) { A.login(`Log in to buy ${pname(P[pid])}.`, { pid }); return; }
      const p = P[pid];
      set(s => ({ buyMetal: p.metal, qty: 1, navDir: 'fwd', stack: [...s.stack, { name: 'product', pid }], lock: lockFor(s, [pid]) }));
      serverLock([pid]);
    },
    openCart: () => { set(s => ({ navDir: 'fwd', stack: [...s.stack, { name: 'cart' }], lock: lockFor(s, s.cart.map(l => l.pid)) })); serverLock(st.cart.map(l => l.pid)); },
    addToCart: (pid, units) => {
      const total = linesUnits(st.cart) + units;
      if (total > MAX_UNITS) { toast(`You can buy up to ${MAX_UNITS} bars per order. Your cart already has ${linesUnits(st.cart)}.`); return; }
      set(s => { const ex = s.cart.find(l => l.pid === pid); return { cart: ex ? s.cart.map(l => (l.pid === pid ? { ...l, units: l.units + units } : l)) : [...s.cart, { pid, units }] }; });
      toast(`Added ${units} × ${pname(P[pid])} to your cart`);
    },
    cartUnits: (pid, units) => set(s => ({ cart: units <= 0 ? s.cart.filter(l => l.pid !== pid) : s.cart.map(l => (l.pid === pid ? { ...l, units } : l)) })),
    checkout: from => {
      if (stale) return;
      if (RATE_CHAT) {                                 // the final rate comes from PGBX support, so the next step is the chat
        const lines = from === 'cart' ? st.cart : [{ pid: top.pid, units: st.qty }];
        if (!lines.length) return;
        if (linesUnits(lines) > MAX_UNITS) { toast(`You can buy up to ${MAX_UNITS} bars per order.`); return; }
        const total = linesTotal(lines, Object.fromEntries(lines.map(l => [l.pid, (st.lock && st.lock.prices[l.pid]) || priceOf(P[l.pid], st.rates)])));
        if (spentToday + total > DAY_LIMIT) { toast(`You can buy up to ${fmt(Math.max(0, DAY_LIMIT - spentToday))} more today.`); return; }
        if (MIN_PURCHASE && total < MIN_PURCHASE) { toast(`The minimum order is ${fmt(MIN_PURCHASE)}.`); return; }
        A.rateChat('buy_bars', { lines: lines.map(l => ({ product_id: l.pid, units: l.units })) }, total);
        return;
      }
      if (LIVE && (!st.lock || st.lock.pending)) { toast('Getting the latest price. Try again in a moment.'); return; }
      if (LIVE && MIN_PURCHASE && linesTotal(from === 'cart' ? st.cart : [{ pid: top.pid, units: st.qty }], st.lock.prices) < MIN_PURCHASE) { toast(`The minimum order is ${fmt(MIN_PURCHASE)}.`); return; }
      const lines = from === 'cart' ? st.cart : [{ pid: top.pid, units: st.qty }];
      if (!lines.length) return;
      if (!st.lock || !lines.every(l => Number.isFinite(st.lock.prices[l.pid]))) { toast('Getting the latest price. Try again in a moment.'); return; }
      const total = linesTotal(lines, st.lock.prices);
      if (linesUnits(lines) > MAX_UNITS) { toast(`You can buy up to ${MAX_UNITS} bars per order.`); return; }
      if (spentToday + total > DAY_LIMIT) { toast(`You can buy up to ${fmt(Math.max(0, DAY_LIMIT - spentToday))} more today.`); return; }
      const orderKey = 'K' + uid() + uid();
      set(s => ({ checkout: lines, checkoutFrom: from, paying: false, navDir: 'fwd', stack: [...s.stack, s.kyc.status === 'verified' ? { name: 'pay', orderKey } : { name: 'kyc', next: 'pay', orderKey }] }));
    },
    pay: () => {
      if ((stale && !(st.lock && st.lock.confirmed)) || st.paying || st.offline) return;
      if (st.lock && st.lock.confirmed && st.lock.expiresAt <= Date.now()) { toast('The confirmed rate has expired. Ask in the chat for a new one.'); return; }
      if (LIVE) {
        if (!st.lock || st.lock.pending || !st.checkout.every(l => Number.isFinite(st.lock.prices[l.pid]))) return;
        const key = top.orderKey;
        set(s => ({ paying: true, navDir: 'fade', stack: [...s.stack, { name: 'processing' }] }));
        Live.placeOrder({ lockId: st.lock.id, lines: st.checkout, method: st.method, key }).then(async o => {
          await sync();
          set(s => ({ paying: false, navDir: 'fade', cart: s.checkoutFrom === 'cart' ? [] : s.cart, stack: [{ name: 'receipt', oid: o.id }], lock: null }));
        }, e => {
          // Back to the payment screen with the reason; the same key makes a retry safe (no double order)
          set(s => ({ paying: false, navDir: 'back', stack: s.stack.filter(r => r.name !== 'processing') }));
          if (!st.lock.confirmed && (e.code === 'LOCK_EXPIRED' || e.code === 'RATES_STALE')) serverLock(st.checkout.map(l => l.pid), true);
          liveFail(e);
        });
        return;
      }
      const key = top.orderKey; const fail = st.simCreditFail;
      if (!st.lock || !st.checkout.length || !st.checkout.every(l => Number.isFinite(st.lock.prices[l.pid]))) { toast('Getting the latest price. Try again in a moment.'); return; }
      const conf = st.lock.confirmed ? { id: st.lock.confId } : null;
      const lines = st.checkout.map(l => ({ ...l, unit: st.lock.prices[l.pid] }));
      const total = lines.reduce((a, l) => a + l.unit * l.units, 0);
      if (spentToday + total > DAY_LIMIT) return;
      set(s => ({ paying: true, navDir: 'fade', stack: [...s.stack, { name: 'processing', fail }] }));
      setTimeout(() => {
        if (committed.current.has(key)) return;      // process exactly once (Rule 2)
        committed.current.add(key);
        const d = new Date(); let rno;
        do { rno = `PGBX-R-${String(d.getFullYear()).slice(2)}${String(d.getMonth() + 1).padStart(2, '0')}${String(d.getDate()).padStart(2, '0')}-${uid()}`; } while (receipts.current.has(rno));
        receipts.current.add(rno);
        if (conf) demoUsed(conf, rno);
        const order = { id: key, receipt: rno, lines, total, method: st.method, ts: Date.now(), status: fail ? 'flagged' : 'credited' };
        set(s => ({
          paying: false, orders: [...s.orders, order], navDir: 'fade', simCreditFail: false,
          ledger: fail ? s.ledger : credit(s, order),
          cart: s.checkoutFrom === 'cart' ? [] : s.cart,
          stack: [{ name: 'receipt', oid: key }], lock: null,
        }));
        if (fail) notify('purchase', 'Payment received, credit pending', `${rno} · ${fmt(total)}. PGBX operations is completing your order.`, true, { name: 'receipt', oid: key, from: 'inbox' });
        else notify('purchase', 'Purchase confirmed', `${linesText(lines)} · ${fmt(total)} · ${rno}`, true, { name: 'receipt', oid: key, from: 'inbox' });
      }, fail ? 5200 : 1800);
    },
    resolveOrder: id => {
      if (LIVE) return;                                  // production: PGBX operations does this in the admin panel
      const o = st.orders.find(x => x.id === id); if (!o || o.status !== 'flagged') return;
      set(s => ({ orders: s.orders.map(x => (x.id === id ? { ...x, status: 'credited' } : x)), ledger: credit(s, o) }));
      notify('purchase', 'Order completed', `${linesText(o.lines)} is now in your wallet · ${o.receipt}`, false, { name: 'receipt', oid: o.id, from: 'inbox' });
    },
    submitKycLive: async f => { const r = await Live.submitKyc(f); await sync(); return r; },
    submitKyc: f => { set(s => ({ kyc: { ...s.kyc, status: 'pending', expiry: f.expiry }, profile: { ...s.profile, name: f.name.trim(), cnic: f.cnic, dob: f.dob } })); notify('account', 'Identity check submitted', 'We are checking your CNIC and selfie.', true); },
    kycVerified: () => { set(s => ({ kyc: { ...s.kyc, status: 'verified', at: Date.now() } })); notify('account', 'Identity verified', 'You can now buy gold and silver.', true); },
    kycFinish: next => set(s => {
      const k = s.stack[s.stack.length - 1];
      if (next === 'pay' && k && k.name === 'kyc') return { navDir: 'fwd', stack: [...s.stack.slice(0, -1), { name: 'pay', orderKey: k.orderKey }] };
      return { navDir: 'back', stack: s.stack.slice(0, -1) };
    }),
    saveProfile: f => {
      if (LIVE) {
        if (st.sending) return;
        set({ sending: true });
        Live.saveProfile(f).then(r => { sync(); set(s => ({ sending: false, navDir: 'back', stack: s.stack.slice(0, -1) })); toast(r.reverify ? 'Saved. Verify your identity again before your next purchase.' : 'Changes saved'); }, e => { set({ sending: false }); liveFail(e); });
        return;
      }
      const idChanged = ['name', 'cnic', 'dob'].some(k => (f[k] || '') !== (st.profile[k] || ''));
      const reverify = idChanged && st.kyc.status === 'verified';
      set(s => ({ profile: { ...f, name: f.name.trim() }, kyc: reverify ? { ...s.kyc, status: 'reverify' } : s.kyc, navDir: 'back', stack: s.stack.slice(0, -1) }));
      notify('account', reverify ? 'Identity details changed' : 'Profile updated', reverify ? 'Verify your identity again before your next purchase.' : 'Your contact details were saved.', true);
      toast(reverify ? 'Saved. Verify your identity again before your next purchase.' : 'Changes saved');
    },
    changePhone: n => { if (LIVE) { sync(); toast('Mobile number updated'); return; } set({ phone: n }); notify('security', 'Mobile number changed', `Your account now uses +92 ${n.slice(0, 3)} ${n.slice(3)}. If this wasn’t you, contact PGBX.`, true); toast('Mobile number updated'); },
    markAllRead: () => { readAt.current = Date.now(); set(s => ({ notifications: s.notifications.map(n => ({ ...n, read: true })) })); if (LIVE) Live.markRead().catch(liveFail); },
    addAlert: (metal, dir, target) => { if (st.guest) { A.login('Log in to get price alerts.', { tab: 'rates' }); return; } if (LIVE) { Live.addAlert(metal, dir, target).then(a => { set(s => ({ alerts: [a, ...s.alerts] })); toast(`We’ll notify you when ${metalName(metal).toLowerCase()} goes ${dir} ${fmt(target)}`); }, liveFail); return; } set(s => ({ alerts: [...s.alerts, { id: uid(), metal, dir, target, active: true }] })); toast(`We’ll notify you when ${metalName(metal).toLowerCase()} goes ${dir} ${fmt(target)}`); },
    removeAlert: id => {
      if (st.guest) return;
      const a = st.alerts.find(x => x.id === id); if (!a) return;
      set(s => ({ alerts: s.alerts.filter(x => x.id !== id) }));
      if (LIVE) { Live.removeAlert(id).then(() => toast('Alert deleted', { label: 'Undo', fn: () => A.addAlert(a.metal, a.dir, a.target) }), liveFail); return; }
      toast('Alert deleted', { label: 'Undo', fn: () => set(s => (s.alerts.some(x => x.id === id) ? {} : { alerts: [...s.alerts, a] })) });
    },
    // force: "Try again" skips the 2-minute cache
    loadHistory: async (metal, range, force = false) => {
      const key = metal + ':' + range; const h = st.history[key];
      if ((!force && h && h.points && Date.now() - h.at < 120e3) || histLoading.current[key]) return;
      histLoading.current[key] = true;
      set(s => ({ history: { ...s.history, [key]: { ...(s.history[key] || {}), error: false } } }));
      let got = null;
      for (const b of API_BASES) {
        try { const r = await fetchT(`${b}/api/history?metal=${metal}&range=${range}`, {}, 10000); if (!r.ok) continue; const d = await r.json(); if (d.ok && d.points && d.points.length > 1) { got = d; break; } } catch (e) { if (e.name === 'AbortError') break; }
      }
      histLoading.current[key] = false;
      set(s => ({ history: { ...s.history, [key]: got ? { points: got.points, source: got.source, usdPkr: got.usdPkr, marketClosed: !!got.marketClosed, lastAt: got.lastAt || null, at: Date.now() } : { error: true } } }));
    },
    redeem: (pid, units, dealerId) => {
      if (LIVE) {
        if (st.paying) return;
        set({ paying: true });
        Live.reserve(pid, units, dealerId).then(async r => { set(s => ({ redemptions: s.redemptions.some(x => x.id === r.id) ? s.redemptions : [r, ...s.redemptions] })); await sync(); loadDealers(); set(s => ({ paying: false, navDir: 'fwd', stack: [...s.stack, { name: 'code', rid: r.id }] })); },
          e => { set({ paying: false }); loadDealers(); liveFail(e); });
        return;
      }
      if (units < 1 || units > (holdings[pid] || 0) - (reserved[pid] || 0) || dealerFree(dealerId, pid) < units) { toast('That dealer no longer has enough stock. Choose another dealer.'); return; }
      const used = new Set(st.redemptions.map(r => r.code)); let code;
      do { code = String(Math.floor(100000 + Math.random() * 900000)); } while (used.has(code));
      const r = { id: 'RD-' + uid(), pid, units, dealerId, code, createdAt: Date.now(), expiresAt: Date.now() + RESERVE_MS, status: 'requested' };
      const d = DEALERS.find(x => x.id === dealerId);
      set(s => ({ redemptions: [...s.redemptions, r], navDir: 'fwd', stack: [...s.stack, { name: 'code', rid: r.id }] }));
      notify('redemption', 'Reserved for collection', `${units} × ${pname(P[pid])} at ${d.name}. Code ${code}, valid for ${Math.round(RESERVE_MS / 3600e3)} hours.`, true, { name: 'code', rid: r.id });
    },
    cancelRedemption: id => { if (LIVE) { Live.cancelRedemption(id).then(() => { sync(); loadDealers(); toast('Collection cancelled'); }, liveFail); return; } const r = st.redemptions.find(x => x.id === id); set(s => ({ redemptions: s.redemptions.map(x => (x.id === id ? { ...x, status: 'cancelled' } : x)) })); notify('redemption', 'Collection cancelled', `${r.units} × ${pname(P[r.pid])} is back in your wallet.`, true, { name: 'code', rid: id }); toast('Collection cancelled'); },
    markReady: id => { if (LIVE) return; const r = st.redemptions.find(x => x.id === id); set(s => ({ redemptions: s.redemptions.map(x => (x.id === id && x.status === 'requested' ? { ...x, status: 'ready' } : x)) })); notify('redemption', 'Ready for collection', `${pname(P[r.pid])} is ready at ${DEALERS.find(d => d.id === r.dealerId).name}. Bring your CNIC.`, false, { name: 'code', rid: id }); },
    handOver: id => {
      if (LIVE) return;                                    // production: the dealer does this in the dealer app
      const r = st.redemptions.find(x => x.id === id);
      if (!r || r.status !== 'ready') return;            // a code works once (Rule 5)
      const p = P[r.pid]; const d = DEALERS.find(x => x.id === r.dealerId);
      const serials = Array.from({ length: r.units }, () => `PGBX-${p.metal === 'gold' ? 'AU' : 'AG'}-${Math.floor(100000 + Math.random() * 900000)}`);
      set(s => ({
        redemptions: s.redemptions.map(x => (x.id === id ? { ...x, status: 'completed', completedAt: Date.now(), serials } : x)),
        ledger: [...s.ledger, { id: 'L-' + uid(), ts: Date.now(), pid: r.pid, delta: -r.units, reason: 'redemption', ref: r.id, dealer: d.name, serials }],
        dealerStock: { ...s.dealerStock, [d.id]: { ...s.dealerStock[d.id], [r.pid]: Math.max(0, s.dealerStock[d.id][r.pid] - r.units) } },
      }));
      notify('redemption', 'Collected', `${r.units} × ${pname(p)} collected at ${d.name}. Serial ${serials.join(', ')}.`, false, { name: 'code', rid: id });
    },
  };

  // A guest (including someone who chose "Browse as guest" on the lock screen) sees none of the account's data.
  aRef.current = A; ACT = A;
  const S = { ...st, ...(st.guest ? GUEST_VIEW : {}), now, stale, holdings: st.guest ? {} : holdings, reserved, dealerFree, walletValue, statusOf, spentToday, unread: st.guest ? 0 : unread };
  const framed = !Live.NATIVE && !matchMedia('(max-width:500px), (hover:none) and (pointer:coarse) and (max-height:600px)').matches;   // same rule as the CSS
  const enterApp = () => {
    lastActive.current = Date.now();
    set(s => { const go = s.loginIntent && s.loginIntent.go;
      return { guest: false, lockNote: '', loginNote: '', loginIntent: null, navDir: 'fade', pinFails: 0, pinLockUntil: 0, loggedIn: true,
        ...(go && go.tab ? { tab: go.tab, stack: [] } : {}),
        ...(go && go.push ? { tab: 'services', stack: [go.push] } : {}),
        ...(go && go.push && go.push.name === 'appraisal-book' ? { apprDraft: s.apprDraft || apprDefaults(s) } : {}),
        ...(go && go.push && go.push.name === 'gift-new' ? { giftDraft: s.giftDraft || giftDefaults(s) } : {}),
        ...(go && go.pid && P[go.pid] ? { buyMetal: P[go.pid].metal, qty: 1, stack: [{ name: 'product', pid: go.pid }], lock: lockFor(s, [go.pid]) } : {}) }; });
    const go = st.loginIntent && st.loginIntent.go;
    if (go && go.pid && P[go.pid]) serverLock([go.pid]);
    setPhase('app');
  };
  // After the code is verified: a phone without a chosen PIN (first login, or "Forgot PIN") creates one first.
  // Production: the PIN belongs to the server session, so every login chooses one.
  const afterLogin = () => { if (LIVE || !st.pinSet || st.pinReset) setPhase('createpin'); else enterApp(); };
  // Production lock screen: the server checks the PIN. Answers true when unlocked.
  const liveCheck = async p => {
    try {
      const r = await Live.unlock(p);
      if (r.noPin) {
        // A session from before PINs were checked by the server: the PIN saved on this phone moves to the server once
        if (st.pin && pinOk(p, st.pin)) { try { await Live.setPin(p); set({ pin: null }); return true; } catch (e) { setPhase('createpin'); return false; } }
        if (!st.pin) { setPhase('createpin'); return false; }
        pinFail(); return false;
      }
      set({ pinFails: 0, pinLockUntil: 0 }); return true;
    } catch (e) {
      if (e.code === 'WRONG_PIN') { set({ pinFails: e.fails || 1, pinLockUntil: e.waitSeconds ? Date.now() + e.waitSeconds * 1000 : 0, lockNote: '' }); return false; }
      if (e.code === 'PIN_WAIT') { set({ pinLockUntil: Date.now() + (e.retryIn || 30) * 1000 }); return false; }
      if (Live.signedOut(e)) { sessionEnded(endedNote(e)); if (e.code === 'PIN_LOCKED_OUT') set({ pinReset: true }); return false; }
      set({ lockNote: e.message }); return false;
    }
  };
  const liveBio = async () => {
    try { if (await Live.bioUnlock()) return true; set({ biometric: false, lockNote: 'Enter your PIN. Switch ' + bioName() + ' on again in Account.' }); return false; }
    catch (e) { if (Live.signedOut(e)) sessionEnded(endedNote(e)); else set({ lockNote: e.message }); return false; }
  };
  // The PIN chosen after login. Production saves it on the server; a refusal is shown on the PIN screen.
  const pinChosen = async p => {
    const reset = st.pinReset;
    if (LIVE) {
      try { await Live.setPin(p); } catch (e) { if (Live.signedOut(e)) { sessionEnded(endedNote(e)); return e.message; } return e.message; }
    }
    set({ pin: LIVE ? null : pinStore(p), pinSet: true, pinReset: false });
    setTimeout(() => {
      enterApp(); toast(reset ? 'New PIN saved. Use it to unlock PGBX on this phone.' : 'PIN created. Use it to unlock PGBX on this phone.');
      const b = LIVE && window.PGBXNative && window.PGBXNative.biometric;
      if (b && b.ready) set({ dialog: { title: `Unlock with ${bioName()}?`, body: `Use ${bioName()} instead of your PIN to unlock PGBX on this phone. You can change this in Account.`, confirm: `Use ${bioName()}`, cancel: 'Not now', onConfirm: () => aRef.current.setBio(true) } });
    }, 500);
    return true;
  };
  const browse = () => { set({ guest: true, tab: 'rates', stack: [], lockNote: '', loginIntent: null, navDir: 'fade' }); setPhase('app'); };
  const pinFail = () => {
    const f = st.pinFails + 1;
    if (f >= PIN_MAX_FAILS) {
      // The PIN is forgotten on this phone (so a reload can't offer it again) and the server session is ended.
      if (LIVE) Live.logout();
      set({ ...ACCOUNT_BLANK, pin: null, pinSet: false, pinFails: 0, pinLockUntil: 0, stack: [], loggedIn: false, guest: false, pinReset: true, loginNote: `${PIN_MAX_FAILS} wrong PINs. For your security, log in again with your mobile number, then choose a new PIN.` });
      notify('security', 'Session ended after wrong PINs', `${PIN_MAX_FAILS} wrong PIN attempts on this device. If this wasn’t you, contact PGBX.`);
      setPhase('login'); return;
    }
    set({ pinFails: f, pinLockUntil: f === PIN_COOLDOWN_AT ? Date.now() + 30000 : st.pinLockUntil });
    if (f === PIN_COOLDOWN_AT) notify('security', 'PIN entry paused', `${PIN_COOLDOWN_AT} wrong PIN attempts. Try again in 30 seconds.`);
  };

  let content;
  if (top) {
    const n = top.name;
    if (n === 'product') content = html`<${ProductScreen} S=${S} A=${A} pid=${top.pid}/>`;
    else if (n === 'cart') content = html`<${CartScreen} S=${S} A=${A}/>`;
    else if (n === 'pay') content = html`<${PayScreen} S=${S} A=${A}/>`;
    else if (n === 'processing') content = html`<${Processing} fail=${top.fail} kind=${top.kind}/>`;
    else if (n === 'receipt') content = html`<${Receipt} S=${S} A=${A} oid=${top.oid} showBack=${top.from === 'inbox'}/>`;
    else if (n === 'code') content = html`<${CodeScreen} S=${S} A=${A} rid=${top.rid}/>`;
    else if (n === 'collect') content = html`<${RedeemScreen} S=${S} A=${A} pushed=${true}/>`;
    else if (n === 'worth') content = html`<${WorthScreen} S=${S} A=${A}/>`;
    else if (n === 'micro') content = html`<${MicroScreen} S=${S} A=${A}/>`;
    else if (n === 'micro-sell') content = html`<${MicroSell} S=${S} A=${A}/>`;
    else if (n === 'micro-txn') content = html`<${MicroTxn} S=${S} A=${A} ref_=${top.ref}/>`;
    else if (n === 'chat') content = html`<${ChatScreen} S=${S} A=${A} id=${top.id} key=${top.id}/>`;
    else if (n === 'chats') content = html`<${ChatsScreen} S=${S} A=${A}/>`;
    else if (n === 'sell-bars') content = html`<${SellBarsScreen} S=${S} A=${A}/>`;
    else if (n === 'appraisal-book') content = html`<${AppraisalBook} S=${S} A=${A}/>`;
    else if (n === 'appraisal') content = html`<${AppraisalDetail} S=${S} A=${A} id=${top.id}/>`;
    else if (n === 'gift-new') content = html`<${GiftNew} S=${S} A=${A}/>`;
    else if (n === 'gift') content = html`<${GiftDetail} S=${S} A=${A} id=${top.id}/>`;
    else if (n === 'info') content = html`<${InfoScreen} S=${S} A=${A} kind=${top.kind}/>`;
    else if (n === 'changepin') content = html`<${ChangePin} S=${S} A=${A}/>`;
    else if (n === 'history') content = html`<${HistoryScreen} S=${S} A=${A} metal=${top.metal}/>`;
    else if (n === 'kyc') content = html`<${KycScreen} S=${S} A=${A} next=${top.next}/>`;
    else if (n === 'profile') content = html`<${ProfileScreen} S=${S} A=${A}/>`;
    else if (n === 'inbox') content = html`<${InboxScreen} S=${S} A=${A}/>`;
    else if (n === 'notifsettings') content = html`<${NotifSettings} S=${S} A=${A}/>`;
    else if (n === 'statement') content = html`<${StatementScreen} S=${S} A=${A}/>`;
    else if (n === 'closeaccount') content = html`<${CloseAccount} S=${S} A=${A}/>`;
  } else {
    const M = { rates: RatesHome, buy: BuyList, services: ServicesScreen, wallet: WalletScreen, account: AccountScreen }[st.tab] || RatesHome;
    content = html`<${M} S=${S} A=${A}/>`;
  }
  const routeKey = st.tab + '/' + (top ? top.name + (top.pid || top.rid || top.kind || top.oid || top.orderKey || '') : '') + '/' + st.stack.length;
  const darkTop = phase !== 'app' || (!top && st.tab === 'rates') || (top && top.name === 'changepin');
  // Tell the browser which colour sits behind the system status bar (Safari on iOS 26 fades the page into it),
  // so the top of the screen stays crisp: dark green on green screens, cream on cream screens.
  useEffect(() => {
    const c = darkTop ? '#0B4A2C' : '#F7F4EC';
    document.documentElement.style.backgroundColor = c;
    const m = document.querySelector('meta[name="theme-color"]'); if (m) m.setAttribute('content', c);
  }, [darkTop]);
  // Checkout and verification are focused tasks: the tab bar steps aside for their sticky actions.
  const hideTabs = top && ['product', 'cart', 'pay', 'processing', 'receipt', 'kyc', 'changepin', 'worth', 'appraisal-book', 'gift-new', 'micro', 'micro-sell', 'micro-txn', 'chat', 'sell-bars'].includes(top.name);
  const enterCls = st.navDir === 'fwd' ? 'enter-fwd' : st.navDir === 'back' ? 'enter-back' : 'enter';

  // System back (Android back button, iOS edge swipe, browser back) walks back through the app's screens.
  // Each pushed screen gets a history entry; going back in the app removes it again.
  stRef.current = st;
  useEffect(() => {
    const want = phase === 'app' ? st.stack.length : 0, d = want - histDepth.current;
    if (d > 0) { for (let i = 0; i < d; i++) history.pushState({ pgbx: histDepth.current + i + 1 }, ''); }
    // Browsers report a multi-step history.go(d) as one popstate at the target entry; the target depth (not a count)
    // is remembered so this stays correct even if a browser reported each intermediate step.
    else if (d < 0) { ignorePop.current = want; history.go(d); }
    histDepth.current = want;
  }, [st.stack.length, phase]);
  useEffect(() => {
    // A reload keeps the browser's history entries and their old depths: the page the app starts on is depth 0.
    try { history.replaceState({ pgbx: 0 }, ''); } catch (e) { }
    const onPop = e => {
      if (ignorePop.current !== null) {
        const at = e.state && typeof e.state.pgbx === 'number' ? e.state.pgbx : 0;
        if (at > ignorePop.current) return;                                  // an intermediate step of our own jump
        const ours = at === ignorePop.current; ignorePop.current = null;
        if (ours) return;                                                    // arrived where the app sent it
      }
      histDepth.current = Math.max(0, histDepth.current - 1);
      const s = stRef.current, top = s.stack[s.stack.length - 1];
      const stay = () => { history.pushState({ pgbx: histDepth.current + 1 }, ''); histDepth.current++; };
      if (s.dialog) { stay(); set({ dialog: null }); return; }              // back closes an open dialog first
      if (!top) return;
      if (top.name === 'processing') { stay(); return; }                     // never leave a payment half way
      const pop = () => set(x => ({ stack: x.stack.slice(0, -1), navDir: 'back' }));
      if (guardRef.current) { stay(); guardRef.current(pop); return; }       // unsaved work: ask first
      pop();
    };
    addEventListener('popstate', onPop); return () => removeEventListener('popstate', onPop);
  }, []);

  // Activity (for auto-lock) is noted with passive listeners: a non-passive touchmove or wheel listener on the app's
  // root would make every scroll wait for JavaScript before it can move.
  const deviceRef = useRef(null);
  useEffect(() => {
    const el = deviceRef.current; if (!el) return;
    const active = () => { lastActive.current = Date.now(); };
    const opts = { passive: true, capture: true };
    // (a touchstart listener also makes iOS show :active pressed states the moment a finger lands)
    const evs = ['pointerdown', 'touchstart', 'keydown', 'wheel', 'touchmove', 'scroll', 'input'];
    evs.forEach(e => el.addEventListener(e, active, opts));
    return () => evs.forEach(e => el.removeEventListener(e, active, opts));
  }, []);
  return html`<div class="device" ref=${deviceRef}>
    <div class="device-inner">
      <${StatusBar} light=${darkTop} />
      ${phase === 'splash' && html`<${Splash} rates=${st.rates} quick=${returning} onDone=${() => {  setPhase(returning ? 'pin' : 'login'); }} />`}
      ${phase === 'login' && html`<${Login} S=${S} note=${st.loginNote} intent=${st.loginIntent && st.loginIntent.note} hasPin=${st.pinSet && !st.pinReset} onRetry=${checkOtp} onDone=${phone => {
        // Another customer on this phone: nothing of the previous one's carries over (data, cart, PIN, biometrics)
        const other = phone !== st.phone;
        // (what this person just started as a guest, such as an appraisal from the calculator, comes along)
        const mine = st.loginIntent && st.loginIntent.go && st.loginIntent.go.push ? { apprDraft: st.apprDraft, giftDraft: st.giftDraft, worth: st.worth } : { worth: [] };
        if (other) set({ ...ACCOUNT_BLANK, ...(LIVE ? {} : { pin: null, pinSet: false }), cart: [], ...mine, biometric: !LIVE && st.biometric, pinFails: 0, pinLockUntil: 0 });
        set({ phone });
        if (other && !LIVE) setPhase('createpin'); else afterLogin();
        if (LIVE) { knownNotes.current = null; sync(); return; }
        notify('security', 'New login on this device', `Logged in with +92 ${phone.slice(0, 3)} ${phone.slice(3)}. If this wasn’t you, contact PGBX.`, true);
      }} onBrowse=${browse} onPin=${() => setPhase('pin')} />`}
      ${phase === 'pin' && html`<${LockScreen} pin=${st.pin} fails=${st.pinFails} lockUntil=${st.pinLockUntil} now=${now} biometric=${st.biometric} note=${st.lockNote}
          liveCheck=${liveCheck} liveBio=${liveBio}
          onUnlock=${enterApp} onFail=${pinFail} onBrowse=${browse} onForgot=${A.forgotPin} onLogin=${() => { if (LIVE) A.logout(); else { set({ lockNote: '', loginNote: '', loginIntent: null }); setPhase('login'); } }} />`}
      ${phase === 'createpin' && html`<${CreatePin} reset=${st.pinReset} onDone=${pinChosen} />`}
      ${phase === 'app' && html`<div class=${'app' + (framed ? ' framed' : '') + (hideTabs ? ' no-tabs' : '')}>
        <div class="view"><div class=${enterCls} key=${routeKey} style="position:absolute;inset:0">${content}</div></div>
        ${!hideTabs && html`<nav class="tabbar" aria-label="Main"><div class="tabs">
          <span class="tab-ind" style=${{ transform: `translateX(${Math.max(0, tabIndex(st.tab)) * 100}%)` }} aria-hidden="true"><i></i></span>
          ${TABS.map(([k, l]) => html`<button class=${'tab' + (st.tab === k ? ' on' : '')} onClick=${() => A.tab(k)} aria-current=${st.tab === k ? 'page' : null}>
            <${Icon} n=${k}/>${l}${st.guest && !OPEN_TABS.includes(k) ? html`<span class="lk" aria-label="Log in required"><${Icon} n="lock" c="xs"/></span>` : ''}</button>`)}
        </div></nav>`}
        ${st.offline && html`<div class="offline" role="status"><${Icon} n="wifiOff" c="sm"/> Offline. Prices update when you reconnect.</div>`}
        ${st.banner && html`<${PushBanner} n=${st.banner} onOpen=${() => (st.banner.link ? A.openLink(st.banner.link) : set(s => ({ banner: null, stack: [...s.stack, { name: 'inbox' }], navDir: 'fwd' })))} />`}
        ${st.toast && html`<div class="toast" key=${st.toast.id} role="status"><${Icon} n="check" c="sm"/><span class="grow">${st.toast.msg}</span>
          ${st.toast.action && html`<button class="toast-act" onClick=${() => { st.toast.action.fn(); set({ toast: null }); }}>${st.toast.action.label}</button>`}</div>`}
        ${st.dialog && html`<${Dialog} d=${st.dialog} onClose=${A.closeDialog} />`}
      </div>`}
    </div>
  </div>`;
}

// Confirmation sheet. Focus moves to the safe choice; Escape or tapping outside cancels.
function Dialog({ d, onClose }) {
  const ref = useRef(null);
  useEffect(() => {
    const prev = document.activeElement;
    const b = ref.current && ref.current.querySelector('[data-cancel]'); if (b) b.focus({ preventScroll: true });
    const esc = e => { if (e.key === 'Escape') onClose(); };
    addEventListener('keydown', esc);
    return () => { removeEventListener('keydown', esc); try { prev && prev.focus && prev.focus({ preventScroll: true }); } catch (e) { } };
  }, []);
  const ok = () => { onClose(); d.onConfirm && d.onConfirm(); };
  return html`<div class="scrim" onClick=${e => { if (e.target === e.currentTarget) onClose(); }}>
    <div class="dialog" ref=${ref} role="alertdialog" aria-modal="true" aria-labelledby="dlg-t" aria-describedby="dlg-b">
      <h2 id="dlg-t">${d.title}</h2>${d.body && html`<p id="dlg-b">${d.body}</p>`}
      <div class="stack-btns">
        <button class=${'btn ' + (d.danger ? 'btn-danger-solid' : 'btn-primary')} onClick=${ok}>${d.confirm || 'Confirm'}</button>
        <button class="btn btn-secondary" data-cancel onClick=${() => { onClose(); d.onCancel && d.onCancel(); }}>${d.cancel || 'Cancel'}</button>
      </div>
    </div>
  </div>`;
}

function StatusBar({ light }) {
  const [t, setT] = useState(() => new Date());
  useEffect(() => { const i = setInterval(() => setT(new Date()), 15000); return () => clearInterval(i); }, []);
  return html`<div class=${'statusbar ' + (light ? 'light' : 'dark')} aria-hidden="true">
    <span>${t.getHours()}:${String(t.getMinutes()).padStart(2, '0')}</span><span class="notch"></span>
    <span class="sb-icons">
      <svg width="18" height="12" viewBox="0 0 18 12" fill="currentColor"><rect x="0" y="8" width="3" height="4" rx="1"/><rect x="5" y="5.5" width="3" height="6.5" rx="1"/><rect x="10" y="3" width="3" height="9" rx="1"/><rect x="15" y="0" width="3" height="12" rx="1"/></svg>
      <svg width="16" height="12" viewBox="0 0 16 12" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"><path d="M1.5 4.5a9.5 9.5 0 0 1 13 0M4 7.3a6 6 0 0 1 8 0"/><circle cx="8" cy="10.2" r="1.1" fill="currentColor" stroke="none"/></svg>
      <svg width="26" height="12" viewBox="0 0 26 12" fill="none"><rect x=".5" y=".5" width="22" height="11" rx="3.2" stroke="currentColor" opacity=".45"/><rect x="2.5" y="2.5" width="16" height="7" rx="1.6" fill="currentColor"/><rect x="24" y="4" width="1.6" height="4" rx=".8" fill="currentColor" opacity=".5"/></svg>
    </span>
  </div>`;
}

/* Fit the 390×844 phone frame into the desktop window */
if (Live.NATIVE) document.documentElement.classList.add('native');
function fit() { const s = Math.min(1, (innerHeight - 48) / 862, (innerWidth - 32) / 408); document.documentElement.style.setProperty('--s', Math.max(0.4, s).toFixed(4)); }
addEventListener('resize', fit); fit();

// If anything unexpected breaks while drawing the app, show a way out instead of a blank page.
function CrashScreen() {
  return html`<div class="device"><div class="device-inner"><div class="lock" style="justify-content:center">
    <${Coin} size=${64} />
    <h2>Something went wrong</h2>
    <p class="note" style="line-height:1.5">${LIVE ? 'Try again. Your account and holdings are safe on PGBX’s servers. If it keeps happening, clear this phone’s app settings; you’ll need to log in again.' : 'The app couldn’t load your demo data. Try again, or reset the demo to start fresh.'}</p>
    <div class="stack-btns" style="width:100%;max-width:320px;margin-top:24px">
      <button class="btn btn-accent" onClick=${() => location.reload()}>Try again</button>
      <button class="btn btn-tertiary" style="color:#fff" onClick=${async () => { clearSaved(); if (LIVE) await Live.logout().catch(() => {}); location.href = location.pathname; }}>${LIVE ? 'Clear settings on this phone' : 'Reset demo data'}</button>
    </div>
  </div></div></div>`;
}
function Root() {
  const [error] = useErrorBoundary(e => { try { console.error('PGBX app error:', e); } catch (x) { } });
  return error ? html`<${CrashScreen}/>` : html`<${App}/>`;
}
render(html`<${Root}/>`, document.getElementById('root'));
