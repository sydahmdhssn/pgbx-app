import { handle } from '../server/api.mjs';

// /api/v1/*: the PGBX back end (customers, dealers, admin). Routes and rules: server/api.mjs.
// Needs DATABASE_URL; until it is set every route except /api/v1/config answers 503 "not connected".
export default function handler(req, res) {
  return handle(req, res);
}
