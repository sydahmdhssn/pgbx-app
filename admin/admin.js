// PGBX admin panel for operations and administrators (FR-M1–M10).
// Roles: admin (everything), ops (day-to-day work; cannot change settings, prices, dealers' details, staff or suspend
// customers). The server enforces roles; this screen only hides what a role can't use.
import { html, render, useState, useEffect, useRef } from '../vendor/htm-preact-standalone-3.1.1.module.js';
import { api, useLoad, useStaff, SignIn, ChangePassword, Loading, Failed, Tag, Toast, useToast, Modal, Act, Asker, ask, Shown, Brand, pkr, when, day, ago, productName, PRODUCT_NAMES } from '../staff/kit.js';
import { qrSvg } from '../staff/qr.js';

const ORDER = Object.keys(PRODUCT_NAMES);
const pkToday = () => new Date(Date.now() + 5 * 3600e3).toISOString().slice(0, 10);   // PGBX's business day is Pakistan time (UTC+5)
const byProduct = (a, b) => ORDER.indexOf(a.product_id) - ORDER.indexOf(b.product_id);

// [id, label, roles that can open it]; without roles: administrators and operations
const SECTIONS = [
  ['overview', 'Overview'], ['chats', 'Rate chats', ['admin', 'support']], ['kyc', 'Identity checks'], ['orders', 'Orders'], ['appraisals', 'Doorstep appraisals'], ['gifts', 'Gift orders'],
  ['micro', '$1 gold & tola lots'], ['barsales', 'Bar sell-backs'], ['refunds', 'Refunds'], ['customers', 'Customers'], ['support', 'Support'], ['dealers', 'Dealers & stock'],
  ['products', 'Products & premiums'], ['reconciliation', 'Reconciliation'], ['settings', 'Settings'], ['audit', 'Audit log'], ['staff', 'Staff', ['admin']],
];
const canOpen = (s, role) => (s[2] || ['admin', 'ops']).includes(role);
const ROLE_NAME = { admin: 'Administrator', ops: 'Operations', support: 'Support' };
const go = (s, id) => { location.hash = id ? `${s}/${id}` : s; };
const useHash = () => {
  const read = () => (location.hash.slice(1) || 'overview').split('/');
  const [h, set] = useState(read());
  useEffect(() => { const f = () => set(read()); addEventListener('hashchange', f); return () => removeEventListener('hashchange', f); }, []);
  return h;
};
const Head = ({ title, sub, children }) => html`<div class="head"><div><h1>${title}</h1>${sub && html`<p class="muted" style="margin:0">${sub}</p>`}</div><div class="row">${children}</div></div>`;
const Card = ({ title, children, action }) => html`<section class="card">${(title || action) && html`<div class="spread" style="margin-bottom:12px"><h2 style="margin:0">${title}</h2>${action}</div>`}${children}</section>`;
const Table = ({ head, rows, empty }) => rows.length
  ? html`<div class="tbl-wrap"><table><thead><tr>${head.map(h => html`<th class=${h.startsWith('#') ? 'r' : ''}>${h.replace(/^#/, '')}</th>`)}</tr></thead><tbody>${rows}</tbody></table></div>`
  : html`<div class="empty">${empty}</div>`;
const Screen = ({ load, children }) => load.error ? html`<${Failed} error=${load.error} retry=${load.reload} />` : !load.data ? html`<div class="card"><${Loading} /></div>` : children(load.data);
const Seg = ({ value, options, onChange, label }) => html`<div class="seg" role="group" aria-label=${label}>${options.map(([v, l]) => html`<button aria-pressed=${value === v} onClick=${() => onChange(v)}>${l}</button>`)}</div>`;

// ---------- overview ----------
function Overview({ me }) {
  const load = useLoad('/admin/overview');
  return html`<${Head} title="Overview" sub="Today at a glance"><button class="btn sm sec" onClick=${load.reload}>Refresh</button></${Head}>
    <${Screen} load=${load}>${d => html`<div class="stack">
      <div class="grid g4">
        <a class=${'card stat' + (d.kyc_review ? ' attn' : '')} href="#kyc" style="text-decoration:none;color:inherit"><div class="k">Identity checks to review</div><div class="v">${d.kyc_review}</div></a>
        <a class=${'card stat' + (d.flagged_orders ? ' attn' : '')} href="#orders" style="text-decoration:none;color:inherit"><div class="k">Orders needing operations</div><div class="v">${d.flagged_orders}</div></a>
        <a class=${'card stat' + (d.appraisals_to_assign ? ' attn' : '')} href="#appraisals" style="text-decoration:none;color:inherit"><div class="k">Appraisals to assign</div><div class="v">${d.appraisals_to_assign ?? 0}</div></a>
        <a class="card stat" href="#gifts" style="text-decoration:none;color:inherit"><div class="k">Gift orders in progress</div><div class="v">${d.gifts_open ?? 0}</div></a>
        <a class=${'card stat' + (d.lots_to_settle ? ' attn' : '')} href="#micro" style="text-decoration:none;color:inherit"><div class="k">Full tola lots to settle</div><div class="v">${d.lots_to_settle ?? 0}</div></a>
        <a class=${'card stat' + (d.payouts_pending ? ' attn' : '')} href="#micro/payouts" style="text-decoration:none;color:inherit"><div class="k">$1 gold payouts to send</div><div class="v">${d.payouts_pending ?? 0}</div></a>
        ${me.role === 'admin' && html`<a class=${'card stat' + (d.chats_waiting ? ' attn' : '')} href="#chats" style="text-decoration:none;color:inherit"><div class="k">Rate chats waiting for a reply</div><div class="v">${d.chats_waiting ?? 0}</div></a>`}
        <a class=${'card stat' + (d.bar_sales_pending ? ' attn' : '')} href="#barsales" style="text-decoration:none;color:inherit"><div class="k">Bar sell-backs to pay</div><div class="v">${d.bar_sales_pending ?? 0}</div></a>
        <a class=${'card stat' + (d.refunds_due ? ' attn' : '')} href="#refunds" style="text-decoration:none;color:inherit"><div class="k">Refunds to pay</div><div class="v">${d.refunds_due ?? 0}</div></a>
        <div class="card stat"><div class="k">Sales today</div><div class="v">${pkr(d.sales_today_pkr)}</div><div class="muted small">${d.orders_today} orders</div></div>
        <div class="card stat"><div class="k">Active collections</div><div class="v">${d.active_collections}</div></div>
        <div class="card stat"><div class="k">Customers</div><div class="v">${d.customers}</div><div class="muted small">${d.verified} verified</div></div>
      </div>
      ${d.sandbox && html`<div class="note warn">Test providers are switched on (sandbox payments, identity checks or login codes). Money and identities shown here are not real; never pay out or hand over against them.</div>`}
      <${Card} title="Latest rates (per tola)">${d.rates ? html`<dl class="kv">
        <dt>Gold buy / sell</dt><dd class="num">${pkr(d.rates.gold_buy_tola)} / ${pkr(d.rates.gold_sell_tola)}</dd>
        <dt>Silver buy / sell</dt><dd class="num">${pkr(d.rates.silver_buy_tola)} / ${pkr(d.rates.silver_sell_tola)}</dd>
        <dt>Source</dt><dd>${d.rates.source} · ${ago(d.rates.fetched_at)}</dd></dl>` : html`<div class="empty">No rates recorded yet.</div>`}</${Card}>
    </div>`}</${Screen}>`;
}

// ---------- identity checks ----------
function Kyc({ toast }) {
  const [status, setStatus] = useState('review');
  const load = useLoad('/admin/kyc?status=' + status);
  const [deciding, setDeciding] = useState(null);
  const [reason, setReason] = useState('');
  const decide = async decision => {
    await api(`/admin/kyc/${deciding.id}/decide`, { method: 'POST', body: { decision, reason } });
    toast(decision === 'passed' ? 'Verified. The customer has been told.' : 'Marked as failed. The customer has been told.');
    setDeciding(null); setReason(''); load.reload();
  };
  return html`<${Head} title="Identity checks" sub="Checks the provider sent for a person to decide">
      <${Seg} label="Status" value=${status} onChange=${setStatus} options=${[['review', 'To review'], ['submitted', 'Waiting on provider'], ['failed', 'Failed'], ['passed', 'Passed']]} /></${Head}>
    <${Screen} load=${load}>${d => html`<${Card}><${Table} head=${['Customer', 'CNIC', 'Reason', 'Since', '']} empty="Nothing here." rows=${d.checks.map(k => html`<tr>
      <td><a href=${'#customers/' + k.customer_id}>${k.name || '—'}</a><div class="muted small">+92 ${k.phone || '—'}</div></td>
      <td class="mono">${k.cnic || '—'}</td><td class="small">${k.reason || '—'}</td><td class="small">${ago(k.created_at)}</td>
      <td class="r">${['review', 'submitted'].includes(k.status) ? html`<button class="btn sm" onClick=${() => { setReason(''); setDeciding(k); }}>Decide</button>` : html`<${Tag} s=${k.status} />`}</td></tr>`)} /><${Shown} n=${d.checks.length} total=${d.total} /></${Card}>`}</${Screen}>
    ${deciding && html`<${Modal} title="Decide identity check" onClose=${() => setDeciding(null)}>
      <dl class="kv" style="margin-bottom:16px"><dt>Name</dt><dd>${deciding.name}</dd><dt>CNIC</dt><dd class="mono">${deciding.cnic}</dd><dt>Provider note</dt><dd>${deciding.reason || '—'}</dd></dl>
      <p class="muted small">Compare the CNIC images and selfie in the provider’s dashboard before deciding.</p>
      <label class="f"><span>Reason (kept in the audit log)</span><input class="in" value=${reason} onInput=${e => setReason(e.target.value)} placeholder="Optional for a pass, required for a fail" /></label>
      <div class="row" style="justify-content:flex-end"><button class="btn sec" onClick=${() => setDeciding(null)}>Cancel</button>
        <${Act} cls="btn danger" disabled=${!reason.trim()} run=${() => decide('failed')}>Fail</${Act}><${Act} run=${() => decide('passed')}>Verify</${Act}></div>
    </${Modal}>`}`;
}

// ---------- orders ----------
function Orders({ toast }) {
  const [status, setStatus] = useState('flagged');
  const load = useLoad('/admin/orders?status=' + status);
  const [resolving, setResolving] = useState(null);
  const [note, setNote] = useState('');
  const resolve = async action => {
    await api(`/admin/orders/${resolving.id}/resolve`, { method: 'POST', body: { action, note } });
    toast(action === 'credit' ? 'Credited to the customer’s wallet.' : 'Marked for refund.');
    setResolving(null); setNote(''); load.reload();
  };
  return html`<${Head} title="Orders" sub="Flagged orders are paid but not credited automatically (amount mismatch, late payment or a failure)">
      <${Seg} label="Status" value=${status} onChange=${setStatus} options=${[['flagged', 'Needs operations'], ['pending_payment', 'Awaiting payment'], ['credited', 'Credited'], ['refunded', 'Refunded'], ['failed', 'Failed'], ['expired', 'Expired']]} /></${Head}>
    <${Screen} load=${load}>${d => html`<${Card}><${Table} head=${['Receipt', 'Customer', '#Total', 'Note', 'Created', '']} empty="No orders with this status." rows=${d.orders.map(o => html`<tr>
      <td class="mono small">${o.receipt_no || o.id.slice(0, 8)}</td><td>${o.name || '—'}<div class="muted small">+92 ${o.phone || '—'}</div></td>
      <td class="r num">${pkr(o.total_pkr)}</td><td class="small">${o.note || '—'}</td><td class="small">${when(o.created_at)}</td>
      <td class="r">${o.status === 'flagged' ? html`<button class="btn sm" onClick=${() => { setNote(''); setResolving(o); }}>Resolve</button>` : html`<${Tag} s=${o.status} />`}</td></tr>`)} /><${Shown} n=${d.orders.length} total=${d.total} /></${Card}>`}</${Screen}>
    ${resolving && html`<${Modal} title="Resolve order" onClose=${() => setResolving(null)}>
      <dl class="kv" style="margin-bottom:16px"><dt>Receipt</dt><dd class="mono">${resolving.receipt_no}</dd><dt>Total</dt><dd>${pkr(resolving.total_pkr)}</dd><dt>Why flagged</dt><dd>${resolving.note || '—'}</dd></dl>
      <p class="muted small">Check the payment in the provider’s dashboard first. Credit only if the full amount was received; otherwise refund it through the provider.</p>
      <label class="f"><span>Note (required, kept in the audit log)</span><input class="in" value=${note} onInput=${e => setNote(e.target.value)} /></label>
      <div class="row" style="justify-content:flex-end"><button class="btn sec" onClick=${() => setResolving(null)}>Cancel</button>
        <${Act} cls="btn danger" disabled=${!note.trim()} run=${() => resolve('refund')}>Refund</${Act}><${Act} disabled=${!note.trim()} run=${() => resolve('credit')}>Credit wallet</${Act}></div>
    </${Modal}>`}`;
}

// ---------- customers ----------
function Customers() {
  const [q, setQ] = useState('');
  const [term, setTerm] = useState('');
  useEffect(() => { const t = setTimeout(() => setTerm(q.trim()), 300); return () => clearTimeout(t); }, [q]);
  const load = useLoad('/admin/customers?q=' + encodeURIComponent(term));
  return html`<${Head} title="Customers" sub="Opening a customer is recorded in the audit log" />
    <${Card}><label class="f"><span class="sr">Search</span><input class="in" type="search" placeholder="Search by mobile number, name or CNIC" value=${q} onInput=${e => setQ(e.target.value)} /></label>
    <${Screen} load=${load}>${d => html`<${Table} head=${['Name', 'Mobile', 'CNIC', 'Identity', 'Account', 'Joined']} empty=${term ? 'No customers match.' : 'No customers yet.'} rows=${d.customers.map(c => html`<tr class="click" onClick=${() => go('customers', c.id)}>
      <td><a href=${'#customers/' + c.id} onClick=${e => e.stopPropagation()}>${c.name || 'Not given yet'}</a></td><td class="num">${c.phone ? '+92 ' + c.phone : '—'}</td><td class="mono small">${c.cnic || '—'}</td>
      <td><${Tag} s=${c.kyc_status} /></td><td><${Tag} s=${c.status} /></td><td class="small">${day(c.created_at)}</td></tr>`)} /><${Shown} n=${d.customers.length} total=${d.total} />`}</${Screen}></${Card}>`;
}
function Customer({ id, me, toast }) {
  const load = useLoad('/admin/customers/' + id);
  const setStatus = async status => {
    const reason = await ask({ title: status === 'suspended' ? 'Suspend this account?' : 'Reactivate this account?', body: status === 'suspended' ? 'The customer is signed out everywhere and can’t log in until reactivated.' : null,
      input: status === 'suspended' ? 'Why? (kept in the audit log)' : 'Why? (kept in the audit log)', confirm: status === 'suspended' ? 'Suspend' : 'Reactivate', danger: status === 'suspended' });
    if (!reason) return;
    await api(`/admin/customers/${id}/status`, { method: 'POST', body: { status, reason } });
    toast(status === 'suspended' ? 'Suspended. The customer has been signed out.' : 'Account reactivated.');
    load.reload();
  };
  return html`<${Screen} load=${load}>${d => html`
    <${Head} title=${d.customer.name || 'Customer'} sub=${d.customer.phone ? '+92 ' + d.customer.phone : 'Closed account'}>
      <a class="btn sm sec" href="#customers">All customers</a>
      ${me.role === 'admin' && d.customer.status === 'active' && html`<${Act} cls="btn sm danger" run=${() => setStatus('suspended')}>Suspend</${Act}>`}
      ${me.role === 'admin' && d.customer.status === 'suspended' && html`<${Act} cls="btn sm" run=${() => setStatus('active')}>Reactivate</${Act}>`}
    </${Head}>
    <div class="grid g2">
      <${Card} title="Profile"><dl class="kv">
        <dt>Account</dt><dd><${Tag} s=${d.customer.status} /></dd><dt>Identity</dt><dd><${Tag} s=${d.customer.kyc_status} /> ${d.customer.kyc_at ? day(d.customer.kyc_at) : ''}</dd>
        <dt>CNIC</dt><dd class="mono">${d.customer.cnic || '—'}</dd><dt>Date of birth</dt><dd>${d.customer.dob ? day(d.customer.dob) : '—'}</dd>
        <dt>Email</dt><dd>${d.customer.email || '—'}</dd><dt>Address</dt><dd>${d.customer.address || '—'}</dd><dt>Joined</dt><dd>${day(d.customer.created_at)}</dd>
        ${d.customer.closed_at && html`<dt>Closed</dt><dd>${day(d.customer.closed_at)} (was +92 ${d.customer.closed_phone})</dd>`}</dl></${Card}>
      <${Card} title=${'Wallet · ' + pkr(d.wallet.total_value_pkr)}><${Table} head=${['Product', '#Units', '#Reserved', '#Value']} empty="No metal held." rows=${d.wallet.holdings.map(h => html`<tr>
        <td>${productName(h.product_id)}</td><td class="r num">${h.units}</td><td class="r num">${h.reserved || 0}</td><td class="r num">${pkr(h.value_pkr)}</td></tr>`)} /></${Card}>
      <${Card} title="Orders"><${Table} head=${['Receipt', '#Total', 'Status', 'Date']} empty="No orders." rows=${d.orders.map(o => html`<tr>
        <td class="mono small">${o.receipt_no || '—'}</td><td class="r num">${pkr(o.total_pkr)}</td><td><${Tag} s=${o.status} /></td><td class="small">${when(o.created_at)}</td></tr>`)} /></${Card}>
      <${Card} title="Collections"><${Table} head=${['Product', '#Units', 'Dealer', 'Status', 'Date']} empty="No collections." rows=${d.redemptions.map(r => html`<tr>
        <td>${productName(r.product_id)}</td><td class="r num">${r.units}</td><td>${r.dealer_name || r.dealer_id}</td><td><${Tag} s=${r.status} /></td><td class="small">${when(r.created_at)}</td></tr>`)} /></${Card}>
      <${Card} title="Identity checks"><${Table} head=${['Provider', 'Status', 'Reason', 'Decided']} empty="No checks." rows=${d.kyc.map(k => html`<tr>
        <td>${k.provider}</td><td><${Tag} s=${k.status} /></td><td class="small">${k.reason || '—'}</td><td class="small">${k.decided_at ? when(k.decided_at) + ' · ' + (k.decided_by || '') : '—'}</td></tr>`)} /></${Card}>
    </div>`}</${Screen}>`;
}

// ---------- doorstep appraisals ----------
const SLOT_DAY = d => new Date(d + 'T00:00:00').toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'short' });
function Appraisals({ toast }) {
  const [status, setStatus] = useState('booked');
  const load = useLoad('/admin/appraisals?status=' + status);
  const [act, setAct] = useState(null);                       // { a, action }
  const [f, setF] = useState({});
  const run = async () => {
    await api(`/admin/appraisals/${act.a.id}`, { method: 'POST', body: { action: act.action, ...f } });
    toast({ assign: 'Goldsmith assigned. The customer has been told.', complete: 'Result sent to the customer.', cancel: 'Visit cancelled. The customer has been told.' }[act.action]);
    setAct(null); setF({}); load.reload();
  };
  // Each visit starts with an empty form: nothing typed for one customer can be sent to another
  const open = (a, action) => { setF({}); setAct({ a, action }); };
  const close = () => { setAct(null); setF({}); };
  const items = a => (a.items || []).map(i => `${i.metal === 'silver' ? 'Silver' : 'Gold'}${i.karat ? ' ' + i.karat : ''}${i.approx_g ? ' ~' + i.approx_g + ' g' : ''}${i.note ? ' (' + i.note + ')' : ''}`).join(', ');
  return html`<${Head} title="Doorstep appraisals" sub="Paid visits: assign a goldsmith, then record the assay result">
      <${Seg} label="Status" value=${status} onChange=${setStatus} options=${[['booked', 'To assign'], ['confirmed', 'Assigned'], ['completed', 'Completed'], ['cancelled', 'Cancelled'], ['pending_payment', 'Awaiting payment']]} /></${Head}>
    <${Screen} load=${load}>${d => html`<${Card}><${Table} head=${['Visit', 'Customer', 'Address', 'Pieces', status === 'confirmed' ? 'Goldsmith' : 'Ref', '']} empty="Nothing here." rows=${d.appraisals.map(a => html`<tr>
      <td><b>${SLOT_DAY(a.date)}</b><div class="muted small">${a.slot}</div></td>
      <td>${a.customer_name || '—'}<div class="muted small">+92 ${a.phone}</div></td>
      <td class="small" style="max-width:240px">${a.address}, ${a.area}, ${a.city}${a.notes ? html`<div class="muted">${a.notes}</div>` : ''}</td>
      <td class="small" style="max-width:220px">${items(a)}</td>
      <td class="small">${status === 'confirmed' && a.goldsmith ? html`${a.goldsmith.name}<div class="muted">${a.goldsmith.phone} · code ${a.visit_code}</div>` : html`<span class="mono">${a.ref}</span>`}
        ${a.refund_due ? html`<div><span class="tag warn">refund due</span></div>` : ''}</td>
      <td class="r"><div class="row" style="justify-content:flex-end">
        ${a.status === 'booked' && html`<button class="btn sm" onClick=${() => open(a, 'assign')}>Assign</button>`}
        ${a.status === 'confirmed' && html`<button class="btn sm" onClick=${() => open(a, 'complete')}>Record result</button>`}
        ${['booked', 'confirmed'].includes(a.status) && html`<button class="btn sm sec" onClick=${() => open(a, 'cancel')}>Cancel</button>`}
        ${a.status === 'completed' && a.result && html`<span class="small muted" style="max-width:220px;display:inline-block">${a.result.summary}</span>`}
      </div></td></tr>`)} /><${Shown} n=${d.appraisals.length} total=${d.total} /></${Card}>`}</${Screen}>
    ${act && html`<${Modal} title=${{ assign: 'Assign goldsmith', complete: 'Record assay result', cancel: 'Cancel visit' }[act.action]} onClose=${close}>
      <p class="muted small">${act.a.ref} · ${SLOT_DAY(act.a.date)}, ${act.a.slot} · ${act.a.area}, ${act.a.city}</p>
      ${act.action === 'assign' && html`
        <label class="f"><span>Goldsmith’s name</span><input class="in" value=${f.name || ''} onInput=${e => setF({ ...f, name: e.target.value })} /></label>
        <label class="f"><span>Goldsmith’s phone</span><input class="in" inputmode="tel" value=${f.phone || ''} onInput=${e => setF({ ...f, phone: e.target.value })} />
          <small>Give the goldsmith the visit code <b class="mono">${act.a.visit_code}</b>. The customer opens the door only to someone who says it.</small></label>`}
      ${act.action === 'complete' && html`
        <div class="grid g2" style="gap:12px"><label class="f"><span>Karat found</span><input class="in" value=${f.karat || ''} placeholder="e.g. 21K" onInput=${e => setF({ ...f, karat: e.target.value })} /></label>
          <label class="f"><span>Net metal weight (g)</span><input class="in" inputmode="decimal" value=${f.net_g || ''} onInput=${e => setF({ ...f, net_g: e.target.value })} /></label></div>
        <label class="f"><span>Value offered (PKR, optional)</span><input class="in" inputmode="numeric" value=${f.value_pkr || ''} onInput=${e => setF({ ...f, value_pkr: e.target.value.replace(/\D/g, '') })} /></label>
        <label class="f"><span>Result for the customer</span><textarea class="in" rows="4" value=${f.summary || ''} onInput=${e => setF({ ...f, summary: e.target.value })}></textarea></label>`}
      ${act.action === 'cancel' && html`<label class="f"><span>Reason (sent to the customer)</span><input class="in" value=${f.reason || ''} onInput=${e => setF({ ...f, reason: e.target.value })} />
        <small>A paid visit cancelled by PGBX is marked for refund.</small></label>`}
      <div class="row" style="justify-content:flex-end"><button class="btn sec" onClick=${close}>Close</button>
        <${Act} cls=${act.action === 'cancel' ? 'btn danger' : 'btn'} run=${run}>${{ assign: 'Assign', complete: 'Send result', cancel: 'Cancel visit' }[act.action]}</${Act}></div>
    </${Modal}>`}`;
}

// ---------- gift orders ----------
const DESIGN = { plain: 'Plain', eid: 'Eid Mubarak', wedding: 'Wedding', birthday: 'Birthday', newborn: 'New baby', graduation: 'Graduation' };
function Gifts({ toast }) {
  const [status, setStatus] = useState('placed');
  const load = useLoad('/admin/gifts?status=' + status);
  const [act, setAct] = useState(null);
  const [f, setF] = useState({});
  const run = async () => {
    await api(`/admin/gifts/${act.g.id}`, { method: 'POST', body: { action: act.action, ...f } });
    toast('Updated. The customer has been told.'); setAct(null); setF({}); load.reload();
  };
  const NEXT = { placed: ['produce', 'Start production'], in_production: ['dispatch', 'Dispatch'], dispatched: ['deliver', 'Mark delivered'] };
  return html`<${Head} title="Gift orders" sub="Bullion and coins made to order and delivered by insured courier">
      <${Seg} label="Status" value=${status} onChange=${setStatus} options=${[['placed', 'New'], ['in_production', 'In production'], ['dispatched', 'Dispatched'], ['delivered', 'Delivered'], ['cancelled', 'Cancelled'], ['pending_payment', 'Awaiting payment']]} /></${Head}>
    <${Screen} load=${load}>${d => html`<${Card}><${Table} head=${['Deliver by', 'Piece', 'Engraving and card', 'Recipient', '#Total', '']} empty="Nothing here." rows=${d.gifts.map(g => html`<tr>
      <td><b>${SLOT_DAY(g.deliver_by)}</b><div class="muted small mono">${g.ref}</div></td>
      <td>${g.metal === 'silver' ? 'Silver' : 'Gold'} ${g.item_label} ${g.shape}<div class="muted small">${DESIGN[g.design]} · ${g.packaging} box</div></td>
      <td class="small" style="max-width:220px">${g.engraving ? html`<b>“${g.engraving}”</b>` : html`<span class="muted">No engraving</span>`}${g.message ? html`<div class="muted">${g.message}</div>` : ''}</td>
      <td class="small" style="max-width:240px">${g.recipient.name} · +92 ${g.recipient.phone}<div class="muted">${g.recipient.address}, ${g.recipient.city}</div><div class="muted">Ordered by ${g.customer_name || '—'}</div></td>
      <td class="r num">${pkr(g.total_pkr)}${g.refund_due ? html`<div><span class="tag warn">refund due</span></div>` : ''}</td>
      <td class="r"><div class="row" style="justify-content:flex-end">
        ${NEXT[g.status] && html`<button class="btn sm" onClick=${() => { setF({}); setAct({ g, action: NEXT[g.status][0] }); }}>${NEXT[g.status][1]}</button>`}
        ${['placed', 'in_production'].includes(g.status) && html`<button class="btn sm sec" onClick=${() => { setF({}); setAct({ g, action: 'cancel' }); }}>Cancel</button>`}
        ${g.tracking && html`<span class="small mono">${g.tracking}</span>`}
      </div></td></tr>`)} /><${Shown} n=${d.gifts.length} total=${d.total} /></${Card}>`}</${Screen}>
    ${act && html`<${Modal} title=${{ produce: 'Start production', dispatch: 'Dispatch', deliver: 'Mark delivered', cancel: 'Cancel order' }[act.action]} onClose=${() => setAct(null)}>
      <p class="muted small">${act.g.ref} · ${act.g.item_label} ${act.g.shape} for ${act.g.recipient.name}</p>
      ${act.action === 'dispatch' && html`<label class="f"><span>Courier tracking number</span><input class="in mono" value=${f.tracking || ''} onInput=${e => setF({ ...f, tracking: e.target.value })} />
        <small>Insured courier only. The recipient shows their CNIC on delivery.</small></label>`}
      ${act.action === 'cancel' && html`<label class="f"><span>Reason (sent to the customer)</span><input class="in" value=${f.reason || ''} onInput=${e => setF({ ...f, reason: e.target.value })} /><small>The payment is marked for refund.</small></label>`}
      ${act.action === 'produce' && html`<p class="small">Check the engraving spelling with the customer before production. It can’t be cancelled by the customer after this.</p>`}
      <div class="row" style="justify-content:flex-end"><button class="btn sec" onClick=${() => setAct(null)}>Close</button>
        <${Act} cls=${act.action === 'cancel' ? 'btn danger' : 'btn'} run=${run}>Confirm</${Act}></div>
    </${Modal}>`}`;
}

// ---------- $1 gold: tola lots, any transaction ID, payouts ----------
const grams = g => (g === null || g === undefined ? '—' : Number(g).toFixed(4) + ' g');
const MICRO_TABS = ['buy', 'sell', 'payouts', 'paid'];
function Micro({ id, toast }) {
  const [tab, setTab] = useState(MICRO_TABS.includes(id) ? id : 'buy');
  useEffect(() => { if (MICRO_TABS.includes(id)) setTab(id); }, [id]);
  const [q, setQ] = useState('');
  const [found, setFound] = useState(null);
  const find = async e => { e && e.preventDefault(); if (!q.trim()) return; setFound(null);
    try { setFound(await api('/admin/micro/find?ref=' + encodeURIComponent(q.trim()))); } catch (x) { setFound({ error: x.message }); } };
  if (id && !MICRO_TABS.includes(id)) return html`<${MicroLot} ref_=${id} toast=${toast} />`;
  return html`<${Head} title="$1 gold & tola lots" sub="Customers buy $1 of gold at a time. Paid transactions from everyone fill 1-tola lots in order; each lot keeps every transaction ID in it." />
    <${Card}><form class="row" onSubmit=${find}><label class="f" style="flex:1;margin:0"><span class="sr">Transaction, order or lot ID</span>
      <input class="in mono" placeholder="Find a transaction, order or lot ID, e.g. PGBX-M-261006-1A2B3C4D" value=${q} onInput=${e => setQ(e.target.value)} /></label>
      <button class="btn">Find</button></form>
      ${found && html`<div style="margin-top:14px">${found.error ? html`<div class="note err" role="alert">${found.error}</div>`
        : found.lot ? html`<div class="spread"><span>Lot <b class="mono">${found.lot.ref}</b> · ${grams(found.lot.grams_filled)} · <${Tag} s=${found.lot.status} /></span><a class="btn sm" href=${'#micro/' + found.lot.ref}>Open lot</a></div>`
        : found.order ? html`<dl class="kv"><dt>Order</dt><dd class="mono">${found.order.ref}</dd><dt>Customer</dt><dd><a href=${'#customers/' + found.order.customer.id}>${found.order.customer.name || '—'}</a></dd>
            <dt>Paid</dt><dd>${found.order.units} × $1 · ${pkr(found.order.total_pkr)} · <${Tag} s=${found.order.status} /></dd>${found.order.note && html`<dt>Note</dt><dd>${found.order.note}</dd>`}
            <dt>Transactions</dt><dd class="mono small" style="overflow-wrap:anywhere">${found.order.transactions.join(', ')}</dd></dl>`
        : html`<dl class="kv"><dt>Transaction</dt><dd class="mono">${found.transaction.ref} (${found.transaction.side === 'buy' ? 'buy' : 'sell'})</dd>
            <dt>Customer</dt><dd><a href=${'#customers/' + found.transaction.customer.id}>${found.transaction.customer.name || '—'}</a> · +92 ${found.transaction.customer.phone || '—'}</dd>
            <dt>Amount</dt><dd>${grams(found.transaction.grams)} for ${pkr(found.transaction.amount_pkr)} at ${pkr(found.transaction.price_gram)}/g</dd>
            <dt>Status</dt><dd><${Tag} s=${found.transaction.status} /> ${when(found.transaction.created_at)}</dd>
            ${found.transaction.order_ref && html`<dt>Order</dt><dd class="mono">${found.transaction.order_ref}</dd>`}
            ${found.transaction.payout_to && found.transaction.side === 'sell' && html`<dt>Pay to</dt><dd class="mono">${found.transaction.payout_to}</dd>`}
            <dt>In lot</dt><dd>${found.transaction.lots.length ? found.transaction.lots.map(l => html`<a class="mono" style="margin-right:10px" href=${'#micro/' + l.ref}>${l.ref}</a><span class="small muted" style="margin-right:12px">${grams(l.grams)}</span>`) : 'Not in a lot yet (unpaid)'}</dd></dl>`}</div>`}
    </${Card}>
    <div style="margin:16px 0"><${Seg} label="View" value=${tab} onChange=${setTab} options=${[['buy', 'Buy lots'], ['sell', 'Sell lots'], ['payouts', 'Payouts to send'], ['paid', 'Payouts sent']]} /></div>
    ${(tab === 'buy' || tab === 'sell') && html`<${MicroLots} side=${tab} toast=${toast} />`}
    ${(tab === 'payouts' || tab === 'paid') && html`<${MicroPayouts} done=${tab === 'paid'} toast=${toast} />`}
    <p class="muted small">Payments to give back for $1 gold, appraisals, gifts and orders are under <a href="#refunds">Refunds</a>.</p>`;
}
function MicroLots({ side, toast }) {
  const load = useLoad('/admin/micro/lots?side=' + side);
  const [settling, setSettling] = useState(null);
  const [f, setF] = useState({ serial: '', note: '' });
  const settle = async () => {
    await api(`/admin/micro/lots/${settling.id}/settle`, { method: 'POST', body: f });
    toast(side === 'buy' ? 'Recorded: tola bar bought for this lot.' : 'Recorded: tola sold for this lot.'); setSettling(null); load.reload();
  };
  return html`<${Screen} load=${load}>${d => html`<div class="stack">
    <div class="grid g4">
      <div class="card stat"><div class="k">Gold customers hold</div><div class="v">${grams(d.totals.held)}</div><div class="muted small">bought ${grams(d.totals.bought)} · sold ${grams(d.totals.sold)}</div></div>
      <div class=${'card stat' + (d.lots.some(l => l.status === 'full') ? ' attn' : '')}><div class="k">${side === 'buy' ? 'Full lots: buy a tola bar' : 'Full lots: sell a tola'}</div><div class="v">${d.lots.filter(l => l.status === 'full').length}</div></div>
    </div>
    <${Card} title=${side === 'buy' ? 'Buy lots (1 tola each)' : 'Sell lots (1 tola each)'}><${Table} head=${['Lot', 'Filled', '#Transactions', '#Value at trade', 'Status', '']} empty="No lots yet. The first paid transaction starts lot 1." rows=${d.lots.map(l => html`<tr>
      <td><a class="mono" href=${'#micro/' + l.ref}>${l.ref}</a></td>
      <td style="min-width:160px"><div class="small">${grams(l.grams_filled)} of 1 tola (${Math.floor(l.grams_filled / l.grams_target * 100)}%)</div><div class="bar" role="img" aria-label=${Math.floor(l.grams_filled / l.grams_target * 100) + '% full'}><i style=${`width:${Math.min(100, l.grams_filled / l.grams_target * 100)}%`}></i></div></td>
      <td class="r num">${l.transactions}</td><td class="r num">${pkr(l.amount_pkr)}</td>
      <td><${Tag} s=${l.status} />${l.bar_serial && html`<div class="small mono">${l.bar_serial}</div>`}</td>
      <td class="r">${l.status === 'full' && html`<button class="btn sm" onClick=${() => { setF({ serial: '', note: '' }); setSettling(l); }}>${side === 'buy' ? 'Bar bought' : 'Tola sold'}</button>`}</td></tr>`)} /></${Card}>
    ${settling && html`<${Modal} title=${side === 'buy' ? 'Record the tola bar bought' : 'Record the tola sold'} onClose=${() => setSettling(null)}>
      <p class="small muted">${settling.ref} · ${settling.transactions} transactions · exactly 1 tola (11.664 g)</p>
      <label class="f"><span>${side === 'buy' ? 'Bar serial number' : 'Buyer’s reference (optional)'}</span><input class="in mono" value=${f.serial} onInput=${e => setF({ ...f, serial: e.target.value })} /></label>
      <label class="f"><span>Note (kept in the audit log)</span><input class="in" value=${f.note} onInput=${e => setF({ ...f, note: e.target.value })} placeholder="e.g. Bought from Saddar Sarafa, invoice 1182" /></label>
      <div class="row" style="justify-content:flex-end"><button class="btn sec" onClick=${() => setSettling(null)}>Cancel</button>
        <${Act} disabled=${side === 'buy' && f.serial.trim().length < 3} run=${settle}>Save</${Act}></div>
    </${Modal}>`}
  </div>`}</${Screen}>`;
}
function MicroLot({ ref_ }) {
  const [page, setPage] = useState(0);
  const load = useLoad(`/admin/micro/lots/${encodeURIComponent(ref_)}?page=${page}`);
  const download = async () => {
    const d = await api(`/admin/micro/lots/${encodeURIComponent(ref_)}/ids`);
    const text = [`${d.lot} · ${d.status}${d.bar_serial ? ' · bar ' + d.bar_serial : ''} · ${d.grams.toFixed(6)} g · ${d.ids.length} transactions`, 'transaction_id\tgrams_in_this_lot', ...d.ids].join('\n');
    const a = document.createElement('a'); a.href = URL.createObjectURL(new Blob([text], { type: 'text/plain' })); a.download = d.lot + '-transactions.txt'; a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  };
  return html`<${Screen} load=${load}>${d => html`
    <${Head} title=${'Lot ' + d.lot.ref} sub=${`${d.lot.side === 'buy' ? 'Buy' : 'Sell'} lot · ${grams(d.lot.grams_filled)} of 11.664 g · ${d.lot.transactions} transactions`}>
      <a class="btn sm sec" href="#micro">All lots</a><${Act} cls="btn sm" run=${download}>Download all IDs</${Act}></${Head}>
    <div class="grid g2">
      <${Card} title="Lot"><dl class="kv"><dt>Status</dt><dd><${Tag} s=${d.lot.status} /></dd><dt>Started</dt><dd>${when(d.lot.created_at)}</dd>
        <dt>Full</dt><dd>${d.lot.filled_at ? when(d.lot.filled_at) : 'Still filling'}</dd>
        ${d.lot.settled_at && html`<dt>${d.lot.side === 'buy' ? 'Bar bought' : 'Sold'}</dt><dd>${when(d.lot.settled_at)} · ${d.lot.settled_by}</dd>`}
        ${d.lot.bar_serial && html`<dt>${d.lot.side === 'buy' ? 'Bar serial' : 'Reference'}</dt><dd class="mono">${d.lot.bar_serial}</dd>`}
        ${d.lot.settle_note && html`<dt>Note</dt><dd>${d.lot.settle_note}</dd>`}</dl></${Card}>
    </div>
    <${Card} title="Transactions in this lot" action=${d.pages > 1 && html`<div class="row"><button class="btn sm sec" disabled=${page === 0} onClick=${() => setPage(page - 1)}>Previous</button><span class="small">Page ${page + 1} of ${d.pages}</span><button class="btn sm sec" disabled=${page + 1 >= d.pages} onClick=${() => setPage(page + 1)}>Next</button></div>`}>
      <${Table} head=${['Transaction ID', 'Customer', '#Grams in lot', '#Amount', 'When']} empty="No transactions yet." rows=${d.transactions.map(t => html`<tr>
        <td class="mono small">${t.ref}${t.grams < t.txn_grams && html` <span class="tag" title="Split between two lots">split</span>`}</td><td>${t.name || '—'}<div class="muted small">+92 ${t.phone || '—'}</div></td>
        <td class="r num">${Number(t.grams).toFixed(6)}</td><td class="r num">${pkr(t.amount_pkr)}</td><td class="small">${when(t.created_at)}</td></tr>`)} /></${Card}>`}</${Screen}>`;
}
function MicroPayouts({ done, toast }) {
  const load = useLoad('/admin/micro/payouts?status=' + (done ? 'paid_out' : 'pending_payout'));
  const [paying, setPaying] = useState(null);
  const [ref, setRef] = useState('');
  const pay = async () => { await api(`/admin/micro/payouts/${paying.id}`, { method: 'POST', body: { ref } }); toast('Payout recorded. The customer has been told.'); setPaying(null); load.reload(); };
  return html`<${Screen} load=${load}>${d => html`<${Card} title=${done ? 'Payouts sent' : 'Sales to pay out'}><${Table} head=${['Sale', 'Customer', '#Grams', '#Amount', 'Pay to (IBAN)', '']} empty=${done ? 'Nothing paid yet.' : 'No payouts waiting.'} rows=${d.payouts.map(p => html`<tr>
    <td class="mono small">${p.ref}<div class="muted">${when(p.created_at)}</div></td><td><a href=${'#customers/' + p.customer_id}>${p.name || '—'}</a><div class="muted small">+92 ${p.phone || '—'}</div></td>
    <td class="r num">${Number(p.grams).toFixed(4)}</td><td class="r num">${pkr(p.amount_pkr)}</td><td class="mono small">${p.payout_to}${p.sandbox && html`<div><span class="tag bad" title="This customer's gold was bought with test payments">test money: don’t pay</span></div>`}</td>
    <td class="r">${done ? html`<span class="small mono">${p.payout_ref}</span><div class="muted small">${when(p.paid_out_at)}</div>` : html`<button class="btn sm" onClick=${() => { setRef(''); setPaying(p); }}>Mark paid</button>`}</td></tr>`)} /><${Shown} n=${d.payouts.length} total=${d.total} /></${Card}>
    ${paying && html`<${Modal} title="Record the bank transfer" onClose=${() => setPaying(null)}>
      <p>Send <b>${pkr(paying.amount_pkr)}</b> to <span class="mono">${paying.payout_to}</span> (${paying.name || 'customer'}), then enter the transfer reference.</p>
      <label class="f"><span>Bank transfer reference</span><input class="in mono" value=${ref} onInput=${e => setRef(e.target.value)} /></label>
      <div class="row" style="justify-content:flex-end"><button class="btn sec" onClick=${() => setPaying(null)}>Cancel</button><${Act} disabled=${ref.trim().length < 4} run=${pay}>Mark paid</${Act}></div>
    </${Modal}>`}`}</${Screen}>`;
}
// ---------- refunds (H8): every payment PGBX must give back, from any service ----------
const REFUND_KIND = { order: 'Order', micro: '$1 gold', appraisal: 'Appraisal', gift: 'Gift' };
function Refunds({ toast }) {
  const [status, setStatus] = useState('due');
  const load = useLoad('/admin/refunds?status=' + status);
  const [paying, setPaying] = useState(null);
  const [ref, setRef] = useState('');
  const mark = async () => { await api(`/admin/refunds/${paying.id}`, { method: 'POST', body: { ref } }); toast('Refund recorded.'); setPaying(null); load.reload(); };
  return html`<${Head} title="Refunds" sub="Payments to give back: overpayments, payments for cancelled bookings and gifts, and payments that arrived too late">
      <${Seg} label="Status" value=${status} onChange=${setStatus} options=${[['due', 'To refund'], ['refunded', 'Refunded']]} /></${Head}>
    <${Screen} load=${load}>${d => html`<${Card}><${Table} head=${['What', 'Customer', '#Amount', 'Why', 'Paid with', status === 'due' ? '' : 'Refunded']} empty=${status === 'due' ? 'No refunds due.' : 'Nothing refunded yet.'} rows=${d.refunds.map(r => html`<tr>
      <td>${REFUND_KIND[r.kind] || r.kind}<div class="mono small">${r.entity_ref || String(r.entity_id).slice(0, 8)}</div></td>
      <td>${r.customer_id ? html`<a href=${'#customers/' + r.customer_id}>${r.name || 'Customer'}</a>` : '—'}<div class="muted small">${r.phone ? '+92 ' + r.phone : ''}</div></td>
      <td class="r num">${pkr(r.amount_pkr)}</td><td class="small" style="max-width:260px">${r.reason}</td>
      <td class="small">${r.provider || '—'}<div class="mono muted">${r.payment_ref || ''}</div>${r.provider === 'sandbox' && html`<div><span class="tag bad">test money: nothing to refund</span></div>`}</td>
      <td class="r">${r.status === 'due' ? html`<button class="btn sm" onClick=${() => { setRef(''); setPaying(r); }}>Mark refunded</button>` : html`<span class="small mono">${r.refund_ref}</span><div class="muted small">${when(r.refunded_at)} · ${r.refunded_by || ''}</div>`}</td></tr>`)} />
      <${Shown} n=${d.refunds.length} total=${d.total} /></${Card}>`}</${Screen}>
    ${paying && html`<${Modal} title="Record the refund" onClose=${() => setPaying(null)}>
      <p>Refund <b>${pkr(paying.amount_pkr)}</b> to ${paying.name || 'the customer'} through ${paying.provider || 'the payment provider'}${paying.payment_ref ? html` (payment <span class="mono">${paying.payment_ref}</span>)` : ''}, then enter the refund reference.</p>
      <label class="f"><span>Refund reference</span><input class="in mono" value=${ref} onInput=${e => setRef(e.target.value)} /></label>
      <div class="row" style="justify-content:flex-end"><button class="btn sec" onClick=${() => setPaying(null)}>Cancel</button><${Act} disabled=${ref.trim().length < 4} run=${mark}>Mark refunded</${Act}></div>
    </${Modal}>`}`;
}


// ---------- rate chats (admins and the support team) ----------
// Customers ask for the final rate of a specific purchase or sale; support replies and confirms the rate, which the
// customer then uses once, before it expires. Lists refresh every 8 s, an open chat every 3 s.
const KIND_LABEL = { buy_bars: 'Buy bars', sell_bars: 'Sell bars back', buy_micro: 'Buy $1 gold', sell_micro: 'Sell $1 gold', gift: 'Gift order' };
const CHAT_TAG = { open: 'warn', confirmed: 'gold', completed: 'ok', closed: '' };
const CHAT_LABEL = { open: 'awaiting rate', confirmed: 'rate confirmed', completed: 'order placed', closed: 'closed' };
const timeShort = d => new Date(d).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' });
// Photos are made smaller before sending (long side 1600 px, JPEG); PDFs go as they are
async function fileForUpload(file) {
  if (file.size > 12e6) throw new Error('That file is too large.');
  if (/^image\//.test(file.type) && (file.size > 600e3 || file.type === 'image/heic')) {
    const img = await createImageBitmap(file).catch(() => null);
    if (img) {
      const k = Math.min(1, 1600 / Math.max(img.width, img.height)), c = document.createElement('canvas');
      c.width = Math.round(img.width * k); c.height = Math.round(img.height * k); c.getContext('2d').drawImage(img, 0, 0, c.width, c.height);
      const blob = await new Promise(r => c.toBlob(r, 'image/jpeg', 0.85));
      return { name: file.name.replace(/\.\w+$/, '') + '.jpg', mime: 'image/jpeg', data: await b64(blob) };
    }
  }
  if (!['image/jpeg', 'image/png', 'image/webp', 'application/pdf'].includes(file.type)) throw new Error('Send a photo (JPEG, PNG or WebP) or a PDF.');
  if (file.size > 2621440) throw new Error('Files can be up to 2.5 MB.');
  return { name: file.name, mime: file.type, data: await b64(file) };
}
const b64 = blob => new Promise((ok, bad) => { const r = new FileReader(); r.onload = () => ok(String(r.result).split(',')[1]); r.onerror = bad; r.readAsDataURL(blob); });
function Attachment({ chatId, a }) {
  const [url, setUrl] = useState(null);
  const [err, setErr] = useState(false);
  useEffect(() => { let u = null, live = true;
    api(`/support/chats/${chatId}/attachments/${a.id}`).then(d => { if (!live) return; const bin = Uint8Array.from(atob(d.attachment.data), c => c.charCodeAt(0)); u = URL.createObjectURL(new Blob([bin], { type: d.attachment.mime })); setUrl(u); }, () => live && setErr(true));
    return () => { live = false; u && URL.revokeObjectURL(u); }; }, [a.id]);
  if (err) return html`<span class="small muted">File no longer available</span>`;
  if (!url) return html`<span class="small muted">Loading ${a.name}…</span>`;
  return a.mime.startsWith('image/') ? html`<a href=${url} target="_blank" rel="noopener"><img class="chat-img" src=${url} alt=${a.name} /></a>`
    : html`<a class="btn sm sec" href=${url} download=${a.name}>📄 ${a.name}</a>`;
}
function Chats({ id, me, toast }) {
  const [status, setStatus] = useState('active');
  const [q, setQ] = useState(''); const [term, setTerm] = useState('');
  useEffect(() => { const t = setTimeout(() => setTerm(q.trim()), 300); return () => clearTimeout(t); }, [q]);
  const list = useLoad(`/support/chats?status=${status}&q=${encodeURIComponent(term)}`);
  useEffect(() => { const t = setInterval(() => document.visibilityState === 'visible' && list.reload(), 8000); return () => clearInterval(t); }, [status, term]);
  const rows = list.data ? list.data.chats : [];
  const listView = html`<div class="chat-list">
    <div class="row" style="margin-bottom:10px"><${Seg} label="Status" value=${status} onChange=${setStatus} options=${[['active', 'Active'], ['completed', 'Order placed'], ['closed', 'Closed']]} /></div>
    <label class="f" style="margin-bottom:10px"><span class="sr">Search</span><input class="in" type="search" placeholder="Customer, mobile or chat ID" value=${q} onInput=${e => setQ(e.target.value)} /></label>
    ${list.error && html`<${Failed} error=${list.error} retry=${list.reload} />`}
    ${!list.data && !list.error ? html`<${Loading} />` : rows.length === 0 ? html`<div class="empty">${status === 'active' ? 'No active chats.' : 'Nothing here.'}</div>`
      : rows.map(c => html`<a class=${'chat-row' + (c.id === id ? ' on' : '') + (c.waiting ? ' waiting' : '')} href=${'#chats/' + c.id}>
          <div class="spread"><b>${c.customer.name || (c.customer.phone ? '+92 ' + c.customer.phone : 'Customer')}</b><span class="small muted">${ago(c.last_message_at)}</span></div>
          <div class="small">${c.summary}</div>
          <div class="small muted mono">${c.ref}${c.customer.name && c.customer.phone ? ' · +92 ' + c.customer.phone : ''}</div>
          <div class="spread small muted" style="margin-top:2px"><span class="ellipsis">${c.last_body || ''}</span>${c.waiting ? html`<span class="tag warn">reply</span>` : html`<${Tag} s=${c.status} />`}</div>
        </a>`)}
    ${list.data && html`<${Shown} n=${rows.length} total=${list.data.total} />`}
  </div>`;
  return html`<${Head} title="Rate chats" sub="Customers ask here for the final rate before buying or selling. Confirm a rate to let them place the order at it." />
    <div class=${'chat-shell' + (id ? ' has-thread' : '')}>
      ${listView}
      ${id ? html`<${ChatThread} key=${id} id=${id} me=${me} toast=${toast} onChange=${list.reload} />` : html`<div class="chat-thread card empty-thread"><div class="empty">Choose a chat on the left.</div></div>`}
    </div>`;
}
function ChatThread({ id, me, toast, onChange }) {
  const [d, setD] = useState(null);
  const [err, setErr] = useState(null);
  const [msgs, setMsgs] = useState([]);
  const [conf, setConf] = useState(null);
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const [rate, setRate] = useState(null);                 // the confirm form: { prices, minutes, note }
  const last = useRef(0), box = useRef(null), fileRef = useRef(null);
  const add = list => { if (!list.length) return; last.current = list[list.length - 1].id; setMsgs(m => [...m, ...list.filter(x => !m.some(y => y.id === x.id))]); };
  useEffect(() => {
    let live = true;
    api(`/support/chats/${id}`).then(r => { if (!live) return; setD(r); setConf(r.confirmation); last.current = 0; setMsgs([]); add(r.messages); }, e => live && setErr(e));
    const t = setInterval(() => { if (document.visibilityState !== 'visible' || !last.current) return;
      api(`/support/chats/${id}?after=${last.current}`).then(r => { if (!live) return; add(r.messages); setConf(r.confirmation); if (r.messages.length) onChange(); }).catch(() => {}); }, 3000);
    return () => { live = false; clearInterval(t); };
  }, [id]);
  useEffect(() => { if (box.current) box.current.scrollTop = box.current.scrollHeight; }, [msgs.length]);
  if (err) return html`<div class="chat-thread"><${Failed} error=${err} /></div>`;
  if (!d) return html`<div class="chat-thread card"><${Loading} /></div>`;
  const c = d.chat, closed = c.status === 'closed', u = d.customer;
  const send = async () => {
    if (!text.trim() || busy) return; setBusy(true);
    try { const r = await api(`/support/chats/${id}/messages`, { method: 'POST', body: { body: text.trim() } }); add([r.message]); setText(''); onChange(); }
    catch (e) { toast(e.message, true); } finally { setBusy(false); }
  };
  const attach = async e => {
    const f = e.target.files && e.target.files[0]; e.target.value = ''; if (!f) return;
    setBusy(true);
    try { const up = await fileForUpload(f); const r = await api(`/support/chats/${id}/attachments`, { method: 'POST', body: { ...up, caption: text.trim() } }); add([r.message]); setText(''); }
    catch (x) { toast(x.message, true); } finally { setBusy(false); }
  };
  const sg = d.suggested && d.suggested.prices;
  const openRate = () => setRate({ prices: JSON.parse(JSON.stringify(sg || (c.kind === 'buy_bars' || c.kind === 'sell_bars' ? { unit: {} } : {}))), minutes: d.minutes, note: '' });
  const total = rate && rateTotal(c, rate.prices);
  const confirm = async () => {
    const r = await api(`/support/chats/${id}/confirm`, { method: 'POST', body: { prices: rate.prices, minutes: Number(rate.minutes), note: rate.note } });
    setConf(r.confirmation); setRate(null); toast('Rate confirmed. The customer has been told.'); onChange();
    const m = await api(`/support/chats/${id}?after=${last.current}`); add(m.messages);
  };
  const closeChat = async () => {
    const note = await ask({ title: 'Close this chat?', body: 'The customer can still read it but can’t reply or use its rate. They can start a new request any time.', input: 'Note to the customer (optional)', required: false, confirm: 'Close chat', danger: true });
    if (note === null) return;
    await api(`/support/chats/${id}/close`, { method: 'POST', body: { note } }); toast('Chat closed.'); onChange();
    const r = await api(`/support/chats/${id}`); setD(r); setConf(r.confirmation); last.current = 0; setMsgs([]); add(r.messages);
  };
  const confLive = conf && conf.status === 'valid' && new Date(conf.expires_at) > new Date();
  return html`<div class="chat-thread">
    <div class="card chat-head">
      <div class="spread"><div><a class="btn sm ghost back-link" href="#chats">‹ All chats</a><h2 style="margin:0">${u.name || 'Customer'} <span class="muted small">+92 ${u.phone || '—'}</span></h2>
        <div class="small muted">${KIND_LABEL[c.kind]} · <span class="mono">${c.ref}</span> · started ${when(c.created_at)}</div></div>
        <span class=${'tag ' + (CHAT_TAG[c.status] || '')}>${CHAT_LABEL[c.status]}</span></div>
      <div class="chat-ctx">
        <div><span class="k">Request</span><b>${c.summary}</b>${c.indicative_pkr ? html`<div class="small muted">App price when asked: ${pkr(c.indicative_pkr)} (indicative)</div>` : ''}</div>
        <div><span class="k">Market now</span><b>${d.suggested && d.suggested.total_pkr ? pkr(d.suggested.total_pkr) : '—'}</b><div class="small muted">${d.suggested ? 'PGBX prices from ' + ago(d.suggested.at) : 'No recent prices'}</div></div>
        <div><span class="k">Identity</span><${Tag} s=${u.kyc_status} /> ${u.status !== 'active' ? html`<${Tag} s=${u.status} />` : ''}</div>
        <div><span class="k">Bought today</span><b>${pkr(u.spent_today_pkr)}</b><div class="small muted">of ${pkr(u.daily_limit_pkr)} daily limit</div></div>
        <div><span class="k">Holds</span><b class="small">${u.holdings.length ? u.holdings.map(h => `${h.units} × ${productName(h.product_id)}`).join(', ') : 'No bars'}${u.micro_grams > 0 ? ` · ${u.micro_grams.toFixed(4)} g $1 gold` : ''}</b></div>
      </div>
      ${conf && html`<div class=${'note ' + (confLive ? 'ok' : '')} style="margin-top:10px">${conf.status === 'used' ? html`Rate used for <span class="mono">${conf.used_ref}</span>.`
        : confLive ? html`Confirmed ${pkr(conf.total_pkr)}, valid until ${timeShort(conf.expires_at)}.` : conf.status === 'withdrawn' ? 'The last confirmed rate was withdrawn.' : html`The confirmed ${pkr(conf.total_pkr)} expired at ${timeShort(conf.expires_at)}.`}</div>`}
    </div>
    <div class="card chat-msgs" ref=${box} aria-live="polite">
      ${msgs.map(m => html`<div class=${'msg ' + m.sender + (m.confirmation_id ? ' rate' : '')}>
        ${m.sender === 'system' ? html`<span>${m.body}</span>` : html`<div class="bubble">
          ${m.attachment && html`<${Attachment} chatId=${id} a=${m.attachment} />`}
          ${m.body && html`<div style="white-space:pre-wrap">${m.body}</div>`}
          <div class="meta">${m.sender === 'staff' ? (m.staff_name || 'PGBX') : (u.name || 'Customer').split(' ')[0]} · ${timeShort(m.created_at)}</div></div>`}
      </div>`)}
    </div>
    ${!closed ? html`<div class="card chat-compose">
      <textarea class="in" rows="2" placeholder="Reply to the customer" value=${text} onInput=${e => setText(e.target.value)} maxlength="2000"
        onKeyDown=${e => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send(); } }} aria-label="Reply"></textarea>
      <div class="row" style="justify-content:space-between;margin-top:8px;flex-wrap:wrap">
        <div class="row"><input type="file" ref=${fileRef} accept="image/jpeg,image/png,image/webp,application/pdf" style="display:none" onChange=${attach} />
          <button class="btn sm sec" disabled=${busy} onClick=${() => fileRef.current.click()}>Attach</button>
          <button class="btn sm sec" onClick=${closeChat}>Close chat</button></div>
        <div class="row"><button class="btn sm sec" onClick=${openRate}>${conf && confLive ? 'Confirm a new rate' : 'Confirm final rate'}</button>
          <button class="btn sm" disabled=${busy || !text.trim()} onClick=${send}>${busy ? 'Sending…' : 'Send'}</button></div>
      </div></div>` : html`<div class="note">This chat is closed.</div>`}
    ${rate && html`<${Modal} title="Confirm the final rate" onClose=${() => setRate(null)}>
      <p class="small muted">${c.summary}. The customer can use this rate once, until it expires.</p>
      ${(c.kind === 'buy_bars' || c.kind === 'sell_bars') && c.details.lines.map(l => html`<label class="f"><span>${l.units} × ${productName(l.product_id)}: price per bar (PKR)</span>
        <input class="in num" inputmode="numeric" value=${rate.prices.unit[l.product_id] ?? ''} onInput=${e => setRate({ ...rate, prices: { unit: { ...rate.prices.unit, [l.product_id]: num(e.target.value) } } })} />
        ${sg && html`<small>Market ${pkr(sg.unit[l.product_id])}</small>`}</label>`)}
      ${c.kind === 'buy_micro' && html`
        <label class="f"><span>Price of $1 (PKR)</span><input class="in num" inputmode="numeric" value=${rate.prices.unit_pkr ?? ''} onInput=${e => setRate({ ...rate, prices: { ...rate.prices, unit_pkr: num(e.target.value) } })} /></label>
        <label class="f"><span>Gold price per gram (PKR)</span><input class="in num" inputmode="decimal" value=${rate.prices.price_gram ?? ''} onInput=${e => setRate({ ...rate, prices: { ...rate.prices, price_gram: dec(e.target.value) } })} />
          <small>$1 buys ${rate.prices.unit_pkr && rate.prices.price_gram ? (rate.prices.unit_pkr / rate.prices.price_gram).toFixed(6) : '—'} g</small></label>`}
      ${c.kind === 'sell_micro' && html`<label class="f"><span>PGBX pays per gram (PKR)</span><input class="in num" inputmode="decimal" value=${rate.prices.price_gram ?? ''} onInput=${e => setRate({ ...rate, prices: { price_gram: dec(e.target.value) } })} />
        <small>${Number(c.details.grams).toFixed(4)} g</small></label>`}
      ${c.kind === 'gift' && [['metal_pkr', 'Metal (PKR)'], ['making_pkr', 'Making and engraving (PKR)'], ['packaging_pkr', 'Packaging (PKR)'], ['delivery_pkr', 'Insured delivery (PKR)']].map(([k, l]) => html`
        <label class="f"><span>${l}</span><input class="in num" inputmode="numeric" value=${rate.prices[k] ?? ''} onInput=${e => setRate({ ...rate, prices: { ...rate.prices, [k]: num(e.target.value) } })} /></label>`)}
      <div class="grid g2" style="gap:12px"><label class="f"><span>Valid for (minutes)</span><input class="in" inputmode="numeric" value=${rate.minutes} onInput=${e => setRate({ ...rate, minutes: e.target.value.replace(/\D/g, '') })} /></label>
        <div class="f"><span class="small" style="font-weight:600">Customer pays${c.kind.startsWith('sell') ? ' / receives' : ''}</span><div style="font:600 22px var(--serif);margin-top:6px">${total ? pkr(total) : '—'}</div></div></div>
      <label class="f"><span>Note to the customer (optional)</span><input class="in" value=${rate.note} maxlength="300" onInput=${e => setRate({ ...rate, note: e.target.value })} placeholder="e.g. Includes today’s premium" /></label>
      <div class="row" style="justify-content:flex-end"><button class="btn sec" onClick=${() => setRate(null)}>Cancel</button>
        <${Act} disabled=${!total || !Number(rate.minutes)} run=${confirm}>Confirm ${total ? pkr(total) : ''}</${Act}></div>
    </${Modal}>`}
  </div>`;
}
const num = v => { const x = String(v).replace(/[^\d]/g, ''); return x === '' ? '' : Number(x); };
const dec = v => { const x = String(v).replace(/[^\d.]/g, '').replace(/(\..*)\./g, '$1'); return x === '' ? '' : x.endsWith('.') ? x : Number(x); };
function rateTotal(c, p) {
  const n = v => Number(v) || 0;
  if (c.kind === 'buy_bars' || c.kind === 'sell_bars') return c.details.lines.every(l => n(p.unit && p.unit[l.product_id]) > 0) ? c.details.lines.reduce((a, l) => a + n(p.unit[l.product_id]) * l.units, 0) : 0;
  if (c.kind === 'buy_micro') return n(p.unit_pkr) > 0 && n(p.price_gram) > 0 ? n(p.unit_pkr) * c.details.units : 0;
  if (c.kind === 'sell_micro') return n(p.price_gram) > 0 ? Math.max(1, Math.floor(Number(c.details.grams) * n(p.price_gram))) : 0;
  return n(p.metal_pkr) > 0 ? n(p.metal_pkr) + n(p.making_pkr) + n(p.packaging_pkr) + n(p.delivery_pkr) : 0;
}

// ---------- bars sold back to PGBX ----------
function BarSales({ toast }) {
  const [done, setDone] = useState(false);
  const load = useLoad('/admin/bar-sales?status=' + (done ? 'paid_out' : 'pending_payout'));
  const [paying, setPaying] = useState(null);
  const [ref, setRef] = useState('');
  const pay = async () => { await api(`/admin/bar-sales/${paying.id}`, { method: 'POST', body: { ref } }); toast('Payment recorded. The customer has been told.'); setPaying(null); load.reload(); };
  return html`<${Head} title="Bar sell-backs" sub="Bars customers sold back to PGBX at a rate confirmed in chat. The bars have left their wallet; pay the amount to their bank account.">
      <${Seg} label="Status" value=${done ? 'paid' : 'due'} onChange=${v => setDone(v === 'paid')} options=${[['due', 'To pay'], ['paid', 'Paid']]} /></${Head}>
    <${Screen} load=${load}>${d => html`<${Card}><${Table} head=${['Sale', 'Customer', 'Bars', '#Amount', 'Pay to (IBAN)', '']} empty=${done ? 'Nothing paid yet.' : 'No payments waiting.'} rows=${d.sales.map(b => html`<tr>
      <td class="mono small">${b.ref}<div class="muted">${when(b.created_at)}</div></td><td><a href=${'#customers/' + b.customer.id}>${b.customer.name || '—'}</a><div class="muted small">+92 ${b.customer.phone || '—'}</div></td>
      <td class="small">${b.lines.map(l => `${l.units} × ${productName(l.product_id)} @ ${pkr(l.unit_price_pkr)}`).join(', ')}</td><td class="r num">${pkr(b.total_pkr)}</td><td class="mono small">${b.payout_to}</td>
      <td class="r">${done ? html`<span class="small mono">${b.payout_ref}</span><div class="muted small">${when(b.paid_out_at)}</div>` : html`<button class="btn sm" onClick=${() => { setRef(''); setPaying(b); }}>Mark paid</button>`}</td></tr>`)} />
      <${Shown} n=${d.sales.length} total=${d.total} /></${Card}>`}</${Screen}>
    ${paying && html`<${Modal} title="Record the bank transfer" onClose=${() => setPaying(null)}>
      <p>Send <b>${pkr(paying.total_pkr)}</b> to <span class="mono">${paying.payout_to}</span> (${paying.customer.name || 'customer'}), then enter the transfer reference.</p>
      <label class="f"><span>Bank transfer reference</span><input class="in mono" value=${ref} onInput=${e => setRef(e.target.value)} /></label>
      <div class="row" style="justify-content:flex-end"><button class="btn sec" onClick=${() => setPaying(null)}>Cancel</button><${Act} disabled=${ref.trim().length < 4} run=${pay}>Mark paid</${Act}></div>
    </${Modal}>`}`;
}

// ---------- support ----------
function Support({ toast }) {
  const [status, setStatus] = useState('open');
  const load = useLoad('/admin/support?status=' + status);
  const [open, setOpen] = useState(null);
  const [reply, setReply] = useState('');
  const close = async () => { await api(`/admin/support/${open.id}/close`, { method: 'POST', body: { reply } }); toast(reply ? 'Reply sent and request closed.' : 'Request closed.'); setOpen(null); setReply(''); load.reload(); };
  return html`<${Head} title="Support" sub="Problems customers report from the app">
      <${Seg} label="Status" value=${status} onChange=${setStatus} options=${[['open', 'Open'], ['closed', 'Closed']]} /></${Head}>
    <${Screen} load=${load}>${d => html`<${Card}><${Table} head=${['Customer', 'Topic', 'Message', 'Sent', '']} empty=${status === 'open' ? 'No open requests.' : 'Nothing closed yet.'} rows=${d.requests.map(r => html`<tr>
      <td>${r.customer_id ? html`<a href=${'#customers/' + r.customer_id}>${r.name || 'Customer'}</a>` : '—'}<div class="muted small">${r.phone ? '+92 ' + r.phone : ''}</div></td>
      <td><span class="tag">${r.topic}</span></td><td class="small" style="max-width:420px">${r.body}</td><td class="small">${ago(r.created_at)}</td>
      <td class="r">${r.status === 'open' ? html`<button class="btn sm" onClick=${() => { setReply(''); setOpen(r); }}>Reply</button>` : html`<span class="muted small">${when(r.closed_at)}</span>`}</td></tr>`)} /><${Shown} n=${d.requests.length} total=${d.total} /></${Card}>`}</${Screen}>
    ${open && html`<${Modal} title="Reply and close" onClose=${() => setOpen(null)}>
      <p class="small" style="background:var(--fill);padding:12px;border-radius:8px">${open.body}</p>
      <label class="f"><span>Reply (sent to the customer’s inbox; optional)</span><textarea class="in" rows="4" value=${reply} onInput=${e => setReply(e.target.value)}></textarea>
        <small>Never ask for a PIN or login code. For anything sensitive, call the customer on their registered number.</small></label>
      <div class="row" style="justify-content:flex-end"><button class="btn sec" onClick=${() => setOpen(null)}>Cancel</button><${Act} run=${close}>${reply.trim() ? 'Send and close' : 'Close without reply'}</${Act}></div>
    </${Modal}>`}`;
}

// ---------- dealers and stock ----------
function Dealers({ me, toast }) {
  const load = useLoad('/admin/dealers');
  const products = useLoad('/admin/products');
  const [adding, setAdding] = useState(false);
  const [f, setF] = useState({ id: '', name: '', area: '', address: '', phone: '', hours: '' });
  const setStock = async (dealer, product, value) => {
    const v = String(value).trim();
    if (!/^\d+$/.test(v)) { toast('Enter a whole number of 0 or more. An empty field isn’t saved.', true); load.reload(); return; }
    const units = Number(v);
    const note = await ask({ title: `Set ${productName(product)} at ${dealer.name} to ${units}?`, input: 'Reason (e.g. delivery, count correction)', confirm: 'Save stock' });
    if (note === null) { load.reload(); return; }
    try { await api(`/admin/dealers/${dealer.id}/stock`, { method: 'PUT', body: { product_id: product, units, note } }); toast('Stock updated.'); }
    catch (e) { toast(e.message, true); }
    load.reload();
  };
  const add = async () => { await api('/admin/dealers', { method: 'POST', body: f }); toast('Dealer added with zero stock.'); setAdding(false); setF({ id: '', name: '', area: '', address: '', phone: '', hours: '' }); load.reload(); };
  const toggle = async d => { await api(`/admin/dealers/${d.id}`, { method: 'PATCH', body: { active: !d.active } }); toast(d.active ? 'Dealer hidden from customers.' : 'Dealer visible to customers.'); load.reload(); };
  return html`<${Head} title="Dealers & stock" sub="Stock here is what customers can reserve. Change a number and press Enter or leave the field to save.">
      ${me.role === 'admin' && html`<button class="btn sm" onClick=${() => setAdding(true)}>Add dealer</button>`}</${Head}>
    ${products.error && html`<${Failed} error=${products.error} retry=${products.reload} />`}
    <${Screen} load=${load}>${d => !products.data ? (products.error ? null : html`<div class="card"><${Loading} /></div>`) : html`<div class="stack">${d.dealers.map(dl => html`<${Card} title=${dl.name}
        action=${html`<div class="row"><${Tag} s=${dl.active ? 'active' : 'closed'} />${me.role === 'admin' && html`<${Act} cls="btn sm sec" confirm=${dl.active ? `Hide ${dl.name} from customers? Active collections there still work.` : null} run=${() => toggle(dl)}>${dl.active ? 'Deactivate' : 'Activate'}</${Act}>`}</div>`}>
      <p class="muted small">${dl.area} · ${dl.address || 'No address'} · ${dl.phone || 'No phone'} · ${dl.hours || 'No hours'}</p>
      <div class="tbl-wrap"><table><thead><tr>${products.data.products.map(p => html`<th class="r">${productName(p.id).replace(/^(Gold|Silver) /, m => m[0] + ' ')}</th>`)}</tr></thead>
        <tbody><tr>${products.data.products.map(p => html`<td class="r"><input class="in sm num" style="width:64px;text-align:right" inputmode="numeric" aria-label=${`${productName(p.id)} at ${dl.name}`}
          value=${dl.stock[p.id] ?? 0} onKeyDown=${e => e.key === 'Enter' && e.target.blur()}
          onChange=${e => setStock(dl, p.id, e.target.value)} /></td>`)}</tr></tbody></table></div>
    </${Card}>`)}</div>`}</${Screen}>
    ${adding && html`<${Modal} title="Add dealer" onClose=${() => setAdding(false)}>
      ${[['id', 'Short ID', 'Letters, numbers and dashes, e.g. lhr-gulberg'], ['name', 'Name'], ['area', 'Area and city'], ['address', 'Address'], ['phone', 'Phone'], ['hours', 'Opening hours', 'e.g. 10:00 – 20:00']].map(([k, l, hint]) => html`
        <label class="f"><span>${l}</span><input class="in" value=${f[k]} onInput=${e => setF({ ...f, [k]: e.target.value })} />${hint && html`<small>${hint}</small>`}</label>`)}
      <div class="row" style="justify-content:flex-end"><button class="btn sec" onClick=${() => setAdding(false)}>Cancel</button><${Act} disabled=${!f.id || !f.name || !f.area} run=${add}>Add dealer</${Act}></div>
    </${Modal}>`}`;
}

// ---------- products ----------
function Products({ me, toast }) {
  const load = useLoad('/admin/products');
  const save = async (p, body) => { try { await api(`/admin/products/${p.id}`, { method: 'PATCH', body }); toast('Saved. New price locks use it straight away.'); } catch (e) { toast(e.message, true); } load.reload(); };
  const admin = me.role === 'admin';
  return html`<${Head} title="Products & premiums" sub="Price = metal rate for the weight + the premium below (rounded to the nearest rupee)" />
    <${Screen} load=${load}>${d => html`<${Card}><${Table} head=${['Product', '#Weight (g)', '#Premium per unit', 'Sold']} empty="No products." rows=${d.products.map(p => html`<tr>
      <td>${productName(p.id)}</td><td class="r num">${p.grams}</td>
      <td class="r">${admin ? html`<input class="in sm num" style="width:110px;text-align:right" inputmode="numeric" aria-label=${'Premium for ' + productName(p.id)} value=${p.premium_pkr}
        onKeyDown=${e => e.key === 'Enter' && e.target.blur()} onChange=${e => {
          const v = e.target.value.trim().replace(/,/g, '');
          if (!/^\d+$/.test(v)) { toast('Enter the premium as a whole number of rupees (0 or more).', true); load.reload(); return; }
          ask({ title: `Change the premium for ${productName(p.id)}?`, body: `From ${pkr(p.premium_pkr)} to ${pkr(Number(v))}. New price locks use it straight away.`, confirm: 'Change premium' })
            .then(okd => (okd ? save(p, { premium_pkr: Number(v) }) : load.reload()));
        }} />` : pkr(p.premium_pkr)}</td>
      <td>${admin ? html`<label class="row small"><input type="checkbox" checked=${p.active} onChange=${e => { const on = e.target.checked; e.target.checked = p.active;
          ask({ title: on ? `Put ${productName(p.id)} on sale?` : `Hide ${productName(p.id)} from customers?`, body: on ? 'Customers can buy it straight away.' : 'Customers can’t buy it until it’s put back on sale. What they hold isn’t affected.', confirm: on ? 'Put on sale' : 'Hide product', danger: !on })
            .then(okd => okd && save(p, { active: on })); }} /> ${p.active ? 'On sale' : 'Hidden'}</label>` : html`<${Tag} s=${p.active ? 'active' : 'closed'} />`}</td></tr>`)} />
      <p class="muted small" style="margin:12px 0 0">Sample premiums until PGBX confirms the real ones.</p></${Card}>`}</${Screen}>`;
}

// ---------- reconciliation ----------
function Reconciliation({ toast }) {
  const [dayV, setDay] = useState(pkToday());
  const load = useLoad('/admin/reconciliation?day=' + dayV);
  const [count, setCount] = useState(null);
  const saveCount = async () => { await api('/admin/vault', { method: 'POST', body: count }); toast('Vault count recorded.'); setCount(null); load.reload(); };
  return html`<${Head} title="Reconciliation" sub="Money received against orders credited, and metal owed against metal held">
      <input class="in" type="date" style="width:auto" value=${dayV} max=${pkToday()} onChange=${e => setDay(e.target.value)} aria-label="Day" /></${Head}>
    <${Screen} load=${load}>${({ reconciliation: r }) => {
      const money = r.payments_succeeded_pkr === r.orders_credited_pkr;
      return html`<div class="stack">
        <div class="grid g4">
          <div class="card stat"><div class="k">Payments received</div><div class="v">${pkr(r.payments_succeeded_pkr)}</div></div>
          <div class="card stat"><div class="k">Orders credited</div><div class="v">${pkr(r.orders_credited_pkr)}</div></div>
          <div class=${'card stat' + (money ? '' : ' attn')}><div class="k">Difference</div><div class="v">${pkr(r.payments_succeeded_pkr - r.orders_credited_pkr)}</div><div class="muted small">${money ? 'Matches' : 'Includes flagged, late or cross-day payments'}</div></div>
          <a class=${'card stat' + (r.flagged_orders ? ' attn' : '')} href="#orders" style="text-decoration:none;color:inherit"><div class="k">Flagged orders</div><div class="v">${r.flagged_orders}</div></a>
        </div>
        ${r.paid_not_credited.length > 0 && html`<div class="note warn">Paid but not credited: ${r.paid_not_credited.map(o => o.receipt || o.order.slice(0, 8)).join(', ')}</div>`}
        ${r.credited_without_payment.length > 0 && html`<div class="note err">Credited without a recorded payment: ${r.credited_without_payment.map(o => o.receipt).join(', ')}. Investigate now.</div>`}
        <${Card} title="Metal" action=${html`<button class="btn sm" onClick=${() => setCount({ product_id: r.metal[0]?.product_id, units: '', note: '' })}>Record vault count</button>`}>
          <${Table} head=${['Product', '#Owed to customers', '#Reserved', '#At dealers', '#In vault (last count)', '#Cover']} empty="No products." rows=${[...r.metal].sort(byProduct).map(m => {
            const cover = (m.vault_units ?? 0) + m.dealer_units - m.customer_units;
            return html`<tr><td>${productName(m.product_id)}</td><td class="r num">${m.customer_units}</td><td class="r num">${m.reserved_units}</td><td class="r num">${m.dealer_units}</td>
              <td class="r num">${m.vault_units ?? '—'}<div class="muted small">${m.vault_counted_at ? day(m.vault_counted_at) : 'never counted'}</div></td>
              <td class="r num">${cover < 0 ? html`<span class="tag bad">${cover}</span>` : html`<span class="tag ok">+${cover}</span>`}</td></tr>`;
          })} />
          <p class="muted small" style="margin:12px 0 0">Cover = vault + dealer stock − units owed to customers. A negative number means PGBX holds less metal than customers own.</p>
        </${Card}>
        ${r.extra_payments && r.extra_payments.length > 0 && html`<div class="note warn">Orders paid more than once: ${r.extra_payments.length}. The extra payments are in <a href="#refunds">Refunds</a>.</div>`}
        ${r.services && html`<${Card} title="$1 gold and services: money received this day">
          <dl class="kv">${['micro', 'appraisal', 'gift'].map(k => html`<dt>${{ micro: '$1 gold', appraisal: 'Doorstep appraisals', gift: 'Gift orders' }[k]}</dt><dd class="num">${pkr((r.services.received_pkr || {})[k] || 0)}</dd>`)}
            <dt>$1 gold credited</dt><dd class="num">${pkr(r.services.micro_credited_pkr)}</dd></dl>
          ${r.services.micro_paid_not_credited.length > 0 && html`<div class="note warn" style="margin-top:12px">$1 gold paid but not credited: ${r.services.micro_paid_not_credited.map(o => o.ref).join(', ')}</div>`}
        </${Card}>`}
        ${r.micro && (() => { const gap = Number(r.micro.bars_held_grams) - Number(r.micro.customer_grams);
          return html`<${Card} title="$1 gold metal">
            <div class="grid g4">
              <div class="card stat"><div class="k">Customers own</div><div class="v">${Number(r.micro.customer_grams).toFixed(4)} g</div></div>
              <div class="card stat"><div class="k">Tola bars held</div><div class="v">${Number(r.micro.bars_held_grams).toFixed(3)} g</div><div class="muted small">bought − sold lots</div></div>
              <div class=${'card stat' + (r.micro.buy_lots_to_settle ? ' attn' : '')}><div class="k">Bars still to buy</div><div class="v">${r.micro.buy_lots_to_settle}</div><div class="muted small">${r.micro.sell_lots_to_settle} tola to sell</div></div>
              <a class=${'card stat' + (r.micro.payouts_overdue ? ' attn' : '')} href="#micro/payouts" style="text-decoration:none;color:inherit"><div class="k">Payouts to send</div><div class="v">${r.micro.payouts_pending}</div><div class="muted small">${pkr(r.micro.payouts_pending_pkr)}${r.micro.payouts_overdue ? ` · ${r.micro.payouts_overdue} over 2 days` : ''}</div></a>
            </div>
            <p class="muted small" style="margin:12px 0 0">The open lot is always partly filled, so bars held is normally a little below what customers own (less than 1 tola) until it fills. ${gap < -11.664 ? html`<b style="color:var(--danger)">More than a tola short: buy the bars for the full lots.</b>` : ''}</p>
          </${Card}>`; })()}
        ${r.refunds_due && html`<a class=${'card stat' + (r.refunds_due.count ? ' attn' : '')} href="#refunds" style="text-decoration:none;color:inherit"><div class="k">Refunds to pay</div><div class="v">${r.refunds_due.count}</div><div class="muted small">${pkr(r.refunds_due.pkr)}</div></a>`}
      </div>`;
    }}</${Screen}>
    ${count && html`<${Modal} title="Record vault count" onClose=${() => setCount(null)}>
      <label class="f"><span>Product</span><select class="in" value=${count.product_id} onChange=${e => setCount({ ...count, product_id: e.target.value })}>
        ${(load.data?.reconciliation.metal || []).map(m => html`<option value=${m.product_id}>${productName(m.product_id)}</option>`)}</select></label>
      <label class="f"><span>Units counted</span><input class="in" inputmode="numeric" value=${count.units} onInput=${e => setCount({ ...count, units: e.target.value.replace(/\D/g, '') })} /></label>
      <label class="f"><span>Note</span><input class="in" value=${count.note} onInput=${e => setCount({ ...count, note: e.target.value })} placeholder="e.g. Monthly count, counted with auditor" /></label>
      <div class="row" style="justify-content:flex-end"><button class="btn sec" onClick=${() => setCount(null)}>Cancel</button><${Act} disabled=${count.units === ''} run=${() => saveCount()}>Save count</${Act}></div>
    </${Modal}>`}`;
}

// ---------- settings ----------
const SETTING_HELP = {
  max_units_per_order: ['Most bars in one order', 'units'], daily_limit_pkr: ['Daily purchase limit per customer', 'PKR'], min_purchase_pkr: ['Minimum order', 'PKR, empty for none'],
  price_lock_seconds: ['Price lock length', 'seconds'], rate_stale_seconds: ['Prices count as old after', 'seconds'], redemption_valid_hours: ['Collection code valid for', 'hours'],
  order_payment_minutes: ['Time to pay an order', 'minutes'], session_days: ['Customers stay logged in for', 'days'], spread: ['Buy/sell spread', 'JSON'],
  retention_days: ['Keep closed accounts’ records for', 'days, empty until PGBX decides'], redemption_fee_pkr: ['Collection fee', 'PKR, empty for none'],
  purity: ['Fineness of each karat and silver standard', 'JSON'], buyback_deduction_pct: ['Jewellery buy-back deduction', '% by metal, JSON'],
  appraisal_fee_pkr: ['Doorstep appraisal fee', 'PKR'], appraisal_cities: ['Cities with doorstep appraisal', 'JSON list'], appraisal_slots: ['Appraisal time slots', 'JSON list, HH:MM-HH:MM'],
  appraisal_free_cancel_hours: ['Free appraisal cancellation until', 'hours before the visit'], gift_making_pkr: ['Gift making charges', 'PKR, JSON: plain, themed, engraving'],
  gift_packaging_pkr: ['Gift packaging', 'PKR, JSON: standard, premium'], gift_delivery_pkr: ['Gift insured delivery', 'PKR'], gift_lead_days: ['Gift earliest delivery', 'days after ordering'],
  gift_cities: ['Gift delivery cities', 'JSON list'],
  micro_usd: ['$1 gold: dollars per transaction', 'US$, converted at the live USD/PKR rate'], micro_max_units: ['$1 gold: most transactions per payment', 'count'],
  micro_min_sell_g: ['$1 gold: smallest sale', 'grams'],
};
function Settings({ me, toast }) {
  const load = useLoad('/admin/settings');
  const admin = me.role === 'admin';
  const save = async (key, text) => {
    let value;
    try { value = text.trim() === '' ? null : JSON.parse(text); } catch { toast('Enter a number, or valid JSON.', true); load.reload(); return; }
    if (!(await ask({ title: `Change “${SETTING_HELP[key]?.[0] || key}”?`, body: `New value: ${JSON.stringify(value)}. This applies to all customers straight away.`, confirm: 'Change setting' }))) { load.reload(); return; }
    try { await api('/admin/settings', { method: 'PATCH', body: { [key]: value } }); toast('Setting saved.'); } catch (e) { toast(e.message, true); }
    load.reload();
  };
  return html`<${Head} title="Settings" sub=${admin ? 'Business rules the app and server follow. Changes are recorded in the audit log.' : 'Only administrators can change settings.'} />
    <${Screen} load=${load}>${d => html`<${Card}><${Table} head=${['Setting', 'Value', 'Last changed']} empty="No settings." rows=${d.settings.map(s => html`<tr>
      <td>${SETTING_HELP[s.key]?.[0] || s.key}<div class="muted small mono">${s.key}${SETTING_HELP[s.key] ? ' · ' + SETTING_HELP[s.key][1] : ''}</div></td>
      <td>${admin ? html`<input class="in mono" style="min-width:140px" value=${s.value === null ? '' : JSON.stringify(s.value)} aria-label=${SETTING_HELP[s.key]?.[0] || s.key}
        onKeyDown=${e => e.key === 'Enter' && e.target.blur()} onChange=${e => save(s.key, e.target.value)} />` : html`<span class="mono">${s.value === null ? '— (not set)' : JSON.stringify(s.value)}</span>`}</td>
      <td class="small">${s.updated_by ? when(s.updated_at) + ' · ' + s.updated_by : 'Sample default'}</td></tr>`)} /></${Card}>`}</${Screen}>`;
}

// ---------- audit ----------
// Filters by kind of item, action (prefix, e.g. "payment." or "pin.locked"), who did it and the item's ID; pages back in time.
function Audit() {
  const [f, setF] = useState({ entity: '', action: '', actor: '', id: '' });
  const [q, setQ] = useState(f);
  const [before, setBefore] = useState([]);                     // stack of page starts, for Newer / Older
  useEffect(() => { const t = setTimeout(() => { setQ(f); setBefore([]); }, 350); return () => clearTimeout(t); }, [f.action, f.actor, f.id]);
  const params = new URLSearchParams({ entity: q.entity, action: q.action.trim(), actor: q.actor.trim(), id: q.id.trim(), ...(before.length ? { before: before[before.length - 1] } : {}) });
  const load = useLoad('/admin/audit?' + params);
  const ent = v => { setF({ ...f, entity: v }); setQ({ ...q, entity: v }); setBefore([]); };
  return html`<${Head} title="Audit log" sub="Every important action, by whom and when. Entries can’t be edited or deleted." />
    <${Card}><div class="grid g4" style="gap:12px">
      <label class="f" style="margin:0"><span>Item</span><select class="in" value=${f.entity} onChange=${e => ent(e.target.value)}>
        ${[['', 'Everything'], ['customer', 'Customers'], ['order', 'Orders'], ['redemption', 'Collections'], ['kyc', 'Identity checks'], ['appraisal', 'Appraisals'], ['gift', 'Gift orders'], ['micro', '$1 gold'], ['lot', 'Tola lots'], ['refund', 'Refunds'], ['support', 'Support'], ['staff', 'Staff'], ['setting', 'Settings'], ['dealer', 'Dealers'], ['product', 'Products']].map(([v, l]) => html`<option value=${v}>${l}</option>`)}
      </select></label>
      <label class="f" style="margin:0"><span>Action starts with</span><input class="in mono" placeholder="e.g. payment. or login" value=${f.action} onInput=${e => setF({ ...f, action: e.target.value })} /></label>
      <label class="f" style="margin:0"><span>Done by</span><input class="in mono" placeholder="e.g. staff:… or customer:…" value=${f.actor} onInput=${e => setF({ ...f, actor: e.target.value })} /></label>
      <label class="f" style="margin:0"><span>Item ID</span><input class="in mono" placeholder="Full ID" value=${f.id} onInput=${e => setF({ ...f, id: e.target.value })} /></label>
    </div></${Card}>
    <div style="height:16px"></div>
    <${Screen} load=${load}>${d => html`<${Card} action=${html`<div class="row"><button class="btn sm sec" disabled=${!before.length} onClick=${() => setBefore(before.slice(0, -1))}>Newer</button>
        <button class="btn sm sec" disabled=${!d.more} onClick=${() => setBefore([...before, d.entries[d.entries.length - 1].id])}>Older</button></div>`}>
      <${Table} head=${['When', 'Who', 'Action', 'Item', 'Details']} empty="No entries match." rows=${d.entries.map(a => html`<tr>
      <td class="small" style="white-space:nowrap">${when(a.at)}</td><td class="small mono">${a.actor}</td><td><span class="tag">${a.action}</span></td>
      <td class="small mono">${a.entity}${a.entity_id ? html` <button class="btn ghost sm mono" style="padding:0;min-height:0" title="Show everything for this item" onClick=${() => { setF({ ...f, id: String(a.entity_id) }); }}>${String(a.entity_id).slice(0, 8)}</button>` : ''}</td><td class="small mono" style="max-width:320px;overflow-wrap:anywhere">${a.data && Object.keys(a.data).length ? JSON.stringify(a.data) : ''}</td></tr>`)} /></${Card}>`}</${Screen}>`;
}

// ---------- staff ----------
function Staff({ me, toast }) {
  const load = useLoad('/admin/staff');
  const dealers = useLoad('/admin/dealers');
  const [adding, setAdding] = useState(false);
  const [f, setF] = useState({ name: '', email: '', role: 'ops', dealer_id: '' });
  const [setup, setSetup] = useState(null);
  const add = async () => { const r = await api('/admin/staff', { method: 'POST', body: f }); setAdding(false); setSetup({ ...r.setup, email: r.staff.email }); setF({ name: '', email: '', role: 'ops', dealer_id: '' }); load.reload(); };
  const toggle = async s => { await api(`/admin/staff/${s.id}/active`, { method: 'POST', body: { active: !s.active } }); toast(s.active ? 'Deactivated and signed out.' : 'Reactivated.'); load.reload(); };
  const reset = async s => { const r = await api(`/admin/staff/${s.id}/reset`, { method: 'POST', body: {} }); setSetup({ ...r.setup, email: s.email }); load.reload(); };
  return html`<${Head} title="Staff" sub="Everyone signs in with a password and an authenticator app"><button class="btn sm" onClick=${() => setAdding(true)}>Add person</button></${Head}>
    <${Screen} load=${load}>${d => html`<${Card}><${Table} head=${['Name', 'Email', 'Role', 'Status', '']} empty="No staff." rows=${d.staff.map(s => html`<tr>
      <td>${s.name}</td><td class="small">${s.email}</td><td>${s.role}${s.dealer_id ? ' · ' + s.dealer_id : ''}</td><td><${Tag} s=${s.active ? 'active' : 'closed'} />${s.must_change_password && html` <span class="tag warn">new password due</span>`}</td>
      <td class="r">${s.id !== me.id && html`<div class="row" style="justify-content:flex-end">
        <${Act} cls="btn sm sec" confirm=${`Reset ${s.name}’s password and authenticator? They are signed out and must set them up again with what you share.`} run=${() => reset(s)}>Reset sign-in</${Act}>
        <${Act} cls="btn sm sec" confirm=${s.active ? `Deactivate ${s.name}? They are signed out immediately.` : null} run=${() => toggle(s)}>${s.active ? 'Deactivate' : 'Reactivate'}</${Act}></div>`}</td></tr>`)} /></${Card}>`}</${Screen}>
    ${adding && html`<${Modal} title="Add person" onClose=${() => setAdding(false)}>
      <label class="f"><span>Full name</span><input class="in" value=${f.name} onInput=${e => setF({ ...f, name: e.target.value })} /></label>
      <label class="f"><span>Work email</span><input class="in" type="email" value=${f.email} onInput=${e => setF({ ...f, email: e.target.value })} /></label>
      <label class="f"><span>Role</span><select class="in" value=${f.role} onChange=${e => setF({ ...f, role: e.target.value })}>
        <option value="ops">Operations: daily work, no settings or staff</option><option value="support">Support: rate chats with customers only</option><option value="admin">Administrator: everything</option><option value="dealer">Dealer counter staff</option></select></label>
      ${f.role === 'dealer' && html`<label class="f"><span>Dealer</span><select class="in" value=${f.dealer_id} onChange=${e => setF({ ...f, dealer_id: e.target.value })}>
        <option value="">Choose…</option>${(dealers.data?.dealers || []).map(d => html`<option value=${d.id}>${d.name}</option>`)}</select></label>`}
      <div class="row" style="justify-content:flex-end"><button class="btn sec" onClick=${() => setAdding(false)}>Cancel</button>
        <${Act} disabled=${!f.name || !f.email || (f.role === 'dealer' && !f.dealer_id)} run=${add}>Create account</${Act}></div>
    </${Modal}>`}
    ${setup && html`<${Modal} title="Share these once" onClose=${() => ask({ title: 'Close without sharing?', body: 'The password and authenticator secret won’t be shown again.', confirm: 'Close', danger: true }).then(okd => okd && setSetup(null))}>
      <p>Give these to <b>${setup.email}</b> in person or through a secure channel. They are not stored in readable form and won’t be shown again. They must choose their own password when they first sign in.</p>
      <label class="f"><span>One-time password</span><div class="secret">${setup.password}</div></label>
      <div class="f"><span>Authenticator</span>
        <div style="display:flex;gap:16px;align-items:center;flex-wrap:wrap">
          <div role="img" aria-label="QR code for the authenticator app" style="line-height:0" dangerouslySetInnerHTML=${{ __html: qrSvg(setup.otpauthUrl || `otpauth://totp/${encodeURIComponent('PGBX:' + setup.email)}?secret=${setup.totpSecret}&issuer=PGBX`, 4) }}></div>
          <small style="flex:1;min-width:180px">Scan with Google Authenticator, Microsoft Authenticator or 1Password. Or add the account by entering this key: <span class="secret" style="display:block;margin-top:6px">${setup.totpSecret.replace(/(.{4})/g, '$1 ').trim()}</span></small>
        </div></div>
      <div class="row" style="justify-content:flex-end"><button class="btn" onClick=${() => setSetup(null)}>I’ve shared them</button></div>
    </${Modal}>`}`;
}

// ---------- shell ----------
function Admin() {
  const { me, notice, signIn, signOut, passwordChanged } = useStaff();
  const [section, id] = useHash();
  const [menu, setMenu] = useState(false);
  const [pw, setPw] = useState(false);
  const [toast, showToast] = useToast();
  const [narrow, setNarrow] = useState(() => matchMedia('(max-width:860px)').matches);
  // nothing is asked before sign-in; support staff only have the chat counts
  const counts = useLoad(me && !me.mustChangePassword ? (me.role === 'support' ? '/support/counts' : '/admin/overview') : null, [section]);
  useEffect(() => { if (!me || me.mustChangePassword) return; const t = setInterval(counts.reload, 20000); return () => clearInterval(t); }, [me && me.role]);
  const sideRef = useRef();
  useEffect(() => { if (menu && sideRef.current) (sideRef.current.querySelector('[aria-current=page]') || sideRef.current.querySelector('a'))?.focus(); }, [menu]);
  useEffect(() => { setMenu(false); window.scrollTo(0, 0); }, [section, id]);
  useEffect(() => { const m = matchMedia('(max-width:860px)'); const f = () => setNarrow(m.matches); m.addEventListener('change', f); return () => m.removeEventListener('change', f); }, []);
  useEffect(() => { if (!menu) return; const k = e => e.key === 'Escape' && setMenu(false); addEventListener('keydown', k); return () => removeEventListener('keydown', k); }, [menu]);
  if (me === undefined) return html`<div class="signin"></div>`;
  if (!me) return html`<${SignIn} tool="Admin panel" roles=${['admin', 'ops', 'support']} onIn=${signIn} notice=${notice} />`;
  if (me.mustChangePassword) return html`<${ChangePassword} forced=${true} onDone=${passwordChanged} onSignOut=${signOut} />`;
  // Every confirmation also refreshes the counts in the menu, so a handled item stops showing as waiting.
  const show = (text, err) => { showToast(text, err); if (!err) counts.reload(); };
  const badge = { kyc: counts.data?.kyc_review, orders: counts.data?.flagged_orders, support: counts.data?.support_open, appraisals: counts.data?.appraisals_to_assign,
    micro: (counts.data?.lots_to_settle || 0) + (counts.data?.payouts_pending || 0), refunds: counts.data?.refunds_due, chats: counts.data?.chats_waiting, barsales: counts.data?.bar_sales_pending };
  const props = { me, toast: show };
  const views = { overview: Overview, kyc: Kyc, orders: Orders, appraisals: Appraisals, gifts: Gifts, micro: Micro, chats: Chats, barsales: BarSales, refunds: Refunds, customers: Customers, support: Support, dealers: Dealers, products: Products, reconciliation: Reconciliation, settings: Settings, audit: Audit, staff: Staff };
  const allowed = k => { const s = SECTIONS.find(x => x[0] === k); return s && canOpen(s, me.role); };
  const home = me.role === 'support' ? Chats : Overview;
  const View = section === 'customers' && id && allowed('customers') ? null : allowed(section) ? views[section] : home;   // no role opens other sections by URL
  const hidden = narrow && !menu;                              // the closed drawer can't be reached with Tab or a screen reader
  return html`<div class="shell">
    <nav class=${'side' + (menu ? ' open' : '')} id="side" ref=${sideRef} aria-label="Sections" inert=${hidden ? true : undefined} aria-hidden=${hidden ? 'true' : undefined}>
      <${Brand} sub="Admin panel" />
      ${SECTIONS.filter(s => canOpen(s, me.role)).map(([k, l]) => html`<a href=${'#' + k} aria-current=${section === k ? 'page' : undefined}>${l}${badge[k] > 0 && html`<span class="badge">${badge[k]}</span>`}</a>`)}
      <div class="who"><b>${me.name}</b>${ROLE_NAME[me.role] || me.role}<div class="row" style="margin-top:8px;gap:12px">
        <button class="btn sm ghost" style="color:#fff;padding:0" onClick=${() => setPw(true)}>Change password</button>
        <button class="btn sm ghost" style="color:#fff;padding:0" onClick=${signOut}>Sign out</button></div></div>
    </nav>
    ${menu && html`<div class="modal-bg" style="z-index:15" onClick=${() => setMenu(false)}></div>`}
    ${pw && html`<${ChangePassword} onDone=${() => { setPw(false); show('Password changed. Other devices were signed out.'); }} onCancel=${() => setPw(false)} />`}
    <main class="main">
      <button class="btn sm sec menu" style="margin-bottom:12px" onClick=${() => setMenu(true)} aria-label="Open menu" aria-expanded=${menu} aria-controls="side">☰ Menu</button>
      ${View ? html`<${View} ...${props} id=${id} />` : html`<${Customer} id=${id} ...${props} />`}
    </main>
    <${Toast} toast=${toast} /><${Asker} />
  </div>`;
}

render(html`<${Admin} />`, document.getElementById('app'));
