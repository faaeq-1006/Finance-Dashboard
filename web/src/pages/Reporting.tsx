import { useState } from 'react';
import { useInfiniteQuery, useQuery } from '@tanstack/react-query';
import { api, dateTime, today } from '../api';
import { Badge, Card, Empty, ErrorBox, Field, Loading, Page } from '../ui';
import { Diff } from './Loans';

export function Reports() {
  const banks = useQuery({ queryKey: ['banks'], queryFn: () => api('/api/banks') });
  const securities = useQuery({ queryKey: ['securities'], queryFn: () => api('/api/securities') });
  const [bank, setBank] = useState('');
  const [sec, setSec] = useState('');
  const [from, setFrom] = useState(new Date(Date.now() - 30 * 86_400_000).toLocaleDateString('en-CA'));
  const [to, setTo] = useState(today());
  return (
    <Page title="Reports" sub="Management reporting and exports. Every export is recorded in the audit trail.">
      <div className="grid two">
        <Card title="Management report (PDF)"><p style={{ marginTop: 0 }}>Total borrowing, headroom, coverage by loan and key dates for the next 90 days.</p><a className="btn primary" href="/api/reports/management.pdf">Download PDF</a></Card>
        <Card title="Coverage workbook (Excel)"><p style={{ marginTop: 0 }}>The assets-and-liabilities coverage view, the full loan register and the finance charge schedule.</p><a className="btn primary" href="/api/reports/coverage.xlsx">Download Excel</a></Card>
        <Card title="Bank collateral statement (PDF)">
          <p style={{ marginTop: 0 }}>Loans, pledged shares and coverage position for one bank, to reconcile with the bank's own statement.</p>
          <Field label="Bank"><select value={bank} onChange={(e) => setBank(e.target.value)}><option value="">Select a bank</option>{(banks.data ?? []).map((b: any) => <option key={b.id} value={b.id}>{b.name}</option>)}</select></Field>
          <div style={{ marginTop: 12 }}>{bank ? <a className="btn primary" href={`/api/reports/bank-statement/${bank}.pdf`}>Download PDF</a> : <button className="btn" disabled>Download PDF</button>}</div>
        </Card>
        <Card title="Price history (Excel)">
          <p style={{ marginTop: 0 }}>Every recorded price with its time and source.</p>
          <div className="form-grid">
            <Field label="Share" full><select value={sec} onChange={(e) => setSec(e.target.value)}><option value="">All shares</option>{(securities.data ?? []).map((s: any) => <option key={s.id} value={s.id}>{s.symbol} {s.name}</option>)}</select></Field>
            <Field label="From"><input type="date" value={from} max={to} onChange={(e) => setFrom(e.target.value)} /></Field>
            <Field label="To"><input type="date" value={to} min={from} onChange={(e) => setTo(e.target.value)} /></Field>
          </div>
          <div style={{ marginTop: 12 }}><a className="btn primary" href={`/api/reports/price-history.xlsx?security_id=${sec}&from=${from}&to=${to}`}>Download Excel</a></div>
        </Card>
      </div>
    </Page>
  );
}

export function Audit() {
  const [filter, setFilter] = useState({ action: '', entity_type: '', actor: '' });
  const qs = new URLSearchParams(Object.entries(filter).filter(([, v]) => v)).toString();
  const log = useInfiniteQuery({
    queryKey: ['audit', qs], initialPageParam: '',
    queryFn: ({ pageParam }) => api(`/api/audit?${qs}${pageParam ? `&before_id=${pageParam}` : ''}`),
    getNextPageParam: (last: any[]) => (last.length === 50 ? String(last[last.length - 1].id) : undefined),
  });
  const verify = useQuery({ queryKey: ['audit-verify'], queryFn: () => api('/api/audit/verify'), enabled: false });
  const rows = log.data?.pages.flat() ?? [];
  const set = (k: string) => (e: any) => setFilter((f) => ({ ...f, [k]: e.target.value }));
  return (
    <Page title="Audit trail" sub="A complete, tamper-evident log of every change, sign-in, approval and export. Entries cannot be edited or deleted; each one is cryptographically chained to the one before."
      actions={<><button className="btn" onClick={() => verify.refetch()} disabled={verify.isFetching}>{verify.isFetching ? 'Checking…' : 'Verify integrity'}</button><a className="btn" href={`/api/audit/export.csv?${qs}`}>Export CSV</a></>}>
      {verify.data && (verify.data.ok ? <div className="note">Integrity verified: all {verify.data.rows.toLocaleString()} entries are intact and in sequence.</div> : <div className="error">Integrity check failed at entry {verify.data.broken_at_id}. The log may have been altered. Escalate immediately.</div>)}
      <Card>
        <div className="form-grid" style={{ gridTemplateColumns: 'repeat(auto-fit, minmax(180px, 1fr))' }}>
          <Field label="Activity"><select value={filter.action} onChange={set('action')}><option value="">All activity</option><option value="auth.">Sign-ins and security</option><option value="loan.">Loans</option><option value="bank.">Banks and terms</option><option value="portfolio.">Portfolios</option><option value="holding.">Share positions</option><option value="price.">Prices</option><option value="charge.">Finance charges</option><option value="document.">Documents</option><option value="approval.">Approvals</option><option value="user.">Users</option><option value="api_key.">API keys</option><option value="settings.">Settings</option><option value="report.">Exports</option></select></Field>
          <Field label="Record type"><select value={filter.entity_type} onChange={set('entity_type')}><option value="">All</option>{['loan', 'bank', 'portfolio', 'holding', 'security', 'finance_charge', 'change_request', 'user', 'api_key', 'settings'].map((t) => <option key={t} value={t}>{t.replace('_', ' ')}</option>)}</select></Field>
          <Field label="User contains"><input value={filter.actor} onChange={set('actor')} placeholder="name@company.com" /></Field>
        </div>
      </Card>
      {log.isPending ? <Loading /> : log.error ? <ErrorBox error={log.error} /> : (
        <Card flush>
          <div className="table-wrap"><table>
            <thead><tr><th>#</th><th>When</th><th>Who</th><th>Action</th><th>Record</th><th>Change</th></tr></thead>
            <tbody>{rows.map((r: any) => (
              <tr key={r.id}><td className="mono">{r.id}</td><td style={{ whiteSpace: 'nowrap' }}>{dateTime(r.at)}</td><td>{r.actor_label}<div className="muted small">{r.ip}</div></td>
                <td><Badge tone={r.action.includes('failed') || r.action.includes('rejected') ? 'bad' : 'neutral'}>{r.action}</Badge></td><td className="small">{r.entity_type ?? ''}</td>
                <td className="wrap">{(r.before || r.after) && <Diff before={r.before} after={r.after} />}{r.meta && <div className="muted small mono">{JSON.stringify(r.meta)}</div>}</td></tr>))}
              {!rows.length && <tr><td colSpan={6}><Empty>No entries match.</Empty></td></tr>}</tbody>
          </table></div>
          {log.hasNextPage && <div className="card-body" style={{ textAlign: 'center' }}><button className="btn" onClick={() => log.fetchNextPage()} disabled={log.isFetchingNextPage}>{log.isFetchingNextPage ? 'Loading…' : 'Load older entries'}</button></div>}
        </Card>)}
    </Page>
  );
}
