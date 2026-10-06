// Creates a staff account on the production database (the first admin, or anyone while the admin panel is not yet
// reachable). Prints a one-time password and the authenticator secret: share them securely, never by plain email.
//
//   DATABASE_URL=... npm run staff:create -- --email name@pgbx.pk --name "Full Name" --role admin [--dealer d1]
import { connectPostgres } from '../server/db.mjs';
import { hashPassword, newPassword, newTotpSecret, otpauthUrl } from '../server/security.mjs';

const arg = k => { const i = process.argv.indexOf('--' + k); return i > 0 ? process.argv[i + 1] : undefined; };
const email = String(arg('email') || '').toLowerCase(), name = arg('name'), role = arg('role'), dealer = arg('dealer') || null;
if (!process.env.DATABASE_URL) { console.error('Set DATABASE_URL first.'); process.exit(1); }
if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || !name || !['admin', 'ops', 'dealer'].includes(role) || (role === 'dealer' && !dealer)) {
  console.error('Usage: npm run staff:create -- --email name@pgbx.pk --name "Full Name" --role admin|ops|dealer [--dealer <dealer id>]');
  process.exit(1);
}
const db = await connectPostgres(process.env.DATABASE_URL);
const password = newPassword(), secret = newTotpSecret();
const s = await db.one(`insert into staff (email, name, role, dealer_id, password_hash, totp_secret, must_change_password) values ($1, $2, $3, $4, $5, $6, true) returning id`,
  [email, name, role, role === 'dealer' ? dealer : null, hashPassword(password), secret]);
await db.query(`select audit('cli', 'staff.created', 'staff', $1, $2::jsonb)`, [s.id, JSON.stringify({ email, role })]);
console.log(`Created ${role} ${email}\n  One-time password: ${password}\n  Authenticator secret: ${secret}\n  Authenticator link: ${otpauthUrl(secret, email)}`);
await db.close();
