import { Fragment, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import { api, dateTime, money, pct, qty } from '../api';
import { Badge, Card, Empty, ErrorBox, Loading, Money, Page, StatusBadge } from '../ui';
import { FeedBadge } from './Dashboard';

/** The deck's diagram: pledged shares (assets) on the left, the loan they back (liabilities) on the right. */
export function CoverageTable({ data, compare }: { data: any; compare?: any }) {
  const [closed, setClosed] = useState<Record<string, boolean>>({});
  const toggle = (id: string) => setClosed((c) => ({ ...c, [id]: !c[id] }));
  // The collateral column only earns its place when a haircut or an ineligible share makes it differ from share value.
  const showCollateral = data.totals.collateral_value !== data.totals.market_value;
  const A = showCollateral ? 6 : 5;
  const baseLoan = (id: string) => compare?.banks.flatMap((b: any) => b.loans).find((l: any) => l.id === id);
  return (
    <div className="table-wrap"><table className="dense">
      <thead>
        <tr><th colSpan={A} style={{ textAlign: 'center', background: 'var(--brown-900)', color: '#fff' }}>Assets: shares pledged</th><th colSpan={7} style={{ textAlign: 'center', background: 'var(--accent)', color: '#fff' }}>Liabilities: bank loan</th></tr>
        <tr><th>Bank / portfolio</th><th>Share</th><th className="num">No. of shares</th><th className="num">Price</th><th className="num">Share value</th>{showCollateral && <th className="num">Collateral</th>}
          <th>Loan no.</th><th className="num">Limit</th><th className="num">Used</th><th className="num">Ratio</th><th className="num">Required</th><th className="num">Surplus / shortfall</th><th>Status</th></tr>
      </thead>
      <tbody>
        {data.banks.map((bank: any) => (
          <Fragment key={bank.id}>
            <tr className="group"><td colSpan={A + 7}><button className="twisty" onClick={() => toggle(bank.id)} aria-expanded={!closed[bank.id]} aria-label={`Toggle ${bank.name}`}>{closed[bank.id] ? '▶' : '▼'}</button><Link to={`/banks/${bank.id}`}>{bank.name}</Link></td></tr>
            {!closed[bank.id] && bank.loans.map((loan: any) => {
              const lines = loan.portfolios.flatMap((p: any) => p.holdings.map((h: any) => ({ p, h })));
              const base = baseLoan(loan.id);
              const liab = (
                <>
                  <td rowSpan={Math.max(lines.length, 1)}><Link to={`/loans/${loan.id}`}>{loan.loan_no}</Link></td>
                  <td rowSpan={Math.max(lines.length, 1)} className="num">{money(loan.limit_amount)}</td>
                  <td rowSpan={Math.max(lines.length, 1)} className="num">{money(loan.used_amount)}</td>
                  <td rowSpan={Math.max(lines.length, 1)} className="num">{pct(loan.coverage_ratio)}<div className="muted small">now {pct(loan.actual_coverage_pct)}</div></td>
                  <td rowSpan={Math.max(lines.length, 1)} className="num">{money(loan.coverage_required)}</td>
                  <td rowSpan={Math.max(lines.length, 1)} className="num"><Money v={loan.surplus} signed />{base && <div className="muted small">was {money(base.surplus)}</div>}</td>
                  <td rowSpan={Math.max(lines.length, 1)}><StatusBadge status={loan.status} /></td>
                </>
              );
              if (!lines.length) return <tr key={loan.id} className="sub"><td colSpan={A} className="muted">Nothing pledged to this loan</td>{liab}</tr>;
              return lines.map(({ p, h }: any, i: number) => (
                <tr key={h.id} className="sub">
                  <td>{p.name}</td>
                  <td>{h.symbol} <span className="muted">{h.security_name}</span>{!h.eligible && <> <Badge tone="bad">not eligible</Badge></>}{Number(h.haircut_pct) > 0 && <> <Badge tone="neutral">haircut {pct(h.haircut_pct)}</Badge></>}</td>
                  <td className="num">{qty(h.quantity)}</td><td className="num">{h.price ? Number(h.price).toFixed(2) : <Badge tone="bad">no price</Badge>}</td>
                  <td className="num">{money(h.market_value)}</td>{showCollateral && <td className="num">{money(h.collateral_value)}</td>}
                  {i === 0 && liab}
                </tr>));
            })}
            {!closed[bank.id] && bank.unpledged_portfolios.flatMap((p: any) => p.holdings.map((h: any) => (
              <tr key={h.id} className="sub"><td>{p.name} <Badge tone="info">not pledged</Badge></td><td>{h.symbol} <span className="muted">{h.security_name}</span></td><td className="num">{qty(h.quantity)}</td><td className="num">{h.price ? Number(h.price).toFixed(2) : '–'}</td><td className="num">{money(h.market_value)}</td>{showCollateral && <td className="num muted">–</td>}<td colSpan={7} className="muted">Held at the bank, available to pledge</td></tr>)))}
            <tr className="total"><td colSpan={2}>{bank.name} total</td><td className="num">{qty(bank.quantity)}</td><td /><td className="num">{money(bank.market_value)}</td>{showCollateral && <td className="num">{money(bank.collateral_value)}</td>}
              <td /><td className="num">{money(bank.limit_amount)}</td><td className="num">{money(bank.used_amount)}</td><td /><td className="num">{money(bank.coverage_required)}</td><td className={`num ${Number(bank.surplus) < 0 ? 'neg' : 'pos'}`}>{money(bank.surplus)}</td><td /></tr>
          </Fragment>
        ))}
        {!data.banks.length && <tr><td colSpan={A + 7}><Empty>No banks yet.</Empty></td></tr>}
      </tbody>
      {data.banks.length > 0 && (
        <tfoot><tr className="total"><td colSpan={4}>All banks</td><td className="num">{money(data.totals.market_value)}</td>{showCollateral && <td className="num">{money(data.totals.collateral_value)}</td>}<td />
          <td className="num">{money(data.totals.limit_amount)}</td><td className="num">{money(data.totals.used_amount)}</td><td /><td className="num">{money(data.totals.coverage_required)}</td>
          <td className={`num ${Number(data.totals.surplus) < 0 ? 'neg' : 'pos'}`}>{money(data.totals.surplus)}</td><td /></tr></tfoot>
      )}
    </table></div>
  );
}

export default function Coverage() {
  const { data, error, isPending } = useQuery({ queryKey: ['coverage'], queryFn: () => api('/api/coverage') });
  if (isPending) return <Loading />;
  if (error) return <ErrorBox error={error} />;
  return (
    <Page title="Coverage view" sub="Shares pledged at each bank against the loan they back. Share value = number of shares × price. Required = loan used × coverage ratio. Surplus / shortfall = collateral value − required."
      actions={<><FeedBadge feed={data.feed} /><a className="btn" href="/api/reports/coverage.xlsx">Export to Excel</a></>}>
      {data.missing_prices.length > 0 && <div className="warn">No price for {data.missing_prices.join(', ')}. These shares count as zero until a price arrives.</div>}
      {Number(data.totals.total_shortfall) > 0 && <div className="error">Total shortfall across loans: {money(data.totals.total_shortfall)}. A surplus at one bank does not cover a shortfall at another. <Link to="/allocation">See allocation suggestions</Link></div>}
      <Card flush><CoverageTable data={data} /></Card>
      {data.free_portfolios.length > 0 && (
        <Card title="Unpledged shares (not held at any bank)" flush>
          <div className="table-wrap"><table><thead><tr><th>Portfolio</th><th>Share</th><th className="num">No. of shares</th><th className="num">Price</th><th className="num">Value</th></tr></thead>
            <tbody>{data.free_portfolios.flatMap((p: any) => p.holdings.map((h: any) => <tr key={h.id}><td>{p.name}</td><td>{h.symbol} <span className="muted">{h.security_name}</span></td><td className="num">{qty(h.quantity)}</td><td className="num">{h.price ? Number(h.price).toFixed(2) : '–'}</td><td className="num">{money(h.market_value)}</td></tr>))}</tbody></table></div>
        </Card>
      )}
      <div className="muted small">As at {dateTime(data.as_of)}. Early-warning band: {data.warn_buffer_pct}% above each loan's required coverage. Refreshes automatically when prices or positions change.</div>
    </Page>
  );
}
