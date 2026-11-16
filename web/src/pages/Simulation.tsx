import { useState } from 'react';
import { keepPreviousData, useQuery } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import { api, money, pct } from '../api';
import { Card, ErrorBox, Loading, Money, Page, Stat, StatusBadge } from '../ui';

export default function Simulation() {
  const [shock, setShock] = useState(-20);
  const [perShare, setPerShare] = useState<Record<string, number>>({});
  const securities = useQuery({ queryKey: ['securities'], queryFn: () => api('/api/securities') });
  const sim = useQuery({
    queryKey: ['simulate', shock, perShare],
    queryFn: () => api('/api/simulate', { json: { shock_pct: shock, security_shocks: perShare } }),
    placeholderData: keepPreviousData,
  });
  if (sim.isPending) return <Loading />;
  if (sim.error) return <ErrorBox error={sim.error} />;
  const { base, shocked } = sim.data;
  const baseLoans = new Map<string, any>(base.banks.flatMap((b: any) => b.loans.map((l: any) => [l.id, l])));
  const rows = shocked.banks.flatMap((b: any) => b.loans.map((l: any) => ({ ...l, bank: b.name, base: baseLoans.get(l.id) })));
  const held = (securities.data ?? []).filter((s: any) => Number(s.total_quantity) > 0);
  const newlyShort = rows.filter((r: any) => Number(r.surplus) < 0 && Number(r.base.surplus) >= 0).length;
  return (
    <Page title="What-if simulation" sub="Test a fall in share prices and see which loans would go into shortfall, before it happens. Nothing here changes real data.">
      <Card title="Price scenario">
        <div className="actions" style={{ marginBottom: 10 }}>
          {[-10, -15, -20, -25, -30].map((v) => <button key={v} className={`btn sm ${shock === v ? 'primary' : ''}`} onClick={() => setShock(v)}>{v}%</button>)}
          <button className="btn sm" onClick={() => { setShock(0); setPerShare({}); }}>Reset</button>
        </div>
        <label className="field">All shares move by <strong>{shock > 0 ? '+' : ''}{shock}%</strong>
          <input type="range" min={-60} max={20} step={1} value={shock} onChange={(e) => setShock(Number(e.target.value))} aria-label="Price change for all shares, percent" />
        </label>
        {held.length > 0 && <details style={{ marginTop: 12 }}>
          <summary style={{ cursor: 'pointer', fontWeight: 600 }}>Set a different move for individual shares</summary>
          <div className="form-grid" style={{ marginTop: 10, gridTemplateColumns: 'repeat(auto-fit, minmax(190px, 1fr))' }}>
            {held.map((s: any) => (
              <label key={s.id} className="field">{s.symbol} <span className="muted" style={{ fontWeight: 400 }}>{s.name}</span>
                <input type="number" min={-100} max={100} step={1} placeholder={`${shock} (same as all)`} value={perShare[s.id] ?? ''} onChange={(e) => setPerShare((p) => { const n = { ...p }; if (e.target.value === '') delete n[s.id]; else n[s.id] = Math.max(-100, Math.min(100, Number(e.target.value))); return n; })} />
              </label>))}
          </div></details>}
      </Card>
      <div className="grid stats">
        <Stat label="Collateral value" value={money(shocked.totals.collateral_value)} hint={`Today ${money(base.totals.collateral_value)}`} />
        <Stat dark label="Total shortfall in this scenario" value={<span className={Number(shocked.totals.total_shortfall) > 0 ? 'neg' : ''}>{money(shocked.totals.total_shortfall)}</span>} hint={`Today ${money(base.totals.total_shortfall)}`} />
        <Stat label="Loans in shortfall" value={rows.filter((r: any) => Number(r.surplus) < 0).length} hint={newlyShort ? `${newlyShort} more than today` : 'No new shortfalls'} />
      </div>
      <Card title="Result by loan" flush>
        <div className="table-wrap"><table className="dense">
          <thead><tr><th>Bank</th><th>Loan</th><th className="num">Used</th><th className="num">Required</th><th className="num">Collateral today</th><th className="num">In scenario</th><th className="num">Surplus / shortfall</th><th className="num">Coverage</th><th>Status</th><th className="num">Top-up needed</th><th className="num">Or repay</th></tr></thead>
          <tbody>{rows.map((r: any) => (
            <tr key={r.id}><td>{r.bank}</td><td><Link to={`/loans/${r.id}`}>{r.loan_no}</Link></td><td className="num">{money(r.used_amount)}</td><td className="num">{money(r.coverage_required)}</td>
              <td className="num muted">{money(r.base.collateral_value)}</td><td className="num">{money(r.collateral_value)}</td><td className="num"><Money v={r.surplus} signed /></td>
              <td className="num">{pct(r.actual_coverage_pct)} <span className="muted">/ {pct(r.coverage_ratio)}</span></td>
              <td><StatusBadge status={r.status} />{r.status !== r.base.status && <div className="muted small">today: {r.base.status === 'ok' ? 'covered' : r.base.status.replace('_', ' ')}</div>}</td>
              <td className="num">{Number(r.cure_top_up_value) > 0 ? money(r.cure_top_up_value) : '–'}</td><td className="num">{Number(r.cure_repay_amount) > 0 ? money(r.cure_repay_amount) : '–'}</td></tr>))}</tbody>
        </table></div>
      </Card>
    </Page>
  );
}
