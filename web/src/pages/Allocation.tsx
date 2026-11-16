import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import { api, money, qty } from '../api';
import { Badge, Card, Empty, ErrorBox, Loading, Page, useCan, useCommand, useToast } from '../ui';

export default function Allocation() {
  const can = useCan();
  const run = useCommand();
  const toast = useToast();
  const [target, setTarget] = useState<'buffer' | 'required'>('buffer');
  const [sent, setSent] = useState<Record<string, boolean>>({});
  const { data, error, isPending } = useQuery({ queryKey: ['allocation', target], queryFn: () => api(`/api/allocation?target=${target}`) });
  if (isPending) return <Loading />;
  if (error) return <ErrorBox error={error} />;
  const apply = async (m: any, key: string) => {
    try {
      await run('holding.transfer', { holding_id: m.from_holding_id, quantity: m.quantity, ...(m.to_portfolio_id ? { to_portfolio_id: m.to_portfolio_id } : { to_loan_id: m.to_loan_id }) }, 'Shares transferred');
      setSent((s) => ({ ...s, [key]: true }));
    } catch (e: any) { toast(e.message, true); }
  };
  return (
    <Page title="Collateral allocation" sub="Suggests which shares to pledge to loans that are short, using unpledged shares first and then surplus shares at other loans. A loan is never taken below its own requirement plus the safety buffer."
      actions={<label className="field" style={{ minWidth: 260 }}>Restore each loan to
        <select value={target} onChange={(e) => setTarget(e.target.value as any)}><option value="buffer">Requirement plus {data.warn_buffer_pct}% buffer</option><option value="required">Exactly the requirement</option></select></label>}>
      <Card title="Loans that need collateral" flush>
        <div className="table-wrap"><table>
          <thead><tr><th>Bank</th><th>Loan</th><th className="num">Collateral needed</th><th className="num">Covered by suggestions</th><th className="num">Still uncovered</th><th className="num">Or repay instead</th></tr></thead>
          <tbody>{data.loans.map((l: any) => (
            <tr key={l.loan_id}><td>{l.bank}</td><td><Link to={`/loans/${l.loan_id}`}>{l.loan}</Link></td><td className="num">{money(l.need)}</td><td className="num pos">{money(l.covered)}</td>
              <td className={`num ${Number(l.remaining) > 0 ? 'neg' : ''}`}>{money(l.remaining)}</td><td className="num">{Number(l.remaining) > 0 ? money(l.repay_alternative) : '–'}</td></tr>))}
            {!data.loans.length && <tr><td colSpan={6}><Empty>Every loan is covered with its buffer. No moves are needed.</Empty></td></tr>}</tbody>
        </table></div>
      </Card>
      {data.loans.length > 0 && <Card title="Suggested moves" flush>
        <div className="table-wrap"><table>
          <thead><tr><th>Share</th><th className="num">No. of shares</th><th>From</th><th>To</th><th className="num">Collateral added</th><th /></tr></thead>
          <tbody>{data.moves.map((m: any, i: number) => {
            const key = `${m.from_holding_id}:${m.to_loan_id}:${m.quantity}`;
            return (
              <tr key={i}><td><strong>{m.symbol}</strong></td><td className="num">{qty(m.quantity)}</td>
                <td>{m.from_portfolio}<div className="muted small">{m.from_loan ? `surplus at ${m.from_bank} ${m.from_loan}` : m.from_bank ? `unpledged at ${m.from_bank}` : 'unpledged'}</div></td>
                <td>{m.to_bank} {m.to_loan} {m.cross_bank && <Badge tone="watch">moves between banks</Badge>}</td><td className="num">{money(m.collateral_added)}</td>
                <td className="num">{can('write') && (sent[key] ? <Badge tone="info">requested</Badge> : <button className="btn sm primary" onClick={() => apply(m, key)}>Request transfer</button>)}</td></tr>);
          })}
            {!data.moves.length && <tr><td colSpan={6}><Empty>No spare eligible shares are available. Consider a repayment or buying more eligible shares.</Empty></td></tr>}</tbody>
        </table></div>
        <div className="card-body muted small">Moving shares between banks means releasing the pledge at one bank and creating it at the other. Record the transfer here once it has been agreed with both banks.</div>
      </Card>}
      <Card title="Loans holding more than they need" flush>
        <div className="table-wrap"><table><thead><tr><th>Bank</th><th>Loan</th><th className="num">Collateral that could be released</th></tr></thead>
          <tbody>{data.releasable.map((r: any) => <tr key={r.loan_id}><td>{r.bank}</td><td><Link to={`/loans/${r.loan_id}`}>{r.loan}</Link></td><td className="num">{money(r.value)}</td></tr>)}
            {!data.releasable.length && <tr><td colSpan={3}><Empty>No loan has spare collateral above its buffer.</Empty></td></tr>}</tbody></table></div>
      </Card>
    </Page>
  );
}
