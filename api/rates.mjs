// GET /api/rates: live gold and silver prices for the PGBX prototype.
//
// Rule 1 / FR-R3: the server sets every price; the app only displays it.
// Sources (free, no key):
//   metals  https://api.gold-api.com/price/{XAU|XAG|XPT|XPD|HG}  (USD spot)
//           fallback for gold/silver: https://data-asg.goldprice.org/dbXRates/USD
//   USD/PKR https://open.er-api.com/v6/latest/USD
//           fallback: @fawazahmed0/currency-api via jsDelivr
// Spreads and product premiums below are SAMPLE values until PGBX sets them (FR-M1, FR-M2).

const TOLA_G = 11.664;
const OZ_G = 31.1034768;
const SPREAD = { gold: 0.012, silver: 0.025 };

// The eleven online products (SRS section 3). Premiums are sample values.
const PRODUCTS = [
  ['g-10mg', 'gold', 0.01, 120], ['g-20mg', 'gold', 0.02, 160], ['g-50mg', 'gold', 0.05, 250],
  ['g-100mg', 'gold', 0.1, 350], ['g-500mg', 'gold', 0.5, 800], ['g-1g', 'gold', 1, 1200], ['g-5g', 'gold', 5, 3500],
  ['s-1t', 'silver', TOLA_G, 350], ['s-3t', 'silver', 3 * TOLA_G, 800], ['s-5t', 'silver', 5 * TOLA_G, 1200], ['s-10t', 'silver', 10 * TOLA_G, 2000],
];

const WORLD = [
  ['XAU', 'Gold', 'oz'], ['XAG', 'Silver', 'oz'], ['XPT', 'Platinum', 'oz'], ['XPD', 'Palladium', 'oz'], ['HG', 'Copper', 'lb'],
];

let fxCache = null; // USD/PKR moves slowly; keep it for 30 minutes per instance

async function getJson(url, ms = 4500) {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), ms);
  try {
    const r = await fetch(url, { signal: ctl.signal, headers: { accept: 'application/json', 'user-agent': 'Mozilla/5.0 (PGBX prototype)' } });
    if (!r.ok) throw new Error(`${new URL(url).host} HTTP ${r.status}`);
    return await r.json();
  } finally {
    clearTimeout(t);
  }
}

async function goldApi(symbol) {
  const d = await getJson(`https://api.gold-api.com/price/${symbol}`);
  const usd = Number(d.price);
  if (!(usd > 0)) throw new Error(`gold-api ${symbol}: no price`);
  return { usd, updatedAt: d.updatedAt || null, source: 'gold-api.com' };
}

async function goldPriceOrg() {
  const d = await getJson('https://data-asg.goldprice.org/dbXRates/USD');
  const it = d && d.items && d.items[0];
  if (!it || !(it.xauPrice > 0) || !(it.xagPrice > 0)) throw new Error('goldprice.org: no price');
  const updatedAt = d.ts ? new Date(d.ts).toISOString() : null;
  return { XAU: { usd: it.xauPrice, updatedAt, source: 'goldprice.org' }, XAG: { usd: it.xagPrice, updatedAt, source: 'goldprice.org' } };
}

async function usdPkr() {
  if (fxCache && Date.now() - fxCache.at < 30 * 60e3) return fxCache;
  try {
    const d = await getJson('https://open.er-api.com/v6/latest/USD');
    const rate = Number(d.rates && d.rates.PKR);
    if (!(rate > 0)) throw new Error('open.er-api: no PKR');
    fxCache = { rate, updatedAt: d.time_last_update_utc || null, source: 'open.er-api.com', at: Date.now() };
  } catch (e) {
    const d = await getJson('https://cdn.jsdelivr.net/npm/@fawazahmed0/currency-api@latest/v1/currencies/usd.json');
    const rate = Number(d.usd && d.usd.pkr);
    if (!(rate > 0)) throw new Error('currency-api: no PKR');
    fxCache = { rate, updatedAt: d.date || null, source: 'fawazahmed0/currency-api', at: Date.now() };
  }
  return fxCache;
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  const warnings = [];

  const [fxR, ...worldR] = await Promise.allSettled([usdPkr(), ...WORLD.map(([s]) => goldApi(s))]);
  const spot = {};
  WORLD.forEach(([s], i) => {
    if (worldR[i].status === 'fulfilled') spot[s] = worldR[i].value;
    else warnings.push(String(worldR[i].reason && worldR[i].reason.message || worldR[i].reason));
  });
  if (!spot.XAU || !spot.XAG) {
    try {
      const fb = await goldPriceOrg();
      spot.XAU = spot.XAU || fb.XAU;
      spot.XAG = spot.XAG || fb.XAG;
    } catch (e) { warnings.push(String(e.message || e)); }
  }
  if (fxR.status !== 'fulfilled') warnings.push(String(fxR.reason && fxR.reason.message || fxR.reason));

  if (!spot.XAU || !spot.XAG || fxR.status !== 'fulfilled') {
    res.setHeader('Cache-Control', 'no-store');
    res.statusCode = 502;
    res.end(JSON.stringify({ ok: false, error: 'Live rate sources unavailable', warnings }));
    return;
  }

  const fx = fxR.value;
  const metal = (sym, key) => {
    const buyGram = (spot[sym].usd / OZ_G) * fx.rate;
    const sellGram = buyGram * (1 - SPREAD[key]);
    return {
      usdPerOz: spot[sym].usd,
      buyTola: Math.round(buyGram * TOLA_G), sellTola: Math.round(sellGram * TOLA_G),
      buyGram: Math.round(buyGram * 100) / 100, sellGram: Math.round(sellGram * 100) / 100,
      sourceUpdatedAt: spot[sym].updatedAt, source: spot[sym].source,
    };
  };
  const metals = { gold: metal('XAU', 'gold'), silver: metal('XAG', 'silver') };
  const products = Object.fromEntries(PRODUCTS.map(([id, m, grams, premium]) => [id, Math.round(metals[m].buyGram * grams + premium)]));

  res.setHeader('Cache-Control', 'public, s-maxage=8, stale-while-revalidate=30');
  res.statusCode = 200;
  res.end(JSON.stringify({
    ok: true,
    fetchedAt: new Date().toISOString(),
    usdPkr: { rate: fx.rate, updatedAt: fx.updatedAt, source: fx.source },
    metals,
    products,
    world: WORLD.filter(([s]) => spot[s]).map(([s, name, unit]) => ({ symbol: s, name, unit, usd: spot[s].usd, updatedAt: spot[s].updatedAt, source: spot[s].source })),
    spread: SPREAD,
    notes: 'International spot converted at USD/PKR. Spread and premiums are sample values. Local Sarafa rates may differ.',
    warnings,
  }));
}
