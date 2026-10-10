// Launch check: run before going live (and before each store submission) against the production settings.
//
//   vercel env pull .env.production --environment=production      (or put the values in a file another way)
//   node --env-file=.env.production scripts/launch-check.mjs
//
// It reads the settings and, when DATABASE_URL is set, the database (read-only), and lists what is ready, what needs
// attention, and what blocks launch. Exit code 1 when anything blocks launch. Secrets are never printed.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const env = k => (process.env[k] || '').trim();
const out = { block: [], warn: [], ok: [] };
const block = m => out.block.push(m), warn = m => out.warn.push(m), ok = m => out.ok.push(m);
const config = JSON.parse(fs.readFileSync(path.join(ROOT, 'app.config.json'), 'utf8'));

// ---------- settings (Vercel environment variables) ----------
if (env('VERCEL_ENV') && env('VERCEL_ENV') !== 'production') warn(`These settings are for "${env('VERCEL_ENV')}", not production.`);
if (!env('DATABASE_URL')) block('DATABASE_URL is not set: the app has no database.');
else if (!/:6543\//.test(env('DATABASE_URL'))) warn('DATABASE_URL does not use port 6543. On Supabase use the pooled (transaction) connection string.');
else ok('Database connection string is set (pooled).');
const twilio = ['TWILIO_ACCOUNT_SID', 'TWILIO_AUTH_TOKEN', 'TWILIO_VERIFY_SERVICE_SID'].filter(k => !env(k));
if (twilio.length) block('SMS login codes are not set up (missing ' + twilio.join(', ') + '): nobody can log in.');
else ok('SMS login codes (Twilio Verify) are set up.');
if (env('OTP_TEST_MODE') === '1') block('OTP_TEST_MODE=1: the code 123456 would log anyone in. Remove it.');
if (env('ALLOW_SANDBOX') === '1') block('ALLOW_SANDBOX=1: test payments and identity checks would be allowed. Remove it.');
if (!env('PAYMENT_PROVIDER')) block('No payment provider (PAYMENT_PROVIDER): customers can’t pay.');
else if (env('PAYMENT_PROVIDER') === 'sandbox') block('PAYMENT_PROVIDER=sandbox: payments are simulated.');
else if (!env('PAYMENT_WEBHOOK_SECRET')) block('PAYMENT_WEBHOOK_SECRET is missing: payment confirmations can’t be verified.');
else ok(`Payment provider ${env('PAYMENT_PROVIDER')} with a signed webhook.`);
if (!env('KYC_PROVIDER')) block('No identity check provider (KYC_PROVIDER): nobody can be verified to buy.');
else if (env('KYC_PROVIDER') === 'sandbox') block('KYC_PROVIDER=sandbox: every identity check passes automatically.');
else if (!env('KYC_WEBHOOK_SECRET')) block('KYC_WEBHOOK_SECRET is missing: identity results can’t be verified.');
else ok(`Identity checks through ${env('KYC_PROVIDER')}.`);
if (!env('CRON_SECRET')) block('CRON_SECRET is missing: the scheduled sweep (expiries, reminders, purge) is refused.');
else ok('Scheduled sweep is protected.');
if (!env('FCM_SERVICE_ACCOUNT')) warn('FCM_SERVICE_ACCOUNT is missing: notifications stay inside the app (no phone notifications).');
else { try { const j = JSON.parse(env('FCM_SERVICE_ACCOUNT')); j.project_id && j.private_key ? ok('Push notifications (Firebase) are set up.') : warn('FCM_SERVICE_ACCOUNT is not a service account file.'); } catch { warn('FCM_SERVICE_ACCOUNT is not valid JSON.'); } }
if (!env('TURNSTILE_SECRET')) warn('Cloudflare human check is off (TURNSTILE_*): bots can request login codes (each costs an SMS).');
if (env('OTP_DEMO_SMS') === '1') warn('OTP_DEMO_SMS=1: the public demo can send real SMS codes.');
if (env('REVIEW_LOGIN')) warn('REVIEW_LOGIN is on: the store-review number can log in without SMS. Remove it once the review is approved.');
if (env('SITE_PASSWORD')) warn('SITE_PASSWORD is set: the whole site, including the production web app, is behind the password screen.');

// ---------- app identity and the files that go to the stores ----------
if (config.appId === 'pk.com.pgbx.app') warn('app.config.json still has the placeholder app ID pk.com.pgbx.app. It can’t change after the first store upload.');
if (/vercel\.app$/.test(config.apiOrigin)) warn(`The app talks to ${config.apiOrigin}. Use PGBX’s own domain before release.`);
const vj = fs.readFileSync(path.join(ROOT, 'vercel.json'), 'utf8');
if (!vj.includes(`connect-src 'self' ${config.apiOrigin}`)) block('vercel.json doesn’t match app.config.json: run npm run build:app.');
const robots = fs.readFileSync(path.join(ROOT, 'robots.txt'), 'utf8');
if (/Disallow:\s*\/live/.test(robots)) warn('robots.txt hides the production app (/live) from search engines.');
if (!fs.existsSync(path.join(ROOT, 'mobile', 'android', 'app', 'google-services.json'))) warn('Android: google-services.json is missing (push stays off in the Android app).');
if (!fs.existsSync(path.join(ROOT, 'mobile', 'ios', 'App', 'App', 'GoogleService-Info.plist'))) warn('iOS: GoogleService-Info.plist is missing (push stays off in the iOS app).');
for (const f of ['legal/privacy.html', 'legal/terms.html']) {
  const p = path.join(ROOT, f);
  if (!fs.existsSync(p)) block(`${f} is missing: both stores need a privacy policy, and customers must be shown the terms.`);
  else if (/DRAFT/.test(fs.readFileSync(p, 'utf8'))) warn(`${f} is still marked DRAFT: have it reviewed by PGBX’s lawyer, then remove the draft notice.`);
}

// ---------- database (read-only) ----------
if (env('DATABASE_URL')) {
  const { connectPostgres } = await import('../server/db.mjs');
  let db;
  try {
    db = await connectPostgres(env('DATABASE_URL'));
    const one = (q, p) => db.one(q, p);
    const migrated = await one(`select exists (select 1 from pg_trigger where tgname = 'ledger_not_negative') ok`);
    if (!migrated.ok) block('The database is missing the latest migrations (supabase/migrations). Apply them in order.');
    else ok('Database migrations are up to date.');
    const sampleStaff = await db.query(`select email from staff where email like '%@pgbx.test' and active`);
    if (sampleStaff.length) block('Sample staff accounts exist: ' + sampleStaff.map(r => r.email).join(', ') + '. Deactivate them.');
    const admins = await one(`select count(*)::int n from staff where role = 'admin' and active`);
    if (!admins.n) block('No active admin account.');
    else ok(`${admins.n} active admin account(s).`);
    const sampleDealers = await db.query(`select id, name from dealers where address = 'Sample address' and active`);
    if (sampleDealers.length) block('Sample dealers are listed: ' + sampleDealers.map(d => d.name).join(', ') + '. Replace them with PGBX’s real dealers.');
    const dealers = await one(`select count(*)::int n from dealers where active`);
    if (!dealers.n) block('No active dealers: nobody can collect bars.');
    const seedPremiums = { 'g-10mg': 120, 'g-20mg': 160, 'g-50mg': 250, 'g-100mg': 350, 'g-500mg': 800, 'g-1g': 1200, 'g-5g': 3500, 's-1t': 350, 's-3t': 800, 's-5t': 1200, 's-10t': 2000 };
    const products = await db.query(`select id, premium_pkr from products`);
    if (products.length && products.every(p => seedPremiums[p.id] === Number(p.premium_pkr))) warn('Product premiums are still the sample values. Set PGBX’s real premiums in Admin › Products.');
    const s = Object.fromEntries((await db.query(`select key, value from settings`)).map(r => [r.key, r.value]));
    if (s.retention_days == null || s.retention_days === 'null') warn('retention_days is not set: closed accounts are never purged. Set the period the law requires.');
    if (s.rate_chat_required === false || s.rate_chat_required === 'false') warn('rate_chat_required is off: prices are paid as shown, without the final-rate chat.');
    const test = await one(`select (select count(*)::int from payments where provider = 'sandbox') + (select count(*)::int from service_payments where provider = 'sandbox') n`);
    if (test.n) warn(`${test.n} test (sandbox) payments are in this database. If it is the production database, ask before going live: they are not real money.`);
    const fresh = await one(`select max(fetched_at) at from rate_snapshots`);
    if (!fresh.at || Date.now() - new Date(fresh.at) > 3600e3) warn('No market price in the last hour: check the price feeds and the scheduled job.');
    else ok('Market prices are arriving.');
  } catch (e) { block('Couldn’t read the database: ' + (e.message || e).toString().slice(0, 200)); }
  finally { if (db) await db.close().catch(() => {}); }
}

const show = (title, list, mark) => { if (list.length) { console.log(`\n${title}`); for (const m of list) console.log(`  ${mark} ${m}`); } };
console.log(`PGBX launch check · ${config.name} ${config.version} (${config.build}) · ${config.appId}`);
show('Blocks launch', out.block, '✗');
show('Needs attention', out.warn, '!');
show('Ready', out.ok, '✓');
console.log(`\n${out.block.length ? `Not ready: ${out.block.length} item(s) block launch.` : 'Nothing blocks launch.'}`);
process.exit(out.block.length ? 1 : 0);
