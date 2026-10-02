// htm + Preact, self-hosted (no third-party CDN at runtime); licences in vendor/LICENSES.txt
import { html, render, useState, useEffect, useRef, useMemo, useErrorBoundary } from './vendor/htm-preact-standalone-3.1.1.module.js';

// Liquid Glass refraction needs SVG filters inside backdrop-filter, which only Chromium supports; others get blur only.
try { if (navigator.userAgentData && navigator.userAgentData.brands.some(b => /Chromium/.test(b.brand))) document.documentElement.classList.add('lg-refract'); } catch (e) { }

// Fonts load without blocking first paint (replaces an inline onload handler, which the CSP forbids)
{ const f = document.getElementById('fonts'); if (f) { if (f.sheet) f.media = 'all'; else f.addEventListener('load', () => { f.media = 'all'; }); } }

/* ============================================================
   Constants (SRS references in comments)
   ============================================================ */
const TOLA = 11.664;                       // 1 tola = 11.664 g in every calculation
const params = new URLSearchParams(location.search);
const START = params.get('start');         // home | login | pin
const FEED_FAIL = params.get('feedFail') === '1';
const FORCE_SIM = params.get('sim') === '1';
const POLL_MS = 10000;                     // FR-R1: update every 5–10 s
const SIM_TICK_MS = 5000;
const STALE_MS = 30000;                    // FR-R4: freshness limit (proposed default)
const LOCK_S = 60;                         // FR-B2: 60 s price lock
const MAX_UNITS = 10;                      // FR-B6: per-order limit (sample)
const RESERVE_MS = 24 * 3600 * 1000;       // redemption code expiry (24 h)
const AUTOLOCK_MS = 2 * 60 * 1000;         // FR-A4: lock after 2 minutes inactivity
const TBC = '[To be confirmed by PGBX]';
// Live rates come from the prototype's own server endpoint (Rule 1, FR-R3).
// Locally (no /api), it falls back to the deployed endpoint, then to simulated rates.
// Fixed list only: a link must never be able to point the app at another server (phishing / fake prices).
// Same origin first; the production host is the fallback for local static servers that have no /api.
const API_BASES = [...new Set(['', 'https://pgbx-app.vercel.app'])];
const API_URLS = API_BASES.map(b => b + '/api/rates');
const KYC_START = params.get('kyc') === 'done' ? 'verified' : 'none';   // ?kyc=done skips identity verification
const DAY_LIMIT = 1500000;                 // FR-B6: per-day purchase limit in PKR (sample)
const PIN_DEFAULT = '1234';                // prototype PIN (changeable in Account > Change PIN)
const PIN_COOLDOWN_AT = 3;                 // FR-A4: wrong PINs before a 30 s pause (sample)
const PIN_MAX_FAILS = 5;                   // FR-A4: wrong PINs before the session ends and OTP login is required (sample)
// Pakistani mobile numbers: Jazz 300–309 and 320–329, Zong 310–319, Ufone 330–339, Telenor 340–349, SCOM 355
const PK_MOBILE = /^3(?:[0-4]\d|55)\d{7}$/;
// FR-A1 one-time codes go through the server (/api/otp); the provider keys never reach the app (Rule 6).
async function otpCall(body) {
  for (const b of API_BASES) {
    try {
      const r = await fetch(`${b}/api/otp`, body ? { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) } : { cache: 'no-store' });
      if (r.status === 404 || r.status === 405 || r.status === 501) continue;
      const d = await r.json().catch(() => null);
      if (d) return d;
    } catch (e) { }
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
const WORLD_COLORS = { XAU: '#C8962B', XAG: '#9aa5ad', XPT: '#5f7d8e', XPD: '#8a7ca3', HG: '#b8653a' };

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
function applyLive(s, d) {
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
  return { rates: { mode: 'live', gold, silver, products: d.products, world, usdPkr: d.usdPkr, source: d.metals.gold.source, updatedAt: Date.now(), tick: s.rates.tick + (changed ? 1 : 0) } };
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
  sparkle: 'M12 3l1.8 5.2L19 10l-5.2 1.8L12 17l-1.8-5.2L5 10l5.2-1.8z',
  out: 'M15 4h4v16h-4M10 8l-4 4 4 4M6 12h10',
  refresh: 'M20 11a8 8 0 0 0-14.7-3.5M4 4.5V8h3.5M4 13a8 8 0 0 0 14.7 3.5M20 19.5V16h-3.5',
  box: 'M4 7.5l8-4 8 4v9l-8 4-8-4v-9zM4 7.5l8 4 8-4M12 11.5v9',
  bell: 'M6 16V11a6 6 0 0 1 12 0v5l1.5 2h-15L6 16zM10 20.5a2 2 0 0 0 4 0',
  cart: 'M3 4h2.5l2.2 11h10.6l2-8H7M9.5 20a1 1 0 1 0 0-2 1 1 0 0 0 0 2zM17 20a1 1 0 1 0 0-2 1 1 0 0 0 0 2z',
  idcard: 'M3.5 5.5h17v13h-17zM7 10.5a1.8 1.8 0 1 0 3.6 0 1.8 1.8 0 0 0-3.6 0M5.8 15.5c.5-1.4 1.5-2 3-2s2.5.6 3 2M14 9.5h4M14 12.5h4',
  camera: 'M4 8h3l1.5-2.5h7L17 8h3v11H4zM12 16.5a3.2 3.2 0 1 0 0-6.4 3.2 3.2 0 0 0 0 6.4z',
  user: 'M12 12a4 4 0 1 0 0-8 4 4 0 0 0 0 8zM4.5 20a7.5 7.5 0 0 1 15 0',
  mail: 'M3.5 6h17v12h-17zM3.5 6l8.5 7 8.5-7',
  map: 'M9 4L3.5 6v14L9 18l6 2 5.5-2V4L15 6 9 4zM9 4v14M15 6v14',
  nav: 'M4 11l16-7-7 16-2-7-7-2z',
  download: 'M12 4v11M7.5 10.5L12 15l4.5-4.5M5 19.5h14',
  trash: 'M5 7h14M10 7V4.5h4V7M7 7l1 13h8l1-13',
  edit: 'M4 20h4L19 9l-4-4L4 16v4zM13.5 6.5l4 4',
  chart: 'M4 19.5h16M6.5 16l3.5-4.5 3 2.5 4.5-6',
  globe: 'M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18zM3.5 9h17M3.5 15h17M12 3c2.5 2.6 3.7 5.6 3.7 9s-1.2 6.4-3.7 9c-2.5-2.6-3.7-5.6-3.7-9S9.5 5.6 12 3z',
};
const Icon = ({ n, c = '', s }) => html`<svg class=${'icon ' + c} viewBox="0 0 24 24" style=${s} aria-hidden="true"><path d=${PATHS[n]} /></svg>`;

/* ============================================================
   Motion helpers
   ============================================================ */
// Rolling-digit price: each digit column slides (transform only). Rolls up from 0 on first view.
const DIGITS = [0, 1, 2, 3, 4, 5, 6, 7, 8, 9];
function Odo({ value, prefix = 'Rs ', decimals = 0, flash }) {
  const [ready, setReady] = useState(false);
  useEffect(() => { let r2; const r = requestAnimationFrame(() => { r2 = requestAnimationFrame(() => setReady(true)); }); return () => { cancelAnimationFrame(r); cancelAnimationFrame(r2); }; }, []);
  const s = Number(value).toLocaleString('en-US', { minimumFractionDigits: decimals, maximumFractionDigits: decimals });
  const chars = s.split('');
  return html`<span class="odo" role="text" aria-label=${prefix + s}>
    ${flash != null && html`<span class="odo-fl" key=${'f' + flash} aria-hidden="true"></span>`}
    <span aria-hidden="true" style=${{ marginRight: /\s$/.test(prefix) ? '.24em' : 0 }}>${prefix.trim()}</span>
    ${chars.map((c, i) => { const k = chars.length - i;
      return /\d/.test(c)
        ? html`<span class="odo-col" key=${'d' + k} aria-hidden="true"><span class="odo-strip" style=${{ transform: `translateY(${ready ? -Number(c) * 10 : 0}%)`, transitionDelay: (i * 35) + 'ms' }}>${DIGITS.map(d => html`<i>${d}</i>`)}</span></span>`
        : html`<span key=${'s' + k} aria-hidden="true">${c}</span>`; })}
  </span>`;
}
const Letters = ({ text, delay = 0, step = 0.028 }) => {
  let n = 0; const words = text.split(' ');
  return html`<span class="letters" aria-label=${text}>${words.map((w, wi) => html`<span class="w" aria-hidden="true">${w.split('').map(ch => html`<span class="l" style=${{ animationDelay: (delay + (n++) * step).toFixed(3) + 's' }}>${ch}</span>`)}</span>${wi < words.length - 1 ? ' ' : ''}`)}</span>`;
};

/* ============================================================
   Brand visuals
   ============================================================ */
function Coin({ size = 200, glow = false, sweep = false, sweepDelay, still = false }) {
  const star = (cx, cy, R, r) => { let pts = []; for (let i = 0; i < 10; i++) { const a = -Math.PI / 2 + i * Math.PI / 5, rr = i % 2 ? r : R; pts.push((cx + rr * Math.cos(a)).toFixed(2) + ',' + (cy + rr * Math.sin(a)).toFixed(2)); } return pts.join(' '); };
  return html`<div class="coin-wrap" style=${{ width: size + 'px', height: size + 'px' }}>
    ${glow && html`<div class="glow"></div>`}
    <svg class=${'coin' + (still ? ' static' : '')} viewBox="0 0 200 200" width=${size} height=${size} role="img" aria-label="PGBX logo">
      <circle class="dots" cx="100" cy="100" r="97" fill="none" stroke="#E2B65A" stroke-width="2.2" stroke-linecap="round" stroke-dasharray="0.1 7" opacity=".85"/>
      <circle class="face" cx="100" cy="100" r="82" fill="url(#coinFace)"/>
      <circle class="ring" cx="100" cy="100" r="86" fill="none" stroke="url(#goldMetal)" stroke-width="5.5" pathLength="1" transform="rotate(-90 100 100)"/>
      <g class="emblem">
        <circle cx="100" cy="100" r="74" fill="none" stroke="#E2B65A" stroke-width=".8" opacity=".45"/>
        <circle cx="92" cy="80" r="30" fill="url(#goldMetal)" mask="url(#crescentMask)"/>
        <polygon points=${star(124, 62, 10, 4.2)} fill="url(#goldMetal)"/>
        <text x="100" y="146" text-anchor="middle" font-family="Lora, Georgia, serif" font-weight="700" font-size="34" letter-spacing="3" fill="url(#goldText)">PGBX</text>
        <g clip-path="url(#pgbxClip)"><rect class="shine" x="30" y="110" width="44" height="50" fill="url(#shineGrad)" transform="translate(-140 0)"/></g>
      </g>
    </svg>
    ${sweep && html`<div class="coin-sweep" style=${sweepDelay ? { '--sweep-delay': sweepDelay } : null}><i></i></div>`}
  </div>`;
}

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
    <text x="60" y="42" text-anchor="middle" font-family="Lato,sans-serif" font-weight="900" font-size="8" fill=${ink} fill-opacity=".85" letter-spacing="1">PGBX</text>
    <text x="60" y="52" text-anchor="middle" font-family="Lato,sans-serif" font-weight="700" font-size="7" fill=${ink} fill-opacity=".75">${label || '999.0'}</text>
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
    <polygon points=${`0,${h} ${line} ${w},${h}`} fill=${color} fill-opacity=".14"/>
    <polyline points=${line} fill="none" stroke=${color} stroke-width="1.8" stroke-linejoin="round" stroke-linecap="round"/>
    <circle cx=${last[0]} cy=${last[1]} r="3" fill=${color}/>
  </svg>`;
}

function QR({ code }) {
  const N = 25, r = mulberry(+code * 7919 + 13); const cells = [];
  const finder = (x, y) => (x >= 0 && x < 7 && y >= 0 && y < 7);
  const inF = (x, y) => finder(x, y) || finder(x - (N - 7), y) || finder(x, y - (N - 7));
  for (let y = 0; y < N; y++) for (let x = 0; x < N; x++) { if (!inF(x, y) && r() > 0.52) cells.push(html`<rect x=${x} y=${y} width="1" height="1"/>`); }
  const F = (x, y) => html`<g transform=${`translate(${x} ${y})`}><rect width="7" height="7" rx="1.2"/><rect x="1" y="1" width="5" height="5" rx=".8" fill="#fff"/><rect x="2" y="2" width="3" height="3" rx=".5"/></g>`;
  return html`<svg class="qr" viewBox=${`0 0 ${N} ${N}`} shape-rendering="crispEdges" aria-label="Redemption code pattern" fill="#0B4A2C">${cells}${F(0, 0)}${F(N - 7, 0)}${F(0, N - 7)}</svg>`;
}

const feedLabel = (rates, stale, now) => {
  if (rates.mode === 'connecting') return 'Connecting to live rates…';
  if (stale) return `Delayed · last update ${ago(now - rates.updatedAt)}`;
  return `${rates.mode === 'live' ? 'Live' : 'Simulated'} · updated ${ago(now - rates.updatedAt)}`;
};
const dotClass = (rates, stale) => 'ldot' + (stale ? ' stale' : rates.mode !== 'live' ? ' sim' : '');

/* ============================================================
   Splash
   ============================================================ */
function Splash({ onDone, rates, quick }) {
  const [out, setOut] = useState(false);
  const parts = useMemo(() => Array.from({ length: 22 }, (_, i) => ({
    left: (i * 37 % 100) + '%', dur: 5 + (i * 13 % 50) / 10, delay: (i * 7 % 30) / 10, dx: ((i * 23 % 60) - 30) + 'px', size: 2 + (i % 4),
  })), []);
  const sparks = useMemo(() => Array.from({ length: 18 }, (_, i) => { const a = (i / 18) * Math.PI * 2, r = 120 + (i % 3) * 26; return { x: Math.cos(a) * r, y: Math.sin(a) * r, d: (i % 4) * 0.04 }; }), []);
  const finish = () => { if (out) return; setOut(true); setTimeout(onDone, 700); };
  useEffect(() => { const t = setTimeout(finish, quick ? 1200 : 3900); return () => clearTimeout(t); }, []);
  const status = rates.mode === 'live' ? html`<b>●</b> Live rates connected` : rates.mode === 'sim' ? 'Using simulated rates' : 'Connecting to live rates…';
  if (quick) return html`<div class=${'splash quick' + (out ? ' out' : '')} onClick=${finish}>
    <div class="rays"></div><div class="vignette"></div>
    <div class="splash-center">
      <div class="coin-stage"><${Coin} size=${150} glow=${true} still=${true} /></div>
      <h1 class="splash-title">Pakistan Gold Bullion Exchange</h1>
    </div>
  </div>`;
  return html`<div class=${'splash' + (out ? ' out' : '')} onClick=${finish}>
    <div class="rays"></div><div class="vignette"></div>
    <div class="particles">${parts.map(p => html`<span class="particle" style=${{ left: p.left, width: p.size + 'px', height: p.size + 'px', animationDuration: p.dur + 's', animationDelay: p.delay + 's', '--dx': p.dx }}></span>`)}</div>
    <div class="splash-center">
      <div class="coin-stage">
        <div class="burst">${sparks.map(s => html`<span class="ember" style=${{ '--x': s.x + 'px', '--y': s.y + 'px', animationDelay: (1.42 + s.d) + 's' }}></span>`)}</div>
        <div class="coin-flip"><${Coin} size=${190} glow=${true} sweep=${true} /></div>
      </div>
      <h1 class="splash-title"><${Letters} text="Pakistan Gold Bullion Exchange" delay=${1.7} step=${0.026} /></h1>
      <div class="splash-tag">${['LIVE RATES', 'BUY', 'WALLET', 'REDEEM'].map((w, i) => html`${i ? html`<i style=${{ animationDelay: (2.45 + i * 0.12) + 's' }}></i>` : ''}<span style=${{ animationDelay: (2.4 + i * 0.12) + 's' }}>${w}</span>`)}</div>
    </div>
    <div class="splash-load"><div class="bar"><i></i></div><span>${status}</span></div>
  </div>`;
}

/* ============================================================
   Login: mobile number + one-time code (FR-A1)
   ============================================================ */
function Login({ S, note, onDone, onBrowse, onPin, onRetry }) {
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
  const demo = cfg.checked && !cfg.unreachable && cfg.configured === false;
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
  return html`<div class=${'login' + (out ? ' out' : '')}>
    <div class="aurora a"></div><div class="aurora b"></div>
    <div class="login-top">
      <div class="halo two"></div><div class="halo"></div>
      <div class="login-logo"><div class="in"><div class="float">
        <div class="orbit"><i></i></div>
        <${Coin} size=${128} glow=${true} sweep=${true} sweepDelay="2s" />
      </div></div></div>
      <h1><${Letters} text="Welcome to PGBX" delay=${0.75} step=${0.035} /></h1>
      <p>Gold and silver, held for you. Collect at 250 dealers.</p>
      <div class="ticker">
        ${[['gold', g, ''], ['silver', s, ' sil']].map(([m, r, c]) => html`<div class=${'tick' + c}>
          <span class="lv"><span class=${dotClass(S.rates, S.stale)}></span>${metalName(m)} · per tola</span>
          ${connecting ? html`<span class="sk" style="width:96px;height:18px;margin-top:2px"></span>` : html`<b><${Odo} value=${r.buyTola} flash=${S.rates.tick} /></b>`}
        </div>`)}
      </div>
    </div>
    <div class="sheet glass">
      <div class="grab"></div>
      ${note && html`<div class="login-note" role="alert"><${Icon} n="shield" c="sm"/><span>${note}</span></div>`}
      ${down && html`<div class="login-note" role="alert"><${Icon} n="alert" c="sm"/><span style="flex:1">Can’t reach the login service. Check your connection.</span><button class="linkbtn" style="min-height:0;font-size:13px" onClick=${onRetry}>Retry</button></div>`}
      ${demo && html`<div class="login-note"><${Icon} n="info" c="sm"/><span><b style="display:inline">Demo mode.</b> The SMS provider isn’t connected yet, so no message is sent and any 6 digits work.</span></div>`}
      ${step === 'phone' ? html`<div class=${dir === 'in' ? 'step-in' : 'step-back'} key="phone">
        <h2>Log in or create an account</h2>
        <p class="sub">Enter your Pakistani mobile number. We’ll send you a one-time code (FR-A1).</p>
        <label class=${'field' + (phone.length === 10 && !valid ? ' bad' : '')}>
          <span class="cc">PK +92</span>
          <input ref=${phoneRef} type="tel" inputmode="numeric" autocomplete="tel-national" placeholder="3XX XXXXXXX" aria-label="Mobile number" aria-invalid=${phone.length === 10 && !valid}
            value=${shown(phone)} onInput=${e => { let v = e.target.value.replace(/\D/g, ''); if (v.startsWith('92')) v = v.slice(2); if (v.startsWith('0')) v = v.slice(1); setPhone(v.slice(0, 10)); setErr(''); }}
            onKeyDown=${e => { if (e.key === 'Enter') send(); }} />
          ${valid && html`<span class="okc"><${Icon} n="check"/></span>`}
        </label>
        ${phone.length === 10 && !valid ? html`<div class="hint err">That isn’t a Pakistani mobile number. Mobile numbers start with 30–34 or 355, for example 300 1234567.</div>`
          : phone && phone[0] !== '3' ? html`<div class="hint err">Mobile numbers start with 3, for example 300 1234567.</div>` : ''}
        <div style="margin-top:14px">
          <div class="small muted" style="margin-bottom:6px">Send my code by</div>
          <${Seg} items=${[['sms', 'SMS'], ['whatsapp', channels.includes('whatsapp') ? 'WhatsApp' : 'WhatsApp · soon']]} value=${channel} onChange=${v => { if (channels.includes(v)) { setChannel(v); setErr(''); } else setErr('WhatsApp codes need PGBX’s WhatsApp Business number, which isn’t connected yet. Use SMS for now.'); }} />
        </div>
        ${err && html`<div class="hint err" role="alert">${err}</div>`}
        <div style="margin-top:14px"><button class="btn btn-gold" disabled=${!valid || !cfg.checked || down} onClick=${() => send()}>${busy ? html`<span class="mini-spin"></span> Sending code` : !cfg.checked ? html`<span class="mini-spin"></span> Connecting` : html`Send code by ${viaName(channel)} <${Icon} n="chev" c="sm"/>`}</button></div>
      </div>` : html`<div class="step-in" key="otp">
        <h2>${ok ? 'Verified' : 'Enter the 6-digit code'}</h2>
        <p class="sub">${demo ? 'Demo: no message was sent to' : `Sent by ${viaName(sentVia)} to`} +92 ${shown(phone)} · <button class="linkbtn" style="min-height:0;font-size:13px" onClick=${() => { setDir('back'); setStep('phone'); setErr(''); }}>Change</button></p>
        <div class=${'otp' + (ok ? ' ok' : '') + (shake ? ' err' : '')} key=${'o' + shake} onClick=${() => otpRef.current && otpRef.current.focus()}>
          ${[0, 1, 2, 3, 4, 5].map(i => html`<div class=${'ob' + (i === otp.length && !ok ? ' cur' : '')} style=${ok ? { animationDelay: (i * 0.05) + 's' } : null}>${otp[i] ? html`<span key=${i + otp[i]}>${otp[i]}</span>` : ''}</div>`)}
          <input ref=${otpRef} type="text" inputmode="numeric" autocomplete="one-time-code" maxlength="6" aria-label="One-time code" value=${otp} disabled=${ok || busy}
            onInput=${e => setOtp(e.target.value.replace(/\D/g, '').slice(0, 6))} />
        </div>
        ${err && html`<div class="hint err" role="alert">${err}</div>`}
        <div class="between" style="margin-top:12px">
          <span class="small muted">${busy ? 'Verifying…' : ok ? 'Signing you in' : demo ? 'Demo: any 6 digits work' : 'The code expires in 10 minutes'}</span>
          <button class="linkbtn" style="min-height:36px;font-size:13px" disabled=${resendIn > 0 || busy} onClick=${() => send(sentVia)}>${resendIn > 0 ? `Resend in ${resendIn}s` : `Resend by ${viaName(sentVia)}`}</button>
        </div>
        ${resendIn === 0 && channels.length > 1 && html`<button class="linkbtn" style="min-height:36px;font-size:13px" disabled=${busy} onClick=${() => { const v = sentVia === 'sms' ? 'whatsapp' : 'sms'; setChannel(v); send(v); }}>Send by ${viaName(sentVia === 'sms' ? 'whatsapp' : 'sms')} instead</button>`}
      </div>`}
      <div class="login-links">
        <button class="linkbtn" onClick=${onBrowse}><${Icon} n="rates" c="sm"/> Browse live rates without logging in</button>
        <button class="linkbtn" style="color:var(--muted);font-weight:400;font-size:13px;min-height:36px" onClick=${onPin}>Already set up on this phone? Unlock with PIN</button>
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
    <div class=${'dots4' + (ok ? ' ok' : '') + (err ? ' err' : '')} key=${'e' + err} aria-label=${`${pin.length} of 4 digits entered`}>
      ${[0, 1, 2, 3].map(i => html`<span class=${'dot' + (pin.length > i || ok ? ' on' : '')}></span>`)}
    </div>
    <div class=${'keypad' + (disabled ? ' off' : '')}>
      ${keys.map((k, i) => {
        const st = { animationDelay: (0.25 + i * 0.045) + 's' };
        if (k === 'face') return showFace ? html`<button class="key plain" style=${st} onClick=${onFace} aria-label="Unlock with face"><div style="display:grid;justify-items:center"><${Icon} n="face"/><span class="kl">Face</span></div></button>` : html`<span></span>`;
        if (k === 'del') return html`<button class="key plain" style=${st} onClick=${() => setPin(p => p.slice(0, -1))} aria-label="Delete"><${Icon} n="del"/></button>`;
        return html`<button class="key" style=${st} onClick=${() => press(k)}>${k}</button>`;
      })}
    </div>`;
}

// FR-A3 PIN with face unlock; FR-A4 pause after 3 wrong PINs, end the session after 5.
function LockScreen({ pin, fails, lockUntil, now, biometric, note, onUnlock, onFail, onBrowse, onLogin }) {
  const [ok, setOk] = useState(false);
  const [scan, setScan] = useState(false);
  const locked = lockUntil > now;
  const unlock = () => { setOk(true); setTimeout(onUnlock, 650); };
  const check = p => { if (locked) return false; if (p === pin) { unlock(); return true; } onFail(); return false; };
  const face = () => { if (locked) return; setScan(true); setTimeout(() => { setScan(false); unlock(); }, 900); };
  const left = PIN_MAX_FAILS - fails;
  const msg = locked ? `Too many wrong PINs. Try again in ${Math.min(30, Math.ceil((lockUntil - now) / 1000))}s`
    : fails ? `Wrong PIN · ${left} attempt${left === 1 ? '' : 's'} left before you must log in again` : note;
  return html`<div class="lock">
    <${Coin} size=${112} glow=${true} sweep=${true} sweepDelay="1.6s" />
    <h2>${ok ? 'Welcome back' : 'Enter your PIN'}</h2>
    <div class="proto">Prototype PIN: ${PIN_DEFAULT} (unless you changed it)</div>
    <div class=${'note' + (fails || locked ? ' warn' : '')} role="status">${msg || ''}</div>
    <${PinPad} ok=${ok} err=${fails} onComplete=${check} showFace=${biometric && !locked} onFace=${face} disabled=${locked} />
    <button class="browse press" onClick=${onBrowse}><${Icon} n="rates" c="sm"/> Browse live rates without logging in</button>
    <button class="browse dim press" onClick=${onLogin}>Log in with a different number</button>
    ${scan && html`<div class="scan"><div class="scan-box"><${Icon} n="face"/></div></div>`}
  </div>`;
}

/* ============================================================
   Shared bits
   ============================================================ */
const TopBar = ({ title, onBack, right }) => html`<div class="topbar">
  <button class="iconbtn glass" onClick=${onBack} aria-label="Back"><${Icon} n="back"/></button><h2>${title}</h2><div style="margin-left:auto;display:flex;align-items:center;gap:6px">${right || ''}</div>
</div>`;
const TabHead = ({ title, sub, right }) => html`<div class="tabhead enter"><div class="between"><h1>${title}</h1>${right || ''}</div>${sub && html`<p>${sub}</p>`}</div>`;
const StaleBanner = () => html`<div class="banner warn enter" role="alert"><${Icon} n="alert"/><div><b>Rates are delayed</b>Buying is paused until fresh rates arrive from PGBX (FR-R4).</div></div>`;
const Seg = ({ items, value, onChange }) => {
  const idx = Math.max(0, items.findIndex(x => x[0] === value));
  return html`<div class="segn" style=${{ '--n': items.length }} role="tablist">
    <span class="knob" style=${{ transform: `translateX(${idx * 100}%)` }}><i key=${'k' + idx}></i></span>
    ${items.map(([k, l]) => html`<button class=${value === k ? 'on' : ''} onClick=${() => onChange(k)} role="tab" aria-selected=${value === k}>${l}</button>`)}
  </div>`;
};
const Switch = ({ on }) => html`<span class=${'switch' + (on ? ' on' : '')}><i></i></span>`;
const CartButton = ({ S, A }) => {
  const n = S.cart.reduce((a, l) => a + l.units, 0);
  return html`<button class="cartbtn glass" onClick=${A.openCart} aria-label=${`Cart, ${n} units`}><span key=${'c' + S.cartBump} class=${S.cartBump ? 'bump' : ''}><${Icon} n="cart"/></span>${n > 0 && html`<span class="badge lt" key=${'n' + n}>${n}</span>`}</button>`;
};
const linesTotal = (lines, prices) => lines.reduce((a, l) => a + (prices[l.pid] || 0) * l.units, 0);
const linesUnits = lines => lines.reduce((a, l) => a + l.units, 0);
const linesText = lines => lines.map(l => `${l.units} × ${pname(P[l.pid])}`).join(', ');
const sameDay = (a, b) => new Date(a).toDateString() === new Date(b).toDateString();
const maskCnic = c => (c ? c.slice(0, 5) + '-•••••••-' + c.slice(-1) : '');
const isoDay = ts => { const d = new Date(ts); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; };
const LimitBar = ({ S, add = 0 }) => {
  const used = S.spentToday + add, p = Math.min(1, used / DAY_LIMIT);
  return html`<div class="lockbox" style="padding:12px 14px">
    <div class="between small"><span class="muted">Today’s purchases (limit ${fmt(DAY_LIMIT)}, sample)</span><b class=${used > DAY_LIMIT ? 'down' : ''} style="white-space:nowrap">${fmt(used)}</b></div>
    <div class=${'limitbar' + (p > 0.85 ? ' hi' : '')}><i style=${{ transform: `scaleX(${p})` }}></i></div>
    <div class="tiny muted" style="margin-top:6px">Per order: up to ${MAX_UNITS} units (sample). Real limits by verification level: <span class="tbc">${TBC}</span></div>
  </div>`;
};

/* ============================================================
   Rates
   ============================================================ */
function RateCard({ rates, metal, i, onOpen }) {
  const r = rateOf(rates, metal);
  const loading = rates.mode === 'connecting';
  const col = metal === 'gold' ? '#E2B65A' : '#E8EDF0';
  return html`<div class=${'rate ' + metal} style=${{ '--i': i }} role="button" tabindex="0" onClick=${onOpen} onKeyDown=${e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onOpen(); } }} aria-label=${`${metalName(metal)} rate history and price alerts`}>
    <div class="top">
      <${Ingot} metal=${metal} w=${44} />
      <div><div class="metal">${metalName(metal)} 24K</div><div class="pur">999.0 · per tola (11.664 g)</div></div>
      ${!loading && html`<span class=${'chip chg ' + (r.chg >= 0 ? 'upc' : 'downc')}>${pct(r.chg)}</span>`}
    </div>
    <div class="mid">
      <div><div class="lbl">Buy / tola</div><div class="price-big">${loading ? html`<span class="sk" style="width:170px;height:30px;margin-top:4px"></span>` : html`<${Odo} value=${r.buyTola} flash=${rates.tick} />`}</div></div>
      ${loading ? html`<span class="sk" style="width:112px;height:40px"></span>` : html`<div style="text-align:right"><${Spark} data=${rates[metal].hist} color=${col} />${rates.mode === 'live' && rates[metal].hist.length < 6 ? html`<div class="tiny" style="color:rgba(255,255,255,.5);margin-top:2px">chart builds live</div>` : ''}</div>`}
    </div>
    <div class="grid3">
      ${[['Sell / tola', r.sellTola], ['Buy / gram', r.buyGram], ['Sell / gram', r.sellGram]].map(([l, v], k) => html`<div><div class="lbl">${l}</div>
        <b>${loading ? html`<span class="sk" style="width:72px;height:16px;margin-top:3px"></span>` : k === 0 ? html`<${Odo} value=${v} flash=${rates.tick} />` : fmt(v)}</b></div>`)}
    </div>
    <div class="rate-more">History · price alerts <${Icon} n="chev" c="xs"/></div>
  </div>`;
}

function WorldMarkets({ rates }) {
  if (rates.mode !== 'live' || !rates.world.length) {
    return html`<div class="card dealers-card"><div class="badge-ico"><${Icon} n="globe"/></div><div class="small muted">${rates.mode === 'connecting' ? 'Loading world spot prices…' : 'World spot prices appear when the live feed is connected.'}</div></div>`;
  }
  return html`<div class="hscroll cascade">${rates.world.map((w, i) => { const ch = (w.usd / w.open - 1) * 100; return html`<div class="card wcard" style=${{ '--i': i }}>
    <div class="between"><span class="sym">${w.symbol}</span><span class="wdot" style=${{ background: WORLD_COLORS[w.symbol] }}></span></div>
    <div class="small" style="font-weight:700;margin-top:6px">${w.name}</div>
    <b><${Odo} value=${w.usd} prefix="$" decimals=${w.usd < 100 ? 2 : 0} /></b>
    <div class="tiny muted">per ${w.unit} · <span class=${ch >= 0 ? 'up' : 'down'}>${pct(ch)}</span></div>
    <div style="margin-top:6px"><${Spark} data=${w.hist} color=${WORLD_COLORS[w.symbol]} w=${120} h=${26} /></div>
  </div>`; })}</div>`;
}

const KycCta = ({ S, A }) => S.guest || S.kyc.status === 'verified' ? null : html`<button class="cta-card press enter" onClick=${() => A.push({ name: 'kyc' })}>
  <div class="badge-ico"><${Icon} n="idcard"/></div>
  <div style="flex:1"><b style="font-size:15px">${S.kyc.status === 'pending' ? 'Verification in progress' : S.kyc.status === 'reverify' ? 'Re-verify your identity' : 'Verify your identity to start buying'}</b>
    <div class="small muted" style="margin-top:2px">CNIC and a selfie, about 2 minutes (FR-A2)</div></div>
  <${Icon} n="chev" c="sm" s="color:var(--muted)"/>
</button>`;

function RatesHome({ S, A }) {
  const { rates, now, stale, guest } = S;
  const featured = ['g-1g', 'g-5g', 'g-100mg', 's-1t', 's-10t'].map(id => P[id]);
  const wv = S.walletValue;
  return html`<div class="scroll">
    <div class="hero">
      <div class="brand enter"><${Coin} size=${40} still=${true} /><div><b>PGBX</b><small>Pakistan Gold Bullion Exchange</small></div>
        ${!guest && html`<button class="iconbtn glass dark" style="margin-left:auto;color:#fff" aria-label=${`Notifications, ${S.unread} unread`} onClick=${() => A.push({ name: 'inbox' })}><${Icon} n="bell"/>${S.unread > 0 && html`<span class="badge" key=${'u' + S.unread}>${S.unread}</span>`}</button>`}</div>
      <div class="live"><span class=${dotClass(rates, stale)}></span>${feedLabel(rates, stale, now)}</div>
      <h1 class="enter">${guest ? 'Today’s rates' : `Assalam-o-Alaikum, ${S.profile.name.split(' ')[0]}`}</h1>
    </div>
    <div class="rate-stack cascade">
      <${RateCard} rates=${rates} metal="gold" i=${0} onOpen=${() => A.openHistory('gold')} />
      <${RateCard} rates=${rates} metal="silver" i=${1} onOpen=${() => A.openHistory('silver')} />
    </div>
    ${stale && html`<${StaleBanner}/>`}
    ${guest && html`<div class="guest-bar enter"><${Icon} n="lock" c="sm"/><span>Browsing as a guest</span><button class="press" onClick=${A.login}>Log in</button></div>`}
    <${KycCta} S=${S} A=${A} />

    <div class="section-title"><h3>Featured products</h3><span>Whole units · 999.0</span></div>
    <div class="hscroll cascade">
      ${featured.map((p, i) => html`<button class=${'card feat press' + (p.metal === 'silver' ? ' sil' : '')} style=${{ '--i': i }} onClick=${() => A.openProduct(p.id)}>
        <div class="ing"><${Ingot} metal=${p.metal} w=${70} label=${p.short} /></div>
        <b>${pname(p)}</b><div class="p">${fmt(priceOf(p, rates))}</div><div class="tiny muted">999.0 purity</div>
      </button>`)}
    </div>

    ${!guest && html`<div class="section-title"><h3>Your wallet</h3><span>Sell value</span></div>
    <button class="wallet-sum press enter" onClick=${() => A.tab('wallet')}>
      <div class="between"><span class="tiny" style="color:rgba(255,255,255,.65);text-transform:uppercase;letter-spacing:.08em;font-weight:900">Total at current sell price</span><${Icon} n="chev" c="sm"/></div>
      <div class="v"><${Odo} value=${wv.total} /></div>
      <div class="small" style="color:rgba(255,255,255,.75);margin-top:6px">${fmtW(wv.goldG)} gold · ${(wv.silverG / TOLA).toFixed(2)} tola silver</div>
    </button>`}

    <div class="section-title"><h3>World spot</h3><span>USD · live</span></div>
    <${WorldMarkets} rates=${rates} />

    <button class="card dealers-card press enter" onClick=${() => A.tab('redeem')}>
      <div class="badge-ico"><${Icon} n="store"/></div>
      <div><b>Collect at any of 250 dealers</b><div class="small muted" style="margin-top:3px">Redeem your holdings for the physical product. Bring your CNIC.</div></div>
      <${Icon} n="chev" c="sm" s="color:var(--muted);margin-left:auto"/>
    </button>

    <p class="foot-note">${rates.mode === 'live'
      ? html`Live international spot from ${rates.source || 'gold-api.com'}, converted at USD/PKR ${rates.usdPkr ? rates.usdPkr.rate.toFixed(2) : ''} (${rates.usdPkr ? rates.usdPkr.source : 'open.er-api.com'}) by the PGBX prototype server and refreshed every 10 s. Local Sarafa rates may differ. Change % is since you opened the app. Sell prices use a <b>sample</b> spread and product prices a <b>sample</b> premium; PGBX will set both (FR-M1, FR-M2).`
      : html`The live feed is not connected, so rates are <b>simulated</b> from the Pakistan Sarafa 24K rate of 1 Oct 2026 (gold Rs 438,636 / silver Rs 6,528 per tola) with random ticks every 5 s. In the real app every price is set by the PGBX server (FR-R3).`}</p>
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
      <defs><linearGradient id="chFill" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color=${color} stop-opacity=".28"/><stop offset="1" stop-color=${color} stop-opacity="0"/></linearGradient></defs>
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
  return html`<div class="page">
    <${TopBar} title="Rate history" onBack=${A.back} />
    <div class="scroll" style="top:calc(var(--top) + 60px)">
      <div class="pad enter"><${Seg} items=${[['gold', 'Gold'], ['silver', 'Silver']]} value=${metal} onChange=${setMetal} /></div>
      <div class="card summary enter" style="margin-top:12px">
        <div class="between"><div><div class="tiny muted" style="text-transform:uppercase;letter-spacing:.06em;font-weight:900">${metalName(metal)} buy / tola now</div>
          <div style="font-family:var(--serif);font-size:24px;font-weight:700;color:var(--g800)"><${Odo} value=${r.buyTola} flash=${S.rates.tick} /></div></div>
          ${stats && html`<span class=${'chip ' + (stats.chg >= 0 ? 'up' : 'down')} style=${{ background: stats.chg >= 0 ? 'rgba(31,138,76,.1)' : 'rgba(179,65,46,.1)' }}>${pct(stats.chg)} · ${range}</span>`}</div>
        <div style="margin-top:12px"><${Seg} items=${[['day', 'Day'], ['week', 'Week'], ['month', 'Month']]} value=${range} onChange=${setRange} /></div>
        ${pts ? html`<${Chart} key=${key + ':' + pts.length} points=${pts} color=${metal === 'gold' ? '#C8962B' : '#7f8a92'} range=${range} />`
          : h.error ? html`<div class="empty" style="margin:14px 0 0">History is unavailable right now. Nothing is shown rather than a made-up chart.</div>`
          : html`<span class="sk dk" style="height:180px;margin-top:14px;background:rgba(29,43,34,.06)"></span>`}
        ${stats && html`<div class="stats4">${[['Open', stats.open], ['High', stats.high], ['Low', stats.low], ['Last', pts[pts.length - 1][1]]].map(([l, v]) => html`<div><span>${l}</span><b>${fmt(v)}</b></div>`)}</div>`}
        ${pts && html`<p class="tiny muted" style="margin:10px 0 0">Indicative history: ${h.source}, converted at USD/PKR ${h.usdPkr ? h.usdPkr.toFixed(2) : ''}. PGBX’s own buy rate differs; the real history will come from PGBX’s rate source (FR-R5).</p>`}
      </div>

      <div class="section-title"><h3>Price alerts</h3><span>FR-R6</span></div>
      <div class="card summary">
        <div class="small muted">Tell me when ${metalName(metal).toLowerCase()} buy price per tola goes</div>
        <div style="margin-top:8px"><${Seg} items=${[['above', 'Above'], ['below', 'Below']]} value=${dir} onChange=${v => { setDir(v); setTarget(''); }} /></div>
        <div style="margin-top:10px"><input class=${'inp' + (target && !valid ? ' bad' : '')} inputmode="numeric" placeholder=${`Target price, now ${fmt(r.buyTola)}`} aria-label="Target price per tola"
          value=${t ? 'Rs ' + t.toLocaleString('en-US') : ''} onInput=${e => setTarget(e.target.value.replace(/\D/g, ''))} /></div>
        <div class="chips" style="margin-top:8px">${(dir === 'above' ? [0.005, 0.01, 0.02] : [-0.005, -0.01, -0.02]).map(f => html`<button class="chipb" onClick=${() => preset(f)}>${f > 0 ? '+' : '−'}${Math.abs(f * 100)}%</button>`)}</div>
        ${target && !valid && html`<div class="hint err">Choose a price ${dir} today’s ${fmt(r.buyTola)}.</div>`}
        <div style="margin-top:12px"><button class="btn btn-green" disabled=${!valid} onClick=${() => { A.addAlert(metal, dir, t); setTarget(''); }}><${Icon} n="bell" c="sm"/> Create alert</button></div>
      </div>
      ${mine.length > 0 && html`<div class="card list cascade" style="margin-top:12px">${mine.map((a, i) => html`<div class="alert-row" style=${{ '--i': i }}>
        <div class="badge-ico" style="width:38px;height:38px"><${Icon} n="bell" c="sm"/></div>
        <div style="flex:1"><b style="font-size:14px">${a.dir === 'above' ? 'Above' : 'Below'} ${fmt(a.target)}</b>
          <div class="tiny muted">${a.active ? 'Active · checks every rate update' : `Triggered ${dt(a.firedAt)}`}</div></div>
        <button class="rmbtn" onClick=${() => A.removeAlert(a.id)} aria-label="Delete alert"><${Icon} n="trash" c="sm"/></button>
      </div>`)}</div>`}
      <p class="foot-note">Alerts arrive as notifications in the app (and by push, SMS or email per your settings). In this prototype they are checked while the app is open.</p>
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
    <${TabHead} title="Buy" sub="Choose a product. Whole units only, 999.0 purity." right=${!S.guest && html`<${CartButton} S=${S} A=${A} />`} />
    <div class="seg" role="tablist">
      <span class="knob" style=${{ transform: `translateX(${metal === 'gold' ? 0 : 100}%)` }}><i key=${'k' + metal}></i></span>
      <button class=${metal === 'gold' ? 'on' : ''} onClick=${() => A.set({ buyMetal: 'gold' })} role="tab" aria-selected=${metal === 'gold'}>Gold · 7</button>
      <button class=${metal === 'silver' ? 'on' : ''} onClick=${() => A.set({ buyMetal: 'silver' })} role="tab" aria-selected=${metal === 'silver'}>Silver · 4</button>
    </div>
    <div class="pad small muted" style="margin-top:8px;display:flex;align-items:center;gap:6px"><span class=${dotClass(S.rates, S.stale)}></span>${metalName(metal)} ${fmt(r.buyTola)}/tola · ${fmt(r.buyGram)}/g · ${S.rates.mode === 'live' ? 'live' : 'simulated'}</div>
    ${S.stale && html`<${StaleBanner}/>`}
    <${KycCta} S=${S} A=${A} />
    <div class="plist cascade" key=${metal}>
      ${list.map((p, i) => html`<button class=${'card pcard press' + (metal === 'silver' ? ' sil' : '')} style=${{ '--i': i }} onClick=${() => A.openProduct(p.id)}>
        <div class="ing"><${Ingot} metal=${p.metal} w=${64} label=${p.short} /></div>
        <div><b>${p.label}</b><div class="small muted">${metalName(p.metal)} · 999.0 · ${fmtW(p.grams)}</div></div>
        <div class="pp"><b>${fmt(priceOf(p, S.rates))}</b><span class="tiny muted">per unit</span></div>
      </button>`)}
    </div>
    <div class="offline"><${Icon} n="info" c="sm"/><span>Larger bars are sold offline only and are not available in the app (FR-P6). Gold and silver can be combined in one order using the cart (FR-B8).</span></div>
    <p class="foot-note">Price = metal rate × weight + PGBX premium, calculated by the server (Rule 1). Premiums are <b>sample</b> values.</p>
  </div>`;
}

const LockBox = ({ S }) => {
  const remain = S.lock ? Math.min(LOCK_S, Math.max(0, Math.ceil((S.lock.expiresAt - S.now) / 1000))) : LOCK_S;
  return html`<div class="lockbox enter">
    <div class="between"><div class="row" style="gap:8px"><${Icon} n="lock" c="sm" s="color:var(--gold-d)"/><b style="font-size:14px">Price locked for ${remain}s</b></div><span class="small muted">FR-B2</span></div>
    <div class=${'bar' + (remain <= 10 ? ' low' : '')}><i style=${{ transform: `scaleX(${remain / LOCK_S})` }}></i></div>
    <div class="tiny muted" style="margin-top:6px">Refreshes to the latest rate when the timer reaches zero.</div>
  </div>`;
};

function ProductScreen({ S, A, pid }) {
  const p = P[pid]; const unit = S.lock && S.lock.prices[pid];
  const total = (unit || 0) * S.qty;
  return html`<div class="page">
    <${TopBar} title=${pname(p)} onBack=${A.back} right=${html`<${CartButton} S=${S} A=${A} />`} />
    <div class="scroll" style="top:calc(var(--top) + 60px)">
      <div class=${'stage-ing enter' + (p.metal === 'silver' ? ' sil' : '')}>
        <div class="shadow"></div>
        <div class="float"><${Ingot} metal=${p.metal} w=${180} label=${p.short} /></div>
      </div>
      <div class="tiles cascade">
        <div class="tile" style="--i:0"><span>Metal</span><b>${metalName(p.metal)}</b></div>
        <div class="tile" style="--i:1"><span>Weight</span><b>${p.metal === 'silver' ? p.label : fmtW(p.grams)}</b><div class="tiny muted">${fmtW(p.grams)}</div></div>
        <div class="tile" style="--i:2"><span>Purity</span><b>999.0</b></div>
      </div>
      ${S.stale && html`<${StaleBanner}/>`}
      <${LockBox} S=${S} />
      <div class="lockbox enter between">
        <div><b style="font-size:15px">Unit price</b><div class="tiny muted">Locked for you</div></div>
        <b style="font-family:var(--serif);font-size:18px">${unit && html`<${Odo} value=${unit} flash=${S.lock.expiresAt} />`}</b>
      </div>
      <div class="lockbox enter between">
        <div><b style="font-size:15px">Units</b><div class="tiny muted">Whole units only · max ${MAX_UNITS} per order (sample)</div></div>
        <div class="stepper">
          <button disabled=${S.qty <= 1} onClick=${() => A.set({ qty: Math.max(1, S.qty - 1) })} aria-label="Fewer"><${Icon} n="minus" c="sm"/></button>
          <output><span key=${S.qty}>${S.qty}</span></output>
          <button disabled=${S.qty >= MAX_UNITS} onClick=${() => A.set({ qty: Math.min(MAX_UNITS, S.qty + 1) })} aria-label="More"><${Icon} n="plus" c="sm"/></button>
        </div>
      </div>
      <div class="total"><span class="muted">Total · ${S.qty} × ${p.label}</span><b><${Odo} value=${total} /></b></div>
      <div class="cta" style="display:grid;grid-template-columns:1fr 1.25fr;gap:10px">
        <button class="btn btn-ghost" disabled=${S.stale} onClick=${() => A.addToCart(pid, S.qty)}><${Icon} n="cart" c="sm"/> Add to cart</button>
        <button class="btn btn-gold" disabled=${S.stale} onClick=${() => A.checkout('now')}>Buy now <${Icon} n="chev" c="sm"/></button>
      </div>
      <div class="pad tiny muted" style="margin-top:10px">Minimum purchase: <span class="tbc">${TBC}</span></div>
    </div>
  </div>`;
}

/* ---------- FR-B8 cart: gold and silver in one order ---------- */
function CartScreen({ S, A }) {
  const lines = S.cart; const prices = (S.lock && S.lock.prices) || {};
  const total = linesTotal(lines, prices); const units = linesUnits(lines);
  const over = S.spentToday + total > DAY_LIMIT;
  return html`<div class="page">
    <${TopBar} title="Cart" onBack=${A.back} />
    <div class="scroll" style="top:calc(var(--top) + 60px)">
      ${lines.length === 0 ? html`<div class="empty">Your cart is empty.<br/><button class="btn btn-gold" style="margin-top:12px" onClick=${() => A.tab('buy')}>Browse products</button></div>` : html`
      <${LockBox} S=${S} />
      <div class="card list cascade" style="margin-top:14px">
        ${lines.map((l, i) => { const p = P[l.pid]; return html`<div class="line" style=${{ '--i': i }} key=${l.pid}>
          <${Ingot} metal=${p.metal} w=${50} label=${p.short} />
          <div style="flex:1;min-width:0"><b style="font-size:14px">${pname(p)}</b><div class="tiny muted">${fmt(prices[l.pid] || 0)} each</div>
            <div style="margin-top:6px" class="stepper" role="group" aria-label="Units">
              <button disabled=${l.units <= 1} onClick=${() => A.cartUnits(l.pid, l.units - 1)} aria-label="Fewer"><${Icon} n="minus" c="sm"/></button>
              <output><span key=${l.units}>${l.units}</span></output>
              <button disabled=${units >= MAX_UNITS} onClick=${() => A.cartUnits(l.pid, l.units + 1)} aria-label="More"><${Icon} n="plus" c="sm"/></button>
            </div></div>
          <div style="text-align:right"><b style="font-size:14px">${fmt((prices[l.pid] || 0) * l.units)}</b>
            <div><button class="rmbtn" style="margin-left:auto" onClick=${() => A.cartUnits(l.pid, 0)} aria-label="Remove"><${Icon} n="trash" c="sm"/></button></div></div>
        </div>`; })}
      </div>
      <div class="total"><span class="muted">${units} unit${units > 1 ? 's' : ''} · ${new Set(lines.map(l => P[l.pid].metal)).size > 1 ? 'gold and silver' : metalName(P[lines[0].pid].metal).toLowerCase()}</span><b><${Odo} value=${total} /></b></div>
      <${LimitBar} S=${S} add=${total} />
      ${over && html`<div class="banner warn"><${Icon} n="alert" c="sm"/><div><b>Daily limit reached</b>You can buy up to ${fmt(Math.max(0, DAY_LIMIT - S.spentToday))} more today (FR-B6).</div></div>`}
      ${S.stale && html`<${StaleBanner}/>`}
      <div class="cta" style="margin-top:14px"><button class="btn btn-gold" disabled=${S.stale || over || units > MAX_UNITS} onClick=${() => A.checkout('cart')}>Checkout ${fmt(total)} <${Icon} n="chev" c="sm"/></button></div>`}
    </div>
  </div>`;
}

const METHODS = [
  { id: 'bank', icon: 'bank', name: 'Instant bank transfer', sub: 'Pay from your bank app' },
  { id: 'card', icon: 'card', name: 'Debit or credit card', sub: 'Card details are never stored in the app (NFR-7)' },
  { id: 'mwallet', icon: 'phone', name: 'Mobile wallet', sub: 'Pay with your mobile wallet' },
];
function PayScreen({ S, A }) {
  const lines = S.checkout; const prices = S.lock.prices;
  const total = linesTotal(lines, prices);
  const over = S.spentToday + total > DAY_LIMIT;
  return html`<div class="page">
    <${TopBar} title="Pay" onBack=${A.back} />
    <div class="scroll" style="top:calc(var(--top) + 60px)">
      <div class="card summary enter">
        ${lines.map(l => { const p = P[l.pid]; return html`<div class="row" style="padding:6px 0">
          <${Ingot} metal=${p.metal} w=${48} label=${p.short}/><div style="flex:1"><b style="font-size:14px">${l.units} × ${pname(p)}</b><div class="tiny muted">999.0 · <${Odo} value=${prices[l.pid]} flash=${S.lock.expiresAt} /> each</div></div>
          <b style="font-size:14px">${fmt(prices[l.pid] * l.units)}</b></div>`; })}
        <div class="kv" style="border-top:1px solid var(--line);margin-top:6px;padding-top:12px"><span style="color:var(--ink);font-weight:700">Total</span><b style="font-family:var(--serif);font-size:20px;color:var(--g800)"><${Odo} value=${total} /></b></div>
      </div>
      <${LockBox} S=${S} />
      <div class="section-title"><h3>Payment method</h3><span>FR-B3</span></div>
      <div class="methods cascade">
        ${METHODS.map((m, i) => html`<button class=${'method' + (S.method === m.id ? ' on' : '')} style=${{ '--i': i }} onClick=${() => A.set({ method: m.id })} role="radio" aria-checked=${S.method === m.id}>
          <div class="mi"><${Icon} n=${m.icon}/></div><div><b style="font-size:15px">${m.name}</b><div class="tiny muted" style="margin-top:2px">${m.sub}</div></div><span class="radio"><i></i></span>
        </button>`)}
      </div>
      <div class="pad tiny muted" style="margin-top:10px">Which payment channels are enabled, and their providers: <span class="tbc">${TBC}</span></div>
      <div class="banner info enter"><${Icon} n="shield" c="sm" s="color:var(--g700)"/><div>Your wallet is credited only after PGBX confirms the payment (FR-B4). If crediting fails, PGBX retries and then hands the order to operations, so money and metal are never left unmatched (FR-B5).</div></div>
      <button class="protobox" style="text-align:left;width:calc(100% - 36px);display:flex;gap:12px;align-items:center" onClick=${() => A.set({ simCreditFail: !S.simCreditFail })} role="switch" aria-checked=${S.simCreditFail}>
        <div style="flex:1"><b>Prototype: simulate a problem</b>Payment succeeds but crediting the wallet fails (FR-B5)</div><${Switch} on=${S.simCreditFail} />
      </button>
      ${over && html`<div class="banner warn"><${Icon} n="alert" c="sm"/><div><b>Daily limit reached</b>This order would take you over today’s sample limit of ${fmt(DAY_LIMIT)} (FR-B6).</div></div>`}
      ${S.stale && html`<${StaleBanner}/>`}
      <div class="cta" style="margin-top:16px"><button class="btn btn-gold" disabled=${S.stale || S.paying || over} onClick=${A.pay}><${Icon} n="lock" c="sm"/> Pay ${fmt(total)}</button></div>
    </div>
  </div>`;
}

function Processing({ fail }) {
  const steps = fail
    ? [['ok', 'Payment received'], ['bad', 'Crediting your wallet failed'], ['ok', 'Retrying (1 of 3)…'], ['ok', 'Retrying (2 of 3)…'], ['ok', 'Retrying (3 of 3)…'], ['flag', 'Handed to PGBX operations']]
    : [['ok', 'Payment confirmed'], ['ok', 'Crediting your wallet'], ['ok', 'Issuing receipt']];
  const [n, setN] = useState(0);
  useEffect(() => { const t = setInterval(() => setN(v => v + 1), fail ? 800 : 550); return () => clearInterval(t); }, []);
  return html`<div class="center-screen">
    <svg class="spinner" viewBox="0 0 50 50"><circle cx="25" cy="25" r="21" fill="none" stroke="rgba(11,74,44,.12)" stroke-width="4"/><circle cx="25" cy="25" r="21" fill="none" stroke="url(#goldMetal)" stroke-width="4" stroke-linecap="round" stroke-dasharray="40 200"/></svg>
    <h2 style="margin-top:22px;font-size:22px;color:var(--g800)" class="enter">${fail ? 'Processing your order' : 'Confirming payment'}</h2>
    <div class="proc-steps" style="text-align:left">
      ${steps.slice(0, n + 1).map(([k, t]) => html`<div class="row" style="gap:8px"><span style=${{ color: k === 'bad' ? 'var(--down)' : k === 'flag' ? 'var(--gold-d)' : 'var(--up)' }}><${Icon} n=${k === 'bad' ? 'x' : k === 'flag' ? 'flag' : 'check'} c="sm"/></span>${t}</div>`)}
    </div>
  </div>`;
}

function Receipt({ S, A, oid }) {
  const o = S.orders.find(x => x.id === oid); const flagged = o.status === 'flagged';
  const share = async () => {
    const text = `PGBX receipt ${o.receipt}: ${linesText(o.lines)}, ${fmt(o.total)}, ${dt(o.ts)}`;
    try { if (navigator.share) await navigator.share({ title: 'PGBX receipt', text }); else { await navigator.clipboard.writeText(text); A.toast('Receipt details copied'); } } catch (e) { }
  };
  return html`<div class="scroll">
    <div class="check-wrap">${!flagged && html`<span class="ripple"></span><span class="ripple"></span><span class="ripple"></span>`}
      <div class="check-disc" style=${flagged ? { background: 'linear-gradient(150deg,#C8962B,#8A6414)' } : null}>${flagged
        ? html`<svg width="44" height="44" viewBox="0 0 24 24" fill="none" stroke="#fff" stroke-width="2.4" stroke-linecap="round"><path d=${PATHS.clock}/></svg>`
        : html`<svg width="46" height="46" viewBox="0 0 24 24" fill="none" stroke="#E2B65A" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round"><path d=${PATHS.check} pathLength="1"/></svg>`}</div>
    </div>
    <div style="text-align:center;margin-top:16px;padding:0 24px" class="enter"><h1 style="font-size:24px;color:var(--g800)">${flagged ? 'Payment received, credit pending' : 'Payment confirmed'}</h1>
      <p class="muted" style="margin:6px 0 0;font-size:14px">${flagged ? 'Crediting your wallet failed after 3 retries. PGBX operations will credit the metal or refund you; your money is safe (FR-B5).' : `${linesText(o.lines)} added to your wallet`}</p></div>
    <div class="card receipt cascade">
      <div class="kv" style="--i:0"><span>Receipt no. (FR-B7)</span><b class="rno">${o.receipt}</b></div>
      ${o.lines.map((l, i) => html`<div class="kv" style=${{ '--i': i + 1 }}><span>${l.units} × ${pname(P[l.pid])}</span><b>${fmt(l.unit * l.units)}</b></div>`)}
      <div class="kv" style="--i:4"><span>Method</span><b>${METHODS.find(m => m.id === o.method).name}</b></div>
      <div class="kv" style="--i:5"><span>Date</span><b>${dt(o.ts)}</b></div>
      <div class="kv" style="--i:6"><span>Status</span><b class=${flagged ? '' : 'up'} style=${flagged ? { color: 'var(--gold-d)' } : null}>${flagged ? 'Flagged for operations' : 'Credited to wallet'}</b></div>
      <div class="kv" style="--i:7;border-top:1px solid var(--line);margin-top:4px;padding-top:12px"><span style="color:var(--ink);font-weight:700">Total paid</span><b style="font-family:var(--serif);font-size:20px;color:var(--g800)">${fmt(o.total)}</b></div>
      <div class="tiny muted" style="--i:8;padding:6px 0">Tax and legal details on receipts (CMP-7): <span class="tbc">${TBC}</span></div>
    </div>
    <div class="cta" style="display:grid;gap:10px;margin-top:16px">
      <button class="btn btn-green" onClick=${() => A.tab('wallet')}><${Icon} n="wallet" c="sm"/> View wallet</button>
      <button class="btn btn-ghost" onClick=${share}><${Icon} n="share" c="sm"/> Share receipt</button>
      <button class="btn btn-ghost" style="border:0" onClick=${() => A.tab('rates')}>Back to rates</button>
    </div>
  </div>`;
}

/* ============================================================
   Identity verification (FR-A2) and profile (FR-N2)
   ============================================================ */
const fmtCnic = v => { const d = v.replace(/\D/g, '').slice(0, 13); return d.length > 12 ? `${d.slice(0, 5)}-${d.slice(5, 12)}-${d.slice(12)}` : d.length > 5 ? `${d.slice(0, 5)}-${d.slice(5)}` : d; };
const IdCardArt = ({ back }) => html`<svg class="idcard" viewBox="0 0 250 156" aria-hidden="true">
  <rect width="250" height="156" rx="12" fill="#e8efe6"/><rect width="250" height="30" rx="12" fill="#0B4A2C"/><rect y="18" width="250" height="12" fill="#0B4A2C"/>
  <text x="14" y="20" font-size="10" font-weight="900" fill="#E2B65A" font-family="Lato,sans-serif">${back ? 'CNIC · BACK (SAMPLE)' : 'CNIC · FRONT (SAMPLE)'}</text>
  ${back ? html`<rect x="14" y="44" width="222" height="10" rx="3" fill="#c5d3c6"/><rect x="14" y="62" width="180" height="10" rx="3" fill="#c5d3c6"/><rect x="14" y="98" width="222" height="40" rx="4" fill="#fff"/>${Array.from({ length: 40 }, (_, i) => html`<rect x=${18 + i * 5.4} y="102" width=${i % 3 ? 2 : 3.5} height="32" fill="#1D2B22"/>`)}`
    : html`<rect x="14" y="42" width="62" height="78" rx="6" fill="#c5d3c6"/><circle cx="45" cy="70" r="14" fill="#9fb3a2"/><path d="M24 116a21 21 0 0 1 42 0" fill="#9fb3a2"/>
      <rect x="90" y="46" width="120" height="10" rx="3" fill="#c5d3c6"/><rect x="90" y="66" width="90" height="10" rx="3" fill="#c5d3c6"/><rect x="90" y="86" width="140" height="10" rx="3" fill="#c5d3c6"/><rect x="90" y="106" width="70" height="10" rx="3" fill="#c5d3c6"/>`}
</svg>`;

function KycScreen({ S, A, next }) {
  const re = S.kyc.status === 'reverify';
  const [step, setStep] = useState(0);
  const [f, setF] = useState({ cnic: S.profile.cnic || '', name: S.profile.name || '', dob: S.profile.dob || '', expiry: S.kyc.expiry || '' });
  const [shot, setShot] = useState({ front: false, back: false, selfie: false });
  const [busy, setBusy] = useState(false);
  const age = f.dob ? (Date.now() - Date.parse(f.dob)) / (365.25 * 86400e3) : 0;
  const errs = { cnic: f.cnic.replace(/\D/g, '').length !== 13, name: f.name.trim().length < 3, dob: !(age >= 18 && age < 120), expiry: !(Date.parse(f.expiry) > Date.now()) };
  const ok = !Object.values(errs).some(Boolean);
  const capture = k => { setBusy(true); setTimeout(() => { setShot(s => ({ ...s, [k]: true })); setBusy(false); }, 1500); };
  const submit = () => { setStep(5); A.submitKyc(f); setTimeout(() => { A.kycVerified(); setStep(6); }, 2600); };
  const titles = ['Verify your identity', 'CNIC details', 'Front of your CNIC', 'Back of your CNIC', 'Take a selfie', 'Checking', 'You’re verified'];
  const Frame = ({ k, back }) => html`<div class="idframe">
    <span class="cn a"></span><span class="cn b"></span><span class="cn c"></span><span class="cn d"></span>
    ${shot[k] ? html`<${IdCardArt} back=${back} /><span class="okmark"><${Icon} n="check" c="sm"/></span>`
      : busy ? html`<span class="scanline"></span><span>Hold steady…</span>` : html`<span>Place the ${back ? 'back' : 'front'} of your CNIC inside the frame</span>`}
  </div>`;
  return html`<div class="page">
    <${TopBar} title=${re ? 'Re-verify identity' : 'Identity verification'} onBack=${step > 0 && step < 5 ? () => setStep(step - 1) : A.back} />
    <div class="scroll" style="top:calc(var(--top) + 60px)">
      <div class="kprog"><i style=${{ transform: `scaleX(${Math.min(1, step / 6)})` }}></i></div>
      <div class="pad step-in" key=${step} style="margin-top:16px">
        <h2 style="font-size:22px;color:var(--g800)">${titles[step]}</h2>
        ${step === 0 && html`<p class="muted" style="font-size:14px;margin:6px 0 14px">${re ? 'You changed identity details, so PGBX needs to check them again before you can buy (FR-N2).' : 'PGBX must verify your identity before your first purchase (FR-A2). It takes about 2 minutes.'}</p>
          <div class="card list">${[['idcard', 'Your CNIC details', 'Number, name, date of birth, expiry'], ['camera', 'Photos of your CNIC', 'Front and back'], ['user', 'A selfie', 'Matched against your CNIC photo']].map(([ic, t, d], i) => html`<div class="kstep"><span class="kn">${i + 1}</span><div><b style="font-size:14px">${t}</b><div class="tiny muted">${d}</div></div><${Icon} n=${ic} c="sm" s="margin-left:auto;color:var(--muted)"/></div>`)}</div>
          <p class="tiny muted" style="margin-top:12px">Identity verification provider: <span class="tbc">${TBC}</span>. Sanctions and watch-list screening runs on the server (CMP-1).</p>
          <div style="margin-top:14px"><button class="btn btn-gold" onClick=${() => setStep(1)}>Start</button></div>`}
        ${step === 1 && html`<div style="margin-top:8px">
          <label class="f">CNIC number</label><input class=${'inp' + (f.cnic && errs.cnic ? ' bad' : '')} inputmode="numeric" placeholder="00000-0000000-0" value=${fmtCnic(f.cnic)} onInput=${e => setF({ ...f, cnic: fmtCnic(e.target.value) })} />
          <label class="f">Full name (as on CNIC)</label><input class="inp" value=${f.name} onInput=${e => setF({ ...f, name: e.target.value })} />
          <div style="display:grid;grid-template-columns:1fr 1fr;gap:10px">
            <div><label class="f">Date of birth</label><input class=${'inp' + (f.dob && errs.dob ? ' bad' : '')} type="date" value=${f.dob} onInput=${e => setF({ ...f, dob: e.target.value })} /></div>
            <div><label class="f">CNIC expiry</label><input class=${'inp' + (f.expiry && errs.expiry ? ' bad' : '')} type="date" value=${f.expiry} onInput=${e => setF({ ...f, expiry: e.target.value })} /></div>
          </div>
          ${f.dob && errs.dob && html`<div class="hint err">You must be 18 or older.</div>`}${f.expiry && errs.expiry && html`<div class="hint err">This CNIC has expired.</div>`}
          <div style="margin-top:16px"><button class="btn btn-gold" disabled=${!ok} onClick=${() => setStep(2)}>Continue</button></div></div>`}
        ${(step === 2 || step === 3) && html`<${Frame} k=${step === 2 ? 'front' : 'back'} back=${step === 3} />
          <p class="tiny muted" style="text-align:center;margin-top:8px">Prototype: the camera is simulated and no image is taken.</p>
          <div style="margin-top:12px">${shot[step === 2 ? 'front' : 'back']
            ? html`<button class="btn btn-gold" onClick=${() => setStep(step + 1)}>Continue</button>`
            : html`<button class="btn btn-green" disabled=${busy} onClick=${() => capture(step === 2 ? 'front' : 'back')}><${Icon} n="camera" c="sm"/> ${busy ? 'Capturing…' : 'Capture'}</button>`}</div>`}
        ${step === 4 && html`<div class=${'selfie' + (shot.selfie ? ' ok' : '')}>
            ${busy && html`<svg class="ring" viewBox="0 0 210 210"><circle cx="105" cy="105" r="100" stroke="rgba(255,255,255,.12)"/><circle class="pr" cx="105" cy="105" r="100" pathLength="1"/></svg>`}
            ${shot.selfie ? html`<span style="color:#7be3a6;animation:pop .5s var(--spring) both"><svg width="80" height="80" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><path d=${PATHS.check}/></svg></span>`
              : html`<svg class="face" width="120" height="140" viewBox="0 0 120 140" fill="none" stroke="#E2B65A" stroke-width="2" stroke-dasharray="5 6"><ellipse cx="60" cy="62" rx="40" ry="52"/><path d="M20 140c4-18 20-26 40-26s36 8 40 26"/></svg>`}
          </div>
          <p class="small muted" style="text-align:center;margin-top:12px">${shot.selfie ? 'Selfie captured' : busy ? 'Hold still and look at the camera…' : 'Fit your face inside the oval, in good light.'}</p>
          <div style="margin-top:12px">${shot.selfie ? html`<button class="btn btn-gold" onClick=${submit}>Submit for verification</button>`
            : html`<button class="btn btn-green" disabled=${busy} onClick=${() => capture('selfie')}><${Icon} n="camera" c="sm"/> ${busy ? 'Capturing…' : 'Take selfie'}</button>`}</div>`}
        ${step === 5 && html`<svg class="checking" viewBox="0 0 50 50"><circle cx="25" cy="25" r="21" fill="none" stroke="rgba(11,74,44,.12)" stroke-width="4"/><circle cx="25" cy="25" r="21" fill="none" stroke="url(#goldMetal)" stroke-width="4" stroke-linecap="round" stroke-dasharray="40 200"/></svg>
          <p class="muted" style="text-align:center">Checking your CNIC and selfie with the verification provider…</p>`}
        ${step === 6 && html`<div class="check-wrap" style="margin-top:20px"><span class="ripple"></span><span class="ripple"></span><div class="check-disc"><svg width="46" height="46" viewBox="0 0 24 24" fill="none" stroke="#E2B65A" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round"><path d=${PATHS.check} pathLength="1"/></svg></div></div>
          <p class="muted" style="text-align:center;margin-top:14px">Prototype: verification always passes. A real provider returns pass, fail or manual review (section 8).</p>
          <div style="margin-top:12px"><button class="btn btn-gold" onClick=${() => A.kycFinish(next)}>${next === 'pay' ? 'Continue to payment' : 'Done'}</button></div>`}
      </div>
    </div>
  </div>`;
}

function ProfileScreen({ S, A }) {
  const [f, setF] = useState({ ...S.profile });
  const [ph, setPh] = useState({ open: false, num: '', sent: false, code: '', busy: false, err: '' });
  const demo = S.otpCfg.checked && !S.otpCfg.unreachable && S.otpCfg.configured === false;
  const phSend = async () => {
    setPh(p => ({ ...p, busy: true, err: '' }));
    const d = demo ? { ok: true } : await otpCall({ action: 'send', phone: ph.num, channel: 'sms' });
    setPh(p => ({ ...p, busy: false, sent: !!d.ok, err: d.ok ? '' : d.error === 'wait' ? `Please wait ${d.retryIn}s.` : d.error === 'unreachable' ? 'Can’t reach the login service. Try again.' : d.message || 'Could not send the code.' }));
  };
  const phCheck = async () => {
    setPh(p => ({ ...p, busy: true, err: '' }));
    const d = demo ? { ok: true, approved: true } : await otpCall({ action: 'check', phone: ph.num, code: ph.code });
    if (d.ok && d.approved) { A.changePhone(ph.num); setPh({ open: false, num: '', sent: false, code: '', busy: false, err: '' }); return; }
    setPh(p => ({ ...p, busy: false, code: '', err: d.message || 'That code is incorrect.' }));
  };
  const idChanged = ['name', 'cnic', 'dob'].some(k => (f[k] || '') !== (S.profile[k] || ''));
  const dirty = idChanged || ['email', 'address'].some(k => (f[k] || '') !== (S.profile[k] || ''));
  const emailBad = f.email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(f.email);
  const numOk = PK_MOBILE.test(ph.num);
  return html`<div class="page">
    <${TopBar} title="Personal details" onBack=${A.back} />
    <div class="scroll" style="top:calc(var(--top) + 60px)">
      <div class="pad enter">
        <div class="tiny muted" style="text-transform:uppercase;letter-spacing:.08em;font-weight:900;margin-top:4px">Identity details</div>
        <label class="f">Full name</label><input class="inp" value=${f.name} onInput=${e => setF({ ...f, name: e.target.value })} />
        <label class="f">CNIC number</label><input class="inp" inputmode="numeric" placeholder="Added during verification" value=${fmtCnic(f.cnic || '')} onInput=${e => setF({ ...f, cnic: fmtCnic(e.target.value) })} />
        <label class="f">Date of birth</label><input class="inp" type="date" value=${f.dob || ''} onInput=${e => setF({ ...f, dob: e.target.value })} />
        ${idChanged && S.kyc.status === 'verified' && html`<div class="login-note" style="margin-top:12px"><${Icon} n="alert" c="sm"/><span>Changing identity details needs re-verification (FR-N2). Buying is paused until PGBX checks them again.</span></div>`}
        <div class="tiny muted" style="text-transform:uppercase;letter-spacing:.08em;font-weight:900;margin-top:20px">Contact details</div>
        <label class="f">Mobile number</label>
        <div class="between"><b>+92 ${S.phone ? S.phone.slice(0, 3) + ' ' + S.phone.slice(3) : '3•• ••• 4521'}</b><button class="linkbtn" onClick=${() => setPh({ open: !ph.open, num: '', sent: false, code: '', busy: false, err: '' })}>${ph.open ? 'Cancel' : 'Change'}</button></div>
        ${ph.open && html`<div class="card summary step-in" style="margin:8px 0 0">
          <div class="field" style="margin-top:0"><span class="cc">+92</span><input inputmode="numeric" placeholder="New number 3XX XXXXXXX" value=${ph.num} onInput=${e => setPh({ ...ph, num: e.target.value.replace(/\D/g, '').replace(/^92/, '').replace(/^0/, '').slice(0, 10), sent: false, err: '' })} /></div>
          ${ph.num.length === 10 && !numOk && html`<div class="hint err">Enter a valid Pakistani mobile number, for example 300 1234567.</div>`}
          ${!ph.sent ? html`<div style="margin-top:10px"><button class="btn btn-green" disabled=${!numOk || ph.busy} onClick=${phSend}>${ph.busy ? 'Sending…' : 'Send code by SMS to new number'}</button></div>`
            : html`<input class="inp" style="margin-top:10px" inputmode="numeric" autocomplete="one-time-code" placeholder=${demo ? '6-digit code (demo: any)' : '6-digit code from the SMS'} value=${ph.code} onInput=${e => setPh({ ...ph, code: e.target.value.replace(/\D/g, '').slice(0, 6), err: '' })} />
              <div style="margin-top:10px"><button class="btn btn-gold" disabled=${ph.code.length !== 6 || ph.busy} onClick=${phCheck}>${ph.busy ? 'Checking…' : 'Verify and update'}</button></div>`}
          ${ph.err && html`<div class="hint err" role="alert">${ph.err}</div>`}
        </div>`}
        <label class="f">Email</label><input class=${'inp' + (emailBad ? ' bad' : '')} type="email" placeholder="name@example.com" value=${f.email || ''} onInput=${e => setF({ ...f, email: e.target.value })} />
        <label class="f">Address</label><textarea rows="2" placeholder="House, street, area, city" value=${f.address || ''} onInput=${e => setF({ ...f, address: e.target.value })}></textarea>
        <div style="margin-top:16px"><button class="btn btn-gold" disabled=${!dirty || emailBad || f.name.trim().length < 3} onClick=${() => A.saveProfile(f)}>Save changes</button></div>
      </div>
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
    <${TabHead} title="Wallet" sub="Backed one-to-one by metal PGBX holds (FR-W5)" />
    <div class="wallet-hero enter">
      <div class="tiny" style="color:rgba(255,255,255,.65);text-transform:uppercase;letter-spacing:.08em;font-weight:900">Total value at current sell price</div>
      <div class="v"><${Odo} value=${wv.total} flash=${S.rates.tick} /></div>
      <div class="split">
        <div><span class="tiny" style="color:rgba(255,255,255,.6)">GOLD</span><b>${fmtW(wv.goldG)}</b><span class="tiny" style="color:rgba(255,255,255,.6)">${fmt(wv.gold)}</span></div>
        <div><span class="tiny" style="color:rgba(255,255,255,.6)">SILVER</span><b>${(wv.silverG / TOLA).toFixed(2)} tola</b><span class="tiny" style="color:rgba(255,255,255,.6)">${fmtW(wv.silverG)} · ${fmt(wv.silver)}</span></div>
      </div>
    </div>
    ${pending.length > 0 && html`<div class="section-title"><h3>Pending credit</h3><span>FR-B5</span></div>
      <div class="stack cascade">${pending.map((o, i) => html`<div class="card summary" style=${{ '--i': i, margin: 0, borderColor: 'rgba(200,150,43,.5)' }}>
        <div class="between"><b style="font-size:14px">${linesText(o.lines)}</b><span class="status-pill st-requested">With operations</span></div>
        <div class="tiny muted" style="margin-top:4px">Paid ${fmt(o.total)} · ${dt(o.ts)} · <span class="rno">${o.receipt}</span></div>
        <div class="tiny muted" style="margin-top:4px">Not in your balance yet: the ledger records metal only once it is credited.</div>
        <button class="btn btn-ghost" style="margin-top:10px;min-height:44px;border-style:dashed;border-color:rgba(154,91,0,.5);color:#6b3f00" onClick=${() => A.resolveOrder(o.id)}>Prototype: operations credits this order</button>
      </div>`)}</div>`}
    <div class="section-title"><h3>Holdings</h3><span>FR-W1</span></div>
    ${held.length === 0 ? html`<div class="empty">No holdings yet. <br/><button class="btn btn-gold" style="margin-top:12px" onClick=${() => A.tab('buy')}>Buy your first product</button></div>` :
      html`<div class="card list cascade">${held.map((p, i) => html`<div class="hold" style=${{ '--i': i, borderTop: i ? '1px solid var(--line)' : '' }}>
        <div class="cnt">${holdings[p.id]}×</div><${Ingot} metal=${p.metal} w=${48} label=${p.short}/>
        <div><b>${pname(p)}</b><div class="tiny muted">${fmtW(p.grams * holdings[p.id])} total</div>
          ${reserved[p.id] ? html`<div class="tiny" style="color:var(--gold-d);font-weight:700;margin-top:2px">${reserved[p.id]} reserved for redemption</div>` : ''}</div>
        <div style="margin-left:auto;text-align:right"><b style="font-size:14px">${fmt(holdings[p.id] * p.grams * rateOf(S.rates, p.metal).sellGram)}</b><div class="tiny muted">sell value</div></div>
      </div>`)}</div>`}
    <div class="dealers-card card" style="margin-top:12px">
      <div class="badge-ico"><${Icon} n="refresh"/></div>
      <div><b>Sell back to PGBX</b><div class="small muted" style="margin-top:3px">Whether sell-back is in version 1 (FR-W6): <span class="tbc">${TBC}</span></div></div>
    </div>
    <div class="section-title"><h3>History</h3><span>From the ledger (FR-W2, FR-W3)</span></div>
    <div class="card list cascade">
      ${history.map((e, i) => { const p = P[e.pid]; const cls = e.reason === 'purchase' ? 'plus' : e.reason === 'redemption' ? 'minus' : 'open';
        const title = e.reason === 'purchase' ? 'Purchase' : e.reason === 'redemption' ? `Redeemed${e.dealer ? ' at ' + e.dealer : ''}` : 'Opening balance (sample)';
        return html`<div class="ledger-item" style=${{ '--i': Math.min(i, 8), borderTop: i ? '1px solid var(--line)' : '' }}>
          <div class=${'li ' + cls}><${Icon} n=${cls === 'minus' ? 'store' : cls === 'plus' ? 'buy' : 'box'} c="sm"/></div>
          <div style="flex:1;min-width:0"><div class="between"><b style="font-size:14px">${title}</b><b class=${e.delta > 0 ? 'up' : 'down'} style="font-size:14px">${e.delta > 0 ? '+' : '−'}${Math.abs(e.delta)} × ${p.short}</b></div>
            <div class="tiny muted" style="margin-top:3px">${dt(e.ts)}${e.price ? ' · ' + fmt(e.price) + '/unit' : ''}</div>
            <div class="tiny muted rno" style="margin-top:2px">${e.ref}</div>
            ${e.serials && html`<div class="tiny" style="margin-top:2px;color:var(--g700)">Serials: ${e.serials.join(', ')}</div>`}</div>
        </div>`; })}
    </div>
    <div class="pad" style="margin-top:12px"><button class="btn btn-ghost" onClick=${() => A.push({ name: 'statement' })}><${Icon} n="download" c="sm"/> Download statement</button></div>
    <p class="foot-note">The balance is never stored or edited: it is the sum of ledger entries above. Storage fee or time limit for holdings (FR-W7): <span class="tbc">${TBC}</span></p>
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
<style>body{font:13px/1.5 Lato,Arial,sans-serif;color:#1D2B22;margin:32px}h1{font-family:Georgia,serif;color:#0B4A2C;margin:0}table{width:100%;border-collapse:collapse;margin-top:12px}th,td{padding:7px 8px;border-bottom:1px solid #ddd;text-align:left}th{background:#0B4A2C;color:#fff;font-size:11px;text-transform:uppercase}.m{color:#5F6D64}.box{border:1px solid #C8962B;border-radius:8px;padding:10px 12px;margin-top:12px}</style></head>
<body><h1>PGBX wallet statement</h1><div class="m">Pakistan Gold Bullion Exchange · Office 1211, 12th Floor, Gold Tower, Saddar, Karachi</div>
<div class="box"><b>${esc(S.profile.name)}</b> · CNIC ${esc(maskCnic(S.profile.cnic) || 'not verified')} · +92 ${esc(S.phone || '3XX XXX 4521')}<br>Period: ${from} to ${to} · Generated ${esc(dt(Date.now()))}</div>
<p><b>Opening holdings:</b> ${esc(holdText(d.opening))}<br><b>Closing holdings:</b> ${esc(holdText(d.closing))}</p>
<table><tr><th>Date</th><th>Type</th><th>Product</th><th>Units</th><th>Price / unit</th><th>Receipt / reference</th></tr>${rows}</table>
<p class="m">Holdings are derived from the wallet ledger (FR-W3). Tax and legal details (CMP-7): [To be confirmed by PGBX]. Prototype statement with sample data.</p></body></html>`;
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
    downloadBlob(`PGBX-statement-${from}-to-${to}.csv`, 'text/csv', lines.join('\n')); A.toast('Statement downloaded (CSV)');
  };
  const pdf = () => {
    const h = statementHtml(S, d, from, to);
    const w = window.open(URL.createObjectURL(new Blob([h], { type: 'text/html' })), '_blank');
    if (w) w.addEventListener('load', () => setTimeout(() => w.print(), 300));
    if (!w) { downloadBlob(`PGBX-statement-${from}-to-${to}.html`, 'text/html', h); A.toast('Statement downloaded; open it and print to PDF'); }
  };
  return html`<div class="page">
    <${TopBar} title="Statement" onBack=${A.back} />
    <div class="scroll" style="top:calc(var(--top) + 60px)">
      <div class="pad enter">
        <p class="muted" style="font-size:14px;margin:0 0 12px">Choose a period (FR-W4).</p>
        <div class="chips">${[['month', 'This month'], ['d30', 'Last 30 days'], ['d90', 'Last 3 months'], ['custom', 'Custom']].map(([k, l]) => html`<button class=${'chipb' + (preset === k ? ' on' : '')} onClick=${() => pick(k)}>${l}</button>`)}</div>
        <div style="display:grid;grid-template-columns:1fr 1fr;gap:10px">
          <div><label class="f">From</label><input class="inp" type="date" max=${today} value=${from} onInput=${e => { setPreset('custom'); setFrom(e.target.value); }} /></div>
          <div><label class="f">To</label><input class="inp" type="date" max=${today} value=${to} onInput=${e => { setPreset('custom'); setTo(e.target.value); }} /></div>
        </div>
        ${bad && html`<div class="hint err">Choose a start date on or before the end date.</div>`}
      </div>
      ${d && html`<div class="card summary enter" style="margin-top:14px">
        <div class="kv"><span>Entries</span><b>${d.entries.length}</b></div>
        <div class="kv"><span>Opening holdings</span><b style="max-width:60%">${holdText(d.opening)}</b></div>
        <div class="kv"><span>Closing holdings</span><b style="max-width:60%">${holdText(d.closing)}</b></div>
      </div>
      <div class="cta" style="display:grid;gap:10px;margin-top:14px">
        <button class="btn btn-gold" onClick=${pdf}><${Icon} n="doc" c="sm"/> Save as PDF</button>
        <button class="btn btn-ghost" onClick=${csv}><${Icon} n="download" c="sm"/> Download CSV</button>
      </div>`}
      <p class="foot-note">The PDF opens a printable statement; choose “Save as PDF” in the print dialog. Tax and legal details (CMP-7): <span class="tbc">${TBC}</span></p>
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
  return html`<div class="map enter">
    <svg viewBox=${`0 0 ${MAPBOX.W} ${MAPBOX.H}`} role="img" aria-label="Map of sample dealers">
      <path d="M0 140 C40 150 70 165 95 176 S150 190 175 190 L0 190 Z" fill="#bcd9e3"/>
      <path d="M0 150 C40 158 70 170 95 180" fill="none" stroke="#a5c9d6" stroke-width="2"/>
      <ellipse cx="250" cy="70" rx="34" ry="18" fill="#d5e6cc"/><ellipse cx="120" cy="120" rx="22" ry="12" fill="#d5e6cc"/>
      ${['M0 95 C80 90 160 98 340 80', 'M60 0 C80 60 100 120 120 190', 'M150 190 C170 120 210 60 260 0', 'M0 40 C120 52 220 46 340 30', 'M200 190 C230 150 280 130 340 128'].map(dd => html`<path d=${dd} fill="none" stroke="#fff" stroke-width="5" stroke-linecap="round"/>`)}
      <g transform=${`translate(${yx} ${yy})`}><circle class="you-ring" r="9" fill="rgba(31,120,200,.25)"/><circle r="5.5" fill="#1f78c8" stroke="#fff" stroke-width="2"/></g>
      ${DEALERS.map(d => { const [x, y] = proj(d.lat, d.lng); const ok = isOk(d); return html`<g class=${'pin' + (selected === d.id ? ' on' : '') + (ok ? '' : ' off')} transform=${`translate(${x} ${y})`} onClick=${() => ok && onSelect(d.id)}>
        <g class="pg"><path d="M0 0 C-9 -12 -9 -24 0 -24 S9 -12 0 0Z" fill=${selected === d.id ? '#C8962B' : '#0B4A2C'} stroke="#fff" stroke-width="1.5"/><circle cy="-15" r="3.2" fill="#fff"/></g>
        <text y="12" text-anchor="middle" font-size="9" font-weight="900" fill="#1D2B22" font-family="Lato,sans-serif">${d.name.split(' ')[0]}</text></g>`; })}
    </svg>
    <span class="cap">Schematic map · map provider ${TBC}</span>
  </div>`;
}
const DealerActions = ({ d }) => html`<div class="dact" onClick=${e => e.stopPropagation()}>
  <a href=${'tel:' + d.phone.replace(/\s/g, '')}><${Icon} n="call" c="xs"/> ${d.phone}</a>
  <a href=${`https://www.google.com/maps/search/?api=1&query=${d.lat},${d.lng}`} target="_blank" rel="noopener"><${Icon} n="nav" c="xs"/> Directions</a>
</div>`;

function RedeemScreen({ S, A }) {
  const avail = id => (S.holdings[id] || 0) - (S.reserved[id] || 0);
  const held = PRODUCTS.filter(p => avail(p.id) > 0);
  const [pid, setPid] = useState(held[0] ? held[0].id : null);
  const [units, setUnits] = useState(1);
  const [did, setDid] = useState(null);
  useEffect(() => { if (pid && avail(pid) <= 0) setPid(held[0] ? held[0].id : null); }, [S.holdings, S.reserved]);
  useEffect(() => { setUnits(1); if (did && pid && S.dealerStock[did][pid] <= 0) setDid(null); }, [pid]);
  const active = S.redemptions.filter(r => ['requested', 'ready'].includes(S.statusOf(r)));
  const past = S.redemptions.filter(r => !['requested', 'ready'].includes(S.statusOf(r)));
  const canConfirm = pid && did && units >= 1 && units <= avail(pid) && S.dealerStock[did][pid] >= units;
  const dealerOk = d => (S.dealerStock[d.id][pid] || 0) >= units;
  const sorted = [...DEALERS].sort((a, b) => a.km - b.km);
  return html`<div class="scroll">
    <${TabHead} title="Redeem" sub="Collect your metal at a PGBX dealer" />
    ${active.length > 0 && html`<div class="section-title" style="margin-top:12px"><h3>Active redemptions</h3></div>
      <div class="stack cascade">${active.map((r, i) => html`<${RedemptionRow} r=${r} S=${S} A=${A} i=${i}/>`)}</div>`}

    <div class="section-title"><h3>1 · Choose a product</h3><span>Available units</span></div>
    ${held.length === 0 ? html`<div class="empty">Nothing available to redeem.<br/><button class="btn btn-gold" style="margin-top:12px" onClick=${() => A.tab('buy')}>Buy a product</button></div>` : html`
    <div class="stack cascade">
      ${held.map((p, i) => html`<button class=${'choice' + (pid === p.id ? ' on' : '')} style=${{ '--i': i }} onClick=${() => setPid(p.id)} role="radio" aria-checked=${pid === p.id}>
        <div class="ing"><${Ingot} metal=${p.metal} w=${54} label=${p.short}/></div>
        <div><b>${pname(p)}</b><div class="tiny muted">${avail(p.id)} available${S.reserved[p.id] ? ` · ${S.reserved[p.id]} reserved` : ''}</div></div>
        <span class=${'radio' + (pid === p.id ? ' on' : '')}><i></i></span>
      </button>`)}
    </div>
    <div class="lockbox between">
      <div><b style="font-size:15px">Units to collect</b><div class="tiny muted">Whole units only</div></div>
      <div class="stepper">
        <button disabled=${units <= 1} onClick=${() => setUnits(u => u - 1)} aria-label="Fewer"><${Icon} n="minus" c="sm"/></button>
        <output><span key=${units}>${units}</span></output>
        <button disabled=${!pid || units >= avail(pid)} onClick=${() => setUnits(u => u + 1)} aria-label="More"><${Icon} n="plus" c="sm"/></button>
      </div>
    </div>

    <div class="section-title"><h3>2 · Choose a dealer</h3><span>4 of 250 · sample</span></div>
    <${DealerMap} selected=${did} isOk=${dealerOk} onSelect=${setDid} />
    <div class="stack cascade">
      ${sorted.map((d, i) => { const ok = dealerOk(d);
        return html`<div class=${'choice' + (did === d.id ? ' on' : '') + (ok ? '' : ' off')} style=${{ '--i': i }} tabindex=${ok ? 0 : -1} onClick=${() => ok && setDid(d.id)} onKeyDown=${e => { if (ok && (e.key === 'Enter' || e.key === ' ')) { e.preventDefault(); setDid(d.id); } }} role="radio" aria-checked=${did === d.id} aria-disabled=${!ok}>
          <div class="badge-ico" style="width:42px;height:42px"><${Icon} n="pin" c="sm"/></div>
          <div style="flex:1;min-width:0"><div class="between"><b style="font-size:15px">${d.name}</b><span class=${'stock ' + (ok ? 'in' : 'out')}>${ok ? 'In stock' : 'Out of stock'}</span></div>
            <div class="tiny muted" style="margin-top:3px">${d.area} · ${d.km} km away</div>
            <div class="tiny muted" style="margin-top:2px;display:flex;align-items:center;gap:4px"><${Icon} n="clock" c="xs"/> ${d.hours}</div>
            ${ok && html`<${DealerActions} d=${d} />`}</div>
          <span class=${'radio' + (did === d.id ? ' on' : '')}><i></i></span>
        </div>`; })}
    </div>
    <div class="pad tiny muted" style="margin-top:8px">Out-of-stock dealers cannot be chosen (FR-D2). Dealer names, phone numbers, locations and stock are samples; distances are from a sample location in Saddar. Real data comes from the admin panel (FR-D1, FR-M5).</div>

    <div class="card summary" style="margin-top:16px">
      <div class="kv"><span>Redemption fee / making charge (FR-D8)</span><span class="tbc">${TBC}</span></div>
      <div class="kv"><span>Gold vs silver redemption rules</span><span class="tbc">${TBC}</span></div>
      <div class="kv"><span>Code valid for</span><b>24 hours</b></div>
    </div>
    <div class="cnic"><${Icon} n="shield" c="sm"/><div><b>Bring your original CNIC.</b> The dealer checks it against your account before handing over the product (FR-D5). The code works once, only at the dealer you choose (FR-D4).</div></div>
    <div class="cta" style="margin-top:16px"><button class="btn btn-gold" disabled=${!canConfirm} onClick=${() => A.redeem(pid, units, did)}>Confirm and reserve ${units} unit${units > 1 ? 's' : ''}</button></div>
    `}
    ${past.length > 0 && html`<div class="section-title"><h3>Past redemptions</h3></div><div class="stack">${past.map((r, i) => html`<${RedemptionRow} r=${r} S=${S} A=${A} i=${i}/>`)}</div>`}
  </div>`;
}
const STATUS_LABEL = { requested: 'Requested', ready: 'Ready at dealer', completed: 'Collected', cancelled: 'Cancelled', expired: 'Expired' };
function RedemptionRow({ r, S, A, i }) {
  const p = P[r.pid]; const d = DEALERS.find(x => x.id === r.dealerId); const st = S.statusOf(r);
  return html`<button class="choice" style=${{ '--i': i }} onClick=${() => A.push({ name: 'code', rid: r.id })}>
    <div class="ing"><${Ingot} metal=${p.metal} w=${50} label=${p.short}/></div>
    <div style="flex:1;min-width:0"><b style="font-size:14px">${r.units} × ${pname(p)}</b><div class="tiny muted">${d.name} · code ${r.code}</div></div>
    <span class=${'status-pill st-' + st}>${STATUS_LABEL[st]}</span>
  </button>`;
}

function CodeScreen({ S, A, rid }) {
  const r = S.redemptions.find(x => x.id === rid); const p = P[r.pid]; const d = DEALERS.find(x => x.id === r.dealerId);
  const st = S.statusOf(r);
  const [idOk, setIdOk] = useState(false);
  const [confirmCancel, setConfirmCancel] = useState(false);
  const order = ['requested', 'ready', 'completed'];
  const idx = order.indexOf(st);
  const live = st === 'requested' || st === 'ready';
  return html`<div class="page">
    <${TopBar} title="Redemption" onBack=${A.back} right=${html`<span class=${'status-pill st-' + st} style="margin-right:8px">${STATUS_LABEL[st]}</span>`} />
    <div class="scroll" style="top:calc(var(--top) + 60px)">
      <div class="card code-card enter">
        <div class="tiny muted" style="text-transform:uppercase;letter-spacing:.1em;font-weight:900">Your one-time code</div>
        <div class="code-digits" style=${{ opacity: live ? 1 : .45 }}>${r.code.split('').map((c, i) => html`<span style=${{ animationDelay: (0.1 + i * 0.06) + 's' }}>${c}</span>`)}</div>
        <${QR} code=${r.code} />
        <div class="tiny muted">Pattern for prototype only, not a scannable QR</div>
        <div class="small" style="margin-top:10px;font-weight:700;color:${live ? 'var(--g800)' : 'var(--muted)'}">
          ${live ? html`Expires in ${dur(r.expiresAt - S.now)}` : st === 'completed' ? `Collected ${dt(r.completedAt)}` : st === 'cancelled' ? 'Cancelled: units returned to your wallet' : 'Expired: units returned to your wallet'}
        </div>
        ${st !== 'cancelled' && st !== 'expired' ? html`<div class="steps">
          ${order.map((k, i) => html`<div class=${'step' + (i < idx || st === 'completed' ? ' done' : i === idx ? ' cur' : '')}><div class="sd">${i < idx || st === 'completed' ? html`<${Icon} n="check"/>` : i + 1}</div>${STATUS_LABEL[k]}</div>`)}
        </div>` : ''}
      </div>
      <div class="card summary">
        <div class="kv"><span>Item</span><b>${r.units} × ${pname(p)}</b></div>
        <div class="kv"><span>Dealer</span><b>${d.name}</b></div>
        <div class="kv"><span>Address</span><b>${d.area}</b></div>
        <div class="kv"><span>Hours</span><b>${d.hours}</b></div>
        <div class="kv"><span>Fee</span><span class="tbc">${TBC}</span></div>
        ${r.serials && html`<div class="kv"><span>Serial no. (FR-D6)</span><b class="rno">${r.serials.join(', ')}</b></div>`}
        <${DealerActions} d=${d} />
      </div>
      ${live && html`<div class="cnic"><${Icon} n="shield" c="sm"/><div>Show this code and your original CNIC at <b>${d.name}</b>. Your ${r.units} unit${r.units > 1 ? 's are' : ' is'} reserved until then (FR-D3).</div></div>`}
      ${live && html`<div class="cta" style="margin-top:14px">
        <button class="btn btn-danger" onClick=${() => { if (confirmCancel) { A.cancelRedemption(r.id); setConfirmCancel(false); } else setConfirmCancel(true); }}>
          <${Icon} n="x" c="sm"/> ${confirmCancel ? 'Tap again to confirm cancel' : 'Cancel redemption'}</button>
        <div class="tiny muted" style="text-align:center;margin-top:6px">FR-D9 · cancelling releases the reserved units</div>
      </div>`}

      <div class="sim">
        <h3><${Icon} n="store" c="sm"/> Prototype: simulate the dealer</h3>
        <p class="small" style="margin:6px 0 10px;color:#6b3f00">In the real system these steps happen in the dealer interface (FR-DL2, FR-DL3), not in the customer app.</p>
        <button class="btn btn-ghost" style="background:#fff" disabled=${st !== 'requested'} onClick=${() => A.markReady(r.id)}><${Icon} n="box" c="sm"/> Mark ready</button>
        <button class="check" disabled=${st !== 'ready'} style=${{ opacity: st === 'ready' ? 1 : .5, marginTop: '6px' }} onClick=${() => setIdOk(v => !v)} role="checkbox" aria-checked=${idOk}>
          <span class=${'cbox' + (idOk ? ' on' : '')}><${Icon} n="check"/></span> Customer CNIC checked against account (FR-D5)
        </button>
        <button class="btn btn-green" disabled=${st !== 'ready' || !idOk} onClick=${() => A.handOver(r.id)}><${Icon} n="check" c="sm"/> Hand over</button>
        <div class="tiny" style="color:#6b3f00;margin-top:8px">Hand over records serial numbers, deducts the wallet through a ledger entry and updates dealer stock.</div>
      </div>
    </div>
  </div>`;
}

/* ============================================================
   Notifications (FR-N1)
   ============================================================ */
const N_ICON = { purchase: 'buy', redemption: 'store', security: 'shield', account: 'user', alert: 'bell' };
function PushBanner({ n, onOpen }) {
  return html`<button class="push glass" key=${n.id} onClick=${onOpen} role="status">
    <${Coin} size=${34} still=${true} />
    <div style="flex:1;min-width:0"><div class="pt">PGBX · NOW</div><b>${n.title}</b><div class="small muted">${n.body}</div></div>
  </button>`;
}
function InboxScreen({ S, A }) {
  const [unreadAtOpen] = useState(() => new Set(S.notifications.filter(n => !n.read).map(n => n.id)));
  useEffect(() => { A.markAllRead(); }, []);
  const prefs = S.notifPrefs;
  const via = Object.entries(prefs).filter(([, v]) => v).map(([k]) => ({ push: 'push', sms: 'SMS', email: 'email' }[k])).join(', ') || 'in-app only';
  return html`<div class="page">
    <${TopBar} title="Notifications" onBack=${A.back} />
    <div class="scroll" style="top:calc(var(--top) + 60px)">
      <div class="card list enter">
        ${[['push', 'Push notifications', 'bell'], ['sms', 'SMS', 'phone'], ['email', 'Email', 'mail']].map(([k, l, ic]) => html`<button class="li-row" onClick=${() => A.set(s => ({ notifPrefs: { ...s.notifPrefs, [k]: !s.notifPrefs[k] } }))} role="switch" aria-checked=${prefs[k]}>
          <span class="lic"><${Icon} n=${ic} c="sm"/></span><b style="font-size:15px">${l}</b><span class="end"><${Switch} on=${prefs[k]} /></span></button>`)}
      </div>
      <p class="foot-note" style="margin-top:8px">Purchases, redemption status, security events and account changes are always shown here and sent by ${via} (FR-N1). Push, SMS and email providers: <span class="tbc">${TBC}</span></p>
      <div class="section-title"><h3>Recent</h3><span>${S.notifications.length}</span></div>
      ${S.notifications.length === 0 ? html`<div class="empty">No notifications yet. Buy, redeem or set a price alert to see them here.</div>`
        : html`<div class="card list cascade">${S.notifications.map((n, i) => html`<div class="nitem" style=${{ '--i': Math.min(i, 8) }}>
          <span class=${'ni ' + n.kind}><${Icon} n=${N_ICON[n.kind] || 'bell'} c="sm"/></span>
          <div style="flex:1;min-width:0;padding-right:14px"><b style="font-size:14px">${n.title}</b><div class="small muted" style="margin-top:2px">${n.body}</div><div class="tiny muted" style="margin-top:4px">${dt(n.ts)}</div></div>
          ${unreadAtOpen.has(n.id) && html`<span class="ud"></span>`}
        </div>`)}</div>`}
    </div>
  </div>`;
}

/* ============================================================
   Account
   ============================================================ */
const KYC_LABEL = { verified: 'Verified · CNIC + selfie', none: 'Not verified', pending: 'Verification in progress', reverify: 'Re-verification needed' };
function AccountScreen({ S, A }) {
  const rows = [
    { icon: 'user', label: 'Personal details', go: () => A.push({ name: 'profile' }) },
    { icon: 'idcard', label: 'Identity verification', end: { verified: 'Verified', none: 'Not verified', pending: 'In progress', reverify: 'Needed' }[S.kyc.status], go: () => S.kyc.status === 'verified' ? A.toast(`Verified ${S.kyc.at ? dt(S.kyc.at) : ''} · CNIC ${maskCnic(S.profile.cnic)}`) : A.push({ name: 'kyc' }) },
    { icon: 'bell', label: 'Notifications', end: S.unread ? `${S.unread} new` : '', go: () => A.push({ name: 'inbox' }) },
    { icon: 'chart', label: 'Rate history and price alerts', end: S.alerts.filter(a => a.active).length ? `${S.alerts.filter(a => a.active).length} active` : '', go: () => A.openHistory('gold') },
  ];
  const sec = [
    { icon: 'key', label: 'Change PIN', go: () => A.push({ name: 'changepin' }) },
    { icon: 'face', label: 'Face / fingerprint unlock', toggle: true },
    { icon: 'clock', label: 'Auto-lock', end: 'After 2 minutes', go: () => A.toast(`The app locks after 2 minutes of inactivity, and after ${PIN_MAX_FAILS} wrong PINs you must log in again (FR-A4)`) },
  ];
  const help = [
    { icon: 'help', label: 'FAQs', kind: 'faq' },
    { icon: 'call', label: 'Contact PGBX', kind: 'contact' },
    { icon: 'flag', label: 'Report a problem', kind: 'report' },
    { icon: 'receipt', label: 'Fee schedule', kind: 'fees' },
    { icon: 'doc', label: 'Terms and privacy', kind: 'terms' },
  ];
  const masked = S.phone ? `+92 ${S.phone.slice(0, 1)}•• ••• ${S.phone.slice(-4)}` : '+92 3•• ••• 4521';
  const initials = S.profile.name.split(' ').filter(Boolean).slice(0, 2).map(w => w[0].toUpperCase()).join('');
  const Row = (r, i) => r.toggle ? html`<button class="li-row" style=${{ '--i': i }} onClick=${() => A.set({ biometric: !S.biometric })} role="switch" aria-checked=${S.biometric}>
      <span class="lic"><${Icon} n=${r.icon} c="sm"/></span><b style="font-size:15px">${r.label}</b><span class="end"><${Switch} on=${S.biometric} /></span></button>`
    : html`<button class="li-row" style=${{ '--i': i }} onClick=${r.go}><span class="lic"><${Icon} n=${r.icon} c="sm"/></span><b style="font-size:15px">${r.label}</b><span class="end">${r.end || ''}<${Icon} n="chev" c="sm"/></span></button>`;
  return html`<div class="scroll">
    <${TabHead} title="Account" />
    <button class="card profile enter press" style="width:calc(100% - 28px);text-align:left" onClick=${() => A.push({ name: 'profile' })}>
      <div class="avatar">${initials}</div>
      <div style="flex:1"><b style="font-size:17px;font-family:var(--serif)">${S.profile.name}</b><div class="small muted">${masked} · sample customer</div>
        <span class=${'kyc-badge ' + S.kyc.status}><${Icon} n=${S.kyc.status === 'verified' ? 'shield' : 'alert'} c="xs"/> ${KYC_LABEL[S.kyc.status]}</span></div>
      <${Icon} n="edit" c="sm" s="color:var(--muted)"/>
    </button>
    <div class="section-title"><h3>Profile and activity</h3></div>
    <div class="card list cascade">${rows.map(Row)}</div>
    <div class="section-title"><h3>Security</h3></div>
    <div class="card list cascade">${sec.map(Row)}</div>
    <div class="section-title"><h3>Help and legal</h3></div>
    <div class="card list cascade">
      ${help.map((r, i) => html`<button class="li-row" style=${{ '--i': i }} onClick=${() => A.push({ name: 'info', kind: r.kind })}><span class="lic"><${Icon} n=${r.icon} c="sm"/></span><b style="font-size:15px">${r.label}</b><span class="end"><${Icon} n="chev" c="sm"/></span></button>`)}
    </div>
    <div class="pad small muted" style="margin-top:14px">Language: English · Urdu at launch <span class="tbc">${TBC}</span></div>
    <div class="cta" style="margin-top:16px;display:grid;gap:10px">
      <button class="btn btn-green" onClick=${A.lockNow}><${Icon} n="lock" c="sm"/> Lock app</button>
      <button class="btn btn-ghost" onClick=${A.logout}><${Icon} n="out" c="sm"/> Log out</button>
      <${ResetDemo} A=${A} />
    </div>
    <p class="foot-note" style="text-align:center">PGBX customer app · clickable prototype · rates are live, customer, wallet and dealer data is sample data</p>
  </div>`;
}

function ResetDemo({ A }) {
  const [sure, setSure] = useState(false);
  return html`<button class="btn btn-ghost" style="border:0;color:var(--muted);font-size:14px;min-height:44px" onClick=${() => (sure ? A.resetDemo() : setSure(true))}>
    <${Icon} n="refresh" c="sm"/> ${sure ? 'Tap again to erase all demo data' : 'Reset demo data'}</button>`;
}

function ChangePin({ S, A }) {
  const steps = ['Enter current PIN', 'Enter new PIN', 'Confirm new PIN'];
  const [step, setStep] = useState(0);
  const [first, setFirst] = useState('');
  const [ok, setOk] = useState(false);
  const [err, setErr] = useState(0);
  const [msg, setMsg] = useState('');
  const done = p => {
    if (step === 0) { if (p !== S.pin) { setErr(e => e + 1); setMsg('That is not your current PIN'); return false; } setMsg(''); setStep(1); return false; }
    if (step === 1) { if (p === S.pin) { setErr(e => e + 1); setMsg('Choose a PIN different from the current one'); return false; } setFirst(p); setMsg(''); setStep(2); return false; }
    if (p !== first) { setErr(e => e + 1); setMsg('PINs did not match. Enter the new PIN again'); setStep(1); return false; }
    setOk(true); setTimeout(() => { A.setPin(p); A.back(); }, 600); return true;
  };
  return html`<div class="lock" style="position:absolute;inset:0">
    <div style="position:absolute;left:10px;top:calc(var(--top) + 4px)"><button class="iconbtn" style="color:#fff" onClick=${A.back} aria-label="Back"><${Icon} n="back"/></button></div>
    <${Coin} size=${80} still=${true} />
    <h2 key=${step}>${steps[step]}</h2>
    <div class="proto">Prototype: the current PIN is ${PIN_DEFAULT} unless you changed it · a real flow adds an OTP check</div>
    <div class=${'note' + (msg ? ' warn' : '')}>${msg}</div>
    <${PinPad} key=${step} ok=${ok} err=${err} onComplete=${done} showFace=${false} />
  </div>`;
}

function InfoScreen({ S, A, kind }) {
  const titles = { faq: 'FAQs', contact: 'Contact PGBX', report: 'Report a problem', fees: 'Fee schedule', terms: 'Terms and privacy' };
  let body;
  if (kind === 'faq') body = html`<${Faqs}/>`;
  else if (kind === 'contact') body = html`<div class="card list cascade">
      ${[['pin', 'Head office', 'Office 1211, 12th Floor, Gold Tower, Saddar, Karachi'], ['call', 'Phone', '+92 21 35215555', 'tel:+922135215555'], ['phone', 'WhatsApp', '+92 303 3521555', 'https://wa.me/923033521555'], ['sparkle', 'Website', 'pgbx.com.pk', 'https://pgbx.com.pk']].map(([ic, l, v, href], i) =>
        html`<a class="li-row" style=${{ '--i': i, color: 'inherit', textDecoration: 'none' }} href=${href || null} target="_blank" rel="noopener"><span class="lic"><${Icon} n=${ic} c="sm"/></span><div><div class="tiny muted">${l}</div><b style="font-size:15px">${v}</b></div></a>`)}
    </div>
    <div class="pad small muted" style="margin-top:12px">Support hours and in-app chat: <span class="tbc">${TBC}</span></div>`;
  else if (kind === 'report') body = html`<${Report} S=${S} A=${A}/>`;
  else if (kind === 'fees') body = html`<div class="card list enter"><table class="table">
      <tr><th>Product</th><th>Premium (sample)</th></tr>
      ${PRODUCTS.map(p => html`<tr><td>${pname(p)}</td><td>${fmt(p.premium)}</td></tr>`)}
    </table></div>
    <div class="card summary" style="margin-top:12px">
      <div class="kv"><span>Buy / sell spread</span><span class="tbc">${TBC}</span></div>
      <div class="kv"><span>Redemption fee / making charge</span><span class="tbc">${TBC}</span></div>
      <div class="kv"><span>Storage fee or time limit</span><span class="tbc">${TBC}</span></div>
      <div class="kv"><span>Minimum purchase</span><span class="tbc">${TBC}</span></div>
      <div class="kv"><span>Per-day purchase limit</span><b>${fmt(DAY_LIMIT)} (sample)</b></div>
    </div>
    <p class="foot-note">Every fee is shown before you confirm (FR-D8). PGBX sets fees and limits in the admin panel (FR-M2).</p>`;
  else body = html`<div class="prose cascade">
      ${[['Ownership of metal in your wallet', 'How the wallet is classified and which approvals apply'], ['Fees and charges', 'Spread, redemption fee and any storage fee'], ['Redemption period', 'How long holdings can be kept and redeemed (FR-W7)'], ['Refunds and disputes', 'What happens in a dispute'], ['Shariah approval', 'Written approval of the product, wallet and redemption flow (CMP-3)'], ['Privacy policy', 'How personal data is collected, stored and deleted (CMP-6)']].map(([h, d], i) =>
        html`<div style=${{ '--i': i }}><h3>${h}</h3><p style="margin:0" class="muted">${d}.</p><p style="margin:6px 0 0"><span class="tbc">${TBC}</span></p></div>`)}
      <p class="foot-note" style="margin:20px 0 0">Customers accept these terms before their first purchase (CMP-5).</p>
    </div>`;
  return html`<div class="page">
    <${TopBar} title=${titles[kind]} onBack=${A.back} />
    <div class="scroll" style="top:calc(var(--top) + 60px)">${body}</div>
  </div>`;
}
function Faqs() {
  const [open, setOpen] = useState(0);
  const qs = [
    ['What do I own when I buy?', 'A whole product, for example a 1 gram gold bar, held for you by PGBX. Every unit in your wallet is backed one-to-one by metal PGBX holds.'],
    ['What purity are the products?', 'All eleven products are 999.0 purity.'],
    ['Can I buy part of a product?', 'No. You always buy whole units and cannot combine smaller purchases into a larger product (FR-P7).'],
    ['Can I buy gold and silver together?', 'Yes. Add products to the cart and pay for them in one order (FR-B8).'],
    ['Why can I not buy larger bars?', 'Larger bars are sold offline only and do not appear in the app (FR-P6).'],
    ['How long is the price locked?', 'For 60 seconds. After that it refreshes to the latest PGBX rate.'],
    ['Why do I need to verify my identity?', 'PGBX must check your CNIC and a selfie before your first purchase (FR-A2).'],
    ['Where do I collect my metal?', 'At any of the 250 PGBX dealers that has your product in stock. Bring your original CNIC; your code is valid for 24 hours.'],
    ['Is there a redemption fee?', null],
    ['Can I sell back to PGBX?', null],
    ['Is there a storage fee or time limit?', null],
    ['Does redemption differ for gold and silver?', null],
  ];
  return html`<div class="card list cascade">${qs.map(([q, a], i) => html`<div class=${'faq' + (open === i ? ' open' : '')} style=${{ '--i': i }}>
    <button onClick=${() => setOpen(open === i ? -1 : i)} aria-expanded=${open === i}>${q}<${Icon} n="chev" c="sm chev"/></button>
    ${open === i && html`<div class="ans">${a || html`<span class="tbc">${TBC}</span>`}</div>`}
  </div>`)}</div>`;
}
function Report({ S, A }) {
  const opts = [...S.orders.map(o => ['o:' + o.id, `Order ${o.receipt}`]), ...S.redemptions.map(r => ['r:' + r.id, `Redemption ${r.code}`])];
  const [ref, setRef] = useState(opts[0] ? opts[0][0] : 'general');
  const [text, setText] = useState('');
  return html`<div class="pad enter">
    <label class="f">About</label>
    <select value=${ref} onChange=${e => setRef(e.target.value)}>
      ${opts.map(([v, l]) => html`<option value=${v}>${l}</option>`)}<option value="general">Something else</option>
    </select>
    <label class="f">What happened?</label>
    <textarea rows="5" placeholder="Describe the problem" value=${text} onInput=${e => setText(e.target.value)}></textarea>
    <div class="cta" style="padding:16px 0 0"><button class="btn btn-gold" disabled=${text.trim().length < 3} onClick=${() => { A.toast('Report sent to PGBX support (prototype)'); A.back(); }}>Send report</button></div>
    <p class="small muted">FR-N3. PGBX support sees the order or redemption you choose.</p>
  </div>`;
}

/* ============================================================
   App (shared state)
   ============================================================ */
const TABS = [['rates', 'Rates'], ['buy', 'Buy'], ['wallet', 'Wallet'], ['redeem', 'Redeem'], ['account', 'Account']];

// Prototype data is kept in this browser so a refresh does not wipe the demo. Sample data only; nothing leaves the device.
const STORE_KEY = 'pgbx-demo-v1';
const KEEP = ['ledger', 'orders', 'redemptions', 'dealerStock', 'cart', 'profile', 'kyc', 'pin', 'pinFails', 'pinLockUntil', 'phone',
  'notifications', 'notifPrefs', 'alerts', 'biometric', 'tab', 'buyMetal', 'loggedIn'];
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
  if (isObj(s.notifPrefs)) out.notifPrefs = { push: s.notifPrefs.push !== false, sms: s.notifPrefs.sms !== false, email: s.notifPrefs.email === true };
  if (str(s.pin) && /^\d{4}$/.test(s.pin)) out.pin = s.pin;
  if (int(s.pinFails, 0, PIN_MAX_FAILS)) out.pinFails = s.pinFails;
  if (num(s.pinLockUntil)) out.pinLockUntil = Math.min(s.pinLockUntil, Date.now() + 30000);
  if (str(s.phone) && (s.phone === '' || PK_MOBILE.test(s.phone))) out.phone = s.phone;
  if (typeof s.biometric === 'boolean') out.biometric = s.biometric;
  if (TABS.some(t => t[0] === s.tab)) out.tab = s.tab;
  if (s.buyMetal === 'gold' || s.buyMetal === 'silver') out.buyMetal = s.buyMetal;
  if (typeof s.loggedIn === 'boolean') out.loggedIn = s.loggedIn;
  return out;
}
function saveState(st) { try { localStorage.setItem(STORE_KEY, JSON.stringify({ v: 1, s: Object.fromEntries(KEEP.map(k => [k, st[k]])) })); } catch (e) { } }
function clearSaved() { try { localStorage.removeItem(STORE_KEY); } catch (e) { } }
const SAVED = loadSaved();

function App() {
  const [phase, setPhase] = useState(START === 'home' ? 'app' : START === 'login' ? 'login' : START === 'pin' ? 'pin' : 'splash');
  const returning = !!(SAVED && SAVED.loggedIn);   // a returning customer unlocks with the PIN instead of logging in again
  const [st, setSt] = useState(() => ({
    guest: false, tab: 'rates', stack: [], navDir: 'fade', buyMetal: 'gold', qty: 1, lock: null, method: 'bank', paying: false, phone: '',
    rates: initialRates(), ledger: initialLedger(), orders: [], redemptions: [], dealerStock: initialDealerStock(),
    biometric: true, toast: null, lockNote: '', loginNote: '',
    profile: { name: 'Ahmed Khan', cnic: KYC_START === 'verified' ? '42000-0000000-1' : '', dob: KYC_START === 'verified' ? '1990-01-01' : '', email: '', address: '' },
    kyc: { status: KYC_START, at: KYC_START === 'verified' ? Date.now() - 20 * 86400e3 : null },
    pin: PIN_DEFAULT, pinFails: 0, pinLockUntil: 0,
    cart: [], cartBump: 0, checkout: [], checkoutFrom: 'now', simCreditFail: false,
    notifications: [], banner: null, notifPrefs: { push: true, sms: true, email: false },
    alerts: [], history: {},
    otpCfg: { checked: false, configured: false, channels: ['sms'] },
    loggedIn: false,
    ...(SAVED || {}),
    ...(START === 'home' ? { loggedIn: true } : {}),
    ...(KYC_START === 'verified' ? { kyc: { status: 'verified', at: Date.now() - 20 * 86400e3 }, profile: { ...((SAVED && SAVED.profile) || { name: 'Ahmed Khan', email: '', address: '' }), cnic: (SAVED && SAVED.profile && SAVED.profile.cnic) || '42000-0000000-1', dob: (SAVED && SAVED.profile && SAVED.profile.dob) || '1990-01-01' } } : {}),
  }));
  const [now, setNow] = useState(Date.now());
  const set = patch => setSt(s => ({ ...s, ...(typeof patch === 'function' ? patch(s) : patch) }));
  const lastActive = useRef(Date.now());
  const [mini, setMini] = useState(false);              // Liquid Glass tab bar shrinks while scrolling down
  const miniRef = useRef(false), lastY = useRef(0);
  const committed = useRef(new Set(st.orders.map(o => o.id)));       // idempotency (Rule 2 / NFR-1), survives refresh
  const receipts = useRef(new Set(st.orders.map(o => o.receipt)));
  const histLoading = useRef({});

  useEffect(() => { const t = setInterval(() => setNow(Date.now()), 1000); return () => clearInterval(t); }, []);

  // FR-A1: ask the server whether a real SMS / WhatsApp provider is connected
  // Demo mode only when the server explicitly answers configured:false; an unreachable server is an error, never a bypass.
  const checkOtp = () => { set({ otpCfg: { checked: false, configured: false, channels: ['sms'] } }); otpCall().then(d => set({ otpCfg: d.error === 'unreachable' || typeof d.configured !== 'boolean'
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
          if (alive) set(s => applyLive(s, d));
          return true;
        } catch (e) { }
      }
      return false;
    };
    poll().then(ok => { if (!ok && alive) set(s => (s.rates.mode === 'connecting' ? { rates: { ...s.rates, mode: 'sim', updatedAt: Date.now() }, toast: { msg: 'Live rates unavailable · showing simulated rates', id: Math.random() } } : {})); });
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

  const stale = st.rates.mode !== 'connecting' && now - st.rates.updatedAt > STALE_MS;
  const top = st.stack[st.stack.length - 1];

  function toast(msg) { set({ toast: { msg, id: Math.random() } }); }
  // FR-N1: every notice lands in the inbox; a push banner shows when push is on.
  function notify(kind, title, body) {
    const n = { id: uid() + uid(), ts: Date.now(), kind, title, body, read: false };
    set(s => ({ notifications: [n, ...s.notifications].slice(0, 60), banner: s.notifPrefs.push ? n : s.banner }));
  }

  // FR-B2: refresh locked prices at zero while on product, cart or pay
  useEffect(() => {
    if (st.lock && top && ['product', 'cart', 'pay'].includes(top.name) && now >= st.lock.expiresAt) {
      set(s => ({ lock: { prices: Object.fromEntries(Object.keys(s.lock.prices).map(pid => [pid, priceOf(P[pid], s.rates)])), expiresAt: Date.now() + LOCK_S * 1000 } }));
      toast('Price lock expired · refreshed to the latest rate');
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
    if (st.rates.mode === 'connecting') return;
    const fired = st.alerts.filter(a => a.active && (a.dir === 'above' ? st.rates[a.metal].buy >= a.target : st.rates[a.metal].buy <= a.target));
    if (!fired.length) return;
    set(s => ({ alerts: s.alerts.map(a => (fired.some(f => f.id === a.id) ? { ...a, active: false, firedAt: Date.now() } : a)) }));
    fired.forEach(a => notify('alert', `${metalName(a.metal)} is ${a.dir} ${fmt(a.target)}`, `Buy rate is now ${fmt(st.rates[a.metal].buy)} per tola.`));
  }, [st.rates.tick, st.rates.updatedAt, st.alerts.length]);

  useEffect(() => { saveState(st); }, KEEP.map(k => st[k]));

  useEffect(() => { if (!st.toast) return; const t = setTimeout(() => set({ toast: null }), 2800); return () => clearTimeout(t); }, [st.toast]);
  useEffect(() => { if (!st.banner) return; const t = setTimeout(() => set({ banner: null }), 3800); return () => clearTimeout(t); }, [st.banner]);

  // Derived wallet state from the ledger (FR-W3)
  const holdings = useMemo(() => { const h = {}; st.ledger.forEach(e => { h[e.pid] = (h[e.pid] || 0) + e.delta; }); return h; }, [st.ledger]);
  const statusOf = r => ((r.status === 'requested' || r.status === 'ready') && now > r.expiresAt ? 'expired' : r.status);
  const reserved = {}; st.redemptions.forEach(r => { const s = statusOf(r); if (s === 'requested' || s === 'ready') reserved[r.pid] = (reserved[r.pid] || 0) + r.units; });
  const walletValue = (() => { let gold = 0, silver = 0, goldG = 0, silverG = 0; PRODUCTS.forEach(p => { const n = holdings[p.id] || 0; if (!n) return; const v = n * p.grams * rateOf(st.rates, p.metal).sellGram;
    if (p.metal === 'gold') { gold += v; goldG += n * p.grams; } else { silver += v; silverG += n * p.grams; } }); return { gold, silver, goldG, silverG, total: gold + silver }; })();
  const spentToday = st.orders.filter(o => sameDay(o.ts, now)).reduce((a, o) => a + o.total, 0);
  const unread = st.notifications.filter(n => !n.read).length;

  const tabIndex = t => TABS.findIndex(x => x[0] === t);
  const lockFor = (s, pids) => ({ expiresAt: Date.now() + LOCK_S * 1000, prices: Object.fromEntries(pids.map(pid => [pid, priceOf(P[pid], s.rates)])) });
  const credit = (s, o) => [...s.ledger, ...o.lines.map(l => ({ id: 'L-' + uid(), ts: Date.now(), pid: l.pid, delta: l.units, reason: 'purchase', ref: o.receipt, price: l.unit }))];
  const A = {
    set, toast,
    tab: t => {
      if (st.guest && t !== 'rates') { A.login(); return; }
      set(s => ({ tab: t, stack: [], navDir: s.stack.length ? 'back' : tabIndex(t) > tabIndex(s.tab) ? 'fwd' : tabIndex(t) < tabIndex(s.tab) ? 'back' : 'fade' }));
    },
    push: r => { if (st.guest) { A.login(); return; } set(s => ({ stack: [...s.stack, r], navDir: 'fwd' })); },
    back: () => set(s => ({ stack: s.stack.slice(0, -1), navDir: 'back' })),
    login: () => { set({ stack: [], loginNote: '' }); setPhase('login'); },
    logout: () => { set({ stack: [], guest: false, tab: 'rates', loginNote: '', loggedIn: false }); setPhase('login'); },
    resetDemo: () => { clearSaved(); location.href = location.pathname; },
    lockNow: () => { set({ lockNote: 'App locked', stack: [] }); setPhase('pin'); },
    openHistory: metal => set(s => ({ stack: [...s.stack, { name: 'history', metal }], navDir: 'fwd' })),
    openProduct: pid => {
      if (st.guest) { A.login(); return; }
      const p = P[pid];
      set(s => ({ buyMetal: p.metal, qty: 1, navDir: 'fwd', stack: [...s.stack, { name: 'product', pid }], lock: lockFor(s, [pid]) }));
    },
    openCart: () => set(s => ({ navDir: 'fwd', stack: [...s.stack, { name: 'cart' }], lock: lockFor(s, s.cart.map(l => l.pid)) })),
    addToCart: (pid, units) => {
      const total = linesUnits(st.cart) + units;
      if (total > MAX_UNITS) { toast(`Per-order limit is ${MAX_UNITS} units (sample, FR-B6). Your cart has ${linesUnits(st.cart)}.`); return; }
      set(s => { const ex = s.cart.find(l => l.pid === pid); return { cartBump: s.cartBump + 1, cart: ex ? s.cart.map(l => (l.pid === pid ? { ...l, units: l.units + units } : l)) : [...s.cart, { pid, units }] }; });
      toast(`Added ${units} × ${pname(P[pid])} to cart`);
    },
    cartUnits: (pid, units) => set(s => ({ cart: units <= 0 ? s.cart.filter(l => l.pid !== pid) : s.cart.map(l => (l.pid === pid ? { ...l, units } : l)) })),
    checkout: from => {
      if (stale) return;
      const lines = from === 'cart' ? st.cart : [{ pid: top.pid, units: st.qty }];
      if (!lines.length) return;
      const total = linesTotal(lines, st.lock.prices);
      if (linesUnits(lines) > MAX_UNITS) { toast(`Per-order limit is ${MAX_UNITS} units (sample, FR-B6)`); return; }
      if (spentToday + total > DAY_LIMIT) { toast(`Daily limit: you can buy up to ${fmt(Math.max(0, DAY_LIMIT - spentToday))} more today (sample, FR-B6)`); return; }
      const orderKey = 'K' + uid() + uid();
      set(s => ({ checkout: lines, checkoutFrom: from, paying: false, navDir: 'fwd', stack: [...s.stack, s.kyc.status === 'verified' ? { name: 'pay', orderKey } : { name: 'kyc', next: 'pay', orderKey }] }));
    },
    pay: () => {
      if (stale || st.paying) return;
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
        if (fail) notify('purchase', 'Payment received, credit pending', `${rno} · ${fmt(total)}. PGBX operations is completing your order (FR-B5).`);
        else notify('purchase', 'Purchase confirmed', `${linesText(lines)} · ${fmt(total)} · ${rno}`);
      }, fail ? 5200 : 1800);
    },
    resolveOrder: id => {
      const o = st.orders.find(x => x.id === id); if (!o || o.status !== 'flagged') return;
      set(s => ({ orders: s.orders.map(x => (x.id === id ? { ...x, status: 'credited' } : x)), ledger: credit(s, o) }));
      notify('purchase', 'Order credited', `${linesText(o.lines)} is now in your wallet · ${o.receipt}`);
    },
    submitKyc: f => { set(s => ({ kyc: { ...s.kyc, status: 'pending', expiry: f.expiry }, profile: { ...s.profile, name: f.name.trim(), cnic: f.cnic, dob: f.dob } })); notify('account', 'Identity check submitted', 'We are checking your CNIC and selfie.'); },
    kycVerified: () => { set(s => ({ kyc: { ...s.kyc, status: 'verified', at: Date.now() } })); notify('account', 'Identity verified', 'You can now buy gold and silver (FR-A2).'); },
    kycFinish: next => set(s => {
      const k = s.stack[s.stack.length - 1];
      if (next === 'pay' && k && k.name === 'kyc') return { navDir: 'fwd', stack: [...s.stack.slice(0, -1), { name: 'pay', orderKey: k.orderKey }] };
      return { navDir: 'back', stack: s.stack.slice(0, -1) };
    }),
    saveProfile: f => {
      const idChanged = ['name', 'cnic', 'dob'].some(k => (f[k] || '') !== (st.profile[k] || ''));
      const reverify = idChanged && st.kyc.status === 'verified';
      set(s => ({ profile: { ...f, name: f.name.trim() }, kyc: reverify ? { ...s.kyc, status: 'reverify' } : s.kyc, navDir: 'back', stack: s.stack.slice(0, -1) }));
      notify('account', reverify ? 'Identity details changed' : 'Profile updated', reverify ? 'Re-verify your identity before your next purchase (FR-N2).' : 'Your contact details were saved.');
    },
    changePhone: n => { set({ phone: n }); notify('security', 'Mobile number changed', `Your account now uses +92 ${n.slice(0, 3)} ${n.slice(3)}. If this wasn’t you, contact PGBX.`); },
    setPin: p => { set({ pin: p }); notify('security', 'PIN changed', 'Your app PIN was changed on this device.'); },
    markAllRead: () => set(s => ({ notifications: s.notifications.map(n => ({ ...n, read: true })) })),
    addAlert: (metal, dir, target) => { set(s => ({ alerts: [...s.alerts, { id: uid(), metal, dir, target, active: true }] })); toast(`Alert set: ${metalName(metal)} ${dir} ${fmt(target)}`); },
    removeAlert: id => set(s => ({ alerts: s.alerts.filter(a => a.id !== id) })),
    loadHistory: async (metal, range) => {
      const key = metal + ':' + range; const h = st.history[key];
      if ((h && h.points && Date.now() - h.at < 120e3) || histLoading.current[key]) return;
      histLoading.current[key] = true;
      set(s => ({ history: { ...s.history, [key]: { ...(s.history[key] || {}), error: false } } }));
      let got = null;
      for (const b of API_BASES) {
        try { const r = await fetch(`${b}/api/history?metal=${metal}&range=${range}`); if (!r.ok) continue; const d = await r.json(); if (d.ok && d.points && d.points.length > 1) { got = d; break; } } catch (e) { }
      }
      histLoading.current[key] = false;
      set(s => ({ history: { ...s.history, [key]: got ? { points: got.points, source: got.source, usdPkr: got.usdPkr, at: Date.now() } : { error: true } } }));
    },
    redeem: (pid, units, dealerId) => {
      const used = new Set(st.redemptions.map(r => r.code)); let code;
      do { code = String(Math.floor(100000 + Math.random() * 900000)); } while (used.has(code));
      const r = { id: 'RD-' + uid(), pid, units, dealerId, code, createdAt: Date.now(), expiresAt: Date.now() + RESERVE_MS, status: 'requested' };
      const d = DEALERS.find(x => x.id === dealerId);
      set(s => ({ redemptions: [...s.redemptions, r], navDir: 'fwd', stack: [...s.stack, { name: 'code', rid: r.id }] }));
      notify('redemption', 'Redemption requested', `${units} × ${pname(P[pid])} reserved at ${d.name}. Code ${code}, valid 24 hours.`);
    },
    cancelRedemption: id => { const r = st.redemptions.find(x => x.id === id); set(s => ({ redemptions: s.redemptions.map(x => (x.id === id ? { ...x, status: 'cancelled' } : x)) })); notify('redemption', 'Redemption cancelled', `${r.units} × ${pname(P[r.pid])} returned to your wallet.`); },
    markReady: id => { const r = st.redemptions.find(x => x.id === id); set(s => ({ redemptions: s.redemptions.map(x => (x.id === id && x.status === 'requested' ? { ...x, status: 'ready' } : x)) })); notify('redemption', 'Ready for collection', `${pname(P[r.pid])} is ready at ${DEALERS.find(d => d.id === r.dealerId).name}. Bring your CNIC.`); },
    handOver: id => {
      const r = st.redemptions.find(x => x.id === id);
      if (!r || r.status !== 'ready') return;            // a code works once (Rule 5)
      const p = P[r.pid]; const d = DEALERS.find(x => x.id === r.dealerId);
      const serials = Array.from({ length: r.units }, () => `PGBX-${p.metal === 'gold' ? 'AU' : 'AG'}-${Math.floor(100000 + Math.random() * 900000)}`);
      set(s => ({
        redemptions: s.redemptions.map(x => (x.id === id ? { ...x, status: 'completed', completedAt: Date.now(), serials } : x)),
        ledger: [...s.ledger, { id: 'L-' + uid(), ts: Date.now(), pid: r.pid, delta: -r.units, reason: 'redemption', ref: r.id, dealer: d.name, serials }],
        dealerStock: { ...s.dealerStock, [d.id]: { ...s.dealerStock[d.id], [r.pid]: s.dealerStock[d.id][r.pid] - r.units } },
      }));
      notify('redemption', 'Collected', `${r.units} × ${pname(p)} handed over at ${d.name}. Serial ${serials.join(', ')}.`);
    },
  };

  const S = { ...st, now, stale, holdings, reserved, walletValue, statusOf, spentToday, unread };
  const framed = window.innerWidth > 500;
  const enterApp = () => { lastActive.current = Date.now(); set({ guest: false, lockNote: '', loginNote: '', navDir: 'fade', pinFails: 0, pinLockUntil: 0, loggedIn: true }); setPhase('app'); };
  const browse = () => { set({ guest: true, tab: 'rates', stack: [], lockNote: '', navDir: 'fade' }); setPhase('app'); };
  const pinFail = () => {
    const f = st.pinFails + 1;
    if (f >= PIN_MAX_FAILS) {
      set({ pinFails: 0, pinLockUntil: 0, stack: [], loggedIn: false, loginNote: `${PIN_MAX_FAILS} wrong PINs. For your security, log in again with your mobile number (FR-A4).` });
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
    else if (n === 'receipt') content = html`<${Receipt} S=${S} A=${A} oid=${top.oid}/>`;
    else if (n === 'code') content = html`<${CodeScreen} S=${S} A=${A} rid=${top.rid}/>`;
    else if (n === 'info') content = html`<${InfoScreen} S=${S} A=${A} kind=${top.kind}/>`;
    else if (n === 'changepin') content = html`<${ChangePin} S=${S} A=${A}/>`;
    else if (n === 'history') content = html`<${HistoryScreen} S=${S} A=${A} metal=${top.metal}/>`;
    else if (n === 'kyc') content = html`<${KycScreen} S=${S} A=${A} next=${top.next}/>`;
    else if (n === 'profile') content = html`<${ProfileScreen} S=${S} A=${A}/>`;
    else if (n === 'inbox') content = html`<${InboxScreen} S=${S} A=${A}/>`;
    else if (n === 'statement') content = html`<${StatementScreen} S=${S} A=${A}/>`;
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
  const tabIdx = tabIndex(st.tab);
  const hideTabs = top && ['processing', 'changepin', 'kyc'].includes(top.name);
  const enterCls = st.navDir === 'fwd' ? 'enter-fwd' : st.navDir === 'back' ? 'enter-back' : 'enter';
  useEffect(() => { lastY.current = 0; miniRef.current = false; setMini(false); }, [routeKey]);

  const active = () => { lastActive.current = Date.now(); };
  const onScroll = e => {
    active();
    const t = e.target; if (!t || !t.classList || !t.classList.contains('scroll')) return;
    const y = t.scrollTop, d = y - lastY.current; lastY.current = y;
    const m = y > 80 && d > 2 ? true : (d < -6 || y < 24) ? false : null;
    if (m !== null && m !== miniRef.current) { miniRef.current = m; setMini(m); }
  };
  const spec = e => { const r = e.currentTarget.getBoundingClientRect(); e.currentTarget.style.setProperty('--hx', `${(e.clientX - r.left) - r.width * 0.17}px`); };
  return html`<div class="device" onPointerDown=${active} onKeyDown=${active} onWheel=${active} onTouchMove=${active} onScrollCapture=${onScroll} onInput=${active}>
    <div class="device-inner">
      <${StatusBar} light=${darkTop} />
      ${phase === 'splash' && html`<${Splash} rates=${st.rates} quick=${returning} onDone=${() => { if (returning) set({ lockNote: 'Welcome back' }); setPhase(returning ? 'pin' : 'login'); }} />`}
      ${phase === 'login' && html`<${Login} S=${S} note=${st.loginNote} onRetry=${checkOtp} onDone=${phone => {
        set({ phone }); enterApp();
        notify('security', 'New login on this device', `Logged in with +92 ${phone.slice(0, 3)} ${phone.slice(3)}. If this wasn’t you, contact PGBX.`);
      }} onBrowse=${browse} onPin=${() => setPhase('pin')} />`}
      ${phase === 'pin' && html`<${LockScreen} pin=${st.pin} fails=${st.pinFails} lockUntil=${st.pinLockUntil} now=${now} biometric=${st.biometric} note=${st.lockNote}
          onUnlock=${enterApp} onFail=${pinFail} onBrowse=${browse} onLogin=${() => { set({ lockNote: '', loginNote: '' }); setPhase('login'); }} />`}
      ${phase === 'app' && html`<div class=${'app' + (framed ? ' framed' : '')}>
        <div class="view"><div class=${enterCls} key=${routeKey} style="position:absolute;inset:0">${content}</div></div>
        ${!hideTabs && html`<nav class=${'tabbar glass' + (mini ? ' mini' : '')} aria-label="Main" onPointerMove=${spec}><span class="spec"></span><div class="tabs">
          <div class="pill-track" style=${{ transform: `translateX(${tabIdx * 100}%)` }}><div class="pill" key=${'p' + tabIdx}></div></div>
          ${TABS.map(([k, l]) => html`<button class=${'tab' + (st.tab === k ? ' on' : '')} onClick=${() => A.tab(k)} aria-current=${st.tab === k ? 'page' : null}>
            <${Icon} n=${k}/>${l}${st.guest && k !== 'rates' ? html`<span style="position:absolute;top:6px;right:calc(50% - 18px);opacity:.6"><${Icon} n="lock" c="xs"/></span>` : ''}</button>`)}
        </div></nav>`}
        ${st.banner && html`<${PushBanner} n=${st.banner} onOpen=${() => set(s => ({ banner: null, stack: [...s.stack, { name: 'inbox' }], navDir: 'fwd' }))} />`}
        ${st.toast && html`<div class="toast glass" key=${st.toast.id} role="status"><${Icon} n="info" c="sm"/>${st.toast.msg}</div>`}
      </div>`}
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
  return html`<div class="device"><div class="device-inner"><div class="lock" style="justify-content:center;text-align:center;gap:6px">
    <${Coin} size=${96} still=${true} />
    <h2>Something went wrong</h2>
    <p class="proto" style="max-width:280px;line-height:1.5">The app hit a problem loading your demo data. You can try again, or reset the demo to start fresh.</p>
    <div style="display:grid;gap:10px;width:100%;max-width:300px;margin-top:14px">
      <button class="btn btn-gold" onClick=${() => location.reload()}>Try again</button>
      <button class="btn btn-ghost" onClick=${() => { clearSaved(); location.href = location.pathname; }}>Reset demo data</button>
    </div>
  </div></div></div>`;
}
function Root() {
  const [error] = useErrorBoundary(e => { try { console.error('PGBX app error:', e); } catch (x) { } });
  return error ? html`<${CrashScreen}/>` : html`<${App}/>`;
}
render(html`<${Root}/>`, document.getElementById('root'));
