// Security primitives: session tokens, password hashing and two-factor codes. Node's crypto only, no dependencies.
import crypto from 'node:crypto';

// Session tokens: 256 random bits. Only the SHA-256 hash is stored, so a database leak does not expose live sessions.
export const newToken = () => crypto.randomBytes(32).toString('base64url');
export const hashToken = t => crypto.createHash('sha256').update(String(t)).digest('hex');

// 6-digit codes (redemption) from a cryptographic RNG
export const newCode = () => String(crypto.randomInt(100000, 1000000));

// Staff passwords: scrypt with a random salt; constant-time comparison.
const N = 16384, R = 8, P = 1, LEN = 64;
export function hashPassword(pw) {
  const salt = crypto.randomBytes(16);
  const h = crypto.scryptSync(String(pw), salt, LEN, { N, r: R, p: P });
  return `scrypt$${N}$${R}$${P}$${salt.toString('base64')}$${h.toString('base64')}`;
}
export function verifyPassword(pw, stored) {
  const [alg, n, r, p, salt, hash] = String(stored || '').split('$');
  if (alg !== 'scrypt') return false;
  const want = Buffer.from(hash, 'base64');
  const got = crypto.scryptSync(String(pw), Buffer.from(salt, 'base64'), want.length, { N: +n, r: +r, p: +p });
  return want.length === got.length && crypto.timingSafeEqual(want, got);
}
export const newPassword = () => crypto.randomBytes(12).toString('base64url');

// Second factor for staff: TOTP (RFC 6238), compatible with Google Authenticator, Microsoft Authenticator, 1Password.
const B32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
export function base32Encode(buf) {
  let bits = 0, value = 0, out = '';
  for (const byte of buf) { value = (value << 8) | byte; bits += 8; while (bits >= 5) { out += B32[(value >>> (bits - 5)) & 31]; bits -= 5; } }
  if (bits > 0) out += B32[(value << (5 - bits)) & 31];
  return out;
}
export function base32Decode(str) {
  let bits = 0, value = 0; const out = [];
  for (const ch of String(str).replace(/=+$/, '').toUpperCase()) {
    const i = B32.indexOf(ch); if (i < 0) continue;
    value = (value << 5) | i; bits += 5;
    if (bits >= 8) { out.push((value >>> (bits - 8)) & 255); bits -= 8; }
  }
  return Buffer.from(out);
}
export const newTotpSecret = () => base32Encode(crypto.randomBytes(20));
export function totp(secret, at = Date.now(), step = 30) {
  const counter = Buffer.alloc(8); counter.writeBigUInt64BE(BigInt(Math.floor(at / 1000 / step)));
  const h = crypto.createHmac('sha1', base32Decode(secret)).update(counter).digest();
  const o = h[h.length - 1] & 15;
  return String(((h.readUInt32BE(o) & 0x7fffffff) % 1e6)).padStart(6, '0');
}
// Accepts the current code and one step either side (clock drift).
export const verifyTotp = (secret, code, at = Date.now()) => totpStep(secret, code, at) !== null;
// The time step of a valid code (or null), so the caller can refuse a code that was already used.
export function totpStep(secret, code, at = Date.now()) {
  const c = String(code || '').replace(/\D/g, '');
  if (c.length !== 6) return null;
  for (const w of [-1, 0, 1]) {
    const t = at + w * 30000;
    if (crypto.timingSafeEqual(Buffer.from(totp(secret, t)), Buffer.from(c))) return Math.floor(t / 30000);
  }
  return null;
}
export const otpauthUrl = (secret, email) => `otpauth://totp/PGBX:${encodeURIComponent(email)}?secret=${secret}&issuer=PGBX&algorithm=SHA1&digits=6&period=30`;

// Webhook signatures: HMAC-SHA256 of the raw body, compared in constant time.
export function verifySignature(raw, signature, secret) {
  if (!secret || !signature) return false;
  const want = crypto.createHmac('sha256', secret).update(raw).digest('hex');
  const w = Buffer.from(want), g = Buffer.from(String(signature).replace(/^sha256=/, ''));
  return w.length === g.length && crypto.timingSafeEqual(w, g);   // byte lengths: a multi-byte header can't throw
}
export const sign = (raw, secret) => crypto.createHmac('sha256', secret).update(raw).digest('hex');
