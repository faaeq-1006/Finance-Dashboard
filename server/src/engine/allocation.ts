import { Decimal } from 'decimal.js';
import type { CoverageResult, Snapshot } from './coverage.js';

/**
 * Collateral allocation: suggests which shares to pledge to loans that are short, taking first from
 * unpledged shares, then from loans holding more than they need. A donor loan is never taken
 * below its own requirement plus the safety buffer. Suggestions only; nothing is moved here.
 */
export interface Move {
  from_holding_id: string; from_portfolio_id: string; from_portfolio: string;
  from_loan_id: string | null; from_loan: string | null; from_bank: string | null;
  security_id: string; symbol: string; quantity: string; price: string;
  to_loan_id: string; to_loan: string; to_bank: string; to_portfolio_id: string | null;
  collateral_added: string; cross_bank: boolean;
}
export interface AllocationResult {
  target: 'required' | 'buffer';
  moves: Move[];
  loans: { loan_id: string; loan: string; bank: string; need: string; covered: string; remaining: string; repay_alternative: string }[];
  releasable: { loan_id: string; loan: string; bank: string; value: string }[];
}

const D = (v: Decimal.Value) => new Decimal(v);

export function suggestAllocation(cov: CoverageResult, snap: Snapshot, warnBufferPct: number | string, target: 'required' | 'buffer' = 'buffer'): AllocationResult {
  const bufferFactor = D(warnBufferPct).div(100).add(1);
  const bankById = new Map(snap.banks.map((b) => [b.id, b]));
  const haircut = new Map(snap.eligibility.map((e) => [`${e.bank_id}:${e.security_id}`, D(e.haircut_pct)]));
  /** Collateral value per 1.00 of market value for a security at a bank (0 when not accepted). */
  const factorAt = (bankId: string, securityId: string): Decimal => {
    const listed = haircut.get(`${bankId}:${securityId}`);
    if (bankById.get(bankId)?.eligibility_mode === 'list' && listed === undefined) return D(0);
    return D(1).minus((listed ?? D(0)).div(100));
  };

  interface Source {
    holding_id: string; portfolio_id: string; portfolio: string; loan_id: string | null; loan: string | null;
    bank_id: string | null; bank: string | null; security_id: string; symbol: string; price: Decimal; available: Decimal;
  }
  const sources: Source[] = [];
  /** Collateral value each donor loan may still give up. */
  const spare = new Map<string, Decimal>();
  const releasable: AllocationResult['releasable'] = [];

  const addSources = (portfolios: CoverageResult['free_portfolios'], bank: { id: string; name: string } | null, loan: { id: string; loan_no: string } | null) => {
    for (const p of portfolios) for (const h of p.holdings) {
      if (!h.price) continue;
      sources.push({
        holding_id: h.id, portfolio_id: p.id, portfolio: p.name, loan_id: loan?.id ?? null, loan: loan?.loan_no ?? null,
        bank_id: bank?.id ?? null, bank: bank?.name ?? null, security_id: h.security_id, symbol: h.symbol, price: D(h.price), available: D(h.quantity),
      });
    }
  };
  addSources(cov.free_portfolios, null, null);
  for (const b of cov.banks) addSources(b.unpledged_portfolios, b, null);
  for (const b of cov.banks) for (const l of b.loans) {
    const keep = D(l.coverage_required).mul(bufferFactor);
    const extra = D(l.collateral_value).minus(keep);
    if (extra.gt(0)) {
      spare.set(l.id, extra);
      releasable.push({ loan_id: l.id, loan: l.loan_no, bank: b.name, value: extra.toFixed(2) });
      addSources(l.portfolios, b, l);
    }
  }

  const needs = cov.banks.flatMap((b) => b.loans.map((l) => {
    const goal = target === 'buffer' ? D(l.coverage_required).mul(bufferFactor) : D(l.coverage_required);
    // Only loans that are actually below their requirement or inside the warning band need help.
    const need = l.status === 'ok' ? D(0) : goal.minus(l.collateral_value);
    return { loan: l, bank: b, need: Decimal.max(need, 0), covered: D(0) };
  })).filter((n) => n.need.gt(0)).sort((a, b) => b.need.cmp(a.need));

  const moves: Move[] = [];
  for (const n of needs) {
    let remaining = n.need;
    // Free shares first (loan_id null), then donors.
    const ordered = sources.filter((s) => s.loan_id !== n.loan.id).sort((a, b) => Number(!!a.loan_id) - Number(!!b.loan_id));
    for (const s of ordered) {
      if (remaining.lte(0)) break;
      if (s.available.lte(0)) continue;
      const perShare = s.price.mul(factorAt(n.bank.id, s.security_id));
      if (perShare.lte(0)) continue; // not accepted by the receiving bank
      let qty = Decimal.min(s.available, remaining.div(perShare).ceil());
      if (s.loan_id) {
        const donorPerShare = s.price.mul(s.bank_id ? factorAt(s.bank_id, s.security_id) : D(1));
        const donorSpare = spare.get(s.loan_id) ?? D(0);
        if (donorPerShare.gt(0)) qty = Decimal.min(qty, donorSpare.div(donorPerShare).floor());
        if (qty.lte(0)) continue;
        spare.set(s.loan_id, donorSpare.minus(qty.mul(donorPerShare)));
      }
      const added = qty.mul(perShare);
      s.available = s.available.minus(qty);
      remaining = remaining.minus(added);
      n.covered = n.covered.add(added);
      moves.push({
        from_holding_id: s.holding_id, from_portfolio_id: s.portfolio_id, from_portfolio: s.portfolio,
        from_loan_id: s.loan_id, from_loan: s.loan, from_bank: s.bank,
        security_id: s.security_id, symbol: s.symbol, quantity: qty.toString(), price: s.price.toFixed(4),
        to_loan_id: n.loan.id, to_loan: n.loan.loan_no, to_bank: n.bank.name, to_portfolio_id: n.loan.portfolios[0]?.id ?? null,
        collateral_added: added.toFixed(2), cross_bank: s.bank_id !== n.bank.id,
      });
    }
  }

  return {
    target, moves, releasable,
    loans: needs.map((n) => {
      const remaining = Decimal.max(n.need.minus(n.covered), 0);
      return {
        loan_id: n.loan.id, loan: n.loan.loan_no, bank: n.bank.name, need: n.need.toFixed(2), covered: Decimal.min(n.covered, n.need).toFixed(2),
        remaining: remaining.toFixed(2),
        repay_alternative: remaining.div(D(n.loan.coverage_ratio).div(100)).mul(target === 'buffer' ? D(1).div(bufferFactor) : 1).toDecimalPlaces(2, Decimal.ROUND_UP).toFixed(2),
      };
    }),
  };
}
