// In-memory PostgreSQL (PGlite) with the full schema, for tests and `npm run dev`. Kept apart from db.mjs so the
// production functions never bundle it.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { wrap } from './db.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const INT8 = 20;

// TEST_POSTGRES_URL (npm run test:pg): each test gets a fresh database on a real PostgreSQL server instead, through the
// production adapter, so concurrency and parameter encoding are tested the way they run in production.
let template = null, made = 0;
async function realDb(url, seed) {
  const { default: postgres } = await import('postgres');
  const { connectPostgres } = await import('./db.mjs');
  const admin = postgres(url, { onnotice: () => {}, max: 1 });
  try {
    const tpl = `pgbx_test_tpl_${process.pid}_${seed ? 's' : 'n'}`;
    if (!template || template.name !== tpl) {
      await admin.unsafe(`drop database if exists ${tpl}`); await admin.unsafe(`create database ${tpl}`);
      const t = postgres(url.replace(/\/[^/?]*(\?|$)/, `/${tpl}$1`), { onnotice: () => {}, max: 1 });
      const dir = path.join(ROOT, 'supabase', 'migrations');
      for (const f of fs.readdirSync(dir).filter(f => f.endsWith('.sql')).sort()) await t.unsafe(fs.readFileSync(path.join(dir, f), 'utf8'));
      if (seed) await t.unsafe(fs.readFileSync(path.join(ROOT, 'supabase', 'seed.sql'), 'utf8'));
      await t.end(); template = { name: tpl };
    }
    const name = `pgbx_test_${process.pid}_${++made}`;
    await admin.unsafe(`drop database if exists ${name}`); await admin.unsafe(`create database ${name} template ${tpl}`);
    return connectPostgres(url.replace(/\/[^/?]*(\?|$)/, `/${name}$1`));
  } finally { await admin.end(); }
}

export async function createMemoryDb({ seed = true } = {}) {
  if (process.env.TEST_POSTGRES_URL) return realDb(process.env.TEST_POSTGRES_URL, seed);
  const { PGlite } = await import('@electric-sql/pglite');
  const pg = new PGlite({ parsers: { [INT8]: v => Number(v) } });
  const dir = path.join(ROOT, 'supabase', 'migrations');
  for (const f of fs.readdirSync(dir).filter(f => f.endsWith('.sql')).sort()) await pg.exec(fs.readFileSync(path.join(dir, f), 'utf8'));
  if (seed) await pg.exec(fs.readFileSync(path.join(ROOT, 'supabase', 'seed.sql'), 'utf8'));
  return wrap(async (text, params) => (await pg.query(text, params.map(p => (p !== null && typeof p === 'object' && !Array.isArray(p) ? JSON.stringify(p) : p)))).rows, () => pg.close());
}
