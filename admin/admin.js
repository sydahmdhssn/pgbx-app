// PGBX admin panel for operations and administrators (FR-M1–M10).
// Roles: admin (everything), ops (day-to-day work; cannot change settings, prices, dealers' details, staff or suspend
// customers). The server enforces roles; this screen only hides what a role can't use.
import { html, render, useState, useEffect } from '../vendor/htm-preact-standalone-3.1.1.module.js';
import { api, useLoad, useStaff, SignIn, ChangePassword, Loading, Failed, Tag, Toast, useToast, Modal, Act, Brand, pkr, when, day, ago, productName, PRODUCT_NAMES } from '../staff/kit.js';

const ORDER = Object.keys(PRODUCT_NAMES);
const pkToday = () => new Date(Date.now() + 5 * 3600e3).toISOString().slice(0, 10);   // PGBX's business day is Pakistan time (UTC+5)
const byProduct = (a, b) => ORDER.indexOf(a.product_id) - ORDER.indexOf(b.product_id);

const SECTIONS = [
  ['overview', 'Overview'], ['kyc', 'Identity checks'], ['orders', 'Orders'], ['appraisals', 'Doorstep appraisals'], ['gifts', 'Gift orders'], ['customers', 'Customers'], ['support', 'Support'], ['dealers', 'Dealers & stock'],
  ['products', 'Products & premiums'], ['reconciliation', 'Reconciliation'], ['settings', 'Settings'], ['audit', 'Audit log'], ['staff', 'Staff', 'admin'],
];
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
function Overview() {
  const load = useLoad('/admin/overview');
  return html`<${Head} title="Overview" sub="Today at a glance"><button class="btn sm sec" onClick=${load.reload}>Refresh</button></${Head}>
    <${Screen} load=${load}>${d => html`<div class="stack">
      <div class="grid g4">
        <a class=${'card stat' + (d.kyc_review ? ' attn' : '')} href="#kyc" style="text-decoration:none;color:inherit"><div class="k">Identity checks to review</div><div class="v">${d.kyc_review}</div></a>
        <a class=${'card stat' + (d.flagged_orders ? ' attn' : '')} href="#orders" style="text-decoration:none;color:inherit"><div class="k">Orders needing operations</div><div class="v">${d.flagged_orders}</div></a>
        <a class=${'card stat' + (d.appraisals_to_assign ? ' attn' : '')} href="#appraisals" style="text-decoration:none;color:inherit"><div class="k">Appraisals to assign</div><div class="v">${d.appraisals_to_assign ?? 0}</div></a>
        <a class="card stat" href="#gifts" style="text-decoration:none;color:inherit"><div class="k">Gift orders in progress</div><div class="v">${d.gifts_open ?? 0}</div></a>
        <div class="card stat"><div class="k">Sales today</div><div class="v">${pkr(d.sales_today_pkr)}</div><div class="muted small">${d.orders_today} orders</div></div>
        <div class="card stat"><div class="k">Active collections</div><div class="v">${d.active_collections}</div></div>
        <div class="card stat"><div class="k">Customers</div><div class="v">${d.customers}</div><div class="muted small">${d.verified} verified</div></div>
      </div>
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
      <td class="r">${['review', 'submitted'].includes(k.status) ? html`<button class="btn sm" onClick=${() => { setReason(''); setDeciding(k); }}>Decide</button>` : html`<${Tag} s=${k.status} />`}</td></tr>`)} /></${Card}>`}</${Screen}>
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
      <td class="r">${o.status === 'flagged' ? html`<button class="btn sm" onClick=${() => { setNote(''); setResolving(o); }}>Resolve</button>` : html`<${Tag} s=${o.status} />`}</td></tr>`)} /></${Card}>`}</${Screen}>
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
      <td><${Tag} s=${c.kyc_status} /></td><td><${Tag} s=${c.status} /></td><td class="small">${day(c.created_at)}</td></tr>`)} />`}</${Screen}></${Card}>`;
}
function Customer({ id, me, toast }) {
  const load = useLoad('/admin/customers/' + id);
  const setStatus = async status => {
    const reason = prompt(status === 'suspended' ? 'Why are you suspending this account? (kept in the audit log)' : 'Why are you reactivating this account?');
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
        <td>${productName(r.product_id)}</td><td class="r num">${r.units}</td><td>${r.dealer_id}</td><td><${Tag} s=${r.status} /></td><td class="small">${when(r.created_at)}</td></tr>`)} /></${Card}>
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
  const items = a => (a.items || []).map(i => `${i.metal === 'silver' ? 'Silver' : 'Gold'}${i.karat ? ' ' + i.karat : ''}${i.approx_g ? ' ~' + i.approx_g + ' g' : ''}${i.note ? ' (' + i.note + ')' : ''}`).join(', ');
  return html`<${Head} title="Doorstep appraisals" sub="Paid visits: assign a goldsmith, then record the assay result">
      <${Seg} label="Status" value=${status} onChange=${setStatus} options=${[['booked', 'To assign'], ['confirmed', 'Assigned'], ['completed', 'Completed'], ['cancelled', 'Cancelled']]} /></${Head}>
    <${Screen} load=${load}>${d => html`<${Card}><${Table} head=${['Visit', 'Customer', 'Address', 'Pieces', status === 'confirmed' ? 'Goldsmith' : 'Ref', '']} empty="Nothing here." rows=${d.appraisals.map(a => html`<tr>
      <td><b>${SLOT_DAY(a.date)}</b><div class="muted small">${a.slot}</div></td>
      <td>${a.customer_name || '—'}<div class="muted small">+92 ${a.phone}</div></td>
      <td class="small" style="max-width:240px">${a.address}, ${a.area}, ${a.city}${a.notes ? html`<div class="muted">${a.notes}</div>` : ''}</td>
      <td class="small" style="max-width:220px">${items(a)}</td>
      <td class="small">${status === 'confirmed' && a.goldsmith ? html`${a.goldsmith.name}<div class="muted">${a.goldsmith.phone} · code ${a.visit_code}</div>` : html`<span class="mono">${a.ref}</span>`}
        ${a.refund_due ? html`<div><span class="tag warn">refund due</span></div>` : ''}</td>
      <td class="r"><div class="row" style="justify-content:flex-end">
        ${a.status === 'booked' && html`<button class="btn sm" onClick=${() => setAct({ a, action: 'assign' })}>Assign</button>`}
        ${a.status === 'confirmed' && html`<button class="btn sm" onClick=${() => setAct({ a, action: 'complete' })}>Record result</button>`}
        ${['booked', 'confirmed'].includes(a.status) && html`<button class="btn sm sec" onClick=${() => setAct({ a, action: 'cancel' })}>Cancel</button>`}
        ${a.status === 'completed' && a.result && html`<span class="small muted" style="max-width:220px;display:inline-block">${a.result.summary}</span>`}
      </div></td></tr>`)} /></${Card}>`}</${Screen}>
    ${act && html`<${Modal} title=${{ assign: 'Assign goldsmith', complete: 'Record assay result', cancel: 'Cancel visit' }[act.action]} onClose=${() => setAct(null)}>
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
      <div class="row" style="justify-content:flex-end"><button class="btn sec" onClick=${() => setAct(null)}>Close</button>
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
      <${Seg} label="Status" value=${status} onChange=${setStatus} options=${[['placed', 'New'], ['in_production', 'In production'], ['dispatched', 'Dispatched'], ['delivered', 'Delivered'], ['cancelled', 'Cancelled']]} /></${Head}>
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
      </div></td></tr>`)} /></${Card}>`}</${Screen}>
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
      <td class="r">${r.status === 'open' ? html`<button class="btn sm" onClick=${() => { setReply(''); setOpen(r); }}>Reply</button>` : html`<span class="muted small">${when(r.closed_at)}</span>`}</td></tr>`)} /></${Card}>`}</${Screen}>
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
    const units = Number(value);
    if (!Number.isInteger(units) || units < 0) { toast('Enter a whole number of 0 or more.', true); return; }
    const note = prompt(`Set ${productName(product)} at ${dealer.name} to ${units}. Reason (e.g. delivery, count correction):`);
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
    <${Screen} load=${load}>${d => !products.data ? html`<div class="card"><${Loading} /></div>` : html`<div class="stack">${d.dealers.map(dl => html`<${Card} title=${dl.name}
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
          if (!confirm(`Change the premium for ${productName(p.id)} from ${pkr(p.premium_pkr)} to ${pkr(Number(v))}? New price locks use it straight away.`)) { load.reload(); return; }
          save(p, { premium_pkr: Number(v) });
        }} />` : pkr(p.premium_pkr)}</td>
      <td>${admin ? html`<label class="row small"><input type="checkbox" checked=${p.active} onChange=${e => save(p, { active: e.target.checked })} /> ${p.active ? 'On sale' : 'Hidden'}</label>` : html`<${Tag} s=${p.active ? 'active' : 'closed'} />`}</td></tr>`)} />
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
};
function Settings({ me, toast }) {
  const load = useLoad('/admin/settings');
  const admin = me.role === 'admin';
  const save = async (key, text) => {
    let value;
    try { value = text.trim() === '' ? null : JSON.parse(text); } catch { toast('Enter a number, or valid JSON.', true); load.reload(); return; }
    if (!confirm(`Change "${SETTING_HELP[key]?.[0] || key}" to ${JSON.stringify(value)}? This applies to all customers straight away.`)) { load.reload(); return; }
    try { await api('/admin/settings', { method: 'PATCH', body: { [key]: value } }); toast('Setting saved.'); } catch (e) { toast(e.message, true); }
    load.reload();
  };
  return html`<${Head} title="Settings" sub=${admin ? 'Business rules the app and server follow. Changes are recorded in the audit log.' : 'Only administrators can change settings.'} />
    <${Screen} load=${load}>${d => html`<${Card}><${Table} head=${['Setting', 'Value', 'Last changed']} empty="No settings." rows=${d.settings.map(s => html`<tr>
      <td>${SETTING_HELP[s.key]?.[0] || s.key}<div class="muted small mono">${s.key}${SETTING_HELP[s.key] ? ' · ' + SETTING_HELP[s.key][1] : ''}</div></td>
      <td>${admin ? html`<input class="in mono" style="min-width:140px" value=${s.value === null ? '' : JSON.stringify(s.value)} aria-label=${s.key}
        onKeyDown=${e => e.key === 'Enter' && e.target.blur()} onChange=${e => save(s.key, e.target.value)} />` : html`<span class="mono">${s.value === null ? '— (not set)' : JSON.stringify(s.value)}</span>`}</td>
      <td class="small">${s.updated_by ? when(s.updated_at) + ' · ' + s.updated_by : 'Sample default'}</td></tr>`)} /></${Card}>`}</${Screen}>`;
}

// ---------- audit ----------
function Audit() {
  const [entity, setEntity] = useState('');
  const load = useLoad('/admin/audit?entity=' + entity);
  return html`<${Head} title="Audit log" sub="Every important action, by whom and when. Entries can’t be edited or deleted.">
      <select class="in" style="width:auto" value=${entity} onChange=${e => setEntity(e.target.value)} aria-label="Filter">
        ${[['', 'Everything'], ['customer', 'Customers'], ['order', 'Orders'], ['redemption', 'Collections'], ['kyc', 'Identity checks'], ['appraisal', 'Appraisals'], ['gift', 'Gift orders'], ['support', 'Support'], ['staff', 'Staff'], ['setting', 'Settings'], ['dealer', 'Dealers'], ['product', 'Products'], ['paid', 'Payment mismatches'], ['error', 'Errors']].map(([v, l]) => html`<option value=${v}>${l}</option>`)}
      </select></${Head}>
    <${Screen} load=${load}>${d => html`<${Card}><${Table} head=${['When', 'Who', 'Action', 'Item', 'Details']} empty="No entries." rows=${d.entries.map(a => html`<tr>
      <td class="small" style="white-space:nowrap">${when(a.at)}</td><td class="small mono">${a.actor}</td><td><span class="tag">${a.action}</span></td>
      <td class="small mono">${a.entity}${a.entity_id ? ' ' + String(a.entity_id).slice(0, 8) : ''}</td><td class="small mono" style="max-width:320px;overflow-wrap:anywhere">${a.data && Object.keys(a.data).length ? JSON.stringify(a.data) : ''}</td></tr>`)} /></${Card}>`}</${Screen}>`;
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
        <option value="ops">Operations: daily work, no settings or staff</option><option value="admin">Administrator: everything</option><option value="dealer">Dealer counter staff</option></select></label>
      ${f.role === 'dealer' && html`<label class="f"><span>Dealer</span><select class="in" value=${f.dealer_id} onChange=${e => setF({ ...f, dealer_id: e.target.value })}>
        <option value="">Choose…</option>${(dealers.data?.dealers || []).map(d => html`<option value=${d.id}>${d.name}</option>`)}</select></label>`}
      <div class="row" style="justify-content:flex-end"><button class="btn sec" onClick=${() => setAdding(false)}>Cancel</button>
        <${Act} disabled=${!f.name || !f.email || (f.role === 'dealer' && !f.dealer_id)} run=${add}>Create account</${Act}></div>
    </${Modal}>`}
    ${setup && html`<${Modal} title="Share these once" onClose=${() => confirm('Close? The password and secret won’t be shown again.') && setSetup(null)}>
      <p>Give these to <b>${setup.email}</b> in person or through a secure channel. They are not stored in readable form and won’t be shown again. They must choose their own password when they first sign in.</p>
      <label class="f"><span>One-time password</span><div class="secret">${setup.password}</div></label>
      <label class="f"><span>Authenticator secret</span><div class="secret">${setup.totpSecret}</div><small>In Google Authenticator, Microsoft Authenticator or 1Password: add account → enter key manually.</small></label>
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
  const counts = useLoad('/admin/overview', [section, !!me && !me.mustChangePassword]);
  useEffect(() => { setMenu(false); window.scrollTo(0, 0); }, [section, id]);
  useEffect(() => { const m = matchMedia('(max-width:860px)'); const f = () => setNarrow(m.matches); m.addEventListener('change', f); return () => m.removeEventListener('change', f); }, []);
  useEffect(() => { if (!menu) return; const k = e => e.key === 'Escape' && setMenu(false); addEventListener('keydown', k); return () => removeEventListener('keydown', k); }, [menu]);
  if (me === undefined) return html`<div class="signin"></div>`;
  if (!me) return html`<${SignIn} tool="Admin panel" roles=${['admin', 'ops']} onIn=${signIn} notice=${notice} />`;
  if (me.mustChangePassword) return html`<${ChangePassword} forced=${true} onDone=${passwordChanged} onSignOut=${signOut} />`;
  // Every confirmation also refreshes the counts in the menu, so a handled item stops showing as waiting.
  const show = (text, err) => { showToast(text, err); if (!err) counts.reload(); };
  const badge = { kyc: counts.data?.kyc_review, orders: counts.data?.flagged_orders, support: counts.data?.support_open, appraisals: counts.data?.appraisals_to_assign };
  const props = { me, toast: show };
  const views = { overview: Overview, kyc: Kyc, orders: Orders, appraisals: Appraisals, gifts: Gifts, customers: Customers, support: Support, dealers: Dealers, products: Products, reconciliation: Reconciliation, settings: Settings, audit: Audit, staff: Staff };
  const allowed = k => { const s = SECTIONS.find(x => x[0] === k); return s && (!s[2] || s[2] === me.role); };
  const View = section === 'customers' && id ? null : allowed(section) ? views[section] : Overview;   // ops can't open admin-only sections by URL
  const hidden = narrow && !menu;                              // the closed drawer can't be reached with Tab or a screen reader
  return html`<div class="shell">
    <nav class=${'side' + (menu ? ' open' : '')} id="side" aria-label="Sections" inert=${hidden ? true : undefined} aria-hidden=${hidden ? 'true' : undefined}>
      <${Brand} sub="Admin panel" />
      ${SECTIONS.filter(s => !s[2] || s[2] === me.role).map(([k, l]) => html`<a href=${'#' + k} aria-current=${section === k ? 'page' : undefined}>${l}${badge[k] > 0 && html`<span class="badge">${badge[k]}</span>`}</a>`)}
      <div class="who"><b>${me.name}</b>${me.role === 'admin' ? 'Administrator' : 'Operations'}<div class="row" style="margin-top:8px;gap:12px">
        <button class="btn sm ghost" style="color:#fff;padding:0" onClick=${() => setPw(true)}>Change password</button>
        <button class="btn sm ghost" style="color:#fff;padding:0" onClick=${signOut}>Sign out</button></div></div>
    </nav>
    ${menu && html`<div class="modal-bg" style="z-index:15" onClick=${() => setMenu(false)}></div>`}
    ${pw && html`<${ChangePassword} onDone=${() => { setPw(false); show('Password changed. Other devices were signed out.'); }} onCancel=${() => setPw(false)} />`}
    <main class="main">
      <button class="btn sm sec menu" style="margin-bottom:12px" onClick=${() => setMenu(true)} aria-label="Open menu" aria-expanded=${menu} aria-controls="side">☰ Menu</button>
      ${View ? html`<${View} ...${props} />` : html`<${Customer} id=${id} ...${props} />`}
    </main>
    <${Toast} toast=${toast} />
  </div>`;
}

render(html`<${Admin} />`, document.getElementById('app'));
