// htm + Preact, self-hosted (no third-party CDN at runtime); licences in vendor/LICENSES.txt
import { html, render, useState, useEffect, useRef, useMemo, useErrorBoundary } from './vendor/htm-preact-standalone-3.1.1.module.js';
import * as Live from './live.js';

// Two builds from one code base (npm run build:app writes the production one to dist/ and live/):
//   demo        presentations and testing: sample customer data in this browser, demo controls, simulated steps
//   production  the real app: every record comes from the PGBX API, no demo shortcuts, no sample data
const BUILD = document.querySelector('meta[name="pgbx-build"]')?.content === 'production' ? 'production' : 'demo';
const LIVE = BUILD === 'production';

// Fonts: Apple system families (SF Pro, SF Compact, SF Mono, New York) via CSS; nothing is downloaded.
// Requirement IDs (FR-*, NFR-*, CMP-*) live in code comments only; customers never see them.
const APP_VERSION = LIVE ? '1.0' : '0.9 (prototype)';

/* ============================================================
   Constants (SRS references in comments)
   ============================================================ */
const TOLA = 11.664;                       // 1 tola = 11.664 g in every calculation
const params = new URLSearchParams(location.search);
const START = LIVE ? null : params.get('start');   // demo only: home | login | pin
const FEED_FAIL = !LIVE && params.get('feedFail') === '1';
const FORCE_SIM = !LIVE && params.get('sim') === '1';
const POLL_MS = 10000;                     // FR-R1: update every 5–10 s
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
// Production: limits come from the PGBX settings, so the app and the server always agree
function applyLimits(l) {
  if (!l) return;
  if (Number.isInteger(l.max_units_per_order)) MAX_UNITS = l.max_units_per_order;
  if (Number.isInteger(l.daily_limit_pkr)) DAY_LIMIT = l.daily_limit_pkr;
  if (Number.isInteger(l.price_lock_seconds)) LOCK_S = l.price_lock_seconds;
  if (Number.isInteger(l.redemption_valid_hours)) RESERVE_MS = l.redemption_valid_hours * 3600e3;
  MIN_PURCHASE = Number.isInteger(l.min_purchase_pkr) ? l.min_purchase_pkr : null;
}
const PIN_DEFAULT = '1234';                // prototype PIN (changeable in Account > Change PIN)
// Production: the PIN is stored on the phone only as a salted, stretched SHA-256 hash, never as the digits.
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
function pinStore(pin) {
  if (!LIVE) return pin;
  const salt = hex(crypto.getRandomValues(new Uint8Array(16)));
  return `h1$${salt}$${pinHash(pin, salt)}`;
}
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
    await Live.verifyCode(body.phone, body.code);
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
const dealerOf = r => DEALERS.find(x => x.id === r.dealerId) || { id: r.dealerId, name: r.dealerName || 'PGBX dealer', area: '', phone: '', hours: '', lat: YOU.lat, lng: YOU.lng, km: 0, out: [] };
const initialDealerStock = () => Object.fromEntries(DEALERS.map(d => [d.id,
  Object.fromEntries(PRODUCTS.map(p => [p.id, d.out.includes(p.id) ? 0 : 3 + ((p.id.length * 7 + d.km * 10) | 0) % 9]))]));

/* ============================================================
   Helpers
   ============================================================ */
const fmt = n => 'Rs ' + Math.round(n).toLocaleString('en-US');
const fmtW = g => (g < 1 ? `${+(g * 1000).toFixed(0)} mg` : `${+g.toFixed(3)} g`);
const pct = n => (n >= 0 ? '+' : '') + n.toFixed(2) + '%';
const uid = () => Math.random().toString(36).slice(2, 8).toUpperCase();
const dt = ts => new Date(ts).toLocaleString('en-GB', { day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' });
const ago = ms => { const s = Math.max(0, Math.round(ms / 1000)); return s < 60 ? `${s}s ago` : `${Math.floor(s / 60)}m ${s % 60}s ago`; };
// Human-readable time for lists: "Just now", "5 min ago", "Today, 14:05", "Yesterday, 09:10", "28 Sept, 16:40"
const rel = (ts, now = Date.now()) => {
  const m = Math.floor((now - ts) / 60000), d = new Date(ts);
  const hm = d.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' });
  if (m < 1) return 'Just now';
  if (m < 60) return `${m} min ago`;
  if (sameDay(ts, now)) return `Today, ${hm}`;
  if (sameDay(ts, now - 86400e3)) return `Yesterday, ${hm}`;
  return `${d.toLocaleDateString('en-GB', { day: 'numeric', month: 'short' })}, ${hm}`;
};
const dur = ms => { const s = Math.max(0, Math.floor(ms / 1000)); return `${Math.floor(s / 3600)}h ${String(Math.floor(s % 3600 / 60)).padStart(2, '0')}m ${String(s % 60).padStart(2, '0')}s`; };
const buzz = () => { try { navigator.vibrate && navigator.vibrate(6); } catch (e) { } };
function mulberry(seed) { return () => { seed |= 0; seed = seed + 0x6D2B79F5 | 0; let t = Math.imul(seed ^ seed >>> 15, 1 | seed); t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t; return ((t ^ t >>> 14) >>> 0) / 4294967296; }; }

// Rule 1 / FR-R3: when live, buy/sell and product prices come from the server (/api/rates).
// The local formulas below are used only in simulated mode.
function rateOf(rates, metal) {
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
  redeem: 'M4 10l1.5-5h13L20 10M4 10h16M4 10a2.7 2.7 0 0 0 5.3 0 2.7 2.7 0 0 0 5.4 0 2.7 2.7 0 0 0 5.3 0M5.5 12.5V20h13v-7.5M10 20v-4h4v4',
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
  wa: 'M4 20l1.3-4A8 8 0 1 1 8 18.7L4 20zM9 9.5c0 3 2.5 5.5 5.5 5.5l1.2-1.4-1.9-.9-.8.8a3.5 3.5 0 0 1-2.4-2.4l.8-.8-.9-1.9L9 9.5z',
};
const Icon = ({ n, c = '', s }) => html`<svg class=${'icon ' + c} viewBox="0 0 24 24" style=${s} aria-hidden="true"><path d=${PATHS[n]} /></svg>`;

/* ============================================================
   Motion helpers
   ============================================================ */
// Rolling-digit price: each digit column slides (transform only). Rolls up from 0 on first view.
const DIGITS = [0, 1, 2, 3, 4, 5, 6, 7, 8, 9];
function Odo({ value, prefix = 'Rs ', decimals = 0, flash, dir }) {
  const [ready, setReady] = useState(false);
  useEffect(() => { let r2; const r = requestAnimationFrame(() => { r2 = requestAnimationFrame(() => setReady(true)); }); return () => { cancelAnimationFrame(r); cancelAnimationFrame(r2); }; }, []);
  const s = Number(value).toLocaleString('en-US', { minimumFractionDigits: decimals, maximumFractionDigits: decimals });
  const chars = s.split('');
  return html`<span class="odo" role="text" aria-label=${prefix + s}>
    ${flash != null && html`<span class=${'odo-fl' + (dir ? ' ' + dir : '')} key=${'f' + flash} aria-hidden="true"></span>`}
    <span aria-hidden="true" style=${{ marginRight: /\s$/.test(prefix) ? '.24em' : 0 }}>${prefix.trim()}</span>
    ${chars.map((c, i) => { const k = chars.length - i;
      return /\d/.test(c)
        ? html`<span class="odo-col" key=${'d' + k} aria-hidden="true"><span class="odo-strip" style=${{ transform: `translateY(${ready ? -Number(c) * 10 : 0}%)`, transitionDelay: (i * 35) + 'ms' }}>${DIGITS.map(d => html`<i>${d}</i>`)}</span></span>`
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
const Shariah = ({ small }) => html`<span class=${'shariah' + (small ? ' sm' : '')}><${Icon} n="shield" c="xs"/>Shariah compliant</span>`;

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
  const finish = () => { if (out) return; setOut(true); setTimeout(onDone, 350); };
  useEffect(() => { const t = setTimeout(finish, quick ? 800 : 2100); return () => clearTimeout(t); }, []);
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
    const finish = () => { setBusy(false); setOk(true); setTimeout(() => { setOut(true); setTimeout(() => onDone(phone), 620); }, 700); };
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
      <p>Buy 999.0 gold and silver, held for you by PGBX. Collect it at any of 250 dealers.</p>
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
      </div>` : html`<div class="step-in" key="otp">
        <h2>${ok ? 'Verified' : 'Enter the code'}</h2>
        <p class="sub">${demo ? 'Demo mode: no message was sent to' : `We sent a 6-digit code by ${viaName(sentVia)} to`} +92 ${shown(phone)}.${' '}
          <button class="linkbtn sm" style="min-height:0;font-size:14px" onClick=${() => { setDir('back'); setStep('phone'); setErr(''); }}>Change number</button></p>
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
function PinPad({ onComplete, ok, err = 0, showFace, onFace, disabled }) {
  const [pin, setPin] = useState('');
  useEffect(() => { if (pin.length === 4) { const t = setTimeout(() => { if (onComplete(pin) !== true) setPin(''); }, 160); return () => clearTimeout(t); } }, [pin]);
  const press = d => { if (disabled) return; buzz(); setPin(p => (p.length < 4 ? p + d : p)); };
  const keys = ['1', '2', '3', '4', '5', '6', '7', '8', '9', 'face', '0', 'del'];
  return html`
    <div class=${'dots4' + (ok ? ' ok' : '') + (err ? ' err' : '')} key=${'e' + err} role="status" aria-label=${`${pin.length} of 4 digits entered`}>
      ${[0, 1, 2, 3].map(i => html`<span class=${'dot' + (pin.length > i || ok ? ' on' : '')}></span>`)}
    </div>
    <div class=${'keypad' + (disabled ? ' off' : '')}>
      ${keys.map(k => {
        if (k === 'face') return showFace ? html`<button class="key plain" onClick=${onFace} aria-label="Unlock with Face ID"><span><${Icon} n="face"/><span class="kl">Face ID</span></span></button>` : html`<span></span>`;
        if (k === 'del') return html`<button class="key plain" onClick=${() => setPin(p => p.slice(0, -1))} aria-label="Delete digit"><${Icon} n="del"/></button>`;
        return html`<button class="key" onClick=${() => press(k)}>${k}</button>`;
      })}
    </div>`;
}

// FR-A3 PIN with face unlock; FR-A4 pause after 3 wrong PINs, end the session after 5.
function LockScreen({ pin, fails, lockUntil, now, biometric, note, onUnlock, onFail, onBrowse, onLogin, onForgot }) {
  const [ok, setOk] = useState(false);
  const [scan, setScan] = useState(false);
  const locked = lockUntil > now;
  const unlock = () => { setOk(true); setTimeout(onUnlock, 650); };
  const check = p => { if (locked) return false; if (pinOk(p, pin)) { unlock(); return true; } onFail(); return false; };
  // Production: Face ID / fingerprint through the phone (native app only); the demo simulates it.
  const bio = LIVE ? window.PGBXNative && window.PGBXNative.biometric : null;
  const canFace = biometric && !locked && (!LIVE || !!(bio && bio.ready));
  const face = async () => {
    if (locked) return;
    if (LIVE) { if (bio && await bio.verify('Unlock PGBX').catch(() => false)) unlock(); return; }
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
    <${PinPad} ok=${ok} err=${fails} onComplete=${check} showFace=${canFace} onFace=${face} disabled=${locked} />
    <div class="lock-links">
      <button class="linkbtn" onClick=${onForgot}>Forgot PIN?</button>
      <div style="display:flex;gap:16px"><button class="linkbtn dim" onClick=${onBrowse}>Browse as guest</button><button class="linkbtn dim" onClick=${onLogin}>Use another number</button></div>
    </div>
    ${scan && html`<div class="scan" role="status" aria-label="Checking Face ID"><div class="scan-box"><${Icon} n="face"/></div></div>`}
  </div>`;
}

// First login (and after "Forgot PIN"): the customer chooses the PIN they'll use to unlock the app on this phone.
const WEAK_PINS = new Set(['0000', '1111', '2222', '3333', '4444', '5555', '6666', '7777', '8888', '9999', '1234', '4321', '0123', '9876', '1212', '2580']);
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
    setOk(true); setTimeout(() => onDone(p), 500); return true;
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
const StaleBanner = () => html`<${Notice} kind="warning" title="Rates are delayed">Buying is paused until fresh prices arrive. This usually takes a few seconds.</${Notice}>`;
// Empty state: what is missing, why it matters, what to do next.
const Empty = ({ icon, title, body, action, onAction }) => html`<div class="empty rise">
  <div class="ei"><${Icon} n=${icon}/></div><b>${title}</b><p>${body}</p>
  ${action && html`<button class="btn btn-primary" onClick=${onAction}>${action}</button>`}</div>`;
// Demo-only controls, visibly separate from the product.
const Demo = ({ title, body, children }) => LIVE ? null : html`<div class="demo"><div class="demo-h"><${Icon} n="sliders" c="xs"/> Demo · ${title}</div>${body && html`<p>${body}</p>`}${children}</div>`;
const Tbc = () => html`<span class="tbc">${TBC}</span>`;
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
    ${S.kyc.status === 'reverify' ? 'You changed your identity details. It takes about 2 minutes.' : 'You’ll need your CNIC and a selfie. It takes about 2 minutes.'}</div>
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
      <p class="hh-greet">${guest ? 'Browsing as a guest' : `Assalam-o-Alaikum, ${S.profile.name.split(' ')[0]}`}</p>
      <h1>Today’s rates</h1>
      <div class="hh-live" role="status"><span class=${dotClass(rates, stale)}></span>${feedLabel(rates, stale, now)}</div>
    </header>
    <div class="rates">
      <${RateCard} rates=${rates} metal="gold" onOpen=${() => A.openHistory('gold')} />
      <${RateCard} rates=${rates} metal="silver" onOpen=${() => A.openHistory('silver')} />
    </div>
    ${stale && html`<${StaleBanner}/>`}
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

    ${guest && html`<section class="sec"><div class="group"><button class="row" onClick=${() => A.tab('redeem')}>
      <span class="ri gold"><${Icon} n="store" c="sm"/></span><div class="rt"><b>Collect at 250 dealers</b><span>Swap your holdings for the physical bar at a PGBX dealer.</span></div><${Icon} n="chev" c="sm chev"/>
    </button></div></section>`}

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
  if (!points || points.length < 2) return null;
  const W = 340, H = 180, PT = 12, PB = 6;
  const ys = points.map(p => p[1]); const min = Math.min(...ys), max = Math.max(...ys);
  const pad = (max - min) * 0.15 || max * 0.002, lo = min - pad, hi = max + pad;
  const x = i => (i / (points.length - 1)) * W;
  const y = v => PT + (1 - (v - lo) / (hi - lo)) * (H - PT - PB);
  const d = points.map((p, i) => (i ? 'L' : 'M') + x(i).toFixed(1) + ',' + y(p[1]).toFixed(1)).join('');
  const move = e => { const r = ref.current.getBoundingClientRect(); const rel = (e.clientX - r.left) / r.width; setHover(Math.max(0, Math.min(points.length - 1, Math.round(rel * (points.length - 1))))); };
  const tf = t => { const dd = new Date(t); return range === 'day' ? dd.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' }) : range === 'week' ? dd.toLocaleString('en-GB', { weekday: 'short', hour: '2-digit', minute: '2-digit' }) : dd.toLocaleDateString('en-GB', { day: '2-digit', month: 'short' }); };
  const grid = [0.25, 0.5, 0.75].map(f => lo + (hi - lo) * f);
  return html`<div class="chart-wrap">
    <svg ref=${ref} class="chart" viewBox=${`0 0 ${W} ${H}`} onPointerMove=${move} onPointerDown=${move} onPointerLeave=${() => setHover(null)} role="img" aria-label=${`Chart from ${fmt(points[0][1])} to ${fmt(points[points.length - 1][1])}`}>
      <defs><linearGradient id="chFill" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color=${color} stop-opacity=".16"/><stop offset="1" stop-color=${color} stop-opacity="0"/></linearGradient></defs>
      ${grid.map(v => html`<line class="ch-grid" x1="0" x2=${W} y1=${y(v)} y2=${y(v)}/><text class="ch-lbl" x=${W - 2} y=${y(v) - 4} text-anchor="end">${Math.round(v).toLocaleString('en-US')}</text>`)}
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
    ${S.stale && html`<${StaleBanner}/>`}
    <${KycCta} S=${S} A=${A} />
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

// Price lock shown on product, cart and payment (60 s, then refreshed to the latest rate)
const LockLine = ({ S }) => {
  const remain = S.lock ? Math.min(LOCK_S, Math.max(0, Math.ceil((S.lock.expiresAt - S.now) / 1000))) : LOCK_S;
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
      ${S.stale && html`<${StaleBanner}/>`}
      <div class="card" style="margin-top:12px">
        <div class="between"><span class="muted">Price per bar</span><b style="font-size:17px">${unit ? html`<${Odo} value=${unit} flash=${S.lock.expiresAt} />` : '—'}</b></div>
        <div style="margin-top:12px"><${LockLine} S=${S} /></div>
        <div class="between" style="margin-top:16px;padding-top:16px;border-top:1px solid var(--border)">
          <div><b style="display:block">Quantity</b><span class="small muted">Up to ${MAX_UNITS} per order</span></div>
          <div class="stepper" role="group" aria-label="Quantity">
            <button disabled=${S.qty <= 1} onClick=${() => A.set({ qty: Math.max(1, S.qty - 1) })} aria-label="Decrease quantity"><${Icon} n="minus" c="sm"/></button>
            <output aria-live="polite"><span key=${S.qty}>${S.qty}</span></output>
            <button disabled=${S.qty >= MAX_UNITS} onClick=${() => A.set({ qty: Math.min(MAX_UNITS, S.qty + 1) })} aria-label="Increase quantity"><${Icon} n="plus" c="sm"/></button>
          </div>
        </div>
      </div>
      <p class="foot">Each bar is backed one-to-one by metal held by PGBX. Collect it at a dealer whenever you like.</p>
    </div>
    <${ActionBar} label=${`Total for ${S.qty} bar${S.qty > 1 ? 's' : ''}`} amount=${html`<${Odo} value=${total} />`}>
      <div class="ab-btns">
        <button class="btn btn-secondary" disabled=${S.stale} onClick=${() => A.addToCart(pid, S.qty)}>Add to cart</button>
        <button class="btn btn-primary" disabled=${S.stale} onClick=${() => A.checkout('now')}>Buy now</button>
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
      <div class="pad"><${LockLine} S=${S} /></div>
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
      ${S.stale && html`<${StaleBanner}/>`}
    </div>
    <${ActionBar} label=${`${units} bar${units > 1 ? 's' : ''} · ${new Set(lines.map(l => P[l.pid].metal)).size > 1 ? 'gold and silver' : metalName(P[lines[0].pid].metal).toLowerCase()}`} amount=${html`<${Odo} value=${total} />`}>
      <button class="btn btn-primary" disabled=${S.stale || over || units > MAX_UNITS} onClick=${() => A.checkout('cart')}>Continue to payment</button>
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
  return html`<div class="page has-actions">
    <${TopBar} title="Payment" onBack=${A.back} />
    <div class="scroll">
      <div class="sec-h"><h3>Order</h3></div>
      <div class="card">
        ${lines.map(l => { const p = P[l.pid]; return html`<div class="kv"><span>${l.units} × ${pname(p)}</span><b>${fmt(prices[l.pid] * l.units)}</b></div>`; })}
        <div class="kv total"><span>Total</span><b><${Odo} value=${total} /></b></div>
        <div style="margin-top:12px"><${LockLine} S=${S} /></div>
      </div>
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
      ${S.stale && html`<${StaleBanner}/>`}
      <${Demo} title="Simulate a problem">
        <button class="row" onClick=${() => A.set({ simCreditFail: !S.simCreditFail })} role="switch" aria-checked=${S.simCreditFail}>
          <div class="rt"><b>Payment succeeds, crediting fails</b><span>Shows retries and hand-off to PGBX operations</span></div><${Switch} on=${S.simCreditFail} />
        </button>
      </${Demo}>
    </div>
    <${ActionBar}>
      <button class="btn btn-primary" disabled=${S.stale || S.paying || over || S.offline || S.lock.pending} onClick=${A.pay}>${S.paying ? html`<span class="spin"></span> Processing` : S.lock.pending ? html`<span class="spin"></span> Getting the latest price` : html`<${Icon} n="lock" c="sm"/> Pay ${fmt(total)}`}</button>
    </${ActionBar}>
  </div>`;
}

function Processing({ fail }) {
  const steps = fail
    ? [['ok', 'Payment received'], ['bad', 'Couldn’t add the metal to your wallet'], ['ok', 'Retrying (1 of 3)'], ['ok', 'Retrying (2 of 3)'], ['ok', 'Retrying (3 of 3)'], ['flag', 'Passed to PGBX operations']]
    : [['ok', 'Payment confirmed'], ['ok', 'Adding metal to your wallet'], ['ok', 'Issuing your receipt']];
  const [n, setN] = useState(0);
  useEffect(() => { const t = setInterval(() => setN(v => Math.min(v + 1, steps.length - 1)), fail ? 800 : 550); return () => clearInterval(t); }, []);
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
      <div class="kv total"><span>Total paid</span><b>${fmt(o.total)}</b></div>
      <div class="small muted" style="margin-top:8px">Tax and legal details: <${Tbc}/></div>
    </div>
    <div class="pad stack-btns" style="margin-top:24px">
      <button class="btn btn-primary" onClick=${() => A.tab('wallet')}>View wallet</button>
      <button class="btn btn-secondary" onClick=${share}><${Icon} n="share" c="sm"/> Share receipt</button>
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
  const [step, setStep] = useState(0);
  const [f, setF] = useState({ cnic: S.profile.cnic || '', name: S.profile.name || '', dob: S.profile.dob || '', expiry: S.kyc.expiry || '' });
  const [touched, setTouched] = useState({});
  const [shot, setShot] = useState({ front: false, back: false, selfie: false });
  const [busy, setBusy] = useState(false);
  const age = f.dob ? (Date.now() - Date.parse(f.dob)) / (365.25 * 86400e3) : 0;
  const errs = { cnic: f.cnic.replace(/\D/g, '').length !== 13, name: f.name.trim().length < 3, dob: !(age >= 18 && age < 120), expiry: !(Date.parse(f.expiry) > Date.now()) };
  const msgs = { cnic: 'Enter all 13 digits of your CNIC.', name: 'Enter your full name as printed on your CNIC.', dob: f.dob ? 'You must be 18 or older.' : 'Enter your date of birth.', expiry: f.expiry ? 'This CNIC has expired.' : 'Enter the expiry date.' };
  const ok = !Object.values(errs).some(Boolean);
  const show = k => (touched[k] || touched.all) && errs[k];
  const capture = k => { setBusy(true); setTimeout(() => { setShot(s => ({ ...s, [k]: true })); setBusy(false); }, 1500); };
  const [result, setResult] = useState(null);
  // Production: the details go to the server and the identity provider decides. The provider's own capture screens
  // (CNIC photos and selfie) open here once PGBX chooses a provider; the demo build simulates them.
  const submit = LIVE
    ? async () => { setStep(5); try { const r = await A.submitKycLive(f); setResult(r); setStep(r.status === 'verified' ? 6 : 7); } catch (e) { setResult({ status: 'error', reason: e.message }); setStep(7); } }
    : () => { setStep(5); A.submitKyc(f); setTimeout(() => { A.kycVerified(); setStep(6); }, 2600); };
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
          <div class="group" style="margin:20px 0 0">${[['Your CNIC details', 'Number, name, date of birth and expiry'], ['Photos of your CNIC', 'Front and back'], ['A selfie', 'Matched to your CNIC photo']].map(([t, d], i) => html`<div class="row"><span class="kn">${i + 1}</span><div class="rt"><b>${t}</b><span>${d}</span></div></div>`)}</div>
          <p class="small muted" style="margin-top:12px">Your details are encrypted and used only to verify your identity. We’ll ask to use your camera for the photos.</p>
          <button class="btn btn-primary" style="margin-top:24px" onClick=${() => setStep(1)}>Start</button>`}
        ${step === 1 && html`<div>
          ${F('cnic', 'CNIC number', html`<input class=${'inp' + (show('cnic') ? ' bad' : '')} inputmode="numeric" autocomplete="off" placeholder="00000-0000000-0" value=${fmtCnic(f.cnic)} onBlur=${() => setTouched(t => ({ ...t, cnic: true }))} onInput=${e => setF({ ...f, cnic: fmtCnic(e.target.value) })} />`)}
          ${F('name', 'Full name, as on your CNIC', html`<input class=${'inp' + (show('name') ? ' bad' : '')} autocomplete="name" value=${f.name} onBlur=${() => setTouched(t => ({ ...t, name: true }))} onInput=${e => setF({ ...f, name: e.target.value })} />`)}
          <div class="grid2">
            ${F('dob', 'Date of birth', html`<input class=${'inp' + (show('dob') ? ' bad' : '')} type="date" autocomplete="bday" value=${f.dob} onBlur=${() => setTouched(t => ({ ...t, dob: true }))} onInput=${e => setF({ ...f, dob: e.target.value })} />`)}
            ${F('expiry', 'CNIC expiry', html`<input class=${'inp' + (show('expiry') ? ' bad' : '')} type="date" value=${f.expiry} onBlur=${() => setTouched(t => ({ ...t, expiry: true }))} onInput=${e => setF({ ...f, expiry: e.target.value })} />`)}
          </div>
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
        <label class="field"><span class="lbl">CNIC number</span><input class="inp" inputmode="numeric" placeholder="Added during verification" value=${fmtCnic(f.cnic || '')} onInput=${e => setF({ ...f, cnic: fmtCnic(e.target.value) })} /></label>
        <label class="field"><span class="lbl">Date of birth</span><input class="inp" type="date" autocomplete="bday" value=${f.dob || ''} onInput=${e => setF({ ...f, dob: e.target.value })} /></label>
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
      <div class="pad" style="margin-top:24px"><button class="btn btn-primary" disabled=${!dirty || emailBad || nameBad} onClick=${() => A.saveProfile(f)}>Save changes</button></div>
    </div>
  </div>`;
}

/* ============================================================
   Wallet
   ============================================================ */
function WalletScreen({ S, A }) {
  const { holdings, reserved, walletValue: wv } = S;
  const held = PRODUCTS.filter(p => holdings[p.id] > 0);
  const history = [...S.ledger].reverse();
  const pending = S.orders.filter(o => o.status === 'flagged');
  return html`<div class="scroll">
    <${TabHead} title="Wallet" sub="Every bar is backed one-to-one by metal PGBX holds" />
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
      <button onClick=${() => A.tab('redeem')}><${Icon} n="store"/>Redeem</button>
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
      <div class="group"><div class="row">
        <span class="ri"><${Icon} n="refresh" c="sm"/></span>
        <div class="rt"><b>Sell back to PGBX</b><small><${Tbc}/></small></div>
      </div></div>
    </section>

    <section class="sec">
      <div class="sec-h"><h3>Activity</h3></div>
      <div class="group inset">
        ${history.map(e => { const p = P[e.pid]; const kind = e.reason === 'purchase' ? 'plus' : e.reason === 'redemption' ? 'minus' : 'open';
          const title = kind === 'plus' ? 'Bought' : kind === 'minus' ? 'Collected' : 'Opening balance';
          return html`<div class="row" style="align-items:flex-start">
            <span class=${'ri' + (kind === 'minus' ? ' gold' : '')}><${Icon} n=${kind === 'minus' ? 'store' : kind === 'plus' ? 'buy' : 'box'} c="sm"/></span>
            <div class="rt"><b>${title} ${Math.abs(e.delta)} × ${pname(p)}</b>
              <span>${rel(e.ts, S.now)}${e.dealer ? ' · ' + e.dealer : ''}${e.price ? ' · ' + fmt(e.price) + ' each' : ''}</span>
              <span class="mono" style="font-size:12px">${e.ref}${e.reason === 'opening' ? ' · sample' : ''}</span>
              ${e.serials && html`<span>Serial ${e.serials.join(', ')}</span>`}</div>
            <b class=${e.delta > 0 ? 'up' : ''} style="font-size:15px;white-space:nowrap">${e.delta > 0 ? '+' : '−'}${Math.abs(e.delta)}</b>
          </div>`; })}
      </div>
    </section>
    <p class="foot">Your balance is calculated from this activity record, which can’t be edited.</p>
  </div>`;
}

/* ---------- FR-W4 statement for a chosen period ---------- */
function holdingsAt(ledger, untilTs) { const h = {}; ledger.forEach(e => { if (e.ts < untilTs) h[e.pid] = (h[e.pid] || 0) + e.delta; }); return h; }
const holdText = h => PRODUCTS.filter(p => h[p.id] > 0).map(p => `${h[p.id]} × ${pname(p)}`).join(', ') || 'None';
function statementData(S, from, to) {
  const a = Date.parse(from + 'T00:00:00'), b = Date.parse(to + 'T23:59:59.999');
  return { a, b, opening: holdingsAt(S.ledger, a), closing: holdingsAt(S.ledger, b + 1), entries: S.ledger.filter(e => e.ts >= a && e.ts <= b) };
}
const entryType = e => (e.reason === 'purchase' ? 'Purchase' : e.reason === 'redemption' ? 'Redemption' : 'Opening balance (sample)');
function downloadBlob(name, type, text) {
  const url = URL.createObjectURL(new Blob([text], { type }));
  const a = document.createElement('a'); a.href = url; a.download = name; document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 4000);
}
function statementHtml(S, d, from, to) {
  const esc = x => String(x).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  const rows = d.entries.map(e => `<tr><td>${esc(dt(e.ts))}</td><td>${esc(entryType(e))}</td><td>${esc(pname(P[e.pid]))}</td><td style="text-align:right">${e.delta > 0 ? '+' : '−'}${Math.abs(e.delta)}</td><td style="text-align:right">${e.price ? esc(fmt(e.price)) : ''}</td><td>${esc(e.ref)}</td></tr>`).join('') || '<tr><td colspan="6">No activity in this period.</td></tr>';
  return `<!doctype html><html><head><meta charset="utf-8"><title>PGBX statement ${from} to ${to}</title>
<style>body{font:13px/1.5 -apple-system,BlinkMacSystemFont,system-ui,'Segoe UI',Roboto,Arial,sans-serif;color:#1D2B22;margin:32px}h1{font-family:ui-serif,'New York',Georgia,serif;color:#0B4A2C;margin:0}table{width:100%;border-collapse:collapse;margin-top:12px}th,td{padding:7px 8px;border-bottom:1px solid #ddd;text-align:left}th{background:#0B4A2C;color:#fff;font-size:11px;text-transform:uppercase}.m{color:#5F6D64}.box{border:1px solid #C8962B;border-radius:8px;padding:10px 12px;margin-top:12px}</style></head>
<body><h1>PGBX wallet statement</h1><div class="m">Pakistan Gold Bullion Exchange · Shariah compliant · Office 1211, 12th Floor, Gold Tower, Saddar, Karachi</div>
<div class="box"><b>${esc(S.profile.name)}</b> · CNIC ${esc(maskCnic(S.profile.cnic) || 'not verified')} · +92 ${esc(S.phone || '3XX XXX 4521')}<br>Period: ${from} to ${to} · Generated ${esc(dt(Date.now()))}</div>
<p><b>Opening holdings:</b> ${esc(holdText(d.opening))}<br><b>Closing holdings:</b> ${esc(holdText(d.closing))}</p>
<table><tr><th>Date</th><th>Type</th><th>Product</th><th>Units</th><th>Price / unit</th><th>Receipt / reference</th></tr>${rows}</table>
<p class="m">Holdings are calculated from your wallet activity record. Tax and legal details: [To be confirmed by PGBX].${LIVE ? '' : ' Prototype statement with sample data.'}</p></body></html>`;
}
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
      ...d.entries.map(e => [new Date(e.ts).toISOString(), entryType(e), pname(P[e.pid]), e.delta, e.price || '', e.ref].map(q).join(','))];
    downloadBlob(`PGBX-statement-${from}-to-${to}.csv`, 'text/csv', lines.join('\n')); A.toast('Statement downloaded as CSV');
  };
  const pdf = () => {
    const h = statementHtml(S, d, from, to);
    const w = window.open(URL.createObjectURL(new Blob([h], { type: 'text/html' })), '_blank');
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
      </div>
      <div class="pad stack-btns" style="margin-top:24px">
        <button class="btn btn-primary" onClick=${pdf}><${Icon} n="doc" c="sm"/> Save as PDF</button>
        <button class="btn btn-secondary" onClick=${csv}><${Icon} n="download" c="sm"/> Download CSV</button>
      </div>`}
      <p class="foot">Save as PDF opens a printable statement. Choose “Save as PDF” in the print dialog. Tax and legal details on statements: <${Tbc}/></p>
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
  <a class="btn btn-secondary btn-sm" href=${'tel:' + d.phone.replace(/\s/g, '')}><${Icon} n="call" c="sm"/> Call</a>
  <a class="btn btn-secondary btn-sm" href=${`https://www.google.com/maps/search/?api=1&query=${d.lat},${d.lng}`} target="_blank" rel="noopener"><${Icon} n="nav" c="sm"/> Directions</a>
</div>`;

function RedeemScreen({ S, A }) {
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
  return html`<div class="scroll">
    <${TabHead} title="Redeem" sub="Collect your bars at a PGBX dealer" />
    ${active.length > 0 && html`<section class="sec"><div class="sec-h"><h3>Ready to collect</h3></div>
      <div class="group inset-thumb">${active.map(r => html`<${RedemptionRow} r=${r} S=${S} A=${A}/>`)}</div></section>`}

    ${held.length === 0 ? html`<section class="sec"><${Empty} icon="store" title="Nothing to collect yet" body=${S.ledger.length ? 'All your bars are already reserved for collection.' : 'Buy a bar first. You can then collect it at any of 250 PGBX dealers.'} action=${S.ledger.length ? null : 'Buy a bar'} onAction=${() => A.tab('buy')} /></section>` : html`
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
        <div class="kv"><span>Collection fee</span><${Tbc}/></div>
        <div class="kv"><span>Gold and silver rules</span><${Tbc}/></div>
        <div class="kv"><span>Code valid for</span><b>24 hours</b></div>
      </div>
      <${Notice} kind="plain" icon="idcard"><b>Bring your original CNIC</b>The dealer checks it against your account. Your code works once, and only at the dealer you choose.</${Notice}>
    </section>
    ${S.offline && html`<${Notice} kind="warning" icon="wifiOff" title="You’re offline">Connect to the internet to reserve a collection.</${Notice}>`}
    <div class="pad" style="margin-top:24px"><button class="btn btn-primary" disabled=${!canConfirm || S.offline} onClick=${() => A.redeem(pid, units, did)}>${did ? `Reserve ${units} bar${units > 1 ? 's' : ''} for collection` : 'Choose a dealer'}</button></div>
    `}
    ${past.length > 0 && html`<section class="sec"><div class="sec-h"><h3>Past collections</h3></div><div class="group inset-thumb">${past.map(r => html`<${RedemptionRow} r=${r} S=${S} A=${A}/>`)}</div></section>`}
  </div>`;
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
  const r = S.redemptions.find(x => x.id === rid); const p = P[r.pid]; const d = dealerOf(r);
  const st = S.statusOf(r);
  const [idOk, setIdOk] = useState(false);
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
        ${r.code ? html`<div class=${'code' + (live ? '' : ' dim')} aria-label=${`Code ${r.code.split('').join(' ')}`}>${r.code.split('').map(c => html`<span aria-hidden="true">${c}</span>`)}</div>`
          : html`<div class="code dim" aria-label="Code no longer valid">${'••••••'.split('').map(c => html`<span aria-hidden="true">${c}</span>`)}</div>`}
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
        <div class="kv"><span>Collection fee</span><${Tbc}/></div>
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
const N_ICON = { purchase: 'buy', redemption: 'store', security: 'shield', account: 'user', alert: 'bell' };
const N_TONE = { purchase: '', redemption: ' gold', security: ' danger', account: '', alert: ' gold' };
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
        : html`<div class="group inset">${S.notifications.map(n => { const inner = html`
          <span class=${'ri' + (N_TONE[n.kind] || '')}><${Icon} n=${N_ICON[n.kind] || 'bell'} c="sm"/></span>
          <div class="rt"><b>${n.title}</b><span>${n.body}</span><span class="tiny" style="margin-top:4px">${rel(n.ts, S.now)}</span></div>
          ${unreadAtOpen.has(n.id) && html`<span class="ldot unread" aria-label="Unread"></span>`}
          ${n.link && html`<${Icon} n="chev" c="sm chev"/>`}`;
          return n.link ? html`<button class="row" style="align-items:flex-start" onClick=${() => A.openLink(n.link)}>${inner}</button>` : html`<div class="row" style="align-items:flex-start">${inner}</div>`; })}</div>`}
    </div>
  </div>`;
}
function NotifSettings({ S, A }) {
  const prefs = S.notifPrefs;
  return html`<div class="page">
    <${TopBar} title="Notification settings" onBack=${A.back} />
    <div class="scroll">
      <div class="group inset">
        ${[['push', 'Push notifications', 'On this phone', 'bell'], ['sms', 'SMS', 'To your mobile number', 'phone'], ['email', 'Email', S.profile.email || 'Add an email in Personal details', 'mail']].map(([k, l, d, ic]) => html`<button class="row" onClick=${() => A.set(s => ({ notifPrefs: { ...s.notifPrefs, [k]: !s.notifPrefs[k] } }))} role="switch" aria-checked=${prefs[k]}>
          <span class="ri"><${Icon} n=${ic} c="sm"/></span><div class="rt"><b>${l}</b><span>${d}</span></div><${Switch} on=${prefs[k]} /></button>`)}
      </div>
      <p class="foot">Where we send notifications, besides the app.</p>
      <section class="sec"><div class="sec-h"><h3>What we notify you about</h3></div>
        <div class="group">
          <button class="row" onClick=${() => A.set(s => ({ notifPrefs: { ...s.notifPrefs, alerts: s.notifPrefs.alerts === false } }))} role="switch" aria-checked=${prefs.alerts !== false}>
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
        ${(!LIVE || (window.PGBXNative && window.PGBXNative.biometric)) && html`<button class="row" onClick=${() => A.set({ biometric: !S.biometric })} role="switch" aria-checked=${S.biometric}>
          <span class="ri"><${Icon} n="face" c="sm"/></span><div class="rt"><b>${LIVE && /Android/.test(navigator.userAgent) ? 'Unlock with fingerprint or face' : 'Unlock with Face ID'}</b></div><${Switch} on=${S.biometric} /></button>`}
        <div class="row"><span class="ri"><${Icon} n="clock" c="sm"/></span><div class="rt"><b>Auto-lock</b><span>After 2 minutes without activity</span></div></div>
      </div></section>

    <section class="sec"><div class="sec-h"><h3>Preferences</h3></div>
      <div class="group inset">
        ${R({ icon: 'bell', label: 'Notifications', value: S.unread ? `${S.unread} new` : '', go: () => A.push({ name: 'inbox' }) })}
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
  const blockers = [
    bars > 0 && { t: `You still hold ${bars} bar${bars > 1 ? 's' : ''} worth ${fmt(S.walletValue.total)}`, d: 'Collect them at a dealer first. Selling back to PGBX: ', tbc: true, act: 'Collect your bars', go: () => A.tab('redeem') },
    active > 0 && { t: `${active} collection${active > 1 ? ' is' : 's are'} still open`, d: 'Collect or cancel them first.', act: 'View collections', go: () => A.tab('redeem') },
    pending > 0 && { t: `${pending} order${pending > 1 ? ' is' : 's are'} still being completed`, d: 'Wait until PGBX operations completes it.', act: 'View wallet', go: () => A.tab('wallet') },
  ].filter(Boolean);
  const close = () => A.confirm({ title: 'Close your PGBX account?', body: 'You won’t be able to log in or buy with this account again. Your personal details are removed from this phone. This can’t be undone.', confirm: 'Close account', cancel: 'Keep my account', danger: true, onConfirm: A.closeAccount });
  return html`<div class="page">
    <${TopBar} title="Close account" onBack=${A.back} />
    <div class="scroll">
      <div class="pad"><p class="muted">We’re sorry to see you go. Here’s what closing your account means.</p></div>
      ${blockers.length > 0 && html`<section class="sec"><div class="sec-h"><h3>Before you can close it</h3></div>
        <div class="group">${blockers.map(b => html`<div class="row" style="align-items:flex-start"><span class="ri gold"><${Icon} n="alert" c="sm"/></span>
          <div class="rt"><b>${b.t}</b><span>${b.d}${b.tbc && html`<${Tbc}/>`}</span>
            <button class="btn btn-secondary btn-sm" style="margin-top:8px" onClick=${b.go}>${b.act}</button></div></div>`)}</div></section>`}
      <section class="sec"><div class="sec-h"><h3>What happens</h3></div>
        <div class="card prose" style="padding:16px">
          <ul style="margin:0"><li>You can’t log in, buy or collect with this account again.</li>
          <li>Your PIN, saved details and settings are removed from this phone.</li>
          <li>PGBX keeps transaction records for as long as the law requires: <${Tbc}/></li>
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
  const done = p => {
    if (step === 0) { if (!pinOk(p, S.pin)) { setErr(e => e + 1); setMsg('That isn’t your current PIN.'); return false; } setMsg(''); setStep(1); return false; }
    if (step === 1) { if (pinOk(p, S.pin)) { setErr(e => e + 1); setMsg('Choose a PIN that’s different from your current one.'); return false; } setFirst(p); setMsg(''); setStep(2); return false; }
    if (p !== first) { setErr(e => e + 1); setMsg('The PINs didn’t match. Choose your new PIN again.'); setStep(1); return false; }
    setOk(true); setTimeout(() => { A.setPin(p); A.back(); }, 600); return true;
  };
  return html`<div class="lock">
    <div style="position:absolute;left:8px;top:calc(var(--top) + 4px)"><button class="iconbtn on-dark" onClick=${A.back} aria-label="Cancel"><${Icon} n="x"/></button></div>
    <${Coin} size=${56} />
    <h2 key=${step}>${steps[step]}</h2>
    <div class=${'note' + (msg ? ' warn' : '')} role="status">${msg || (step === 0 ? '' : 'Avoid easy PINs like 1234 or your birth year.')}</div>
    ${!LIVE && step === 0 && S.pin === PIN_DEFAULT && html`<div class="hint-demo">Demo PIN ${PIN_DEFAULT}</div>`}
    <${PinPad} key=${step} ok=${ok} err=${err} onComplete=${done} showFace=${false} />
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
    <div class="group" style="margin-top:12px"><div class="row"><div class="rt"><b>Support hours</b><small><${Tbc}/></small></div></div></div>`;
  else if (kind === 'report') body = html`<${Report} S=${S} A=${A}/>`;
  else if (kind === 'fees') body = html`
    <div class="sec-h"><h3>Product premiums</h3><${Sample}/></div>
    <div class="group">${PRODUCTS.map(p => html`<div class="row" style="min-height:48px"><div class="rt"><b style="font-weight:500">${pname(p)}</b></div><span class="rv"><b>${fmt((S.premiums && S.premiums[p.id]) ?? p.premium)}</b></span></div>`)}</div>
    <p class="foot">The premium is added to the metal value of each bar. It’s already included in every price you see.</p>
    <section class="sec"><div class="sec-h"><h3>Other charges</h3></div>
      <div class="group">${[['Buy and sell spread'], ['Collection fee'], ['Storage fee or time limit'], ['Minimum purchase', MIN_PURCHASE]].map(([l, v]) => v ? html`<div class="row"><div class="rt"><b style="font-weight:500">${l}</b></div><span class="rv"><b>${fmt(v)}</b></span></div>` : html`<div class="row"><div class="rt"><b style="font-weight:500">${l}</b><small><${Tbc}/></small></div></div>`)}</div></section>
    <section class="sec"><div class="sec-h"><h3>Limits</h3><${Sample}/></div>
      <div class="group">
        <div class="row"><div class="rt"><b style="font-weight:500">Per order</b></div><span class="rv"><b>${MAX_UNITS} bars</b></span></div>
        <div class="row"><div class="rt"><b style="font-weight:500">Per day</b></div><span class="rv"><b>${fmt(DAY_LIMIT)}</b></span></div>
        <div class="row"><div class="rt"><b style="font-weight:500">Limits by verification level</b><small><${Tbc}/></small></div></div>
      </div></section>
    <p class="foot">Every fee is shown before you confirm a purchase or collection.</p>`;
  else if (kind === 'about' && LIVE) body = html`<div class="prose">
      <h3>Pakistan Gold Bullion Exchange</h3>
      <p>Buy 999.0 gold and silver at live prices. PGBX holds your bars for you until you collect them at a PGBX dealer.</p>
      <p>Prices are set by PGBX from international spot prices converted at the live USD/PKR rate, plus the premium for each bar shown in Fees and limits.</p>
      <p class="small" style="margin-top:16px">Version ${APP_VERSION}</p>
    </div>`;
  else if (kind === 'about') body = html`<div class="prose">
      <h3>What this is</h3>
      <p>A working prototype of the PGBX customer app, built to test the experience before launch. Rates are live; everything else uses sample data stored only in this browser.</p>
      <h3>Live</h3>
      <ul><li>Gold, silver, platinum, palladium and copper prices, converted at the live USD/PKR rate</li><li>Login codes by SMS, once PGBX connects its SMS provider</li></ul>
      <h3>Sample or simulated</h3>
      <ul><li>The customer, wallet, orders and four dealers</li><li>Product premiums, sell spread and purchase limits</li><li>Payments, identity checks and the camera</li><li>The dealer map and the customer’s location</li><li>Notifications, which appear in the app only</li></ul>
      <h3>Still to be decided by PGBX</h3>
      <ul><li>Payment channels and providers: <${Tbc}/></li><li>Identity verification provider: <${Tbc}/></li><li>Push, SMS and email providers: <${Tbc}/></li><li>Map provider: <${Tbc}/></li><li>Urdu at launch: <${Tbc}/></li><li>In-app chat: <${Tbc}/></li><li>Written Shariah approval behind the “Shariah compliant” badge: <${Tbc}/></li></ul>
      <h3>Demo controls</h3>
      <p>The PIN is ${PIN_DEFAULT} until you change it. Boxes marked “Demo” let you simulate payment problems, PGBX operations and the dealer’s steps.</p>
      <p class="small" style="margin-top:16px">Version ${APP_VERSION}</p>
    </div>
    <div class="pad" style="margin-top:24px"><button class="btn btn-danger" onClick=${() => A.confirm({ title: 'Reset demo data?', body: 'This erases the sample wallet, orders, collections, alerts and settings in this browser and starts the demo again.', confirm: 'Reset demo data', danger: true, onConfirm: A.resetDemo })}><${Icon} n="refresh" c="sm"/> Reset demo data</button></div>`;
  else body = html`<div class="prose">
      ${[['Ownership of the metal in your wallet', 'How the wallet is classified and which approvals apply.'], ['Fees and charges', 'Spread, collection fee and any storage fee.'], ['How long you can hold', 'How long holdings can be kept and collected.'], ['Refunds and disputes', 'What happens if something goes wrong.'], ['Shariah approval', 'Written approval of the product, wallet and collection process.'], ['Privacy policy', 'How your personal data is collected, stored and deleted.']].map(([h, d]) =>
        html`<h3>${h}</h3><p>${d}</p><p style="margin-top:4px"><${Tbc}/></p>`)}
      <p class="small" style="margin-top:24px">You’ll be asked to accept these terms before your first purchase.</p>
    </div>`;
  return html`<div class="page">
    <${TopBar} title=${titles[kind]} onBack=${A.back} />
    <div class="scroll">${body}</div>
  </div>`;
}
function Faqs() {
  const [open, setOpen] = useState(0);
  const qs = [
    ['What do I own when I buy?', 'A whole bar, for example a 1 gram gold bar, held for you by PGBX. Every bar in your wallet is backed one-to-one by metal PGBX holds.'],
    ['What purity are the bars?', 'All eleven products are 999.0 purity.'],
    ['Can I buy part of a bar?', 'No. You always buy whole bars, and smaller bars can’t be combined into a larger one.'],
    ['Can I buy gold and silver together?', 'Yes. Add bars to your cart and pay for them in one order.'],
    ['Why can’t I buy larger bars?', 'Larger bars are sold at PGBX offline only.'],
    ['How long is the price locked?', 'For 60 seconds. After that it updates to the latest PGBX price.'],
    ['Why do I need to verify my identity?', 'PGBX must check your CNIC and a selfie before your first purchase.'],
    ['Where do I collect my metal?', 'At any of the 250 PGBX dealers that has your bar in stock. Bring your original CNIC. Your collection code is valid for 24 hours.'],
    ['Is there a collection fee?', null],
    ['Can I sell back to PGBX?', null],
    ['Is there a storage fee or time limit?', null],
    ['Is collecting gold different from silver?', null],
  ];
  return html`<div class="group">${qs.map(([q, a], i) => html`<div class=${'faq' + (open === i ? ' open' : '')}>
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
    <button class="btn btn-primary" style="margin-top:24px" disabled=${text.trim().length < 10} onClick=${() => A.report(ref, text)}>Send report</button>
  </div>`;
}

/* ============================================================
   App (shared state)
   ============================================================ */
const TABS = [['rates', 'Rates'], ['buy', 'Buy'], ['wallet', 'Wallet'], ['redeem', 'Redeem'], ['account', 'Account']];
const GUEST_REASON = { buy: 'Log in to buy gold and silver.', wallet: 'Log in to see your wallet.', redeem: 'Log in to collect your bars at a dealer.', account: 'Log in to manage your account.' };

// Prototype data is kept in this browser so a refresh does not wipe the demo. Sample data only; nothing leaves the device.
const STORE_KEY = LIVE ? 'pgbx-device-v1' : 'pgbx-demo-v1';
const KEEP = LIVE ? ['cart', 'pin', 'pinFails', 'pinLockUntil', 'phone', 'biometric', 'notifPrefs', 'tips', 'pinSet', 'loggedIn'] : ['ledger', 'orders', 'redemptions', 'dealerStock', 'cart', 'profile', 'kyc', 'pin', 'pinFails', 'pinLockUntil', 'phone',
  'notifications', 'notifPrefs', 'alerts', 'biometric', 'tab', 'buyMetal', 'loggedIn', 'pinSet', 'tips'];
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
  set('ledger', list(s.ledger, e => P[e.pid] && Number.isInteger(e.delta) && num(e.ts) && str(e.reason) && str(e.ref)));
  if (Array.isArray(s.orders)) set('orders', s.orders.map(o => {
    if (!isObj(o) || !str(o.id) || !str(o.receipt) || !num(o.ts)) return null;
    const lines = Array.isArray(o.lines) ? o.lines : (P[o.pid] ? [{ pid: o.pid, units: o.units, unit: o.unit }] : null);
    if (!lines || !lines.length || !lines.every(l => line(l) && num(l.unit))) return null;
    return { ...o, lines, total: num(o.total) ? o.total : lines.reduce((a, l) => a + l.unit * l.units, 0), method: METHODS.some(m => m.id === o.method) ? o.method : 'bank', status: o.status === 'flagged' ? 'flagged' : 'credited' };
  }).filter(Boolean));
  set('redemptions', list(s.redemptions, r => str(r.id) && P[r.pid] && int(r.units, 1, 1000) && DEALERS.some(d => d.id === r.dealerId) && /^\d{6}$/.test(r.code) && num(r.expiresAt) && ['requested', 'ready', 'completed', 'cancelled'].includes(r.status)));
  set('cart', list(s.cart, line));
  set('notifications', list(s.notifications, n => str(n.id) && num(n.ts) && str(n.title) && str(n.body) && str(n.kind)));
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
  if (TABS.some(t => t[0] === s.tab)) out.tab = s.tab;
  if (s.buyMetal === 'gold' || s.buyMetal === 'silver') out.buyMetal = s.buyMetal;
  if (typeof s.loggedIn === 'boolean') out.loggedIn = s.loggedIn;
  if (LIVE && !out.pin) { out.pinSet = false; out.loggedIn = false; }   // no usable PIN on this phone: log in again
  return out;
}
function saveState(st) { try { localStorage.setItem(STORE_KEY, JSON.stringify({ v: 1, s: Object.fromEntries(KEEP.map(k => [k, st[k]])) })); } catch (e) { } }
function clearSaved() { try { localStorage.removeItem(STORE_KEY); } catch (e) { } }
const SAVED = loadSaved();
// A one-off message carried across a reload (for example after closing an account)
const CARRY_NOTE = (() => { try { const n = sessionStorage.getItem('pgbx-note'); sessionStorage.removeItem('pgbx-note'); return n || ''; } catch (e) { return ''; } })();

function App() {
  const [phase, setPhase] = useState(START === 'home' ? 'app' : START === 'login' ? 'login' : START === 'pin' ? 'pin' : 'splash');
  const returning = !!(SAVED && SAVED.loggedIn);   // a returning customer unlocks with the PIN instead of logging in again
  const [st, setSt] = useState(() => ({
    guest: false, tab: 'rates', stack: [], navDir: 'fade', buyMetal: 'gold', qty: 1, lock: null, method: 'bank', paying: false, phone: '',
    rates: initialRates(), ledger: LIVE ? [] : initialLedger(), orders: [], redemptions: [], dealerStock: LIVE ? {} : initialDealerStock(), premiums: null,
    biometric: true, toast: null, lockNote: '', loginNote: '',
    // loginIntent: why the customer was sent to log in and where to take them afterwards ({ note, go: { tab } | { pid } })
    loginIntent: CARRY_NOTE ? { note: CARRY_NOTE } : null, pinReset: false, tips: {},
    // pinSet: whether this phone has a PIN the customer chose. Demo links that skip login use the demo PIN.
    pinSet: LIVE ? false : !!SAVED || START === 'home' || START === 'pin',
    profile: LIVE ? { name: '', cnic: '', dob: '', email: '', address: '' } : { name: 'Ahmed Khan', cnic: KYC_START === 'verified' ? '42000-0000000-1' : '', dob: KYC_START === 'verified' ? '1990-01-01' : '', email: '', address: '' },
    kyc: { status: KYC_START, at: KYC_START === 'verified' ? Date.now() - 20 * 86400e3 : null },
    pin: LIVE ? null : PIN_DEFAULT, pinFails: 0, pinLockUntil: 0,
    cart: [], checkout: [], checkoutFrom: 'now', simCreditFail: false,
    notifications: [], banner: null, notifPrefs: { push: true, sms: true, email: false, alerts: true },
    alerts: [], history: {}, dialog: null, offline: typeof navigator !== 'undefined' && navigator.onLine === false,
    otpCfg: { checked: false, configured: false, channels: ['sms'] },
    loggedIn: false,
    ...(SAVED || {}),
    ...(START === 'home' ? { loggedIn: true } : {}),
    ...(KYC_START === 'verified' ? { kyc: { status: 'verified', at: Date.now() - 20 * 86400e3 }, profile: { ...((SAVED && SAVED.profile) || { name: 'Ahmed Khan', email: '', address: '' }), cnic: (SAVED && SAVED.profile && SAVED.profile.cnic) || '42000-0000000-1', dob: (SAVED && SAVED.profile && SAVED.profile.dob) || '1990-01-01' } } : {}),
  }));
  const [now, setNow] = useState(Date.now());
  const set = patch => setSt(s => ({ ...s, ...(typeof patch === 'function' ? patch(s) : patch) }));
  const lastActive = useRef(Date.now());
  const committed = useRef(new Set(st.orders.map(o => o.id)));       // idempotency (Rule 2 / NFR-1), survives refresh
  const receipts = useRef(new Set(st.orders.map(o => o.receipt)));
  const histLoading = useRef({});
  const guardRef = useRef(null);          // set by a screen with unsaved work; called with the navigation it would interrupt
  const stRef = useRef(null);             // latest state for the system back handler
  const histDepth = useRef(0), ignorePop = useRef(null);   // ignorePop: depth an app-initiated history.go() is heading to

  useEffect(() => { const t = setInterval(() => setNow(Date.now()), 1000); return () => clearInterval(t); }, []);
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
    let alive = true, idx = 0;
    const poll = async () => {
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
    const t = setInterval(poll, POLL_MS);
    return () => { alive = false; clearInterval(t); };
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
  const sessionEnded = note => { Live.forget(); knownNotes.current = null; set({ loggedIn: false, guest: false, stack: [], loginIntent: null, loginNote: note || 'Your session has ended. Log in again to continue.' }); setPhase('login'); };
  const sync = async () => {
    if (!LIVE) return;
    try {
      const d = await Live.loadAll();
      const fresh = knownNotes.current ? d.notifications.filter(n => !knownNotes.current.has(n.id) && !n.read && !n.quiet) : [];
      knownNotes.current = new Set(d.notifications.map(n => n.id));
      set(s => ({ ...d, banner: fresh.length && s.notifPrefs.push && !(fresh[0].kind === 'alert' && s.notifPrefs.alerts === false) ? fresh[0] : s.banner }));
      return true;
    } catch (e) { if (Live.signedOut(e)) sessionEnded(e.code === 'ACCOUNT_INACTIVE' ? e.message : undefined); return false; }
  };
  const loadDealers = () => Live.dealers().then(ds => {
    DEALERS.splice(0, DEALERS.length, ...ds.map(d => ({ ...d, km: kmTo(d), out: [] })));
    set({ dealerStock: Object.fromEntries(ds.map(d => [d.id, Object.fromEntries(PRODUCTS.map(p => [p.id, d.available[p.id] || 0]))])) });
  }).catch(() => {});
  useEffect(() => {
    if (!LIVE) return;
    Live.restoreSession();
    loadDealers();
    Live.products().then(ps => set({ premiums: Object.fromEntries(ps.map(p => [p.id, p.premium_pkr])) })).catch(() => {});
  }, []);
  const signedIn = phase === 'app' && st.loggedIn && !st.guest;
  useEffect(() => {
    if (!LIVE || !signedIn) return;
    sync();
    const t = setInterval(() => { if (document.visibilityState !== 'hidden') sync(); }, 20000);
    const vis = () => document.visibilityState === 'visible' && sync();
    document.addEventListener('visibilitychange', vis);
    return () => { clearInterval(t); document.removeEventListener('visibilitychange', vis); };
  }, [signedIn]);
  // Native app: register for push once signed in, and open what a tapped notification points to
  useEffect(() => {
    const push = LIVE && window.PGBXNative && window.PGBXNative.push;
    if (!push || !signedIn) return;
    push.register(t => Live.registerPush(t.token, t.platform).catch(() => {}));
    const open = e => { sync().then(() => A.openLink(e.detail)); };
    addEventListener('pgbx-open-link', open); return () => removeEventListener('pgbx-open-link', open);
  }, [signedIn]);
  // A failed request shows its plain-language message; an expired session goes back to login.
  const liveFail = e => { if (Live.signedOut(e)) sessionEnded(e.code === 'ACCOUNT_INACTIVE' ? e.message : undefined); else toast(e.message); };

  // Stale when the server stops answering (30 s) or answers with prices that are themselves old (90 s)
  const stale = st.rates.mode !== 'connecting' && (now - (st.rates.polledAt || st.rates.updatedAt) > STALE_MS || now - st.rates.updatedAt > DATA_STALE_MS);
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

  // FR-B2: refresh locked prices at zero while on product, cart or pay
  useEffect(() => {
    if (st.lock && top && ['product', 'cart', 'pay'].includes(top.name) && now >= st.lock.expiresAt) {
      if (LIVE) { if (!st.lock.renewing) { set(s => ({ lock: { ...s.lock, renewing: true } })); serverLock(Object.keys(st.lock.prices), true); } return; }
      set(s => ({ lock: { prices: Object.fromEntries(Object.keys(s.lock.prices).map(pid => [pid, priceOf(P[pid], s.rates)])), expiresAt: Date.now() + LOCK_S * 1000 } }));
      toast('Prices updated to the latest rate');
    }
  }, [now]);

  // FR-A4: auto-lock after 2 minutes of inactivity
  useEffect(() => {
    if (phase === 'app' && !st.guest && !(top && ['processing', 'kyc'].includes(top.name)) && now - lastActive.current > AUTOLOCK_MS) {
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

  useEffect(() => { saveState(st); }, KEEP.map(k => st[k]));

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
    if (p.metal === 'gold') { gold += v; goldG += n * p.grams; } else { silver += v; silverG += n * p.grams; } }); return { gold, silver, goldG, silverG, total: gold + silver }; })();
  const spentToday = st.orders.filter(o => sameDay(o.ts, now)).reduce((a, o) => a + o.total, 0);
  const unread = st.notifications.filter(n => !n.read).length;

  const tabIndex = t => TABS.findIndex(x => x[0] === t);
  const lockFor = (s, pids) => ({ expiresAt: Date.now() + LOCK_S * 1000, prices: Object.fromEntries(pids.map(pid => [pid, priceOf(P[pid], s.rates)])), pending: LIVE });
  // Production: the price shown on product, cart and payment is the server's lock; nothing can be paid until it arrives.
  const serverLock = (pids, renewed) => {
    if (!LIVE || !pids.length) return;
    Live.lock(pids).then(l => { set({ lock: l }); if (renewed) toast('Prices updated to the latest rate'); },
      e => { set(s => (s.lock ? { lock: { ...s.lock, pending: true, renewing: false, error: e.message } } : {})); liveFail(e); });
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
      if (st.guest && t !== 'rates') { A.login(GUEST_REASON[t], { tab: t }); return; }
      A.leave(() => set(s => ({ tab: t, stack: [], navDir: s.stack.length ? 'back' : tabIndex(t) > tabIndex(s.tab) ? 'fwd' : tabIndex(t) < tabIndex(s.tab) ? 'back' : 'fade' })));
    },
    push: r => { if (st.guest) { A.login('Log in to continue.'); return; } set(s => ({ stack: [...s.stack, r], navDir: 'fwd' })); },
    back: () => A.leave(() => set(s => ({ stack: s.stack.slice(0, -1), navDir: 'back' }))),
    // Open whatever a notification points to; receipts opened this way get a back button.
    openLink: link => { if (!link) return; if (link.name === 'receipt' && link.from === undefined) link = { ...link, from: 'inbox' }; if (link.name === 'receipt' && !st.orders.some(o => o.id === link.oid)) return; if (link.name === 'code' && !st.redemptions.some(r => r.id === link.rid)) return;
      set(s => ({ banner: null, navDir: 'fwd', stack: [...s.stack, link] })); },
    // Guests are told why they need to log in, and taken where they were going afterwards.
    login: (note, go) => { set({ stack: [], loginNote: '', loginIntent: note ? { note, go } : null }); setPhase('login'); },
    logout: () => { if (LIVE) { Live.logout(); knownNotes.current = null; } set({ stack: [], guest: false, tab: 'rates', loginNote: '', loginIntent: { note: 'You’ve logged out. Your holdings are safe.' }, loggedIn: false }); setPhase('login'); },
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
          clearSaved(); Live.forget();
          try { sessionStorage.setItem('pgbx-note', 'Your PGBX account has been closed and your details were removed from this phone.'); } catch (e) { }
          location.reload();
        }, liveFail);
        return;
      }
      clearSaved(); try { sessionStorage.setItem('pgbx-note', 'Your PGBX account has been closed and your details were removed from this phone.'); } catch (e) { } location.href = location.pathname + '?start=login'; },
    resetDemo: () => { clearSaved(); location.href = location.pathname; },
    report: (ref, text) => {
      const done = () => { A.guard(null); A.toast('Report sent. PGBX support will reply in your notifications.'); A.back(); };
      if (!LIVE) { A.guard(null); A.toast('Report sent to PGBX support (demo)'); A.back(); return; }
      const about = ref.startsWith('o:') ? 'Order ' + ((st.orders.find(o => o.id === ref.slice(2)) || {}).receipt || '') : ref.startsWith('r:') ? 'Collection' : 'General';
      Live.report(ref.startsWith('o:') ? 'order' : ref.startsWith('r:') ? 'collection' : 'general', `${about}\n\n${text.trim()}`).then(done, liveFail);
    },
    lockNow: () => { set({ lockNote: 'App locked', stack: [] }); setPhase('pin'); },
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
      if (LIVE && (!st.lock || st.lock.pending)) { toast('Getting the latest price. Try again in a moment.'); return; }
      if (LIVE && MIN_PURCHASE && linesTotal(from === 'cart' ? st.cart : [{ pid: top.pid, units: st.qty }], st.lock.prices) < MIN_PURCHASE) { toast(`The minimum order is ${fmt(MIN_PURCHASE)}.`); return; }
      const lines = from === 'cart' ? st.cart : [{ pid: top.pid, units: st.qty }];
      if (!lines.length) return;
      const total = linesTotal(lines, st.lock.prices);
      if (linesUnits(lines) > MAX_UNITS) { toast(`You can buy up to ${MAX_UNITS} bars per order.`); return; }
      if (spentToday + total > DAY_LIMIT) { toast(`You can buy up to ${fmt(Math.max(0, DAY_LIMIT - spentToday))} more today.`); return; }
      const orderKey = 'K' + uid() + uid();
      set(s => ({ checkout: lines, checkoutFrom: from, paying: false, navDir: 'fwd', stack: [...s.stack, s.kyc.status === 'verified' ? { name: 'pay', orderKey } : { name: 'kyc', next: 'pay', orderKey }] }));
    },
    pay: () => {
      if (stale || st.paying || st.offline) return;
      if (LIVE) {
        if (!st.lock || st.lock.pending) return;
        const key = top.orderKey;
        set(s => ({ paying: true, navDir: 'fade', stack: [...s.stack, { name: 'processing' }] }));
        Live.placeOrder({ lockId: st.lock.id, lines: st.checkout, method: st.method, key }).then(async o => {
          await sync();
          set(s => ({ paying: false, navDir: 'fade', cart: s.checkoutFrom === 'cart' ? [] : s.cart, stack: [{ name: 'receipt', oid: o.id }], lock: null }));
        }, e => {
          // Back to the payment screen with the reason; the same key makes a retry safe (no double order)
          set(s => ({ paying: false, navDir: 'back', stack: s.stack.filter(r => r.name !== 'processing') }));
          if (e.code === 'LOCK_EXPIRED' || e.code === 'RATES_STALE') serverLock(st.checkout.map(l => l.pid), true);
          liveFail(e);
        });
        return;
      }
      const key = top.orderKey; const fail = st.simCreditFail;
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
        Live.saveProfile(f).then(r => { sync(); set(s => ({ navDir: 'back', stack: s.stack.slice(0, -1) })); toast(r.reverify ? 'Saved. Verify your identity again before your next purchase.' : 'Changes saved'); }, liveFail);
        return;
      }
      const idChanged = ['name', 'cnic', 'dob'].some(k => (f[k] || '') !== (st.profile[k] || ''));
      const reverify = idChanged && st.kyc.status === 'verified';
      set(s => ({ profile: { ...f, name: f.name.trim() }, kyc: reverify ? { ...s.kyc, status: 'reverify' } : s.kyc, navDir: 'back', stack: s.stack.slice(0, -1) }));
      notify('account', reverify ? 'Identity details changed' : 'Profile updated', reverify ? 'Verify your identity again before your next purchase.' : 'Your contact details were saved.', true);
      toast(reverify ? 'Saved. Verify your identity again before your next purchase.' : 'Changes saved');
    },
    changePhone: n => { if (LIVE) { sync(); toast('Mobile number updated'); return; } set({ phone: n }); notify('security', 'Mobile number changed', `Your account now uses +92 ${n.slice(0, 3)} ${n.slice(3)}. If this wasn’t you, contact PGBX.`, true); toast('Mobile number updated'); },
    setPin: p => { set({ pin: pinStore(p) }); notify('security', 'PIN changed', 'Your app PIN was changed on this device.', true); toast('PIN changed'); },
    markAllRead: () => { set(s => ({ notifications: s.notifications.map(n => ({ ...n, read: true })) })); if (LIVE) Live.markRead().catch(liveFail); },
    addAlert: (metal, dir, target) => { if (LIVE) { Live.addAlert(metal, dir, target).then(a => { set(s => ({ alerts: [a, ...s.alerts] })); toast(`We’ll notify you when ${metalName(metal).toLowerCase()} goes ${dir} ${fmt(target)}`); }, liveFail); return; } set(s => ({ alerts: [...s.alerts, { id: uid(), metal, dir, target, active: true }] })); toast(`We’ll notify you when ${metalName(metal).toLowerCase()} goes ${dir} ${fmt(target)}`); },
    removeAlert: id => {
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
        Live.reserve(pid, units, dealerId).then(async r => { await sync(); loadDealers(); set(s => ({ paying: false, navDir: 'fwd', stack: [...s.stack, { name: 'code', rid: r.id }] })); },
          e => { set({ paying: false }); loadDealers(); liveFail(e); });
        return;
      }
      if (units < 1 || units > (holdings[pid] || 0) - (reserved[pid] || 0) || dealerFree(dealerId, pid) < units) { toast('That dealer no longer has enough stock. Choose another dealer.'); return; }
      const used = new Set(st.redemptions.map(r => r.code)); let code;
      do { code = String(Math.floor(100000 + Math.random() * 900000)); } while (used.has(code));
      const r = { id: 'RD-' + uid(), pid, units, dealerId, code, createdAt: Date.now(), expiresAt: Date.now() + RESERVE_MS, status: 'requested' };
      const d = DEALERS.find(x => x.id === dealerId);
      set(s => ({ redemptions: [...s.redemptions, r], navDir: 'fwd', stack: [...s.stack, { name: 'code', rid: r.id }] }));
      notify('redemption', 'Reserved for collection', `${units} × ${pname(P[pid])} at ${d.name}. Code ${code}, valid for 24 hours.`, true, { name: 'code', rid: r.id });
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

  const S = { ...st, now, stale, holdings, reserved, dealerFree, walletValue, statusOf, spentToday, unread };
  const framed = window.innerWidth > 500;
  const enterApp = () => {
    lastActive.current = Date.now();
    set(s => { const go = s.loginIntent && s.loginIntent.go;
      return { guest: false, lockNote: '', loginNote: '', loginIntent: null, navDir: 'fade', pinFails: 0, pinLockUntil: 0, loggedIn: true,
        ...(go && go.tab ? { tab: go.tab, stack: [] } : {}),
        ...(go && go.pid ? { buyMetal: P[go.pid].metal, qty: 1, stack: [{ name: 'product', pid: go.pid }], lock: lockFor(s, [go.pid]) } : {}) }; });
    setPhase('app');
  };
  // After the code is verified: a phone without a chosen PIN (first login, or "Forgot PIN") creates one first.
  const afterLogin = () => { if (!st.pinSet || st.pinReset) setPhase('createpin'); else enterApp(); };
  const browse = () => { set({ guest: true, tab: 'rates', stack: [], lockNote: '', loginIntent: null, navDir: 'fade' }); setPhase('app'); };
  const pinFail = () => {
    const f = st.pinFails + 1;
    if (f >= PIN_MAX_FAILS) {
      set({ pinFails: 0, pinLockUntil: 0, stack: [], loggedIn: false, pinReset: true, loginNote: `${PIN_MAX_FAILS} wrong PINs. For your security, log in again with your mobile number, then choose a new PIN.` });
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
    else if (n === 'processing') content = html`<${Processing} fail=${top.fail}/>`;
    else if (n === 'receipt') content = html`<${Receipt} S=${S} A=${A} oid=${top.oid} showBack=${top.from === 'inbox'}/>`;
    else if (n === 'code') content = html`<${CodeScreen} S=${S} A=${A} rid=${top.rid}/>`;
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
    const M = { rates: RatesHome, buy: BuyList, wallet: WalletScreen, redeem: RedeemScreen, account: AccountScreen }[st.tab];
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
  const hideTabs = top && ['product', 'cart', 'pay', 'processing', 'receipt', 'kyc', 'changepin'].includes(top.name);
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

  const active = () => { lastActive.current = Date.now(); };
  return html`<div class="device" onPointerDown=${active} onKeyDown=${active} onWheel=${active} onTouchMove=${active} onScrollCapture=${active} onInput=${active}>
    <div class="device-inner">
      <${StatusBar} light=${darkTop} />
      ${phase === 'splash' && html`<${Splash} rates=${st.rates} quick=${returning} onDone=${() => {  setPhase(returning ? 'pin' : 'login'); }} />`}
      ${phase === 'login' && html`<${Login} S=${S} note=${st.loginNote} intent=${st.loginIntent && st.loginIntent.note} hasPin=${st.pinSet && !st.pinReset} onRetry=${checkOtp} onDone=${phone => {
        set({ phone }); afterLogin();
        if (LIVE) { knownNotes.current = null; sync(); return; }
        notify('security', 'New login on this device', `Logged in with +92 ${phone.slice(0, 3)} ${phone.slice(3)}. If this wasn’t you, contact PGBX.`, true);
      }} onBrowse=${browse} onPin=${() => setPhase('pin')} />`}
      ${phase === 'pin' && html`<${LockScreen} pin=${st.pin} fails=${st.pinFails} lockUntil=${st.pinLockUntil} now=${now} biometric=${st.biometric} note=${st.lockNote}
          onUnlock=${enterApp} onFail=${pinFail} onBrowse=${browse} onForgot=${A.forgotPin} onLogin=${() => { set({ lockNote: '', loginNote: '', loginIntent: null }); setPhase('login'); }} />`}
      ${phase === 'createpin' && html`<${CreatePin} reset=${st.pinReset} onDone=${p => { set({ pin: pinStore(p), pinSet: true, pinReset: false }); enterApp(); toast(st.pinReset ? 'New PIN saved. Use it to unlock PGBX on this phone.' : 'PIN created. Use it to unlock PGBX on this phone.'); }} />`}
      ${phase === 'app' && html`<div class=${'app' + (framed ? ' framed' : '') + (hideTabs ? ' no-tabs' : '')}>
        <div class="view"><div class=${enterCls} key=${routeKey} style="position:absolute;inset:0">${content}</div></div>
        ${!hideTabs && html`<nav class="tabbar" aria-label="Main"><div class="tabs">
          <span class="tab-ind" style=${{ transform: `translateX(${Math.max(0, tabIndex(st.tab)) * 100}%)` }} aria-hidden="true"><i></i></span>
          ${TABS.map(([k, l]) => html`<button class=${'tab' + (st.tab === k ? ' on' : '')} onClick=${() => A.tab(k)} aria-current=${st.tab === k ? 'page' : null}>
            <${Icon} n=${k}/>${l}${st.guest && k !== 'rates' ? html`<span class="lk" aria-label="Log in required"><${Icon} n="lock" c="xs"/></span>` : ''}</button>`)}
        </div></nav>`}
        ${st.offline && html`<div class="offline" role="status"><${Icon} n="wifiOff" c="sm"/> You’re offline. Prices will update when you reconnect.</div>`}
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
        <button class="btn btn-secondary" data-cancel onClick=${onClose}>${d.cancel || 'Cancel'}</button>
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
function fit() { const s = Math.min(1, (innerHeight - 48) / 862, (innerWidth - 32) / 408); document.documentElement.style.setProperty('--s', Math.max(0.4, s).toFixed(4)); }
addEventListener('resize', fit); fit();

// If anything unexpected breaks while drawing the app, show a way out instead of a blank page.
function CrashScreen() {
  return html`<div class="device"><div class="device-inner"><div class="lock" style="justify-content:center">
    <${Coin} size=${64} />
    <h2>Something went wrong</h2>
    <p class="note" style="line-height:1.5">The app couldn’t load your demo data. Try again, or reset the demo to start fresh.</p>
    <div class="stack-btns" style="width:100%;max-width:320px;margin-top:24px">
      <button class="btn btn-accent" onClick=${() => location.reload()}>Try again</button>
      <button class="btn btn-tertiary" style="color:#fff" onClick=${() => { clearSaved(); location.href = location.pathname; }}>Reset demo data</button>
    </div>
  </div></div></div>`;
}
function Root() {
  const [error] = useErrorBoundary(e => { try { console.error('PGBX app error:', e); } catch (x) { } });
  return error ? html`<${CrashScreen}/>` : html`<${App}/>`;
}
render(html`<${Root}/>`, document.getElementById('root'));
