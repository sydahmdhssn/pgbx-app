// Shared by the admin panel and the dealer app: API calls, staff sign-in (password, then authenticator code),
// formatting and small UI pieces. Sessions use the HttpOnly "pgbx_staff" cookie set by the API; nothing is stored
// in the browser.
import { html, useState, useEffect, useRef, useCallback } from '../vendor/htm-preact-standalone-3.1.1.module.js';

export const API = '/api/v1';

export class ApiError extends Error {
  constructor(status, code, message) { super(message); this.status = status; this.code = code; }
}
// quiet: don't announce "signed out" (used for the first session check, when not being signed in is normal)
export async function api(path, { method = 'GET', body, timeout = 15000, quiet = false } = {}) {
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
    if (!quiet && r.status === 401 && ['SESSION_EXPIRED', 'SESSION_REQUIRED', 'MFA_REQUIRED'].includes(d.error)) window.dispatchEvent(new CustomEvent('pgbx-signed-out', { detail: d.message }));
    if (d.error === 'PASSWORD_CHANGE_REQUIRED') window.dispatchEvent(new CustomEvent('pgbx-password-change'));
    throw err;
  }
  return d;
}

// Loads data for a screen: { data, error, loading, reload }. A null path loads nothing (e.g. before sign-in).
// A different path (another tab or filter) clears the old rows at once, so they can't be clicked while the new ones load.
export function useLoad(path, deps = []) {
  const [s, setS] = useState({ data: null, error: null, loading: !!path });
  const seq = useRef(0), shown = useRef(path);
  const reload = useCallback(() => {
    const n = ++seq.current;
    if (!path) { setS({ data: null, error: null, loading: false }); return; }
    const fresh = shown.current !== path; shown.current = path;
    setS(p => ({ data: fresh ? null : p.data, loading: true, error: null }));
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
  if (s < 2 * 86400) return Math.floor(s / 3600) + ' h ' + Math.floor((s % 3600) / 60) + ' min left';
  return Math.floor(s / 86400) + ' days left';
}
// "Showing 200 of 1,240" under a list the server cut short
export const Shown = ({ n, total }) => (total > n ? html`<p class="muted small" style="margin:10px 0 0">Showing ${n} of ${total.toLocaleString('en-PK')}. The oldest aren’t shown; use search or filters to find them.</p>` : null);
export const PRODUCT_NAMES = {
  'g-10mg': 'Gold 10 mg', 'g-20mg': 'Gold 20 mg', 'g-50mg': 'Gold 50 mg', 'g-100mg': 'Gold 100 mg', 'g-500mg': 'Gold 500 mg', 'g-1g': 'Gold 1 gram', 'g-5g': 'Gold 5 gram',
  's-1t': 'Silver 1 tola', 's-3t': 'Silver 3 tola', 's-5t': 'Silver 5 tola', 's-10t': 'Silver 10 tola',
};
export const productName = id => PRODUCT_NAMES[id] || id;

const TONE = {
  verified: 'ok', passed: 'ok', credited: 'ok', completed: 'ok', active: 'ok', ready: 'ok',
  pending: 'warn', review: 'warn', submitted: 'warn', requested: 'warn', pending_payment: 'warn', reverify: 'warn', started: 'warn',
  flagged: 'gold', failed: 'bad', suspended: 'bad', closed: 'bad', expired: '', cancelled: '', refunded: '', none: '',
  filling: 'warn', full: 'gold', settled: 'ok', pending_payout: 'warn', paid_out: 'ok', refund_due: 'bad',
};
const LABEL = { pending_payment: 'awaiting payment', none: 'not started', reverify: 're-verify', pending_payout: 'to pay out', paid_out: 'paid out', refund_due: 'refund due', settled: 'settled', full: 'full: settle' };
export const Tag = ({ s }) => html`<span class=${'tag ' + (TONE[s] ?? '')}>${LABEL[s] || s}</span>`;

// ---------- small UI ----------
// The live region is always on the page, so screen readers announce each message that appears in it.
export function Toast({ toast }) {
  return html`<div role="status" aria-live="polite" class="sr-live">${toast && html`<div class=${'toast' + (toast.err ? ' err' : '')}>${toast.text}</div>`}</div>`;
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
const FOCUSABLE = 'a[href],button:not([disabled]),input:not([disabled]),select:not([disabled]),textarea:not([disabled]),[tabindex]:not([tabindex="-1"])';
// Dialog: focus moves into it, Tab stays inside, Escape closes, and focus returns to what opened it.
export function Modal({ title, children, onClose }) {
  const box = useRef();
  const close = useRef(onClose); close.current = onClose;
  useEffect(() => {
    const opener = document.activeElement;
    const first = box.current && (box.current.querySelector('input,select,textarea') || box.current.querySelector(FOCUSABLE));
    (first || box.current)?.focus();
    const k = e => {
      const open = document.querySelectorAll('.modal-bg');            // only the dialog on top answers the keyboard
      if (box.current && open.length && open[open.length - 1] !== box.current.parentElement) return;
      if (e.key === 'Escape') { close.current(); return; }
      if (e.key !== 'Tab' || !box.current) return;
      const f = [...box.current.querySelectorAll(FOCUSABLE)]; if (!f.length) return;
      if (e.shiftKey && document.activeElement === f[0]) { e.preventDefault(); f[f.length - 1].focus(); }
      else if (!e.shiftKey && document.activeElement === f[f.length - 1]) { e.preventDefault(); f[0].focus(); }
      else if (!box.current.contains(document.activeElement)) { e.preventDefault(); f[0].focus(); }
    };
    addEventListener('keydown', k);
    return () => { removeEventListener('keydown', k); if (opener && opener.isConnected) opener.focus(); };
  }, []);
  return html`<div class="modal-bg" onClick=${e => e.target === e.currentTarget && onClose()}>
    <div class="modal" role="dialog" aria-modal="true" aria-label=${title} ref=${box} tabindex="-1"><h2>${title}</h2>${children}</div></div>`;
}
// In-page questions instead of the browser's confirm()/prompt(): ask({ title, body, input, confirm, danger })
// answers true (or the typed text) when confirmed, null when cancelled. <Asker/> must be on the page once.
let showAsk = null;
export function ask(q) {
  if (!showAsk) return Promise.resolve(window.confirm(q.title) ? (q.input ? '' : true) : null);
  return new Promise(done => showAsk({ ...q, done }));
}
export function Asker() {
  const [q, setQ] = useState(null);
  const [text, setText] = useState('');
  useEffect(() => { showAsk = x => { setText(x.value || ''); setQ(x); }; return () => { showAsk = null; }; }, []);
  if (!q) return null;
  const end = v => { setQ(null); q.done(v); };
  const need = q.input && q.required !== false;
  return html`<${Modal} title=${q.title} onClose=${() => end(null)}>
    ${q.body && html`<p>${q.body}</p>`}
    ${q.input && html`<label class="f"><span>${q.input}</span><input class="in" value=${text} onInput=${e => setText(e.target.value)} onKeyDown=${e => { if (e.key === 'Enter' && (!need || text.trim())) end(text.trim()); }} /></label>`}
    <div class="row" style="justify-content:flex-end"><button class="btn sec" onClick=${() => end(null)}>Cancel</button>
      <button class=${q.danger ? 'btn danger' : 'btn'} disabled=${need && !text.trim()} onClick=${() => end(q.input ? text.trim() : true)}>${q.confirm || 'Confirm'}</button></div>
  </${Modal}>`;
}
// Button that runs an async action, shows progress and reports the result. While it runs, the other buttons in the
// same dialog are paused too, so two different actions can't be sent at once.
export function Act({ run, children, cls = 'btn', confirm, disabled, done, onError }) {
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState(null);
  const go = async e => {
    if (confirm && !(await ask({ title: confirm, confirm: 'Yes, continue', danger: /deactivate|reset|hide|suspend/i.test(confirm) }))) return;
    const box = e && e.currentTarget && e.currentTarget.closest('.modal');
    // the dialog's other buttons are disabled for real (not only for the mouse), so Enter on another one can't send a second action
    const others = box ? [...box.querySelectorAll('button:not([disabled])')].filter(b => b !== e.currentTarget) : [];
    setBusy(true); setErr(null); if (box) box.setAttribute('data-busy', ''); others.forEach(b => { b.disabled = true; });
    try { const r = await run(); done && done(r); }
    catch (x) { if (!onError || onError(x) === false) setErr(x.message); }   // shown next to the button, not in a browser alert; onError returns false to leave it to the button
    finally { setBusy(false); if (box) box.removeAttribute('data-busy'); others.forEach(b => { b.disabled = false; }); }
  };
  return html`<button class=${cls} onClick=${go} disabled=${busy || disabled} aria-busy=${busy}>${busy ? 'Working…' : children}</button>${err && html`<span class="act-err" role="alert">${err}</span>`}`;
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
        <button type="button" class="btn ghost block" onClick=${() => { api('/staff/logout', { method: 'POST', body: {}, quiet: true }).catch(() => {}); setStep('password'); setCode(''); setErr(null); }}>Use a different account</button>`}
    </form>
  </main>`;
}

// Session state for a staff tool: checks /staff/me on load and listens for expiry
export function useStaff() {
  const [me, setMe] = useState(undefined);       // undefined = checking, null = signed out
  const [notice, setNotice] = useState(null);
  const check = () => api('/staff/me', { quiet: true }).then(d => setMe(d.staff), () => setMe(null));
  useEffect(() => {
    check();
    const out = e => { setMe(null); setNotice(e.detail || 'Your session has ended. Please sign in again.'); };
    const pw = () => setMe(m => (m ? { ...m, mustChangePassword: true } : m));
    addEventListener('pgbx-signed-out', out); addEventListener('pgbx-password-change', pw);
    return () => { removeEventListener('pgbx-signed-out', out); removeEventListener('pgbx-password-change', pw); };
  }, []);
  const signOut = async () => { await api('/staff/logout', { method: 'POST', body: {} }).catch(() => {}); setNotice(null); setMe(null); };
  return { me, notice, signIn: () => { setNotice(null); check(); }, signOut, passwordChanged: () => setMe(m => ({ ...m, mustChangePassword: false })) };
}

// Choosing a new password: required after an account is created or reset, and available any time.
export function ChangePassword({ forced, onDone, onCancel, onSignOut }) {
  const [f, setF] = useState({ current: '', next: '', again: '' });
  const [err, setErr] = useState(null);
  const [busy, setBusy] = useState(false);
  const mismatch = f.again && f.next !== f.again;
  const submit = async e => {
    e.preventDefault(); setErr(null);
    if (f.next.length < 12) { setErr('Use at least 12 characters for the new password.'); return; }
    if (f.next !== f.again) { setErr('The two new passwords don’t match.'); return; }
    setBusy(true);
    try { await api('/staff/password', { method: 'POST', body: { current: f.current, next: f.next } }); onDone(); }
    catch (e2) { setErr(e2.message); } finally { setBusy(false); }
  };
  const field = (k, label, ac, hint) => html`<label class="f"><span>${label}</span><input class="in" type="password" autocomplete=${ac} value=${f[k]} onInput=${e => setF({ ...f, [k]: e.target.value })} aria-invalid=${k === 'again' && mismatch} />${hint && html`<small>${hint}</small>`}</label>`;
  const form = html`<form onSubmit=${submit} noValidate>
      ${err && html`<div class="note err" role="alert" style="margin-bottom:14px">${err}</div>`}
      ${field('current', forced ? 'Temporary password' : 'Current password', 'current-password')}
      ${field('next', 'New password', 'new-password', 'At least 12 characters. A short sentence is easy to remember.')}
      ${field('again', 'New password again', 'new-password')}
      <button class="btn block" disabled=${busy || !f.current || !f.next || !f.again}>${busy ? 'Saving…' : 'Save new password'}</button>
      ${forced ? html`<button type="button" class="btn ghost block" onClick=${onSignOut}>Sign out</button>` : html`<button type="button" class="btn ghost block" onClick=${onCancel}>Cancel</button>`}
    </form>`;
  if (!forced) return html`<${Modal} title="Change password" onClose=${onCancel}>${form}</${Modal}>`;
  return html`<main class="signin"><div class="card"><${Brand} sub="PGBX staff" /><h1>Choose a new password</h1>
    <p class="muted">Your account was set up or reset with a temporary password. Choose your own before continuing. Other devices will be signed out.</p>${form}</div></main>`;
}
