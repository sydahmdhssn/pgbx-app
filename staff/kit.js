// Shared by the admin panel and the dealer app: API calls, staff sign-in (password, then authenticator code),
// formatting and small UI pieces. Sessions use the HttpOnly "pgbx_staff" cookie set by the API; nothing is stored
// in the browser.
import { html, useState, useEffect, useRef, useCallback } from '../vendor/htm-preact-standalone-3.1.1.module.js';

export const API = '/api/v1';

export class ApiError extends Error {
  constructor(status, code, message) { super(message); this.status = status; this.code = code; }
}
export async function api(path, { method = 'GET', body, timeout = 15000 } = {}) {
  const ctl = new AbortController(); const t = setTimeout(() => ctl.abort(), timeout);
  let r;
  try {
    r = await fetch(API + path, {
      method, credentials: 'same-origin', signal: ctl.signal,
      headers: body !== undefined ? { 'Content-Type': 'application/json' } : {},
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
  } catch (e) {
    throw new ApiError(0, 'NETWORK', e.name === 'AbortError' ? 'The server took too long to answer. Try again.' : 'Can’t reach PGBX. Check your connection and try again.');
  } finally { clearTimeout(t); }
  const d = await r.json().catch(() => ({}));
  if (!r.ok) {
    const err = new ApiError(r.status, d.error || 'ERROR', d.message || 'Something went wrong. Try again.');
    if (r.status === 401 && ['SESSION_EXPIRED', 'SESSION_REQUIRED', 'MFA_REQUIRED'].includes(d.error)) window.dispatchEvent(new CustomEvent('pgbx-signed-out', { detail: d.message }));
    throw err;
  }
  return d;
}

// Loads data for a screen: { data, error, loading, reload }
export function useLoad(path, deps = []) {
  const [s, setS] = useState({ data: null, error: null, loading: true });
  const seq = useRef(0);
  const reload = useCallback(() => {
    const n = ++seq.current;
    setS(p => ({ ...p, loading: true, error: null }));
    api(path).then(d => n === seq.current && setS({ data: d, error: null, loading: false }), e => n === seq.current && setS({ data: null, error: e, loading: false }));
  }, [path]);
  useEffect(reload, [path, ...deps]);
  return { ...s, reload };
}

// ---------- formatting ----------
export const pkr = n => (n === null || n === undefined ? '—' : 'Rs ' + Math.round(Number(n)).toLocaleString('en-PK'));
export const when = d => (d ? new Date(d).toLocaleString('en-GB', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }) : '—');
export const day = d => (d ? new Date(d).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' }) : '—');
export function ago(d) {
  const s = (Date.now() - new Date(d)) / 1000;
  if (s < 60) return 'just now';
  if (s < 3600) return Math.floor(s / 60) + ' min ago';
  if (s < 86400) return Math.floor(s / 3600) + ' h ago';
  return day(d);
}
export function left(d) {
  const s = (new Date(d) - Date.now()) / 1000;
  if (s <= 0) return 'expired';
  if (s < 3600) return Math.ceil(s / 60) + ' min left';
  return Math.floor(s / 3600) + ' h ' + Math.floor((s % 3600) / 60) + ' min left';
}
export const PRODUCT_NAMES = {
  'g-10mg': 'Gold 10 mg', 'g-20mg': 'Gold 20 mg', 'g-50mg': 'Gold 50 mg', 'g-100mg': 'Gold 100 mg', 'g-500mg': 'Gold 500 mg', 'g-1g': 'Gold 1 gram', 'g-5g': 'Gold 5 gram',
  's-1t': 'Silver 1 tola', 's-3t': 'Silver 3 tola', 's-5t': 'Silver 5 tola', 's-10t': 'Silver 10 tola',
};
export const productName = id => PRODUCT_NAMES[id] || id;

const TONE = {
  verified: 'ok', passed: 'ok', credited: 'ok', completed: 'ok', active: 'ok', ready: 'ok',
  pending: 'warn', review: 'warn', submitted: 'warn', requested: 'warn', pending_payment: 'warn', reverify: 'warn', started: 'warn',
  flagged: 'gold', failed: 'bad', suspended: 'bad', closed: 'bad', expired: '', cancelled: '', refunded: '', none: '',
};
const LABEL = { pending_payment: 'awaiting payment', none: 'not started', reverify: 're-verify' };
export const Tag = ({ s }) => html`<span class=${'tag ' + (TONE[s] ?? '')}>${LABEL[s] || s}</span>`;

// ---------- small UI ----------
export function Toast({ toast }) {
  if (!toast) return null;
  return html`<div class=${'toast' + (toast.err ? ' err' : '')} role="status" aria-live="polite">${toast.text}</div>`;
}
export function useToast() {
  const [toast, set] = useState(null);
  const t = useRef();
  const show = (text, err = false) => { clearTimeout(t.current); set({ text, err }); t.current = setTimeout(() => set(null), 3200); };
  return [toast, show];
}
export function Loading({ rows = 4 }) {
  return html`<div class="stack" aria-busy="true" aria-label="Loading">${Array.from({ length: rows }, (_, i) => html`<div class="skel" style=${`width:${90 - i * 12}%`}></div>`)}</div>`;
}
export function Failed({ error, retry }) {
  return html`<div class="note err" role="alert"><div class="spread"><span>${error.message}</span>${retry && html`<button class="btn sm sec" onClick=${retry}>Try again</button>`}</div></div>`;
}
export function Modal({ title, children, onClose }) {
  useEffect(() => {
    const k = e => e.key === 'Escape' && onClose();
    addEventListener('keydown', k); return () => removeEventListener('keydown', k);
  }, []);
  return html`<div class="modal-bg" onClick=${e => e.target === e.currentTarget && onClose()}>
    <div class="modal" role="dialog" aria-modal="true" aria-label=${title}><h2>${title}</h2>${children}</div></div>`;
}
// Button that runs an async action, shows progress and reports the result
export function Act({ run, children, cls = 'btn', confirm, disabled, done, onError }) {
  const [busy, setBusy] = useState(false);
  const go = async () => {
    if (confirm && !window.confirm(confirm)) return;
    setBusy(true);
    try { const r = await run(); done && done(r); }
    catch (e) { onError ? onError(e) : alert(e.message); }
    finally { setBusy(false); }
  };
  return html`<button class=${cls} onClick=${go} disabled=${busy || disabled} aria-busy=${busy}>${busy ? 'Working…' : children}</button>`;
}
export function Brand({ sub }) {
  return html`<div class="brand"><div class="mark" aria-hidden="true"></div><div><b>PGBX</b><span>${sub}</span></div></div>`;
}

// ---------- sign-in ----------
// Step 1 email + password, step 2 authenticator code. `roles` limits which staff can use this tool.
export function SignIn({ tool, roles, onIn, notice }) {
  const [step, setStep] = useState('password');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [code, setCode] = useState('');
  const [err, setErr] = useState(notice || null);
  const [busy, setBusy] = useState(false);
  const codeRef = useRef();
  useEffect(() => { if (step === 'code') codeRef.current?.focus(); }, [step]);

  const submit = async e => {
    e.preventDefault(); setErr(null); setBusy(true);
    try {
      if (step === 'password') {
        await api('/staff/login', { method: 'POST', body: { email, password } });
        setPassword(''); setStep('code');
      } else {
        const r = await api('/staff/mfa', { method: 'POST', body: { code } });
        if (!roles.includes(r.staff.role)) {
          await api('/staff/logout', { method: 'POST', body: {} }).catch(() => {});
          setStep('password'); setCode('');
          setErr(r.staff.role === 'dealer' ? 'Dealer accounts use the dealer app at /dealer.' : 'This account uses the admin panel at /admin.');
        } else onIn();
      }
    } catch (e2) {
      setErr(e2.message);
      if (step === 'code' && e2.code === 'SESSION_EXPIRED') { setStep('password'); setCode(''); }
    } finally { setBusy(false); }
  };

  return html`<main class="signin">
    <form class="card" onSubmit=${submit} noValidate>
      <${Brand} sub=${tool} />
      <h1>${step === 'password' ? 'Sign in' : 'Enter your code'}</h1>
      <p class="muted">${step === 'password' ? 'For PGBX staff only. Every sign-in is recorded.' : 'Open your authenticator app and enter the 6-digit code for PGBX.'}</p>
      ${err && html`<div class="note err" role="alert" style="margin-bottom:14px">${err}</div>`}
      ${step === 'password' ? html`
        <label class="f"><span>Work email</span><input class="in" type="email" autocomplete="username" required value=${email} onInput=${e => setEmail(e.target.value)} /></label>
        <label class="f"><span>Password</span><input class="in" type="password" autocomplete="current-password" required value=${password} onInput=${e => setPassword(e.target.value)} /></label>
        <button class="btn block" disabled=${busy || !email || !password}>${busy ? 'Checking…' : 'Continue'}</button>`
      : html`
        <label class="f"><span class="sr">Authenticator code</span><input ref=${codeRef} class="in code" inputmode="numeric" autocomplete="one-time-code" maxlength="6" value=${code} onInput=${e => setCode(e.target.value.replace(/\D/g, ''))} /></label>
        <button class="btn block" disabled=${busy || code.length !== 6}>${busy ? 'Checking…' : 'Sign in'}</button>
        <button type="button" class="btn ghost block" onClick=${() => { setStep('password'); setCode(''); setErr(null); }}>Use a different account</button>`}
    </form>
  </main>`;
}

// Session state for a staff tool: checks /staff/me on load and listens for expiry
export function useStaff() {
  const [me, setMe] = useState(undefined);       // undefined = checking, null = signed out
  const [notice, setNotice] = useState(null);
  const check = () => api('/staff/me').then(d => setMe(d.staff), () => setMe(null));
  useEffect(() => {
    check();
    const out = e => { setMe(null); setNotice(e.detail || 'Your session has ended. Please sign in again.'); };
    addEventListener('pgbx-signed-out', out); return () => removeEventListener('pgbx-signed-out', out);
  }, []);
  const signOut = async () => { await api('/staff/logout', { method: 'POST', body: {} }).catch(() => {}); setNotice(null); setMe(null); };
  return { me, notice, signIn: () => { setNotice(null); check(); }, signOut };
}
