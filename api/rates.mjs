// GET /api/rates: live gold and silver prices for the PGBX app (display only).
// Rule 1 / FR-R3: the server sets every price; the app only displays it. Buying uses the API's own price lock.
// The fetching logic lives in server/rates.mjs.
import { allowOrigin } from './_origin.mjs';
import { fetchLiveRates } from '../server/rates.mjs';

export default async function handler(req, res) {
  allowOrigin(req, res);
  if (req.method === 'OPTIONS') { res.statusCode = 204; res.end(); return; }
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  const d = await fetchLiveRates();
  if (!d.ok) { res.setHeader('Cache-Control', 'no-store'); res.statusCode = 502; res.end(JSON.stringify(d)); return; }
  res.setHeader('Cache-Control', 'public, s-maxage=8, stale-while-revalidate=10');
  res.statusCode = 200;
  res.end(JSON.stringify(d));
}
