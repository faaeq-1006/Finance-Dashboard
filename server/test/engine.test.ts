import { describe, expect, it } from 'vitest';
import { computeCoverage, type Snapshot } from '../src/engine/coverage.js';
import { suggestAllocation } from '../src/engine/allocation.js';

/** The exact figures from the requirements deck. */
export function deckSnapshot(): Snapshot {
  const bank = (id: string, ratio: string) => ({ id, name: `Bank ${id}`, code: id, coverage_ratio: ratio, top_up_ratio: null, margin_call_ratio: null, eligibility_mode: 'all' as const });
  const loan = (id: string, bank_id: string, limit: string, used: string) => ({ id, bank_id, loan_no: `Loan ${id}`, limit_amount: limit, used_amount: used, coverage_ratio: null, top_up_ratio: null, margin_call_ratio: null });
  const prices: Record<string, string> = { A: '10', B: '15', C: '20', D: '25' };
  let n = 0;
  const pf = (id: string, bank_id: string, loan_id: string, sym: string, price?: string) => ({
    p: { id, name: `Portfolio ${id}`, bank_id, loan_id },
    h: { id: `h${++n}`, portfolio_id: id, security_id: sym, symbol: sym, security_name: `Share ${sym}`, quantity: '100', price: price ?? prices[sym] },
  });
  const rows = [pf('A1', 'A', '1', 'A'), pf('A2', 'A', '1', 'B'), pf('A3', 'A', '1', 'C'), pf('B1', 'B', '2', 'A'), pf('B2', 'B', '2', 'B'), pf('C1', 'C', '3', 'C', '30'), pf('C2', 'C', '3', 'D')];
  return {
    banks: [bank('A', '150'), bank('B', '130'), bank('C', '200')],
    loans: [loan('1', 'A', '5000', '4000'), loan('2', 'B', '3000', '1000'), loan('3', 'C', '2000', '1750')],
    portfolios: rows.map((r) => r.p), holdings: rows.map((r) => r.h), eligibility: [],
  };
}
const find = (r: ReturnType<typeof computeCoverage>, loanId: string) => r.banks.flatMap((b) => b.loans).find((l) => l.id === loanId)!;

describe('coverage engine', () => {
  it('reproduces the deck: Bank A Loan 1 is short by 1,500', () => {
    const l = find(computeCoverage(deckSnapshot()), '1');
    expect(l.market_value).toBe('4500.00');
    expect(l.coverage_required).toBe('6000.00');
    expect(l.surplus).toBe('-1500.00');
    expect(l.status).toBe('shortfall');
    expect(l.cure_top_up_value).toBe('1500.00');
    expect(l.cure_repay_amount).toBe('1000.00'); // 4500 / 1.5 = 3000 supportable
  });
  it('reproduces the deck: Bank B +1,200 and Bank C +2,000', () => {
    const r = computeCoverage(deckSnapshot());
    expect(find(r, '2').surplus).toBe('1200.00');
    expect(find(r, '3').surplus).toBe('2000.00');
    expect(r.totals.used_amount).toBe('6750.00');
    expect(r.totals.total_shortfall).toBe('1500.00');
    expect(r.totals.surplus).toBe('1700.00');
  });
  it('flags a loan inside the early-warning band as watch', () => {
    const s = deckSnapshot();
    s.loans[1].used_amount = '1800'; // required 2340, value 2500 => 138.9% vs 130% x 1.10 = 143%
    expect(find(computeCoverage(s, { warnBufferPct: 10 }), '2').status).toBe('watch');
    expect(find(computeCoverage(s, { warnBufferPct: 5 }), '2').status).toBe('ok');
  });
  it('escalates through top-up and margin-call levels', () => {
    const s = deckSnapshot();
    Object.assign(s.banks[0], { top_up_ratio: '120', margin_call_ratio: '110' });
    expect(find(computeCoverage(s), '1').status).toBe('top_up'); // 112.5%
    expect(find(computeCoverage(s, { shockPct: -5 }), '1').status).toBe('margin_call'); // 106.9%
  });
  it('loan-level terms override the bank', () => {
    const s = deckSnapshot();
    s.loans[0].coverage_ratio = '100';
    const l = find(computeCoverage(s), '1');
    expect(l.terms_source).toBe('loan');
    expect(l.surplus).toBe('500.00');
  });
  it('ignores shares the bank does not accept and applies haircuts', () => {
    const s = deckSnapshot();
    s.banks[1].eligibility_mode = 'list';
    s.eligibility = [{ bank_id: 'B', security_id: 'A', haircut_pct: '20' }];
    const l = find(computeCoverage(s), '2');
    expect(l.market_value).toBe('2500.00');
    expect(l.collateral_value).toBe('800.00'); // only Share A, less 20%
    expect(l.surplus).toBe('-500.00');
  });
  it('applies what-if price shocks', () => {
    const r = computeCoverage(deckSnapshot(), { shockPct: -30 });
    expect(find(r, '3').collateral_value).toBe('3850.00');
    expect(find(r, '3').status).toBe('ok');
    expect(find(r, '2').surplus).toBe('450.00');
    const one = computeCoverage(deckSnapshot(), { securityShocks: { D: -100 } });
    expect(find(one, '3').collateral_value).toBe('3000.00');
  });
  it('treats an undrawn loan as fully covered and reports missing prices', () => {
    const s = deckSnapshot();
    s.loans[0].used_amount = '0';
    s.holdings[0].price = null;
    const r = computeCoverage(s);
    expect(find(r, '1').status).toBe('ok');
    expect(find(r, '1').actual_coverage_pct).toBeNull();
    expect(r.missing_prices).toEqual(['A']);
  });
  it('keeps exact decimals (no float drift)', () => {
    const s = deckSnapshot();
    s.holdings[0].quantity = '3';
    s.holdings[0].price = '0.1';
    s.holdings[1].quantity = '1';
    s.holdings[1].price = '0.2';
    s.holdings[2].quantity = '0.0001';
    expect(find(computeCoverage(s), '1').market_value).toBe('0.50');
  });
});

describe('collateral allocation', () => {
  it('moves only surplus from donor loans and never puts a donor at risk', () => {
    const s = deckSnapshot();
    const a = suggestAllocation(computeCoverage(s), s, 10, 'required');
    expect(a.loans[0].need).toBe('1500.00');
    expect(a.loans[0].remaining).toBe('0.00');
    // apply moves and re-test
    for (const m of a.moves) {
      const from = s.holdings.find((h) => h.id === m.from_holding_id)!;
      from.quantity = String(Number(from.quantity) - Number(m.quantity));
      s.portfolios.push({ id: `n${m.from_holding_id}`, name: `New ${m.from_holding_id}`, bank_id: 'A', loan_id: '1' });
      s.holdings.push({ ...from, id: `x${from.id}`, portfolio_id: `n${m.from_holding_id}`, quantity: m.quantity });
    }
    s.holdings = s.holdings.filter((h) => Number(h.quantity) > 0);
    const after = computeCoverage(s);
    expect(after.totals.total_shortfall).toBe('0.00');
    expect(after.banks.flatMap((b) => b.loans).every((l) => l.status === 'ok' || l.id === '1')).toBe(true);
  });
  it('uses unpledged shares before touching other loans and respects eligibility', () => {
    const s = deckSnapshot();
    s.portfolios.push({ id: 'F', name: 'Free', bank_id: null, loan_id: null });
    s.holdings.push({ id: 'hf', portfolio_id: 'F', security_id: 'D', symbol: 'D', security_name: 'Share D', quantity: '1000', price: '25' });
    const a = suggestAllocation(computeCoverage(s), s, 10, 'required');
    expect(a.moves).toHaveLength(1);
    expect(a.moves[0]).toMatchObject({ from_portfolio_id: 'F', quantity: '60', collateral_added: '1500.00' });
    s.banks[0].eligibility_mode = 'list';
    s.eligibility = ['A', 'B', 'C'].map((x) => ({ bank_id: 'A', security_id: x, haircut_pct: '0' }));
    const b = suggestAllocation(computeCoverage(s), s, 10, 'required');
    expect(b.moves.every((m) => m.symbol !== 'D')).toBe(true);
  });
});
