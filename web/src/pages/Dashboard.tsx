import { useQuery } from '@tanstack/react-query';
import { Link, useNavigate } from 'react-router-dom';
import { Bar, BarChart, CartesianGrid, Cell, Legend, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';
import { api, date, daysUntil, money, pct } from '../api';
import { Badge, Card, Empty, ErrorBox, Loading, Money, Page, Stat, StatusBadge } from '../ui';

export const KIND_LABEL: Record<string, string> = { maturity: 'Loan maturity', review: 'Facility review', renewal: 'Renewal', finance_charge: 'Finance charge', document_expiry: 'Document expiry' };
export const FeedBadge = ({ feed }: { feed: any }) => (
  <span className="live" title={feed.last_error ?? ''}>
    <span className={`dot ${feed.provider === 'simulated' ? 'sim' : feed.last_error ? 'off' : ''}`} />
    {feed.provider === 'simulated' ? 'Prices: simulated feed (demo, not market data)' : 'Prices: manual entry and API push'}
  </span>
);

export default function Dashboard() {
  const nav = useNavigate();
  const { data, error, isPending } = useQuery({ queryKey: ['dashboard'], queryFn: () => api('/api/dashboard') });
  if (isPending) return <Loading />;
  if (error) return <ErrorBox error={error} />;
  const t = data.totals;
  const chart = data.banks.map((b: any) => ({ name: b.name, Borrowed: Number(b.used_amount), 'Coverage required': Number(b.coverage_required), 'Collateral value': Number(b.collateral_value), short: Number(b.surplus) < 0 }));
  return (
    <Page title="Dashboard" sub="Total borrowing, headroom and how well the pledged shares cover each loan." actions={<FeedBadge feed={data.feed} />}>
      <div className="grid stats">
        <Stat dark label="Total borrowed" value={money(t.used_amount)} hint={`of ${money(t.limit_amount)} in limits`} />
        <Stat label="Undrawn headroom" value={money(t.headroom)} hint="Limit less amount used" />
        <Stat label="Pledged collateral value" value={money(t.collateral_value)} hint={`Coverage required ${money(t.coverage_required)}`} />
        <Stat label="Total shortfall" value={money(t.total_shortfall)} tone={Number(t.total_shortfall) > 0 ? 'neg' : 'pos'} hint={`${t.loans_at_risk} of ${t.loans} loans need attention`} />
        <Stat label="Surplus on covered loans" value={money(t.total_surplus)} hint={`Unpledged shares ${money(t.unpledged_value)}`} />
      </div>

      <Card title="Coverage by loan" actions={<Link className="btn sm" to="/coverage">Open coverage view</Link>} flush>
        <div className="table-wrap"><table>
          <thead><tr><th>Bank</th><th>Loan</th><th className="num">Used</th><th className="num">Required</th><th className="num">Collateral</th><th className="num">Surplus / shortfall</th><th className="num">Coverage</th><th className="num">Fall to shortfall</th><th>Status</th></tr></thead>
          <tbody>{data.loans.map((l: any) => (
            <tr key={l.id} className="clickable" onClick={() => nav(`/loans/${l.id}`)}>
              <td>{l.bank}</td><td><Link to={`/loans/${l.id}`} onClick={(e) => e.stopPropagation()}>{l.loan_no}</Link></td>
              <td className="num">{money(l.used_amount)}</td><td className="num">{money(l.coverage_required)}</td><td className="num">{money(l.collateral_value)}</td>
              <td className="num"><Money v={l.surplus} signed /></td>
              <td className="num">{pct(l.actual_coverage_pct)} <span className="muted">/ {pct(l.coverage_ratio)}</span></td>
              <td className="num">{l.price_drop_to_shortfall_pct ? `-${pct(l.price_drop_to_shortfall_pct, 1)}` : '–'}</td>
              <td><StatusBadge status={l.status} /></td>
            </tr>))}
            {!data.loans.length && <tr><td colSpan={9}><Empty>No active loans yet. Add a bank, then a loan.</Empty></td></tr>}
          </tbody>
        </table></div>
      </Card>

      <div className="grid two">
        <Card title="Collateral against requirement, by bank">
          <div style={{ height: 250 }}>
            <ResponsiveContainer>
              <BarChart data={chart} margin={{ top: 4, right: 8, left: 8, bottom: 0 }}>
                <CartesianGrid strokeDasharray="3 3" stroke="#e2d5c3" vertical={false} />
                <XAxis dataKey="name" tick={{ fontSize: 12 }} /><YAxis tick={{ fontSize: 12 }} tickFormatter={(v) => v.toLocaleString()} width={64} />
                <Tooltip formatter={(v: any) => money(v)} /><Legend wrapperStyle={{ fontSize: 12 }} />
                <Bar dataKey="Borrowed" fill="#c9a37c" isAnimationActive={false} /><Bar dataKey="Coverage required" fill="#8b4513" isAnimationActive={false} />
                <Bar dataKey="Collateral value" fill="#1b6e3c" isAnimationActive={false}>{chart.map((c: any, i: number) => <Cell key={i} fill={c.short ? '#b42318' : '#1b6e3c'} />)}</Bar>
              </BarChart>
            </ResponsiveContainer>
          </div>
          <div className="muted small">Collateral bar turns red where it is below the bank's requirement.</div>
        </Card>
        <div>
          <Card title="Open alerts" actions={<Link className="btn sm" to="/alerts">All alerts</Link>} flush>
            {data.alerts.length ? <table><tbody>{data.alerts.map((a: any) => (
              <tr key={a.id}><td style={{ width: 90 }}><Badge tone={a.severity === 'critical' ? 'bad' : 'watch'}>{a.severity}</Badge></td><td className="wrap">{a.loan_id ? <Link to={`/loans/${a.loan_id}`}>{a.title}</Link> : a.title}</td></tr>))}</tbody></table>
              : <Empty>No open alerts.</Empty>}
          </Card>
          <Card title="Next 60 days" actions={<Link className="btn sm" to="/key-dates">All key dates</Link>} flush>
            {data.key_dates.length ? <table><tbody>{data.key_dates.map((k: any, i: number) => {
              const d = daysUntil(k.date);
              return (
                <tr key={i}><td style={{ whiteSpace: 'nowrap' }}>{date(k.date)}</td><td className="wrap" style={{ minWidth: 120 }}>{KIND_LABEL[k.kind]}{k.label ? `: ${k.label}` : ''}<div className="muted small"><Link to={`/loans/${k.loan_id}`}>{k.bank} {k.loan_no}</Link></div></td>
                  <td className="num">{k.amount ? money(k.amount) : ''}</td><td><Badge tone={d < 0 ? 'bad' : d <= 7 ? 'watch' : 'neutral'}>{d < 0 ? `${-d}d overdue` : d === 0 ? 'today' : `in ${d}d`}</Badge></td></tr>);
            })}</tbody></table> : <Empty>Nothing due in the next 60 days.</Empty>}
          </Card>
        </div>
      </div>
      {data.pending_approvals > 0 && <div className="note">{data.pending_approvals} change{data.pending_approvals > 1 ? 's are' : ' is'} waiting for approval. <Link to="/approvals">Review</Link></div>}
    </Page>
  );
}
