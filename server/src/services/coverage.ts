import { pool, q, type Db } from '../db.js';
import { computeCoverage, type Options, type Snapshot } from '../engine/coverage.js';
import { getSettings } from './settings.js';

export async function loadSnapshot(db: Db = pool): Promise<Snapshot> {
  const [banks, loans, portfolios, holdings, eligibility] = await Promise.all([
    q(db, `SELECT id, name, code, coverage_ratio, top_up_ratio, margin_call_ratio, eligibility_mode FROM banks WHERE active ORDER BY name`),
    q(db, `SELECT id, bank_id, loan_no, limit_amount, used_amount, coverage_ratio, top_up_ratio, margin_call_ratio, maturity_date FROM loans WHERE status = 'active'`),
    q(db, `SELECT id, name, bank_id, loan_id FROM portfolios`),
    q(db, `SELECT h.id, h.portfolio_id, h.security_id, s.symbol, s.name AS security_name, h.quantity, s.last_price AS price, s.last_price_at AS price_at
             FROM holdings h JOIN securities s ON s.id = h.security_id`),
    q(db, `SELECT bank_id, security_id, haircut_pct FROM bank_eligible_securities`),
  ]);
  return { banks, loans, portfolios, holdings, eligibility } as Snapshot;
}

export async function currentCoverage(opts: Omit<Options, 'warnBufferPct'> = {}) {
  const [snapshot, settings] = await Promise.all([loadSnapshot(), getSettings()]);
  const coverage = computeCoverage(snapshot, { ...opts, warnBufferPct: settings.warn_buffer_pct });
  return { snapshot, settings, coverage };
}
