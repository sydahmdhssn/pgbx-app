// PGBX dealer app: hand over collections at the counter (FR-DL1–DL4).
// Flow: customer shows a 6-digit code -> dealer looks it up -> prepares the bars and marks ready -> checks the CNIC,
// records one serial number per bar and confirms the handover. Every step is recorded on the server.
import { html, render, useState, useEffect, useRef } from '../vendor/htm-preact-standalone-3.1.1.module.js';
import { api, useLoad, useStaff, SignIn, ChangePassword, Loading, Failed, Tag, Toast, useToast, Act, Asker, ask, productName, left, ago } from '../staff/kit.js';

function Lookup({ toast, openRedemption }) {
  const [code, setCode] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState(null);
  const ref = useRef();
  useEffect(() => ref.current?.focus(), []);
  const go = async e => {
    e.preventDefault(); setBusy(true); setErr(null);
    // the code the customer showed is sent again with the handover: bars are only handed over against the customer's code
    try { const r = await api('/dealer/lookup', { method: 'POST', body: { code } }); setCode(''); openRedemption({ ...r.redemption, code }); }
    catch (e2) { setErr(e2.message); }
    finally { setBusy(false); }
  };
  return html`<form class="card" onSubmit=${go} noValidate>
    <h1>Collect</h1>
    <p class="muted">Ask the customer for the 6-digit code in their PGBX app.</p>
    ${err && html`<div class="note err" role="alert" style="margin-bottom:14px">${err}</div>`}
    <label class="f"><span class="sr">Collection code</span>
      <input ref=${ref} class="in code" inputmode="numeric" autocomplete="off" maxlength="6" placeholder="000000" value=${code}
        aria-invalid=${!!err} onInput=${e => { setCode(e.target.value.replace(/\D/g, '')); setErr(null); }} /></label>
    <button class="btn block" disabled=${busy || code.length !== 6}>${busy ? 'Looking up…' : 'Find collection'}</button>
  </form>`;
}

// The collection's status lives with the parent (onStatus), so switching tabs and back shows it as it is now
function Handover({ r, onDone, onBack, onStatus, toast }) {
  const status = r.status, setStatus = onStatus;
  const [cnic, setCnic] = useState(false);
  const [serials, setSerials] = useState(Array.from({ length: r.units }, () => ''));
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState(null);
  const clean = serials.map(s => s.trim().toUpperCase());
  const dupes = clean.filter((s, i) => s && clean.indexOf(s) !== i);
  const complete = clean.every(Boolean) && !dupes.length && cnic;

  // Changed elsewhere meanwhile (another counter, the customer cancelled, or the code ran out): fetch its real state and
  // show that, with the server's reason while it's still active here. Returns the collection as it is now (null: gone).
  const recheck = async e => {
    const now = await api('/dealer/redemptions').then(d => d.redemptions.find(x => x.id === r.id) || null, () => undefined);
    if (now === undefined) { setErr(e.message); return undefined; }                 // couldn't check: say what the server said
    if (!now || !['requested', 'ready'].includes(now.status)) {
      setStatus(now ? now.status : new Date(r.expires_at) < new Date() ? 'expired' : 'cancelled');
      setErr(now && now.status === 'completed' ? 'This collection was already handed over.' : 'This collection was cancelled or has expired. Look up the code again.');
      return null;
    }
    setStatus(now.status); setErr(e.message); return now;
  };
  const conflict = e => [404, 409, 410].includes(e.status);
  const ready = async () => {
    setBusy(true); setErr(null);
    try { await api(`/dealer/redemptions/${r.id}/ready`, { method: 'POST', body: {} }); setStatus('ready'); toast('Marked ready. The customer has been told.'); }
    catch (e) {
      if (!conflict(e)) { setErr(e.message); return; }
      if ((await recheck(e))?.status === 'ready') { setErr(null); toast('This collection was already marked ready.'); }
    } finally { setBusy(false); }
  };
  const handover = async () => {
    setBusy(true); setErr(null);
    try { await api(`/dealer/redemptions/${r.id}/handover`, { method: 'POST', body: { serials: clean, cnicChecked: cnic, code: r.code } }); onDone(); }
    catch (e) { if (conflict(e) && e.code !== 'SANDBOX_FUNDS') await recheck(e); else setErr(e.message); } finally { setBusy(false); }
  };
  const over = !['requested', 'ready'].includes(status);

  return html`<div class="stack">
    <button class="btn ghost sm" onClick=${onBack}>‹ Back</button>
    <div class="card">
      <div class="spread"><span class="muted small">Collection</span><${Tag} s=${status} /></div>
      <div class="big-units" style="margin-top:8px">${r.units} × </div>
      <h1 style="margin-top:4px">${productName(r.product_id)}</h1>
      <dl class="kv" style="margin-top:12px">
        <dt>Customer</dt><dd>${r.customer_name || '—'}</dd>
        <dt>CNIC</dt><dd class="mono">${r.cnic_masked || '—'}</dd>
        <dt>Code valid</dt><dd>${left(r.expires_at)}</dd>
      </dl>
    </div>
    ${err && html`<div class="note err" role="alert">${err}</div>`}
    ${over && html`<button class="btn block" onClick=${onBack}>Look up a code</button>`}
    ${status === 'requested' && html`<div class="card">
      <h2>1. Prepare the bars</h2>
      <p class="muted">Take ${r.units} sealed ${productName(r.product_id)} ${r.units === 1 ? 'bar' : 'bars'} from stock, then mark ready.</p>
      <button class="btn block" onClick=${ready} disabled=${busy}>${busy ? 'Saving…' : 'Mark ready'}</button>
    </div>`}
    ${status === 'ready' && html`<div class="card">
      <h2>2. Check and hand over</h2>
      <label class="check" style="margin-bottom:16px"><input type="checkbox" checked=${cnic} onChange=${e => setCnic(e.target.checked)} />
        <span>I checked the customer’s original CNIC and the name and number match <b>${r.customer_name}</b>, <span class="mono nowrap">${r.cnic_masked}</span>.</span></label>
      ${serials.map((s, i) => html`<label class="f"><span>Serial number, bar ${i + 1}</span>
        <input class="in mono" autocapitalize="characters" autocomplete="off" value=${s} aria-invalid=${dupes.includes(clean[i])}
          onInput=${e => setSerials(serials.map((x, j) => (j === i ? e.target.value : x)))} />
        ${dupes.includes(clean[i]) && html`<small style="color:var(--danger)">This serial is entered twice.</small>`}</label>`)}
      <button class="btn block" onClick=${handover} disabled=${busy || !complete}>${busy ? 'Saving…' : `Confirm handover of ${r.units}`}</button>
      ${!complete && html`<p class="muted small" style="margin:8px 0 0">${!cnic ? 'Tick the CNIC check' : 'Enter one different serial for each bar'} to continue.</p>`}
    </div>`}
  </div>`;
}

function Queue({ toast }) {
  const { data, error, loading, reload } = useLoad('/dealer/redemptions');
  useEffect(() => { const t = setInterval(() => document.visibilityState === 'visible' && reload(), 30000); return () => clearInterval(t); }, []);
  if (error) return html`<${Failed} error=${error} retry=${reload} />`;
  if (!data) return html`<div class="card"><${Loading} /></div>`;
  // marked ready at another counter, cancelled or expired meanwhile: say so and show the list as it is now
  const markReady = async r => {
    try { await api(`/dealer/redemptions/${r.id}/ready`, { method: 'POST', body: {} }); toast('Marked ready. The customer has been told.'); }
    catch (e) { if (![404, 409, 410].includes(e.status)) throw e; toast('This collection changed meanwhile (marked ready, cancelled or expired). The list is up to date now.', true); }
    reload();
  };
  const active = data.redemptions.filter(r => r.status === 'requested' || r.status === 'ready');
  const done = data.redemptions.filter(r => r.status === 'completed');
  return html`<div class="stack">
    <div class="spread"><h1>Today</h1><button class="btn sm sec" onClick=${reload} disabled=${loading}>${loading ? 'Refreshing…' : 'Refresh'}</button></div>
    <div class="card"><h2>Waiting (${active.length})</h2>
      ${active.length ? html`<div class="tbl-wrap"><table><tbody>${active.map(r => html`<tr>
        <td><b>${r.units} × ${productName(r.product_id)}</b><div class="muted small">${r.customer_name || 'Customer'} · ${left(r.expires_at)}</div></td>
        <td class="r">${r.status === 'requested'
          ? html`<${Act} cls="btn sm" run=${() => markReady(r)}>Mark ready</${Act}>`
          : html`<${Tag} s=${r.status} />`}</td></tr>`)}</tbody></table></div>
        <p class="muted small" style="margin:12px 0 0">Prepare the bars and mark them ready so the customer knows to come. To hand over, ask for the customer’s code on the Collect tab.</p>`
      : html`<div class="empty">No collections waiting. New reservations appear here.</div>`}
    </div>
    <div class="card"><h2>Handed over (last 24 h)</h2>
      ${done.length ? html`<div class="tbl-wrap"><table><tbody>${done.map(r => html`<tr>
        <td>${r.units} × ${productName(r.product_id)}<div class="muted small mono">${(r.serials || []).join(', ')}</div></td>
        <td class="r muted small">${ago(r.completed_at)}</td></tr>`)}</tbody></table></div>`
      : html`<div class="empty">Nothing handed over in the last 24 hours.</div>`}
    </div>
  </div>`;
}

function Stock() {
  const { data, error, reload } = useLoad('/dealer/stock');
  if (error) return html`<${Failed} error=${error} retry=${reload} />`;
  if (!data) return html`<div class="card"><${Loading} /></div>`;
  return html`<div class="stack">
    <h1>Stock</h1>
    <p class="muted">Units PGBX has recorded at this counter. If a count is wrong, call PGBX operations; it is corrected in the admin panel.</p>
    <div class="card"><div class="tbl-wrap"><table>
      <thead><tr><th>Product</th><th class="r">Units</th></tr></thead>
      <tbody>${data.stock.map(s => html`<tr><td>${productName(s.product_id)}</td><td class="r num">${s.units === 0 ? html`<span class="tag bad">0</span>` : s.units}</td></tr>`)}</tbody>
    </table></div></div>
  </div>`;
}

function Dealer() {
  const { me, notice, signIn, signOut, passwordChanged } = useStaff();
  const [tab, setTab] = useState('collect');
  const [current, setCurrent] = useState(null);
  const [pw, setPw] = useState(false);
  const [toast, show] = useToast();
  if (me === undefined) return html`<div class="signin"></div>`;
  if (!me) return html`<${SignIn} tool="Dealer app" roles=${['dealer']} onIn=${signIn} notice=${notice} />`;
  if (me.mustChangePassword) return html`<${ChangePassword} forced=${true} onDone=${passwordChanged} onSignOut=${signOut} />`;
  const TABS = [['collect', 'Collect'], ['queue', 'Today'], ['stock', 'Stock']];
  return html`<div class="dl">
    <header class="dl-top"><div><b>${me.dealer?.name || 'PGBX dealer'}</b><span>${me.name}</span></div>
      <div class="row"><button class="btn ghost sm" onClick=${() => setPw(true)}>Password</button>
      <button class="btn ghost sm" onClick=${async () => (await ask({ title: 'Sign out of the dealer app?', confirm: 'Sign out' })) && signOut()}>Sign out</button></div></header>
    ${pw && html`<${ChangePassword} onDone=${() => { setPw(false); show('Password changed. Other devices were signed out.'); }} onCancel=${() => setPw(false)} />`}
    <main class="dl-body">
      ${tab === 'collect' && (current
        ? html`<${Handover} r=${current} toast=${show} onBack=${() => setCurrent(null)} onStatus=${s => setCurrent(c => (c ? { ...c, status: s } : c))} onDone=${() => { setCurrent(null); show('Handover recorded. The customer’s wallet is updated.'); }} />`
        : html`<${Lookup} toast=${show} openRedemption=${setCurrent} />`)}
      ${tab === 'queue' && html`<${Queue} toast=${show} />`}
      ${tab === 'stock' && html`<${Stock} />`}
    </main>
    <nav class="dl-tabs" aria-label="Sections"><div>${TABS.map(([k, l]) => html`<button aria-current=${tab === k ? 'page' : undefined} onClick=${() => setTab(k)}>${l}</button>`)}</div></nav>
    <${Toast} toast=${toast} /><${Asker} />
  </div>`;
}

render(html`<${Dealer} />`, document.getElementById('app'));
