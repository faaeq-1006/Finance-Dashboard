import { Decimal } from 'decimal.js';

/**
 * Pure coverage engine. No I/O: takes a snapshot of positions and terms, returns the
 * assets-vs-liabilities view from the requirements deck.
 *
 *   share value        = no. of shares x price
 *   coverage required  = loan used x coverage ratio
 *   surplus/shortfall  = collateral value - coverage required
 *
 * Collateral value counts only shares the bank accepts, after any haircut.
 */
export type LoanStatus = 'ok' | 'watch' | 'shortfall' | 'top_up' | 'margin_call';

export interface BankIn {
  id: string; name: string; code: string;
  coverage_ratio: string; top_up_ratio: string | null; margin_call_ratio: string | null;
  eligibility_mode: 'all' | 'list';
}
export interface LoanIn {
  id: string; bank_id: string; loan_no: string; limit_amount: string; used_amount: string;
  coverage_ratio: string | null; top_up_ratio: string | null; margin_call_ratio: string | null;
  maturity_date?: string;
}
export interface PortfolioIn { id: string; name: string; bank_id: string | null; loan_id: string | null }
export interface HoldingIn {
  id: string; portfolio_id: string; security_id: string; symbol: string; security_name: string;
  quantity: string; price: string | null; price_at?: string | null;
}
export interface EligibilityIn { bank_id: string; security_id: string; haircut_pct: string }

export interface Snapshot {
  banks: BankIn[]; loans: LoanIn[]; portfolios: PortfolioIn[]; holdings: HoldingIn[]; eligibility: EligibilityIn[];
}
export interface Options {
  warnBufferPct?: number | string;
  /** Uniform price shock in percent, e.g. -20 for a 20% fall. */
  shockPct?: number | string;
  /** Per-security shocks in percent; override the uniform shock. */
  securityShocks?: Record<string, number | string>;
}

export interface HoldingOut {
  id: string; security_id: string; symbol: string; security_name: string; quantity: string;
  price: string | null; market_value: string; eligible: boolean; haircut_pct: string; collateral_value: string;
}
export interface PortfolioOut {
  id: string; name: string; bank_id: string | null; loan_id: string | null;
  quantity: string; market_value: string; collateral_value: string; holdings: HoldingOut[];
}
export interface LoanOut {
  id: string; bank_id: string; loan_no: string; maturity_date?: string;
  limit_amount: string; used_amount: string; headroom: string; utilisation_pct: string;
  coverage_ratio: string; top_up_ratio: string | null; margin_call_ratio: string | null; terms_source: 'loan' | 'bank';
  market_value: string; collateral_value: string; coverage_required: string; surplus: string;
  actual_coverage_pct: string | null; status: LoanStatus;
  /** How far collateral can fall (percent) before a shortfall. Null when nothing is drawn or already short. */
  price_drop_to_shortfall_pct: string | null;
  /** To cure a shortfall: add this much eligible collateral, or repay this much. */
  cure_top_up_value: string; cure_repay_amount: string;
  portfolios: PortfolioOut[];
}
export interface BankOut {
  id: string; name: string; code: string;
  limit_amount: string; used_amount: string; headroom: string;
  quantity: string; market_value: string; collateral_value: string; coverage_required: string; surplus: string;
  worst_status: LoanStatus; loans: LoanOut[]; unpledged_portfolios: PortfolioOut[];
}
export interface CoverageResult {
  totals: {
    limit_amount: string; used_amount: string; headroom: string; market_value: string; collateral_value: string;
    coverage_required: string; surplus: string; total_shortfall: string; total_surplus: string;
    unpledged_value: string; loans: number; loans_at_risk: number;
  };
  banks: BankOut[];
  free_portfolios: PortfolioOut[];
  missing_prices: string[];
  shock_pct: string;
}

const D = (v: Decimal.Value | null | undefined) => new Decimal(v ?? 0);
const money = (d: Decimal) => d.toFixed(2);
const SEVERITY: LoanStatus[] = ['ok', 'watch', 'shortfall', 'top_up', 'margin_call'];
export const worse = (a: LoanStatus, b: LoanStatus) => (SEVERITY.indexOf(a) >= SEVERITY.indexOf(b) ? a : b);

export function effectiveTerms(bank: BankIn, loan: LoanIn) {
  return {
    coverage_ratio: loan.coverage_ratio ?? bank.coverage_ratio,
    top_up_ratio: loan.top_up_ratio ?? bank.top_up_ratio,
    margin_call_ratio: loan.margin_call_ratio ?? bank.margin_call_ratio,
    terms_source: (loan.coverage_ratio ? 'loan' : 'bank') as 'loan' | 'bank',
  };
}

export function loanStatus(actualPct: Decimal | null, terms: { coverage_ratio: string; top_up_ratio: string | null; margin_call_ratio: string | null }, warnBufferPct: Decimal): LoanStatus {
  if (actualPct === null) return 'ok'; // nothing drawn, nothing to cover
  if (terms.margin_call_ratio && actualPct.lt(terms.margin_call_ratio)) return 'margin_call';
  if (terms.top_up_ratio && actualPct.lt(terms.top_up_ratio)) return 'top_up';
  if (actualPct.lt(terms.coverage_ratio)) return 'shortfall';
  if (actualPct.lt(D(terms.coverage_ratio).mul(warnBufferPct.div(100).add(1)))) return 'watch';
  return 'ok';
}

export function computeCoverage(snap: Snapshot, opts: Options = {}): CoverageResult {
  const warnBuffer = D(opts.warnBufferPct ?? 10);
  const shock = D(opts.shockPct ?? 0);
  const haircuts = new Map<string, Decimal>();
  for (const e of snap.eligibility) haircuts.set(`${e.bank_id}:${e.security_id}`, D(e.haircut_pct));
  const bankById = new Map(snap.banks.map((b) => [b.id, b]));
  const missing = new Set<string>();

  const holdingsByPortfolio = new Map<string, HoldingIn[]>();
  for (const h of snap.holdings) {
    const list = holdingsByPortfolio.get(h.portfolio_id) ?? [];
    list.push(h);
    holdingsByPortfolio.set(h.portfolio_id, list);
  }

  function shockedPrice(h: HoldingIn): Decimal | null {
    if (h.price === null) return null;
    const pct = opts.securityShocks?.[h.security_id] ?? shock;
    const factor = Decimal.max(D(pct).div(100).add(1), 0);
    return D(h.price).mul(factor);
  }

  function buildPortfolio(p: PortfolioIn): PortfolioOut & { _mv: Decimal; _cv: Decimal; _qty: Decimal } {
    const bank = p.bank_id ? bankById.get(p.bank_id) : undefined;
    let mv = D(0), cv = D(0), qty = D(0);
    const holdings = (holdingsByPortfolio.get(p.id) ?? [])
      .slice()
      .sort((a, b) => a.symbol.localeCompare(b.symbol))
      .map((h): HoldingOut => {
        const price = shockedPrice(h);
        if (price === null) missing.add(h.symbol);
        const marketValue = price ? D(h.quantity).mul(price) : D(0);
        let eligible = true;
        let haircut = D(0);
        if (bank) {
          const listed = haircuts.get(`${bank.id}:${h.security_id}`);
          if (bank.eligibility_mode === 'list') eligible = listed !== undefined;
          if (listed !== undefined) haircut = listed;
        }
        const collateral = eligible ? marketValue.mul(D(1).minus(haircut.div(100))) : D(0);
        mv = mv.add(marketValue); cv = cv.add(collateral); qty = qty.add(h.quantity);
        return {
          id: h.id, security_id: h.security_id, symbol: h.symbol, security_name: h.security_name,
          quantity: D(h.quantity).toString(), price: price ? price.toFixed(4) : null,
          market_value: money(marketValue), eligible, haircut_pct: haircut.toFixed(2), collateral_value: money(collateral),
        };
      });
    return {
      id: p.id, name: p.name, bank_id: p.bank_id, loan_id: p.loan_id, quantity: qty.toString(),
      market_value: money(mv), collateral_value: money(cv), holdings, _mv: mv, _cv: cv, _qty: qty,
    };
  }

  const built = snap.portfolios.slice().sort((a, b) => a.name.localeCompare(b.name)).map(buildPortfolio);
  const strip = ({ _mv, _cv, _qty, ...rest }: ReturnType<typeof buildPortfolio>): PortfolioOut => rest;

  const T = { limit: D(0), used: D(0), mv: D(0), cv: D(0), req: D(0), shortfall: D(0), surplus: D(0), unpledged: D(0), loans: 0, atRisk: 0 };

  const banks: BankOut[] = snap.banks.slice().sort((a, b) => a.name.localeCompare(b.name)).map((bank) => {
    const B = { limit: D(0), used: D(0), mv: D(0), cv: D(0), req: D(0), qty: D(0) };
    let worst: LoanStatus = 'ok';
    const loans = snap.loans.filter((l) => l.bank_id === bank.id).sort((a, b) => a.loan_no.localeCompare(b.loan_no, undefined, { numeric: true })).map((loan): LoanOut => {
      const terms = effectiveTerms(bank, loan);
      const pledged = built.filter((p) => p.loan_id === loan.id);
      const mv = pledged.reduce((s, p) => s.add(p._mv), D(0));
      const cv = pledged.reduce((s, p) => s.add(p._cv), D(0));
      const qty = pledged.reduce((s, p) => s.add(p._qty), D(0));
      const used = D(loan.used_amount);
      const limit = D(loan.limit_amount);
      const required = used.mul(terms.coverage_ratio).div(100);
      const surplus = cv.minus(required);
      const actual = used.gt(0) ? cv.div(used).mul(100) : null;
      const status = loanStatus(actual, terms, warnBuffer);
      const short = surplus.lt(0);
      const drop = used.gt(0) && cv.gt(0) && !short ? D(1).minus(required.div(cv)).mul(100) : null;
      // Repaying R cures when cv >= (used - R) x ratio  =>  R = used - cv / ratio
      const repay = short ? Decimal.min(used, used.minus(cv.div(D(terms.coverage_ratio).div(100)))) : D(0);
      B.limit = B.limit.add(limit); B.used = B.used.add(used); B.mv = B.mv.add(mv); B.cv = B.cv.add(cv); B.req = B.req.add(required); B.qty = B.qty.add(qty);
      if (short) T.shortfall = T.shortfall.add(surplus.neg()); else T.surplus = T.surplus.add(surplus);
      T.loans++;
      if (status !== 'ok') T.atRisk++;
      worst = worse(worst, status);
      return {
        id: loan.id, bank_id: bank.id, loan_no: loan.loan_no, maturity_date: loan.maturity_date,
        limit_amount: money(limit), used_amount: money(used), headroom: money(limit.minus(used)),
        utilisation_pct: limit.gt(0) ? used.div(limit).mul(100).toFixed(2) : '0.00',
        coverage_ratio: D(terms.coverage_ratio).toFixed(2), top_up_ratio: terms.top_up_ratio ? D(terms.top_up_ratio).toFixed(2) : null,
        margin_call_ratio: terms.margin_call_ratio ? D(terms.margin_call_ratio).toFixed(2) : null, terms_source: terms.terms_source,
        market_value: money(mv), collateral_value: money(cv), coverage_required: money(required), surplus: money(surplus),
        actual_coverage_pct: actual ? actual.toFixed(2) : null, status,
        price_drop_to_shortfall_pct: drop ? drop.toFixed(2) : null,
        cure_top_up_value: money(short ? surplus.neg() : D(0)), cure_repay_amount: money(repay.toDecimalPlaces(2, Decimal.ROUND_UP)),
        portfolios: pledged.map(strip),
      };
    });
    const unpledged = built.filter((p) => p.bank_id === bank.id && !p.loan_id);
    for (const p of unpledged) T.unpledged = T.unpledged.add(p._mv);
    T.limit = T.limit.add(B.limit); T.used = T.used.add(B.used); T.mv = T.mv.add(B.mv); T.cv = T.cv.add(B.cv); T.req = T.req.add(B.req);
    return {
      id: bank.id, name: bank.name, code: bank.code,
      limit_amount: money(B.limit), used_amount: money(B.used), headroom: money(B.limit.minus(B.used)), quantity: B.qty.toString(),
      market_value: money(B.mv), collateral_value: money(B.cv), coverage_required: money(B.req), surplus: money(B.cv.minus(B.req)),
      worst_status: worst, loans, unpledged_portfolios: unpledged.map(strip),
    };
  });

  const free = built.filter((p) => !p.bank_id);
  for (const p of free) T.unpledged = T.unpledged.add(p._mv);

  return {
    totals: {
      limit_amount: money(T.limit), used_amount: money(T.used), headroom: money(T.limit.minus(T.used)),
      market_value: money(T.mv), collateral_value: money(T.cv), coverage_required: money(T.req), surplus: money(T.cv.minus(T.req)),
      total_shortfall: money(T.shortfall), total_surplus: money(T.surplus), unpledged_value: money(T.unpledged),
      loans: T.loans, loans_at_risk: T.atRisk,
    },
    banks, free_portfolios: free.map(strip), missing_prices: [...missing].sort(), shock_pct: shock.toFixed(2),
  };
}
