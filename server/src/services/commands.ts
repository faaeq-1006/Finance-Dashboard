import type pg from 'pg';
import { Decimal } from 'decimal.js';
import { z } from 'zod';
import { audit, type Actor } from '../audit.js';
import { one, q, tx } from '../db.js';
import { badRequest, conflict, forbidden, notFound } from '../errors.js';
import { getSettings } from './settings.js';
import { afterChange } from './hooks.js';

/**
 * Every change to business data is a named command. Sensitive commands go through
 * maker-checker: the request is stored, and a different user with approval rights applies it.
 * The same code path applies a command whether it runs immediately or on approval.
 */
const dec = (int: number, frac: number, what: string) =>
  z.string().trim().regex(new RegExp(`^\\d{1,${int}}(\\.\\d{1,${frac}})?$`), `${what} must be a positive number with up to ${frac} decimals`);
const money = dec(16, 2, 'Amount');
const qty = dec(14, 4, 'Quantity');
const pct = dec(4, 2, 'Ratio');
const rate = dec(3, 4, 'Rate');
const priceS = dec(12, 4, 'Price');
const id = z.uuid();
const date = z.iso.date();
const text = (max = 200) => z.string().trim().min(1).max(max);
const optText = (max = 2000) => z.string().trim().max(max).nullish().transform((v) => v || null);
const fmt = (v: string) => new Decimal(v).toNumber().toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const optPct = pct.nullish().transform((v) => v || null);

function assertLevels(coverage: string | null, topUp: string | null, marginCall: string | null) {
  // Levels must step down: required >= top-up >= margin call.
  if (coverage && topUp && new Decimal(topUp).gt(coverage)) throw badRequest('Top-up level cannot be above the coverage ratio');
  const ceiling = topUp ?? coverage;
  if (ceiling && marginCall && new Decimal(marginCall).gt(ceiling)) throw badRequest('Margin call level cannot be above the top-up level / coverage ratio');
}

interface Ctx { client: pg.PoolClient; actor: Actor }
interface Outcome { entityType: string; entityId: string; before?: unknown; after?: unknown; result?: unknown }
interface Command<S extends z.ZodType> {
  schema: S;
  approval: boolean;
  summary: (p: z.infer<S>, client: pg.PoolClient) => Promise<string>;
  apply: (p: z.infer<S>, ctx: Ctx) => Promise<Outcome>;
}
const define = <S extends z.ZodType>(c: Command<S>) => c;

const row = (client: pg.PoolClient, table: string, rowId: string) => one(client, `SELECT * FROM ${table} WHERE id = $1`, [rowId]);
const mustRow = async (client: pg.PoolClient, table: string, rowId: string, what: string) => {
  const r = await row(client, table, rowId);
  if (!r) throw notFound(what);
  return r;
};
const loanLabel = async (client: pg.PoolClient, loanId: string) => {
  const r = await one(client, 'SELECT l.loan_no, b.name FROM loans l JOIN banks b ON b.id = l.bank_id WHERE l.id = $1', [loanId]);
  if (!r) throw notFound('Loan');
  return `${r.loan_no} (${r.name})`;
};

const bankFields = z.object({
  name: text(120), code: text(20).transform((s) => s.toUpperCase()),
  coverage_ratio: pct, top_up_ratio: optPct, margin_call_ratio: optPct,
  contact_name: optText(120), contact_email: z.email().nullish().or(z.literal('')).transform((v) => v || null), notes: optText(),
});
const loanFields = z.object({
  loan_no: text(60), facility_type: text(60), limit_amount: money,
  start_date: date, maturity_date: date,
  review_date: date.nullish().or(z.literal('')).transform((v) => v || null),
  renewal_date: date.nullish().or(z.literal('')).transform((v) => v || null),
  rate_type: z.enum(['fixed', 'floating']), rate_pct: rate.nullish().or(z.literal('')).transform((v) => v || null),
  benchmark: optText(40), margin_pct: rate.nullish().or(z.literal('')).transform((v) => v || null),
  coverage_ratio: optPct.or(z.literal('').transform(() => null)), top_up_ratio: optPct.or(z.literal('').transform(() => null)),
  margin_call_ratio: optPct.or(z.literal('').transform(() => null)), notes: optText(),
});

export const commands = {
  'bank.create': define({
    schema: bankFields, approval: true,
    summary: async (p) => `Add bank ${p.name} with ${p.coverage_ratio}% coverage`,
    apply: async (p, { client }) => {
      assertLevels(p.coverage_ratio, p.top_up_ratio, p.margin_call_ratio);
      const after = await one(client,
        `INSERT INTO banks(name, code, coverage_ratio, top_up_ratio, margin_call_ratio, contact_name, contact_email, notes)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING *`,
        [p.name, p.code, p.coverage_ratio, p.top_up_ratio, p.margin_call_ratio, p.contact_name, p.contact_email, p.notes]);
      return { entityType: 'bank', entityId: after.id, after };
    },
  }),
  'bank.update': define({
    schema: bankFields.extend({ id }), approval: true,
    summary: async (p) => `Update terms for ${p.name}: coverage ${p.coverage_ratio}%, top-up ${p.top_up_ratio ?? '-'}%, margin call ${p.margin_call_ratio ?? '-'}%`,
    apply: async (p, { client }) => {
      const before = await mustRow(client, 'banks', p.id, 'Bank');
      assertLevels(p.coverage_ratio, p.top_up_ratio, p.margin_call_ratio);
      const after = await one(client,
        `UPDATE banks SET name=$2, code=$3, coverage_ratio=$4, top_up_ratio=$5, margin_call_ratio=$6, contact_name=$7, contact_email=$8, notes=$9, updated_at=now()
          WHERE id=$1 RETURNING *`,
        [p.id, p.name, p.code, p.coverage_ratio, p.top_up_ratio, p.margin_call_ratio, p.contact_name, p.contact_email, p.notes]);
      return { entityType: 'bank', entityId: p.id, before, after };
    },
  }),
  'bank.set_eligibility': define({
    schema: z.object({
      bank_id: id, eligibility_mode: z.enum(['all', 'list']),
      items: z.array(z.object({ security_id: id, haircut_pct: dec(2, 2, 'Haircut') })).max(2000),
    }),
    approval: true,
    summary: async (p, client) => {
      const b = await mustRow(client, 'banks', p.bank_id, 'Bank');
      return p.eligibility_mode === 'all' ? `${b.name}: accept all shares (${p.items.length} with a haircut)` : `${b.name}: accept only ${p.items.length} listed shares`;
    },
    apply: async (p, { client }) => {
      const bank = await mustRow(client, 'banks', p.bank_id, 'Bank');
      if (new Set(p.items.map((i) => i.security_id)).size !== p.items.length) throw badRequest('A share is listed twice');
      const load = () => q(client, 'SELECT security_id, haircut_pct FROM bank_eligible_securities WHERE bank_id = $1 ORDER BY security_id', [p.bank_id]);
      const before = { eligibility_mode: bank.eligibility_mode, items: await load() };
      await client.query('UPDATE banks SET eligibility_mode = $2, updated_at = now() WHERE id = $1', [p.bank_id, p.eligibility_mode]);
      await client.query('DELETE FROM bank_eligible_securities WHERE bank_id = $1', [p.bank_id]);
      for (const i of p.items) {
        await client.query('INSERT INTO bank_eligible_securities(bank_id, security_id, haircut_pct) VALUES ($1,$2,$3)', [p.bank_id, i.security_id, i.haircut_pct]);
      }
      return { entityType: 'bank', entityId: p.bank_id, before, after: { eligibility_mode: p.eligibility_mode, items: await load() } };
    },
  }),

  'loan.create': define({
    schema: loanFields.extend({ bank_id: id, used_amount: money.default('0') }), approval: true,
    summary: async (p, client) => {
      const b = await mustRow(client, 'banks', p.bank_id, 'Bank');
      return `New loan ${p.loan_no} at ${b.name}: limit ${fmt(p.limit_amount)}, opening balance ${fmt(p.used_amount)}`;
    },
    apply: async (p, { client, actor }) => {
      const bank = await mustRow(client, 'banks', p.bank_id, 'Bank');
      assertLevels(p.coverage_ratio ?? bank.coverage_ratio, p.top_up_ratio ?? bank.top_up_ratio, p.margin_call_ratio ?? bank.margin_call_ratio);
      if (new Decimal(p.used_amount).gt(p.limit_amount)) throw badRequest('Amount used cannot exceed the loan limit');
      if (p.maturity_date < p.start_date) throw badRequest('Maturity date is before the start date');
      const loan = await one(client,
        `INSERT INTO loans(bank_id, loan_no, facility_type, limit_amount, used_amount, start_date, maturity_date, review_date, renewal_date,
                           rate_type, rate_pct, benchmark, margin_pct, coverage_ratio, top_up_ratio, margin_call_ratio, notes)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17) RETURNING *`,
        [p.bank_id, p.loan_no, p.facility_type, p.limit_amount, p.used_amount, p.start_date, p.maturity_date, p.review_date, p.renewal_date,
          p.rate_type, p.rate_pct, p.benchmark, p.margin_pct, p.coverage_ratio, p.top_up_ratio, p.margin_call_ratio, p.notes]);
      if (new Decimal(p.used_amount).gt(0)) {
        await client.query(
          `INSERT INTO loan_transactions(loan_id, type, amount, value_date, reference, balance_after, created_by) VALUES ($1,'drawdown',$2,$3,'Opening balance',$2,$4)`,
          [loan.id, p.used_amount, p.start_date, actor.type === 'user' ? actor.id : null]);
      }
      return { entityType: 'loan', entityId: loan.id, after: loan };
    },
  }),
  'loan.update': define({
    schema: loanFields.extend({ id }), approval: true,
    summary: async (p, client) => `Update ${await loanLabel(client, p.id)}: limit ${fmt(p.limit_amount)}, maturity ${p.maturity_date}, coverage ${p.coverage_ratio ?? 'bank default'}`,
    apply: async (p, { client }) => {
      const before = await one(client, 'SELECT * FROM loans WHERE id = $1 FOR UPDATE', [p.id]);
      if (!before) throw notFound('Loan');
      if (before.status !== 'active') throw conflict('A closed loan cannot be changed');
      const bank = await mustRow(client, 'banks', before.bank_id, 'Bank');
      assertLevels(p.coverage_ratio ?? bank.coverage_ratio, p.top_up_ratio ?? bank.top_up_ratio, p.margin_call_ratio ?? bank.margin_call_ratio);
      if (new Decimal(before.used_amount).gt(p.limit_amount)) throw badRequest(`Limit cannot be below the amount already used (${before.used_amount})`);
      if (p.maturity_date < p.start_date) throw badRequest('Maturity date is before the start date');
      const after = await one(client,
        `UPDATE loans SET loan_no=$2, facility_type=$3, limit_amount=$4, start_date=$5, maturity_date=$6, review_date=$7, renewal_date=$8, rate_type=$9, rate_pct=$10,
                benchmark=$11, margin_pct=$12, coverage_ratio=$13, top_up_ratio=$14, margin_call_ratio=$15, notes=$16, updated_at=now() WHERE id=$1 RETURNING *`,
        [p.id, p.loan_no, p.facility_type, p.limit_amount, p.start_date, p.maturity_date, p.review_date, p.renewal_date, p.rate_type, p.rate_pct,
          p.benchmark, p.margin_pct, p.coverage_ratio, p.top_up_ratio, p.margin_call_ratio, p.notes]);
      return { entityType: 'loan', entityId: p.id, before, after };
    },
  }),
  'loan.close': define({
    schema: z.object({ id }), approval: true,
    summary: async (p, client) => `Close ${await loanLabel(client, p.id)} and release its pledged portfolios`,
    apply: async (p, { client }) => {
      const before = await one(client, 'SELECT * FROM loans WHERE id = $1 FOR UPDATE', [p.id]);
      if (!before) throw notFound('Loan');
      if (before.status !== 'active') throw conflict('Loan is already closed');
      if (new Decimal(before.used_amount).gt(0)) throw conflict('Repay the loan in full before closing it');
      const released = await q(client, 'UPDATE portfolios SET loan_id = NULL, updated_at = now() WHERE loan_id = $1 RETURNING id, name', [p.id]);
      const after = await one(client, `UPDATE loans SET status = 'closed', updated_at = now() WHERE id = $1 RETURNING *`, [p.id]);
      return { entityType: 'loan', entityId: p.id, before, after: { ...after, released_portfolios: released } };
    },
  }),
  'loan.transaction': define({
    schema: z.object({ loan_id: id, type: z.enum(['drawdown', 'repayment']), amount: money, value_date: date, reference: optText(80), notes: optText() }),
    approval: true,
    summary: async (p, client) => `${p.type === 'drawdown' ? 'Drawdown' : 'Repayment'} of ${fmt(p.amount)} on ${await loanLabel(client, p.loan_id)}`,
    apply: async (p, { client, actor }) => {
      // Row lock: two concurrent drawdowns cannot both pass the limit check.
      const loan = await one(client, 'SELECT * FROM loans WHERE id = $1 FOR UPDATE', [p.loan_id]);
      if (!loan) throw notFound('Loan');
      if (loan.status !== 'active') throw conflict('Loan is closed');
      const amount = new Decimal(p.amount);
      if (amount.lte(0)) throw badRequest('Amount must be greater than zero');
      const used = new Decimal(loan.used_amount);
      const next = p.type === 'drawdown' ? used.add(amount) : used.minus(amount);
      if (next.gt(loan.limit_amount)) throw badRequest(`Drawdown exceeds the limit. Available headroom is ${new Decimal(loan.limit_amount).minus(used).toFixed(2)}`);
      if (next.lt(0)) throw badRequest(`Repayment exceeds the outstanding amount (${used.toFixed(2)})`);
      await client.query('UPDATE loans SET used_amount = $2, updated_at = now() WHERE id = $1', [p.loan_id, next.toFixed(2)]);
      const t = await one(client,
        `INSERT INTO loan_transactions(loan_id, type, amount, value_date, reference, notes, balance_after, created_by) VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING *`,
        [p.loan_id, p.type, p.amount, p.value_date, p.reference, p.notes, next.toFixed(2), actor.type === 'user' ? actor.id : null]);
      return { entityType: 'loan', entityId: p.loan_id, before: { used_amount: loan.used_amount }, after: { used_amount: next.toFixed(2), transaction: t } };
    },
  }),

  'portfolio.save': define({
    schema: z.object({
      id: id.nullish(), name: text(120), bank_id: id.nullish().or(z.literal('')).transform((v) => v || null),
      loan_id: id.nullish().or(z.literal('')).transform((v) => v || null), custody_account: optText(80), notes: optText(),
    }),
    approval: true,
    summary: async (p, client) => {
      const where = p.loan_id ? `pledged to ${await loanLabel(client, p.loan_id)}` : p.bank_id ? `held at ${(await mustRow(client, 'banks', p.bank_id, 'Bank')).name}, not pledged` : 'unpledged';
      return `${p.id ? 'Update' : 'Add'} portfolio ${p.name}: ${where}`;
    },
    apply: async (p, { client }) => {
      if (p.loan_id) {
        const loan = await mustRow(client, 'loans', p.loan_id, 'Loan');
        if (loan.status !== 'active') throw conflict('Cannot pledge to a closed loan');
        if (p.bank_id && p.bank_id !== loan.bank_id) throw badRequest('A portfolio can only be pledged to a loan of the bank that holds it');
        p.bank_id = loan.bank_id;
      }
      if (p.id) {
        const before = await mustRow(client, 'portfolios', p.id, 'Portfolio');
        const after = await one(client, 'UPDATE portfolios SET name=$2, bank_id=$3, loan_id=$4, custody_account=$5, notes=$6, updated_at=now() WHERE id=$1 RETURNING *',
          [p.id, p.name, p.bank_id, p.loan_id, p.custody_account, p.notes]);
        return { entityType: 'portfolio', entityId: p.id, before, after };
      }
      const after = await one(client, 'INSERT INTO portfolios(name, bank_id, loan_id, custody_account, notes) VALUES ($1,$2,$3,$4,$5) RETURNING *',
        [p.name, p.bank_id, p.loan_id, p.custody_account, p.notes]);
      return { entityType: 'portfolio', entityId: after.id, after };
    },
  }),
  'portfolio.delete': define({
    schema: z.object({ id }), approval: true,
    summary: async (p, client) => `Delete empty portfolio ${(await mustRow(client, 'portfolios', p.id, 'Portfolio')).name}`,
    apply: async (p, { client }) => {
      const before = await mustRow(client, 'portfolios', p.id, 'Portfolio');
      if (await one(client, 'SELECT 1 FROM holdings WHERE portfolio_id = $1 LIMIT 1', [p.id])) throw conflict('Remove or transfer the shares first');
      await client.query('DELETE FROM portfolios WHERE id = $1', [p.id]);
      return { entityType: 'portfolio', entityId: p.id, before };
    },
  }),
  'holding.set': define({
    schema: z.object({ portfolio_id: id, security_id: id, quantity: qty }), approval: true,
    summary: async (p, client) => {
      const pf = await mustRow(client, 'portfolios', p.portfolio_id, 'Portfolio');
      const s = await mustRow(client, 'securities', p.security_id, 'Share');
      return new Decimal(p.quantity).isZero() ? `Remove ${s.symbol} from ${pf.name}` : `Set ${s.symbol} in ${pf.name} to ${p.quantity} shares`;
    },
    apply: async (p, { client }) => {
      await mustRow(client, 'portfolios', p.portfolio_id, 'Portfolio');
      await mustRow(client, 'securities', p.security_id, 'Share');
      const before = await one(client, 'SELECT * FROM holdings WHERE portfolio_id = $1 AND security_id = $2 FOR UPDATE', [p.portfolio_id, p.security_id]);
      if (new Decimal(p.quantity).isZero()) {
        if (!before) throw notFound('Holding');
        await client.query('DELETE FROM holdings WHERE id = $1', [before.id]);
        return { entityType: 'holding', entityId: before.id, before };
      }
      const after = await one(client,
        `INSERT INTO holdings(portfolio_id, security_id, quantity) VALUES ($1,$2,$3)
         ON CONFLICT (portfolio_id, security_id) DO UPDATE SET quantity = EXCLUDED.quantity, updated_at = now() RETURNING *`,
        [p.portfolio_id, p.security_id, p.quantity]);
      return { entityType: 'holding', entityId: after.id, before, after };
    },
  }),
  'holding.transfer': define({
    schema: z.object({ holding_id: id, quantity: qty, to_portfolio_id: id.nullish(), to_loan_id: id.nullish() })
      .refine((p) => !!p.to_portfolio_id !== !!p.to_loan_id, 'Choose a destination portfolio or a loan'),
    approval: true,
    summary: async (p, client) => {
      const h = await one(client, 'SELECT s.symbol, pf.name FROM holdings h JOIN securities s ON s.id = h.security_id JOIN portfolios pf ON pf.id = h.portfolio_id WHERE h.id = $1', [p.holding_id]);
      if (!h) throw notFound('Holding');
      const dest = p.to_portfolio_id ? (await mustRow(client, 'portfolios', p.to_portfolio_id, 'Portfolio')).name : `a new portfolio pledged to ${await loanLabel(client, p.to_loan_id!)}`;
      return `Transfer ${p.quantity} ${h.symbol} from ${h.name} to ${dest}`;
    },
    apply: async (p, { client }) => {
      const from = await one(client, 'SELECT * FROM holdings WHERE id = $1 FOR UPDATE', [p.holding_id]);
      if (!from) throw notFound('Holding');
      const amount = new Decimal(p.quantity);
      if (amount.lte(0)) throw badRequest('Quantity must be greater than zero');
      if (amount.gt(from.quantity)) throw badRequest(`Only ${new Decimal(from.quantity).toString()} shares are available`);
      let destId = p.to_portfolio_id ?? null;
      if (!destId) {
        const loan = await mustRow(client, 'loans', p.to_loan_id!, 'Loan');
        if (loan.status !== 'active') throw conflict('Cannot pledge to a closed loan');
        const existing = await one(client, 'SELECT id FROM portfolios WHERE loan_id = $1 ORDER BY created_at LIMIT 1', [loan.id]);
        destId = existing?.id ?? (await one(client, `INSERT INTO portfolios(name, bank_id, loan_id) VALUES ($1,$2,$3) RETURNING id`,
          [`${loan.loan_no} top-up ${new Date().toISOString().slice(0, 10)} ${Math.random().toString(36).slice(2, 6)}`, loan.bank_id, loan.id])).id;
      }
      if (destId === from.portfolio_id) throw badRequest('Shares are already in that portfolio');
      await mustRow(client, 'portfolios', destId!, 'Portfolio');
      const left = new Decimal(from.quantity).minus(amount);
      if (left.isZero()) await client.query('DELETE FROM holdings WHERE id = $1', [from.id]);
      else await client.query('UPDATE holdings SET quantity = $2, updated_at = now() WHERE id = $1', [from.id, left.toString()]);
      const to = await one(client,
        `INSERT INTO holdings(portfolio_id, security_id, quantity) VALUES ($1,$2,$3)
         ON CONFLICT (portfolio_id, security_id) DO UPDATE SET quantity = holdings.quantity + EXCLUDED.quantity, updated_at = now() RETURNING *`,
        [destId, from.security_id, amount.toString()]);
      return { entityType: 'holding', entityId: from.id, before: from, after: { from_quantity_left: left.toString(), to } };
    },
  }),

  // --- Operational commands: audited, no second approval ---
  'security.save': define({
    schema: z.object({ id: id.nullish(), symbol: text(20).transform((s) => s.toUpperCase()), name: text(120), exchange: text(30).default('TADAWUL'), active: z.boolean().default(true) }),
    approval: false,
    summary: async (p) => `${p.id ? 'Update' : 'Add'} share ${p.symbol}`,
    apply: async (p, { client }) => {
      if (p.id) {
        const before = await mustRow(client, 'securities', p.id, 'Share');
        const after = await one(client, 'UPDATE securities SET symbol=$2, name=$3, exchange=$4, active=$5 WHERE id=$1 RETURNING *', [p.id, p.symbol, p.name, p.exchange, p.active]);
        return { entityType: 'security', entityId: p.id, before, after };
      }
      const after = await one(client, 'INSERT INTO securities(symbol, name, exchange, active) VALUES ($1,$2,$3,$4) RETURNING *', [p.symbol, p.name, p.exchange, p.active]);
      return { entityType: 'security', entityId: after.id, after };
    },
  }),
  'price.manual': define({
    schema: z.object({ security_id: id, price: priceS }), approval: false,
    summary: async (p) => `Manual price ${p.price}`,
    apply: async (p, { client, actor }) => {
      const before = await mustRow(client, 'securities', p.security_id, 'Share');
      if (new Decimal(p.price).lte(0)) throw badRequest('Price must be greater than zero');
      await client.query(`INSERT INTO prices(security_id, price, as_of, source, created_by) VALUES ($1,$2,now(),'manual',$3)`, [p.security_id, p.price, actor.type === 'user' ? actor.id : null]);
      const after = await one(client, `UPDATE securities SET last_price=$2, last_price_at=now(), last_price_source='manual' WHERE id=$1 RETURNING symbol, last_price`, [p.security_id, p.price]);
      return { entityType: 'security', entityId: p.security_id, before: { symbol: before.symbol, last_price: before.last_price }, after };
    },
  }),
  'charge.save': define({
    schema: z.object({ id: id.nullish(), loan_id: id, charge_type: z.enum(['profit', 'fee', 'commission', 'other']), due_date: date, amount: money, reference: optText(80), notes: optText() }),
    approval: false,
    summary: async (p) => `Finance charge ${p.amount} due ${p.due_date}`,
    apply: async (p, { client, actor }) => {
      await mustRow(client, 'loans', p.loan_id, 'Loan');
      if (p.id) {
        const before = await mustRow(client, 'finance_charges', p.id, 'Charge');
        if (before.status !== 'due') throw conflict('Only unpaid charges can be edited');
        const after = await one(client, 'UPDATE finance_charges SET charge_type=$2, due_date=$3, amount=$4, reference=$5, notes=$6, updated_at=now() WHERE id=$1 RETURNING *',
          [p.id, p.charge_type, p.due_date, p.amount, p.reference, p.notes]);
        return { entityType: 'finance_charge', entityId: p.id, before, after };
      }
      const after = await one(client, 'INSERT INTO finance_charges(loan_id, charge_type, due_date, amount, reference, notes, created_by) VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING *',
        [p.loan_id, p.charge_type, p.due_date, p.amount, p.reference, p.notes, actor.type === 'user' ? actor.id : null]);
      return { entityType: 'finance_charge', entityId: after.id, after };
    },
  }),
  'charge.schedule': define({
    schema: z.object({ loan_id: id, charge_type: z.enum(['profit', 'fee', 'commission', 'other']), first_due_date: date, months_between: z.number().int().min(1).max(12), count: z.number().int().min(1).max(60), amount: money }),
    approval: false,
    summary: async (p) => `Schedule ${p.count} charges of ${p.amount}`,
    apply: async (p, { client, actor }) => {
      await mustRow(client, 'loans', p.loan_id, 'Loan');
      const created = await q(client,
        `INSERT INTO finance_charges(loan_id, charge_type, due_date, amount, created_by)
         SELECT $1, $2, ($3::date + make_interval(months => (n * $4::int)))::date, $5::numeric, $6::uuid FROM generate_series(0, $7::int - 1) AS n RETURNING id, due_date, amount`,
        [p.loan_id, p.charge_type, p.first_due_date, p.months_between, p.amount, actor.type === 'user' ? actor.id : null, p.count]);
      return { entityType: 'loan', entityId: p.loan_id, after: { charges_created: created } };
    },
  }),
  'charge.set_status': define({
    schema: z.object({ id, status: z.enum(['paid', 'due', 'cancelled']), paid_date: date.nullish() }), approval: false,
    summary: async (p) => `Mark charge ${p.status}`,
    apply: async (p, { client }) => {
      const before = await mustRow(client, 'finance_charges', p.id, 'Charge');
      const paidDate = p.status === 'paid' ? (p.paid_date ?? new Date().toISOString().slice(0, 10)) : null;
      const after = await one(client, 'UPDATE finance_charges SET status=$2, paid_date=$3, updated_at=now() WHERE id=$1 RETURNING *', [p.id, p.status, paidDate]);
      return { entityType: 'finance_charge', entityId: p.id, before, after };
    },
  }),
};
export type CommandName = keyof typeof commands;
export const isCommand = (name: string): name is CommandName => Object.hasOwn(commands, name);

function parse(name: CommandName, payload: unknown) {
  const r = commands[name].schema.safeParse(payload);
  if (!r.success) {
    const first = r.error.issues[0];
    const field = first.path.join('.');
    throw badRequest(field && !first.message.toLowerCase().includes(field.replace(/_/g, ' ')) ? `${field.replace(/_/g, ' ')}: ${first.message}` : first.message, r.error.issues);
  }
  return r.data as any;
}

async function applyIn(client: pg.PoolClient, name: CommandName, data: any, actor: Actor, meta?: unknown) {
  const out = await (commands[name] as Command<any>).apply(data, { client, actor });
  await audit(client, actor, { action: name, entityType: out.entityType, entityId: out.entityId, before: out.before, after: out.after, meta });
  return out;
}

/** Runs a command now, or files it for approval. */
export async function submit(name: CommandName, payload: unknown, actor: Actor) {
  const data = parse(name, payload);
  const cmd = commands[name] as Command<any>;
  const result = await tx(async (client) => {
    const needsApproval = cmd.approval && (await getSettings(client)).require_approval;
    if (!needsApproval) {
      const out = await applyIn(client, name, data, actor);
      return { status: 'applied' as const, entity_type: out.entityType, entity_id: out.entityId };
    }
    const summary = await cmd.summary(data, client);
    // Dry run: reject a request that could not be applied today, instead of leaving it for the approver to discover.
    await client.query('SAVEPOINT dry_run');
    await cmd.apply(structuredClone(data), { client, actor });
    await client.query('ROLLBACK TO SAVEPOINT dry_run');
    const cr = await one(client, 'INSERT INTO change_requests(command, payload, summary, requested_by) VALUES ($1,$2,$3,$4) RETURNING id', [name, JSON.stringify(data), summary, actor.id]);
    await audit(client, actor, { action: 'approval.requested', entityType: 'change_request', entityId: cr.id, after: { command: name, summary, payload: data } });
    return { status: 'pending' as const, change_request_id: cr.id as string, summary };
  });
  if (result.status === 'applied') afterChange(); else afterChange('approvals');
  return result;
}

/** Seeding and internal use: apply without the approval step (still audited). */
export async function applyDirect(name: CommandName, payload: unknown, actor: Actor) {
  const data = parse(name, payload);
  return tx((client) => applyIn(client, name, data, actor));
}

export async function decide(changeRequestId: string, decision: 'approve' | 'reject' | 'cancel', note: string | null, actor: Actor) {
  const result = await tx(async (client) => {
    const cr = await one(client, 'SELECT * FROM change_requests WHERE id = $1 FOR UPDATE', [changeRequestId]);
    if (!cr) throw notFound('Change request');
    if (cr.status !== 'pending') throw conflict(`This request was already ${cr.status}`);
    if (decision === 'cancel') {
      if (cr.requested_by !== actor.id) throw forbidden('Only the requester can withdraw a request');
      await client.query(`UPDATE change_requests SET status = 'cancelled', decided_at = now(), decision_note = $2 WHERE id = $1`, [cr.id, note]);
      await audit(client, actor, { action: 'approval.cancelled', entityType: 'change_request', entityId: cr.id });
      return { status: 'cancelled' };
    }
    // Four-eyes: nobody approves or rejects their own request.
    if (cr.requested_by === actor.id) throw forbidden('You cannot decide your own request. A second approver is required.');
    if (decision === 'reject') {
      if (!note) throw badRequest('Give a reason for rejecting');
      await client.query(`UPDATE change_requests SET status = 'rejected', decided_by = $2, decided_at = now(), decision_note = $3 WHERE id = $1`, [cr.id, actor.id, note]);
      await audit(client, actor, { action: 'approval.rejected', entityType: 'change_request', entityId: cr.id, meta: { note } });
      return { status: 'rejected' };
    }
    if (!isCommand(cr.command)) throw badRequest('Unknown command');
    // Re-validate against today's data: the world may have changed since the request was made.
    const data = parse(cr.command, cr.payload);
    const out = await applyIn(client, cr.command, data, actor, { change_request_id: cr.id, requested_by: cr.requested_by });
    await client.query(`UPDATE change_requests SET status = 'approved', decided_by = $2, decided_at = now(), decision_note = $3 WHERE id = $1`, [cr.id, actor.id, note]);
    await audit(client, actor, { action: 'approval.approved', entityType: 'change_request', entityId: cr.id, meta: { command: cr.command, note } });
    return { status: 'approved', entity_type: out.entityType, entity_id: out.entityId };
  });
  afterChange();
  return result;
}
