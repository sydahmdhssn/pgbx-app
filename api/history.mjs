// GET /api/history?metal=gold|silver&range=day|week|month
// Rate history for the chart (FR-R5), in PKR per tola, set on the server (Rule 1, FR-R3).
// Sources (free, no key):
//   Yahoo Finance chart API, COMEX futures GC=F (gold) and SI=F (silver), USD per troy ounce
//   fallback (week/month only): Stooq daily CSV for XAUUSD / XAGUSD
// Prices are converted at the current USD/PKR rate from open.er-api.com.

import { allowOrigin } from './_origin.mjs';

const TOLA_G = 11.664;
const OZ_G = 31.1034768;
const RANGES = {
  day: { range: '1d', interval: '5m' },
  week: { range: '5d', interval: '30m' },
  month: { range: '1mo', interval: '1d' },
};
const YAHOO = { gold: 'GC=F', silver: 'SI=F' };
const STOOQ = { gold: 'xauusd', silver: 'xagusd' };

let fxCache = null;

async function fetchWithTimeout(url, ms = 5000) {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), ms);
  try {
    const r = await fetch(url, { signal: ctl.signal, headers: { 'user-agent': 'Mozilla/5.0 (PGBX prototype)', accept: '*/*' } });
    if (!r.ok) throw new Error(`${new URL(url).host} HTTP ${r.status}`);
    return r;
  } finally {
    clearTimeout(t);
  }
}

async function usdPkr() {
  if (fxCache && Date.now() - fxCache.at < 30 * 60e3) return fxCache.rate;
  const d = await (await fetchWithTimeout('https://open.er-api.com/v6/latest/USD')).json();
  const rate = Number(d.rates && d.rates.PKR);
  if (!(rate > 0)) throw new Error('open.er-api: no PKR');
  fxCache = { rate, at: Date.now() };
  return rate;
}

async function yahoo(metal, range) {
  const { range: r, interval } = RANGES[range];
  const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(YAHOO[metal])}?range=${r}&interval=${interval}`;
  const d = await (await fetchWithTimeout(url)).json();
  const res = d && d.chart && d.chart.result && d.chart.result[0];
  if (!res || !res.timestamp) throw new Error('yahoo: no data');
  const closes = res.indicators.quote[0].close;
  const pts = res.timestamp.map((t, i) => [t * 1000, closes[i]]).filter(p => p[1] > 0);
  if (pts.length < 2) throw new Error('yahoo: too few points');
  return { pts, source: `COMEX ${YAHOO[metal]} futures via Yahoo Finance` };
}

async function stooq(metal, range) {
  if (range === 'day') throw new Error('stooq: no intraday');
  const csv = await (await fetchWithTimeout(`https://stooq.com/q/d/l/?s=${STOOQ[metal]}&i=d`)).text();
  const rows = csv.trim().split('\n').slice(1).map(l => l.split(','));
  const pts = rows.map(r => [Date.parse(r[0] + 'T00:00:00Z'), Number(r[4])]).filter(p => p[0] && p[1] > 0);
  const days = range === 'week' ? 7 : 31;
  const cut = Date.now() - days * 86400e3;
  const out = pts.filter(p => p[0] >= cut);
  if (out.length < 2) throw new Error('stooq: too few points');
  return { pts: out, source: `Stooq ${STOOQ[metal].toUpperCase()} daily` };
}

export default async function handler(req, res) {
  allowOrigin(req, res);
  if (req.method === 'OPTIONS') { res.statusCode = 204; res.end(); return; }
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  const q = new URL(req.url, 'http://x').searchParams;
  const metal = q.get('metal') === 'silver' ? 'silver' : 'gold';
  const range = RANGES[q.get('range')] ? q.get('range') : 'day';
  const warnings = [];
  try {
    const rate = await usdPkr();
    let h = null;
    for (const f of [yahoo, stooq]) {
      try { h = await f(metal, range); break; } catch (e) { warnings.push(String(e.message || e)); }
    }
    if (!h) throw new Error('No history source available');
    const points = h.pts.map(([t, usd]) => [t, Math.round((usd / OZ_G) * TOLA_G * rate)]);
    res.setHeader('Cache-Control', `public, s-maxage=${range === 'day' ? 120 : 1800}, stale-while-revalidate=600`);
    res.statusCode = 200;
    res.end(JSON.stringify({ ok: true, metal, range, unit: 'PKR per tola', usdPkr: rate, source: h.source, points, warnings }));
  } catch (e) {
    res.setHeader('Cache-Control', 'no-store');
    res.statusCode = 502;
    res.end(JSON.stringify({ ok: false, error: String(e.message || e), warnings }));
  }
}
