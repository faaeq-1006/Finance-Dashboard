import { useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { api, date, dateTime, daysUntil, money, pct, qty, today } from '../api';
import { Badge, Card, Confirm, DEC, Empty, ErrorBox, Field, Form, Loading, Modal, Money, Page, Stat, StatusBadge, Tabs, useCan, useCommand, useToast } from '../ui';

function LoanForm({ loan, banks, onClose }: { loan?: any; banks: any[]; onClose: () => void }) {
  const run = useCommand();
  return (
    <Modal title={loan ? `Edit ${loan.loan_no}` : 'New loan'} onClose={onClose} wide>
      <Form onCancel={onClose} submit={loan ? 'Save changes' : 'Add loan'} onSubmit={async (v) => {
        await run(loan ? 'loan.update' : 'loan.create', loan ? { ...v, id: loan.id } : v);
        onClose();
      }}>
        <div className="form-grid">
          {!loan && <Field label="Bank"><select name="bank_id" required defaultValue="">{<option value="" disabled>Select a bank</option>}{banks.map((b) => <option key={b.id} value={b.id}>{b.name}</option>)}</select></Field>}
          <Field label="Loan number"><input name="loan_no" required maxLength={60} defaultValue={loan?.loan_no} /></Field>
          <Field label="Facility type"><input name="facility_type" required defaultValue={loan?.facility_type ?? 'Murabaha'} /></Field>
          <Field label="Loan limit"><input name="limit_amount" required {...DEC} defaultValue={loan?.limit_amount} /></Field>
          {!loan && <Field label="Amount already used" hint="Opening balance. Later drawdowns and repayments are recorded as transactions."><input name="used_amount" {...DEC} defaultValue="0" required /></Field>}
          <Field label="Start date"><input name="start_date" type="date" required defaultValue={loan?.start_date} /></Field>
          <Field label="Maturity date"><input name="maturity_date" type="date" required defaultValue={loan?.maturity_date} /></Field>
          <Field label="Facility review date (optional)"><input name="review_date" type="date" defaultValue={loan?.review_date ?? ''} /></Field>
          <Field label="Renewal date (optional)"><input name="renewal_date" type="date" defaultValue={loan?.renewal_date ?? ''} /></Field>
          <Field label="Rate type"><select name="rate_type" defaultValue={loan?.rate_type ?? 'floating'}><option value="floating">Floating</option><option value="fixed">Fixed</option></select></Field>
          <Field label="All-in rate % (optional)"><input name="rate_pct" {...DEC} defaultValue={loan?.rate_pct ?? ''} /></Field>
          <Field label="Benchmark (optional)"><input name="benchmark" placeholder="SAIBOR 3M" defaultValue={loan?.benchmark ?? ''} /></Field>
          <Field label="Margin % (optional)"><input name="margin_pct" {...DEC} defaultValue={loan?.margin_pct ?? ''} /></Field>
          <div className="full note" style={{ margin: 0 }}>Leave the three levels below empty to use the bank's standard terms. Fill them in only when this loan has its own terms.</div>
          <Field label="Coverage ratio % (this loan)"><input name="coverage_ratio" {...DEC} placeholder="Bank default" defaultValue={loan?.coverage_ratio ?? ''} /></Field>
          <Field label="Top-up level %"><input name="top_up_ratio" {...DEC} placeholder="Bank default" defaultValue={loan?.top_up_ratio ?? ''} /></Field>
          <Field label="Margin call level %"><input name="margin_call_ratio" {...DEC} placeholder="Bank default" defaultValue={loan?.margin_call_ratio ?? ''} /></Field>
          <Field label="Notes" full><textarea name="notes" defaultValue={loan?.notes ?? ''} /></Field>
        </div>
      </Form>
    </Modal>
  );
}

export function Loans() {
  const nav = useNavigate();
  const can = useCan();
  const [adding, setAdding] = useState(false);
  const loans = useQuery({ queryKey: ['loans'], queryFn: () => api('/api/loans') });
  const banks = useQuery({ queryKey: ['banks'], queryFn: () => api('/api/banks') });
  if (loans.isPending) return <Loading />;
  if (loans.error) return <ErrorBox error={loans.error} />;
  return (
    <Page title="Loan register" sub="One record per loan: limit, amount used, dates, rate and repayments."
      actions={can('write') && <button className="btn primary" onClick={() => setAdding(true)} disabled={!banks.data?.length}>New loan</button>}>
      <Card flush>
        <div className="table-wrap"><table>
          <thead><tr><th>Bank</th><th>Loan no.</th><th>Facility</th><th className="num">Limit</th><th className="num">Used</th><th>Utilisation</th><th className="num">Rate</th><th>Maturity</th><th>Status</th></tr></thead>
          <tbody>{loans.data.map((l: any) => {
            const d = daysUntil(l.maturity_date);
            return (
              <tr key={l.id} className="clickable" onClick={() => nav(`/loans/${l.id}`)}>
                <td>{l.bank}</td><td><Link to={`/loans/${l.id}`} onClick={(e) => e.stopPropagation()}>{l.loan_no}</Link></td><td>{l.facility_type}</td>
                <td className="num">{money(l.limit_amount)}</td><td className="num">{money(l.used_amount)}</td>
                <td><div className="bar" title={`${((Number(l.used_amount) / Math.max(Number(l.limit_amount), 1)) * 100).toFixed(0)}% used`}><i style={{ width: `${Math.min(100, (Number(l.used_amount) / Math.max(Number(l.limit_amount), 0.01)) * 100)}%` }} /></div></td>
                <td className="num">{l.rate_pct ? `${Number(l.rate_pct).toFixed(2)}%` : '–'}</td>
                <td>{date(l.maturity_date)} {l.status === 'active' && d <= 30 && <Badge tone={d < 0 ? 'bad' : 'watch'}>{d < 0 ? 'past due' : `${d}d`}</Badge>}</td>
                <td><Badge tone={l.status === 'active' ? 'ok' : 'neutral'}>{l.status}</Badge></td>
              </tr>);
          })}
            {!loans.data.length && <tr><td colSpan={9}><Empty>No loans yet. {banks.data?.length ? 'Add the first loan.' : 'Add a bank first.'}</Empty></td></tr>}
          </tbody>
        </table></div>
      </Card>
      {adding && <LoanForm banks={banks.data ?? []} onClose={() => setAdding(false)} />}
    </Page>
  );
}

function Diff({ before, after }: { before: any; after: any }) {
  const skip = new Set(['updated_at', 'created_at', 'id', 'bank_id']);
  const keys = [...new Set([...Object.keys(before ?? {}), ...Object.keys(after ?? {})])].filter((k) => !skip.has(k) && JSON.stringify(before?.[k] ?? null) !== JSON.stringify(after?.[k] ?? null));
  if (!keys.length) return null;
  const show = (v: any) => (v === null || v === undefined ? '–' : typeof v === 'object' ? JSON.stringify(v) : String(v));
  return <div className="diff">{keys.map((k) => [<span key={`${k}k`} className="k">{k.replace(/_/g, ' ')}</span>, <del key={`${k}b`}>{before ? show(before[k]) : ''}</del>, <ins key={`${k}a`}>{show(after?.[k])}</ins>])}</div>;
}
export { Diff };

export function LoanDetail() {
  const { id } = useParams();
  const can = useCan();
  const run = useCommand();
  const toast = useToast();
  const qc = useQueryClient();
  const [tab, setTab] = useState('collateral');
  const [modal, setModal] = useState<{ kind: string; item?: any } | null>(null);
  const { data, error, isPending } = useQuery({ queryKey: ['loan', id], queryFn: () => api(`/api/loans/${id}`) });
  if (isPending) return <Loading />;
  if (error) return <ErrorBox error={error} />;
  const { loan, bank, position: pos, terms } = data;
  const active = loan.status === 'active';
  const close = () => setModal(null);
  const upload = async (url: string, form: HTMLFormElement) => {
    const res = await api(url, { body: new FormData(form) });
    await qc.invalidateQueries();
    toast('Document stored');
    return res;
  };

  return (
    <Page crumbs={<><Link to="/loans">Loans</Link> / <Link to={`/banks/${bank.id}`}>{bank.name}</Link></>}
      title={<>{loan.loan_no} <span className="muted" style={{ fontWeight: 400 }}>{bank.name}</span> {pos ? <StatusBadge status={pos.status} /> : <Badge tone="neutral">closed</Badge>}</>}
      sub={`${loan.facility_type}, ${loan.rate_type} rate${loan.rate_pct ? ` ${Number(loan.rate_pct).toFixed(2)}%` : ''}${loan.benchmark ? ` (${loan.benchmark}${loan.margin_pct ? ` + ${Number(loan.margin_pct).toFixed(2)}%` : ''})` : ''}`}
      actions={can('write') && active && <>
        <button className="btn primary" onClick={() => setModal({ kind: 'tx', item: 'drawdown' })}>Drawdown</button>
        <button className="btn" onClick={() => setModal({ kind: 'tx', item: 'repayment' })}>Repayment</button>
        <button className="btn" onClick={() => setModal({ kind: 'edit' })}>Edit</button>
        <button className="btn danger" onClick={() => setModal({ kind: 'close' })}>Close loan</button>
      </>}>
      {pos && pos.status !== 'ok' && pos.status !== 'watch' && <div className="error">Shortfall of {money(pos.cure_top_up_value)}. To cure it, pledge eligible shares worth {money(pos.cure_top_up_value)} or repay {money(pos.cure_repay_amount)}. <Link to="/allocation">See which shares could be moved</Link></div>}
      {pos?.status === 'watch' && <div className="warn">Early warning: a fall of {pct(pos.price_drop_to_shortfall_pct, 1)} in the pledged shares would cause a shortfall.</div>}
      <div className="grid stats">
        <Stat dark label="Loan used" value={money(loan.used_amount)} hint={`Limit ${money(loan.limit_amount)}`} />
        <Stat label="Headroom" value={money(Number(loan.limit_amount) - Number(loan.used_amount))} />
        <Stat label="Collateral value" value={money(pos?.collateral_value)} hint={pos ? `Actual coverage ${pct(pos.actual_coverage_pct)}` : ''} />
        <Stat label="Coverage required" value={money(pos?.coverage_required)} hint={`${pct(terms.coverage_ratio)} of used (${terms.terms_source === 'loan' ? 'loan-specific' : 'bank standard'})`} />
        <Stat label="Surplus / shortfall" value={pos ? <Money v={pos.surplus} signed /> : '–'} hint={pos?.price_drop_to_shortfall_pct ? `Shares can fall ${pct(pos.price_drop_to_shortfall_pct, 1)} first` : ''} />
      </div>
      <Card>
        <dl className="kv">
          <div><dt>Start date</dt><dd>{date(loan.start_date)}</dd></div><div><dt>Maturity date</dt><dd>{date(loan.maturity_date)}</dd></div>
          <div><dt>Facility review</dt><dd>{date(loan.review_date)}</dd></div><div><dt>Renewal</dt><dd>{date(loan.renewal_date)}</dd></div>
          <div><dt>Top-up level</dt><dd>{pct(terms.top_up_ratio)}</dd></div><div><dt>Margin call level</dt><dd>{pct(terms.margin_call_ratio)}</dd></div>
          {loan.notes && <div style={{ gridColumn: '1 / -1' }}><dt>Notes</dt><dd style={{ fontWeight: 400 }}>{loan.notes}</dd></div>}
        </dl>
      </Card>

      <Tabs value={tab} onChange={setTab} tabs={[['collateral', 'Pledged shares'], ['tx', `Drawdowns & repayments (${data.transactions.length})`], ['charges', `Finance charges (${data.charges.length})`], ['docs', `Documents (${data.documents.length})`], ['history', 'Change history']]} />

      {tab === 'collateral' && <Card flush actions={<Link className="btn sm" to="/portfolios">Manage portfolios</Link>} title="Shares backing this loan">
        <div className="table-wrap"><table><thead><tr><th>Portfolio</th><th>Share</th><th className="num">No. of shares</th><th className="num">Price</th><th className="num">Share value</th><th className="num">Collateral value</th></tr></thead>
          <tbody>{pos?.portfolios.flatMap((p: any) => p.holdings.map((h: any) => (
            <tr key={h.id}><td>{p.name}</td><td>{h.symbol} <span className="muted">{h.security_name}</span>{!h.eligible && <> <Badge tone="bad">not eligible at {bank.name}</Badge></>}{Number(h.haircut_pct) > 0 && <> <Badge tone="neutral">haircut {pct(h.haircut_pct)}</Badge></>}</td>
              <td className="num">{qty(h.quantity)}</td><td className="num">{h.price ? Number(h.price).toFixed(2) : '–'}</td><td className="num">{money(h.market_value)}</td><td className="num">{money(h.collateral_value)}</td></tr>)))}
            {!pos?.portfolios.some((p: any) => p.holdings.length) && <tr><td colSpan={6}><Empty>No shares are pledged to this loan.</Empty></td></tr>}
            {pos && <tr className="total"><td colSpan={4}>Total</td><td className="num">{money(pos.market_value)}</td><td className="num">{money(pos.collateral_value)}</td></tr>}
          </tbody></table></div>
      </Card>}

      {tab === 'tx' && <Card flush>
        <div className="table-wrap"><table><thead><tr><th>Value date</th><th>Type</th><th className="num">Amount</th><th className="num">Balance after</th><th>Reference</th><th>Recorded by</th></tr></thead>
          <tbody>{data.transactions.map((t: any) => <tr key={t.id}><td>{date(t.value_date)}</td><td><Badge tone={t.type === 'drawdown' ? 'info' : 'ok'}>{t.type}</Badge></td><td className="num">{money(t.amount)}</td><td className="num">{money(t.balance_after)}</td><td>{t.reference ?? ''}{t.notes && <div className="muted small">{t.notes}</div>}</td><td>{t.created_by_name ?? 'system'}</td></tr>)}
            {!data.transactions.length && <tr><td colSpan={6}><Empty>No drawdowns or repayments recorded.</Empty></td></tr>}</tbody></table></div>
      </Card>}

      {tab === 'charges' && <Card flush title="Finance charge payment dates" actions={can('write') && active && <><button className="btn sm" onClick={() => setModal({ kind: 'schedule' })}>Create schedule</button><button className="btn sm primary" onClick={() => setModal({ kind: 'charge' })}>Add charge</button></>}>
        <div className="table-wrap"><table><thead><tr><th>Due date</th><th>Type</th><th className="num">Amount</th><th>Status</th><th>Reference</th><th /></tr></thead>
          <tbody>{data.charges.map((c: any) => {
            const d = daysUntil(c.due_date);
            return (
              <tr key={c.id}><td>{date(c.due_date)} {c.status === 'due' && d <= 7 && <Badge tone={d < 0 ? 'bad' : 'watch'}>{d < 0 ? `${-d}d overdue` : d === 0 ? 'today' : `in ${d}d`}</Badge>}</td><td style={{ textTransform: 'capitalize' }}>{c.charge_type}</td><td className="num">{money(c.amount)}</td>
                <td><Badge tone={c.status === 'paid' ? 'ok' : c.status === 'due' ? 'info' : 'neutral'}>{c.status}{c.paid_date ? ` ${date(c.paid_date)}` : ''}</Badge></td><td>{c.reference}</td>
                <td className="num">{can('write') && c.status === 'due' && <span className="actions" style={{ justifyContent: 'flex-end' }}>
                  <button className="btn sm" onClick={() => run('charge.set_status', { id: c.id, status: 'paid', paid_date: today() }, 'Marked as paid').catch((e) => toast(e.message, true))}>Mark paid</button>
                  <button className="btn sm" onClick={() => setModal({ kind: 'charge', item: c })}>Edit</button>
                  <button className="btn sm danger" onClick={() => run('charge.set_status', { id: c.id, status: 'cancelled' }, 'Charge cancelled').catch((e) => toast(e.message, true))}>Cancel</button></span>}</td></tr>);
          })}
            {!data.charges.length && <tr><td colSpan={6}><Empty>No finance charges scheduled. Create a schedule to get reminders before each payment.</Empty></td></tr>}</tbody></table></div>
      </Card>}

      {tab === 'docs' && <Card flush title="Loan documents" actions={can('write') && <button className="btn sm primary" onClick={() => setModal({ kind: 'doc' })}>Upload document</button>}>
        <div className="table-wrap"><table><thead><tr><th>Document</th><th>Category</th><th>Expiry</th><th>Versions</th><th /></tr></thead>
          <tbody>{data.documents.map((d: any) => {
            const days = d.expiry_date ? daysUntil(d.expiry_date) : null;
            return (
              <tr key={d.id}><td><strong>{d.title}</strong></td><td style={{ textTransform: 'capitalize' }}>{d.category}</td>
                <td>{date(d.expiry_date)} {days !== null && days <= 30 && <Badge tone={days < 0 ? 'bad' : 'watch'}>{days < 0 ? 'expired' : `${days}d left`}</Badge>}</td>
                <td className="wrap">{d.versions.map((v: any) => (
                  <div key={v.version_no} className="small"><a href={`/api/documents/${d.id}/versions/${v.version_no}/download`}>v{v.version_no} {v.filename}</a> <span className="muted">{(v.size_bytes / 1024).toFixed(0)} KB, {dateTime(v.uploaded_at)}, {v.uploaded_by}{v.note ? `, ${v.note}` : ''}</span></div>))}</td>
                <td className="num">{can('write') && <span className="actions" style={{ justifyContent: 'flex-end' }}><button className="btn sm" onClick={() => setModal({ kind: 'version', item: d })}>New version</button><button className="btn sm" onClick={() => setModal({ kind: 'docedit', item: d })}>Edit</button></span>}</td></tr>);
          })}
            {!data.documents.length && <tr><td colSpan={5}><Empty>No documents stored. Upload the facility agreement, pledge agreement and other papers here.</Empty></td></tr>}</tbody></table></div>
      </Card>}

      {tab === 'history' && <Card flush>
        <div className="table-wrap"><table><thead><tr><th>When</th><th>Who</th><th>What</th><th>Change</th></tr></thead>
          <tbody>{data.history.map((h: any) => <tr key={h.id}><td style={{ whiteSpace: 'nowrap' }}>{dateTime(h.at)}</td><td>{h.actor_label}</td><td className="mono">{h.action}</td><td className="wrap"><Diff before={h.before} after={h.after} /></td></tr>)}
            {!data.history.length && <tr><td colSpan={4}><Empty>No changes recorded.</Empty></td></tr>}</tbody></table></div>
      </Card>}

      {modal?.kind === 'edit' && <LoanForm loan={loan} banks={[]} onClose={close} />}
      {modal?.kind === 'close' && <Confirm title="Close loan" danger action="Close loan" onClose={close} text={`Close ${loan.loan_no}? It must be fully repaid. Its pledged portfolios are released and stay at ${bank.name}, unpledged.`} onConfirm={() => run('loan.close', { id: loan.id }, 'Loan closed')} />}
      {modal?.kind === 'tx' && <Modal title={modal.item === 'drawdown' ? 'Record drawdown' : 'Record repayment'} onClose={close}>
        <Form onCancel={close} submit="Record" onSubmit={async (v) => { await run('loan.transaction', { ...v, loan_id: loan.id, type: modal.item }, 'Recorded'); close(); }}>
          <p className="muted" style={{ marginTop: 0 }}>{modal.item === 'drawdown' ? `Headroom available: ${money(Number(loan.limit_amount) - Number(loan.used_amount))}` : `Outstanding: ${money(loan.used_amount)}`}</p>
          <div className="form-grid">
            <Field label="Amount"><input name="amount" required {...DEC} autoFocus /></Field>
            <Field label="Value date"><input name="value_date" type="date" required defaultValue={today()} /></Field>
            <Field label="Bank reference (optional)" full><input name="reference" maxLength={80} /></Field>
            <Field label="Notes (optional)" full><textarea name="notes" /></Field>
          </div>
        </Form></Modal>}
      {modal?.kind === 'charge' && <Modal title={modal.item ? 'Edit finance charge' : 'Add finance charge'} onClose={close}>
        <Form onCancel={close} onSubmit={async (v) => { await run('charge.save', { ...v, loan_id: loan.id, id: modal.item?.id }); close(); }}>
          <div className="form-grid">
            <Field label="Type"><select name="charge_type" defaultValue={modal.item?.charge_type ?? 'profit'}><option value="profit">Profit</option><option value="fee">Fee</option><option value="commission">Commission</option><option value="other">Other</option></select></Field>
            <Field label="Due date"><input name="due_date" type="date" required defaultValue={modal.item?.due_date} /></Field>
            <Field label="Amount"><input name="amount" required {...DEC} defaultValue={modal.item?.amount} /></Field>
            <Field label="Reference (optional)"><input name="reference" defaultValue={modal.item?.reference ?? ''} /></Field>
          </div>
        </Form></Modal>}
      {modal?.kind === 'schedule' && <Modal title="Create a finance charge schedule" onClose={close}>
        <Form onCancel={close} submit="Create schedule" onSubmit={async (v) => { await run('charge.schedule', { loan_id: loan.id, charge_type: v.charge_type, first_due_date: v.first_due_date, amount: v.amount, months_between: Number(v.months_between), count: Number(v.count) }, 'Schedule created'); close(); }}>
          <div className="form-grid">
            <Field label="Type"><select name="charge_type"><option value="profit">Profit</option><option value="fee">Fee</option><option value="commission">Commission</option></select></Field>
            <Field label="First due date"><input name="first_due_date" type="date" required /></Field>
            <Field label="Frequency"><select name="months_between" defaultValue="3"><option value="1">Monthly</option><option value="3">Quarterly</option><option value="6">Half-yearly</option><option value="12">Yearly</option></select></Field>
            <Field label="Number of payments"><input name="count" type="number" min={1} max={60} defaultValue={4} required /></Field>
            <Field label="Amount of each payment" hint="You can edit individual payments afterwards."><input name="amount" required {...DEC} /></Field>
          </div>
        </Form></Modal>}
      {(modal?.kind === 'doc' || modal?.kind === 'version') && <Modal title={modal.kind === 'doc' ? 'Upload document' : `New version of "${modal.item.title}"`} onClose={close}>
        <UploadForm isNew={modal.kind === 'doc'} onCancel={close} onSubmit={async (form) => { await upload(modal.kind === 'doc' ? `/api/loans/${loan.id}/documents` : `/api/documents/${modal.item.id}/versions`, form); close(); }} />
      </Modal>}
      {modal?.kind === 'docedit' && <Modal title="Edit document" onClose={close}>
        <Form onCancel={close} onSubmit={async (v) => { await api(`/api/documents/${modal.item.id}`, { method: 'PUT', json: { title: v.title, category: v.category, expiry_date: v.expiry_date || null, archived: v.archived === 'on' } }); await qc.invalidateQueries(); close(); }}>
          <div className="form-grid">
            <Field label="Title" full><input name="title" required defaultValue={modal.item.title} /></Field>
            <Field label="Category"><CategorySelect value={modal.item.category} /></Field>
            <Field label="Expiry date (optional)"><input name="expiry_date" type="date" defaultValue={modal.item.expiry_date ?? ''} /></Field>
            <label className="full"><input type="checkbox" name="archived" />Archive this document (kept for audit, hidden from the list)</label>
          </div>
        </Form></Modal>}
    </Page>
  );
}

const CategorySelect = ({ value }: { value?: string }) => (
  <select name="category" defaultValue={value ?? 'agreement'}><option value="agreement">Facility agreement</option><option value="pledge">Pledge agreement</option><option value="security">Security document</option><option value="valuation">Valuation</option><option value="correspondence">Correspondence</option><option value="other">Other</option></select>
);

function UploadForm({ isNew, onSubmit, onCancel }: { isNew: boolean; onSubmit: (form: HTMLFormElement) => Promise<void>; onCancel: () => void }) {
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  return (
    <form onSubmit={async (e) => { e.preventDefault(); setBusy(true); setError(''); try { await onSubmit(e.currentTarget); } catch (err: any) { setError(err.message); } finally { setBusy(false); } }}>
      {error && <div className="error" role="alert">{error}</div>}
      <div className="form-grid">
        {/* Text fields come before the file so the server receives them first. */}
        {isNew && <Field label="Title" full><input name="title" required maxLength={200} /></Field>}
        {isNew && <Field label="Category"><CategorySelect /></Field>}
        <Field label={isNew ? 'Expiry date (optional)' : 'New expiry date (optional)'} hint="You get a reminder before it expires."><input name="expiry_date" type="date" /></Field>
        <Field label="Version note (optional)" full><input name="note" maxLength={500} placeholder="e.g. Signed copy, amendment no. 2" /></Field>
        <Field label="File" hint="PDF, DOCX, XLSX, PNG or JPG, up to 25 MB. Stored encrypted." full><input name="file" type="file" required accept=".pdf,.docx,.xlsx,.png,.jpg,.jpeg" /></Field>
      </div>
      <div className="form-actions"><button type="button" className="btn" onClick={onCancel}>Cancel</button><button className="btn primary" disabled={busy}>{busy ? 'Uploading…' : 'Upload'}</button></div>
    </form>
  );
}
