import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { api, money, pct } from '../api';
import { Badge, Card, DEC, Empty, ErrorBox, Field, Form, Loading, Modal, Money, Page, StatusBadge, useCan, useCommand } from '../ui';

function BankForm({ bank, onClose }: { bank?: any; onClose: () => void }) {
  const run = useCommand();
  return (
    <Modal title={bank ? `Edit terms: ${bank.name}` : 'New bank'} onClose={onClose}>
      <Form onCancel={onClose} onSubmit={async (v) => { await run(bank ? 'bank.update' : 'bank.create', bank ? { ...v, id: bank.id } : v); onClose(); }}>
        <div className="form-grid">
          <Field label="Bank name"><input name="name" required defaultValue={bank?.name} /></Field>
          <Field label="Short code"><input name="code" required maxLength={20} defaultValue={bank?.code} /></Field>
          <Field label="Coverage ratio %" hint="Share value the bank requires, as a % of the loan used. Example: 150." full><input name="coverage_ratio" required {...DEC} defaultValue={bank?.coverage_ratio} /></Field>
          <Field label="Top-up level % (optional)" hint="Below this, the bank asks for more shares."><input name="top_up_ratio" {...DEC} defaultValue={bank?.top_up_ratio ?? ''} /></Field>
          <Field label="Margin call level % (optional)" hint="Below this, the bank may call the loan or sell shares."><input name="margin_call_ratio" {...DEC} defaultValue={bank?.margin_call_ratio ?? ''} /></Field>
          <Field label="Contact name (optional)"><input name="contact_name" defaultValue={bank?.contact_name ?? ''} /></Field>
          <Field label="Contact email (optional)"><input name="contact_email" type="email" defaultValue={bank?.contact_email ?? ''} /></Field>
          <Field label="Notes" full><textarea name="notes" defaultValue={bank?.notes ?? ''} /></Field>
        </div>
      </Form>
    </Modal>
  );
}

export function Banks() {
  const nav = useNavigate();
  const can = useCan();
  const [adding, setAdding] = useState(false);
  const { data, error, isPending } = useQuery({ queryKey: ['banks'], queryFn: () => api('/api/banks') });
  if (isPending) return <Loading />;
  if (error) return <ErrorBox error={error} />;
  return (
    <Page title="Banks & terms" sub="Each bank's coverage ratio, top-up and margin call levels, and the shares it accepts. These terms feed the coverage calculation automatically."
      actions={can('write') && <button className="btn primary" onClick={() => setAdding(true)}>New bank</button>}>
      <Card flush>
        <div className="table-wrap"><table>
          <thead><tr><th>Bank</th><th>Code</th><th className="num">Coverage ratio</th><th className="num">Top-up level</th><th className="num">Margin call level</th><th>Eligible shares</th><th className="num">Active loans</th></tr></thead>
          <tbody>{data.map((b: any) => (
            <tr key={b.id} className="clickable" onClick={() => nav(`/banks/${b.id}`)}>
              <td><Link to={`/banks/${b.id}`} onClick={(e) => e.stopPropagation()}>{b.name}</Link></td><td>{b.code}</td><td className="num">{pct(b.coverage_ratio)}</td><td className="num">{pct(b.top_up_ratio)}</td><td className="num">{pct(b.margin_call_ratio)}</td>
              <td>{b.eligibility_mode === 'all' ? 'All shares' : `${b.listed_securities} listed shares only`}</td><td className="num">{b.active_loans}</td></tr>))}
            {!data.length && <tr><td colSpan={7}><Empty>No banks yet. Add the first bank and its terms.</Empty></td></tr>}
          </tbody>
        </table></div>
      </Card>
      {adding && <BankForm onClose={() => setAdding(false)} />}
    </Page>
  );
}

function EligibilityForm({ bank, securities, onClose }: { bank: any; securities: any[]; onClose: () => void }) {
  const run = useCommand();
  const [mode, setMode] = useState<string>(bank.eligibility_mode);
  const current = new Map<string, string>(bank.eligibility.map((e: any) => [e.security_id, e.haircut_pct]));
  return (
    <Modal title={`Eligible shares: ${bank.name}`} onClose={onClose} wide>
      <Form onCancel={onClose} onSubmit={async (v) => {
        const items = securities.filter((s) => (mode === 'list' ? v[`on_${s.id}`] === 'on' : Number(v[`cut_${s.id}`] || 0) > 0)).map((s) => ({ security_id: s.id, haircut_pct: v[`cut_${s.id}`] || '0' }));
        await run('bank.set_eligibility', { bank_id: bank.id, eligibility_mode: mode, items });
        onClose();
      }}>
        <div className="grid" style={{ marginBottom: 12 }}>
          <label><input type="radio" checked={mode === 'all'} onChange={() => setMode('all')} />The bank accepts all shares (set a haircut only where one applies)</label>
          <label><input type="radio" checked={mode === 'list'} onChange={() => setMode('list')} />The bank accepts only the shares ticked below</label>
        </div>
        <div className="table-wrap"><table>
          <thead><tr>{mode === 'list' && <th>Accepted</th>}<th>Share</th><th className="num">Haircut %</th></tr></thead>
          <tbody>{securities.map((s) => (
            <tr key={s.id}>{mode === 'list' && <td><input type="checkbox" name={`on_${s.id}`} defaultChecked={current.has(s.id)} aria-label={`Accept ${s.symbol}`} /></td>}
              <td>{s.symbol} <span className="muted">{s.name}</span></td>
              <td className="num"><input name={`cut_${s.id}`} {...DEC} defaultValue={Number(current.get(s.id) ?? 0) || ''} placeholder="0" style={{ width: 90, textAlign: 'right' }} aria-label={`Haircut for ${s.symbol}`} /></td></tr>))}</tbody>
        </table></div>
        <p className="muted small">A haircut reduces the value the bank gives a share. With a 20% haircut, shares worth 1,000 count as 800 of collateral.</p>
      </Form>
    </Modal>
  );
}

export function BankDetail() {
  const { id } = useParams();
  const can = useCan();
  const [modal, setModal] = useState('');
  const bank = useQuery({ queryKey: ['bank', id], queryFn: () => api(`/api/banks/${id}`) });
  const coverage = useQuery({ queryKey: ['coverage'], queryFn: () => api('/api/coverage') });
  const securities = useQuery({ queryKey: ['securities'], queryFn: () => api('/api/securities') });
  if (bank.isPending || coverage.isPending) return <Loading />;
  if (bank.error) return <ErrorBox error={bank.error} />;
  const b = bank.data;
  const pos = coverage.data?.banks.find((x: any) => x.id === id);
  return (
    <Page crumbs={<Link to="/banks">Banks & terms</Link>} title={b.name} sub={b.notes}
      actions={<>{pos && <a className="btn" href={`/api/reports/bank-statement/${b.id}.pdf`}>Collateral statement (PDF)</a>}
        {can('write') && <><button className="btn" onClick={() => setModal('elig')}>Eligible shares</button><button className="btn primary" onClick={() => setModal('edit')}>Edit terms</button></>}</>}>
      <Card title="Standard terms">
        <dl className="kv">
          <div><dt>Coverage ratio</dt><dd>{pct(b.coverage_ratio)}</dd></div><div><dt>Top-up level</dt><dd>{pct(b.top_up_ratio)}</dd></div><div><dt>Margin call level</dt><dd>{pct(b.margin_call_ratio)}</dd></div>
          <div><dt>Eligible shares</dt><dd>{b.eligibility_mode === 'all' ? 'All shares' : `${b.eligibility.length} listed`}</dd></div>
          <div><dt>Contact</dt><dd>{b.contact_name ?? '–'}{b.contact_email && <div className="small" style={{ fontWeight: 400 }}>{b.contact_email}</div>}</dd></div>
        </dl>
        {b.eligibility.length > 0 && <p style={{ marginBottom: 0 }}>{b.eligibility.map((e: any) => <Badge key={e.security_id} tone="neutral">{e.symbol}{Number(e.haircut_pct) > 0 ? ` (haircut ${pct(e.haircut_pct)})` : ''}</Badge>).reduce((acc: any[], x: any) => [...acc, ' ', x], [])}</p>}
      </Card>
      <Card title="Loans at this bank" flush>
        <div className="table-wrap"><table><thead><tr><th>Loan</th><th className="num">Limit</th><th className="num">Used</th><th className="num">Coverage ratio</th><th className="num">Required</th><th className="num">Collateral</th><th className="num">Surplus / shortfall</th><th>Status</th></tr></thead>
          <tbody>{pos?.loans.map((l: any) => (
            <tr key={l.id}><td><Link to={`/loans/${l.id}`}>{l.loan_no}</Link></td><td className="num">{money(l.limit_amount)}</td><td className="num">{money(l.used_amount)}</td>
              <td className="num">{pct(l.coverage_ratio)} {l.terms_source === 'loan' && <Badge tone="info">loan-specific</Badge>}</td><td className="num">{money(l.coverage_required)}</td><td className="num">{money(l.collateral_value)}</td><td className="num"><Money v={l.surplus} signed /></td><td><StatusBadge status={l.status} /></td></tr>))}
            {!pos?.loans.length && <tr><td colSpan={8}><Empty>No active loans at this bank.</Empty></td></tr>}</tbody></table></div>
      </Card>
      {modal === 'edit' && <BankForm bank={b} onClose={() => setModal('')} />}
      {modal === 'elig' && <EligibilityForm bank={b} securities={securities.data ?? []} onClose={() => setModal('')} />}
    </Page>
  );
}
