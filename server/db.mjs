// Database access for the API. One small interface, two engines:
//   production  -> PostgreSQL via DATABASE_URL (Supabase: use the pooled connection string, port 6543)
//   tests / dev -> PGlite (PostgreSQL compiled to WebAssembly, in memory): server/memory-db.mjs
// Business rules live in SQL functions (supabase/migrations), so both engines behave the same.
const INT8 = 20, JSON_OID = 114, JSONB_OID = 3802;
const asJson = v => (typeof v === 'string' ? v : JSON.stringify(v));

// Wraps an engine as { query(text, params) -> rows, one(text, params) -> row | null }
export function wrap(run, close) {
  const query = async (text, params = []) => run(text, params);
  return { query, one: async (text, params) => (await query(text, params))[0] || null, close };
}

let shared = null;
export function getDb() {
  if (shared) return shared;
  const url = process.env.DATABASE_URL;
  if (!url) return null;                                     // not connected yet: the API reports live: false
  return (shared = connectPostgres(url));
}

export async function connectPostgres(url) {
  const { default: postgres } = await import('postgres');
  const sql = postgres(url, {
    max: 3, idle_timeout: 20, connect_timeout: 10, prepare: false,  // prepare:false for Supabase's transaction pooler
    connection: { statement_timeout: 10000 },                // no query may hold a connection for more than 10 s
    ssl: /localhost|127\.0\.0\.1/.test(url) ? false : 'require',
    // Parameters go to postgres.js as they are: arrays stay arrays (for any($1::uuid[]) and the like) and objects are
    // sent as JSON. Text that is already JSON passes through unchanged instead of being encoded a second time.
    types: {
      bigint: { to: INT8, from: [INT8], serialize: String, parse: Number },
      json: { to: JSON_OID, from: [JSON_OID], serialize: asJson, parse: JSON.parse },
      jsonb: { to: JSONB_OID, from: [JSONB_OID], serialize: asJson, parse: JSON.parse },
    },
  });
  return wrap((text, params) => sql.unsafe(text, params), () => sql.end());
}
