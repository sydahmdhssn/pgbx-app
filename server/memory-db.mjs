// In-memory PostgreSQL (PGlite) with the full schema, for tests and `npm run dev`. Kept apart from db.mjs so the
// production functions never bundle it.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { wrap } from './db.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const INT8 = 20;

export async function createMemoryDb({ seed = true } = {}) {
  const { PGlite } = await import('@electric-sql/pglite');
  const pg = new PGlite({ parsers: { [INT8]: v => Number(v) } });
  const dir = path.join(ROOT, 'supabase', 'migrations');
  for (const f of fs.readdirSync(dir).filter(f => f.endsWith('.sql')).sort()) await pg.exec(fs.readFileSync(path.join(dir, f), 'utf8'));
  if (seed) await pg.exec(fs.readFileSync(path.join(ROOT, 'supabase', 'seed.sql'), 'utf8'));
  return wrap(async (text, params) => (await pg.query(text, params.map(p => (p !== null && typeof p === 'object' && !Array.isArray(p) ? JSON.stringify(p) : p)))).rows, () => pg.close());
}
