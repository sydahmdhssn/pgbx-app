// Production build only: the customer app's connection to the PGBX API (/api/v1). The demo build never loads data
// from here. The server is the source of truth for the wallet, orders, collections, notifications and alerts;
// the phone keeps only device settings (PIN, notification choices, cart).
//
// Sessions: on the web the API sets an HttpOnly cookie (JavaScript can't read it). In the native app the session
// token is kept in the phone's secure storage (iOS Keychain / Android Keystore) through mobile/bridge.js.

const meta = n => document.querySelector(`meta[name="${n}"]`)?.content || '';
export const NATIVE = !!(window.Capacitor && window.Capacitor.isNativePlatform && window.Capacitor.isNativePlatform());
// Native apps call the production server; the web app calls its own origin.
export const API_ROOT = (NATIVE ? meta('pgbx-api') || 'https://pgbx-app.vercel.app' : '') + '/api/v1';

const secure = () => window.PGBXNative && window.PGBXNative.secure;
let token = null;
// The native session token is read from secure storage once; every request waits for that.
const ready = (async () => { if (NATIVE && secure()) token = await secure().get('session').catch(() => null); })();
export const restoreSession = () => ready;
async function keepToken(t) {
  token = t;
  if (NATIVE && secure()) await (t ? secure().set('session', t) : secure().remove('session')).catch(() => {});
}

export class LiveError extends Error {
  constructor(status, code, message, extra) { super(message); this.status = status; this.code = code; Object.assign(this, extra || {}); }
}
export async function api(path, { method = 'GET', body, timeout = 15000 } = {}) {
  await ready;
  const ctl = new AbortController(); const t = setTimeout(() => ctl.abort(), timeout);
  let r;
  try {
    r = await fetch(API_ROOT + path, {
      method, signal: ctl.signal, cache: 'no-store', credentials: NATIVE ? 'omit' : 'same-origin',
      headers: { ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}), ...(token ? { Authorization: 'Bearer ' + token } : {}) },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
  } catch (e) {
    throw new LiveError(0, 'NETWORK', e.name === 'AbortError' ? 'PGBX is taking too long to answer. Check your connection and try again.' : 'Can’t reach PGBX. Check your connection and try again.');
  } finally { clearTimeout(t); }
  const d = await r.json().catch(() => ({}));
  if (!r.ok) throw new LiveError(r.status, d.error || 'ERROR', d.message || 'Something went wrong. Please try again.', d);
  return d;
}
export const signedOut = e => e instanceof LiveError && e.status === 401;

// ---------- login ----------
export async function config() { return api('/config'); }
export async function sendCode(phone, channel) { return api('/auth/otp/start', { method: 'POST', body: { phone, channel } }); }
export async function verifyCode(phone, code) {
  const d = await api('/auth/otp/verify', { method: 'POST', body: { phone, code, device: deviceName(), cookie: !NATIVE } });
  await keepToken(NATIVE ? d.token : null);
  return d;
}
export async function logout() { await api('/auth/logout', { method: 'POST', body: {} }).catch(() => {}); await keepToken(null); }
export async function forget() { await keepToken(null); }
function deviceName() {
  const ua = navigator.userAgent;
  return /iPhone/.test(ua) ? 'iPhone' : /iPad/.test(ua) ? 'iPad' : /Android/.test(ua) ? 'Android phone' : /Mac/.test(ua) ? 'Mac' : /Windows/.test(ua) ? 'Windows PC' : 'a device';
}

// ---------- mapping server records to the app's shapes ----------
const ts = d => (d ? new Date(d).getTime() : null);
const order = o => ({
  id: o.id, receipt: o.receipt_no, total: o.total_pkr, method: o.method, ts: ts(o.created_at), status: o.status === 'pending_payment' ? 'pending' : o.status,
  lines: (o.lines || []).map(l => ({ pid: l.product_id, units: l.units, unit: l.unit_price_pkr })),
});
const ledgerEntry = (e, redemptions) => {
  const r = e.reason === 'redemption' ? redemptions.find(x => x.id === e.ref) : null;
  return { id: e.id, ts: ts(e.created_at), pid: e.product_id, delta: e.delta, reason: e.reason, ref: e.ref, price: e.unit_price_pkr, dealer: r ? r.dealerName : undefined, serials: r ? r.serials : undefined };
};
const redemption = r => ({
  id: r.id, pid: r.product_id, units: r.units, dealerId: r.dealer_id, dealerName: r.dealer_name, code: r.code, status: r.status,
  createdAt: ts(r.created_at), expiresAt: ts(r.expires_at), readyAt: ts(r.ready_at), completedAt: ts(r.completed_at), serials: r.serials || undefined,
});
const notification = n => ({ id: n.id, ts: ts(n.created_at), kind: n.kind, title: n.title, body: n.body, read: !!n.read_at, link: n.link || undefined, quiet: n.push === false });
const alert = a => ({ id: a.id, metal: a.metal, dir: a.dir, target: a.target_pkr, active: a.active, firedAt: ts(a.fired_at) });
const KYC = { none: 'none', pending: 'pending', review: 'pending', verified: 'verified', failed: 'failed', reverify: 'reverify' };

// Everything the signed-in screens show, in one round of requests
export async function loadAll() {
  const [me, orders, ledger, reds, notes, alerts] = await Promise.all([
    api('/me'), api('/orders'), api('/ledger'), api('/redemptions'), api('/notifications'), api('/alerts'),
  ]);
  const redemptions = reds.redemptions.map(redemption);
  return {
    phone: me.profile.phone || '',
    profile: { name: me.profile.name || '', cnic: me.profile.cnic || '', dob: me.profile.dob ? String(me.profile.dob).slice(0, 10) : '', email: me.profile.email || '', address: me.profile.address || '' },
    kyc: { status: KYC[me.kyc.status] || 'none', serverStatus: me.kyc.status, at: ts(me.kyc.at) },
    orders: orders.orders.map(order).reverse(),
    ledger: ledger.entries.map(e => ledgerEntry(e, redemptions)),
    redemptions: redemptions.reverse(),
    notifications: notes.notifications.map(notification),
    alerts: alerts.alerts.map(alert),
  };
}
// Dealers with what each can hand over now (capped at 10 by the server)
export async function dealers() {
  const d = await api('/dealers');
  return d.dealers.map(x => ({ id: x.id, name: x.name, area: x.area, address: x.address, phone: x.phone, lat: x.lat, lng: x.lng, hours: x.hours, available: x.available || {} }));
}
export async function products() { return (await api('/products')).products; }

// ---------- actions ----------
export async function lock(pids) {
  const d = await api('/locks', { method: 'POST', body: { products: pids } });
  return { id: d.lock.id, prices: d.lock.prices, expiresAt: ts(d.lock.expires_at) };
}
// Places the order (idempotent on `key`) and runs the payment. Returns the server order.
export async function placeOrder({ lockId, lines, method, key }) {
  const d = await api('/orders', { method: 'POST', body: { lockId, lines: lines.map(l => ({ productId: l.pid, units: l.units })), method, idempotencyKey: key } });
  if (d.payment && d.payment.action && d.payment.action.type === 'sandbox') {
    const p = await api(`/payments/sandbox/${d.order.id}`, { method: 'POST', body: { outcome: 'success' } });
    return p.order;
  }
  if (d.payment && d.payment.action && d.payment.action.type === 'redirect' && d.payment.action.url) {
    // A real provider: open its payment page. The webhook credits the wallet; the app picks it up on the next refresh.
    if (window.PGBXNative && window.PGBXNative.openUrl) window.PGBXNative.openUrl(d.payment.action.url); else window.open(d.payment.action.url, '_blank', 'noopener');
  }
  return d.order;
}
export async function submitKyc(f) {
  const k = await api('/kyc', { method: 'POST', body: {} });
  return api(`/kyc/${k.check.id}/submit`, { method: 'POST', body: { cnic: f.cnic.replace(/\D/g, ''), name: f.name.trim(), dob: f.dob, expiry: f.expiry } });
}
export const saveProfile = f => api('/me', { method: 'PATCH', body: { name: f.name.trim(), ...(f.cnic ? { cnic: f.cnic } : {}), ...(f.dob ? { dob: f.dob } : {}), email: f.email || '', address: f.address || '' } });
export const phoneStart = phone => api('/me/phone/start', { method: 'POST', body: { phone } });
export const phoneVerify = (phone, code) => api('/me/phone/verify', { method: 'POST', body: { phone, code } });
export const reserve = (pid, units, dealerId) => api('/redemptions', { method: 'POST', body: { productId: pid, units, dealerId } }).then(d => redemption(d.redemption));
export const cancelRedemption = id => api(`/redemptions/${id}/cancel`, { method: 'POST', body: {} });
export const markRead = () => api('/notifications/read', { method: 'POST', body: {} });
export const addAlert = (metal, dir, target) => api('/alerts', { method: 'POST', body: { metal, dir, targetPkr: target } }).then(d => alert(d.alert));
export const removeAlert = id => api(`/alerts/${id}`, { method: 'DELETE' });
export const closeAccount = () => api('/account/close', { method: 'POST', body: {} });
export const report = (topic, body) => api('/support', { method: 'POST', body: { topic, body } });
export const registerPush = (t, platform) => api('/devices/push', { method: 'POST', body: { token: t, platform } });
