import { Decimal } from 'decimal.js';
import { pool, q, tx } from '../db.js';
import { currentCoverage } from './coverage.js';
import { processOutbox } from './notify.js';

interface Wanted { key: string; type: string; severity: 'info' | 'warning' | 'critical'; bank_id?: string | null; loan_id?: string | null; title: string; message: string }

const fmt = (v: string) => new Decimal(v).toNumber().toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const daysUntil = (date: string) => Math.round((Date.parse(`${date}T00:00:00Z`) - Date.parse(`${new Date().toISOString().slice(0, 10)}T00:00:00Z`)) / 86_400_000);
/** Tightest reminder threshold that has been reached, e.g. 12 days left with [30, 14, 7] -> 14. */
const reached = (days: number, thresholds: number[]) => thresholds.filter((t) => days <= t).sort((a, b) => a - b)[0];
const when = (days: number) => (days < 0 ? `${-days} day(s) overdue` : days === 0 ? 'today' : `in ${days} day(s)`);

async function wantedAlerts(): Promise<Wanted[]> {
  const { coverage, settings } = await currentCoverage();
  const out: Wanted[] = [];

  for (const bank of coverage.banks) for (const l of bank.loans) {
    if (l.status === 'ok') continue;
    const name = `${bank.name} ${l.loan_no}`;
    const base = { type: 'coverage', bank_id: bank.id, loan_id: l.id, key: `coverage:${l.id}:${l.status}` };
    if (l.status === 'watch') {
      out.push({ ...base, severity: 'warning', title: `Early warning: ${name} is close to its coverage requirement`,
        message: `Coverage is ${l.actual_coverage_pct}% against ${l.coverage_ratio}% required. Surplus is ${fmt(l.surplus)}; a fall of ${l.price_drop_to_shortfall_pct}% in the pledged shares would cause a shortfall.` });
    } else {
      const label = l.status === 'margin_call' ? 'Margin call level breached' : l.status === 'top_up' ? 'Top-up level breached' : 'Coverage shortfall';
      out.push({ ...base, severity: 'critical', title: `${label}: ${name}`,
        message: `Coverage is ${l.actual_coverage_pct}% against ${l.coverage_ratio}% required. Shortfall is ${fmt(l.cure_top_up_value)}. Pledge shares worth ${fmt(l.cure_top_up_value)} or repay ${fmt(l.cure_repay_amount)}.` });
    }
  }
  if (coverage.missing_prices.length) {
    out.push({ key: `missing_price:${coverage.missing_prices.join(',')}`, type: 'price', severity: 'warning', title: 'Pledged shares have no price',
      message: `No price is available for: ${coverage.missing_prices.join(', ')}. They are valued at zero until a price arrives.` });
  }

  const loans = await q(pool, `SELECT l.id, l.bank_id, l.loan_no, l.maturity_date, l.review_date, l.renewal_date, b.name AS bank FROM loans l JOIN banks b ON b.id = l.bank_id WHERE l.status = 'active'`);
  for (const l of loans) {
    const dates: [string, string | null, number[]][] = [
      ['maturity', l.maturity_date, settings.maturity_reminder_days], ['review', l.review_date, settings.review_reminder_days], ['renewal', l.renewal_date, settings.review_reminder_days],
    ];
    for (const [kind, date, thresholds] of dates) {
      if (!date) continue;
      const days = daysUntil(date);
      const t = reached(days, thresholds);
      if (t === undefined) continue;
      out.push({ key: `${kind}:${l.id}:${date}:${days < 0 ? 'overdue' : t}`, type: kind, severity: days <= 7 ? 'critical' : 'warning', bank_id: l.bank_id, loan_id: l.id,
        title: `${l.bank} ${l.loan_no}: ${kind === 'maturity' ? 'loan matures' : `facility ${kind} is due`} ${when(days)}`,
        message: `${kind[0].toUpperCase()}${kind.slice(1)} date is ${date}.${kind === 'maturity' ? ' Plan repayment, renewal or refinancing.' : ''}` });
    }
  }

  const charges = await q(pool,
    `SELECT c.id, c.loan_id, c.due_date, c.amount, c.charge_type, l.loan_no, l.bank_id, b.name AS bank
       FROM finance_charges c JOIN loans l ON l.id = c.loan_id JOIN banks b ON b.id = l.bank_id WHERE c.status = 'due'`);
  for (const c of charges) {
    const days = daysUntil(c.due_date);
    const t = reached(days, settings.charge_reminder_days);
    if (t === undefined) continue;
    out.push({ key: `charge:${c.id}:${c.due_date}:${days < 0 ? 'overdue' : t}`, type: 'finance_charge', severity: days <= 1 ? 'critical' : 'warning', bank_id: c.bank_id, loan_id: c.loan_id,
      title: `${c.bank} ${c.loan_no}: ${c.charge_type} payment of ${fmt(c.amount)} due ${when(days)}`, message: `Due date is ${c.due_date}.` });
  }

  const docs = await q(pool,
    `SELECT d.id, d.title, d.expiry_date, d.loan_id, l.loan_no, l.bank_id, b.name AS bank
       FROM documents d JOIN loans l ON l.id = d.loan_id JOIN banks b ON b.id = l.bank_id WHERE d.expiry_date IS NOT NULL AND NOT d.archived AND l.status = 'active'`);
  for (const d of docs) {
    const days = daysUntil(d.expiry_date);
    const t = reached(days, settings.document_expiry_reminder_days);
    if (t === undefined) continue;
    out.push({ key: `document:${d.id}:${d.expiry_date}:${days < 0 ? 'expired' : t}`, type: 'document', severity: days < 0 ? 'critical' : 'warning', bank_id: d.bank_id, loan_id: d.loan_id,
      title: `${d.bank} ${d.loan_no}: document "${d.title}" ${days < 0 ? 'has expired' : `expires ${when(days)}`}`, message: `Expiry date is ${d.expiry_date}.` });
  }
  return out;
}

let chain: Promise<void> = Promise.resolve();
/** Brings open alerts in line with the current state. Serialised so overlapping runs cannot double-create. */
export function evaluateAlerts(): Promise<void> {
  chain = chain.catch(() => {}).then(run);
  return chain;
}

async function run() {
  const wanted = await wantedAlerts();
  const created = await tx(async (client) => {
    await client.query('SELECT pg_advisory_xact_lock(7002)');
    const active = await q(client, `SELECT id, dedupe_key FROM alerts WHERE status <> 'resolved'`);
    const wantedKeys = new Set(wanted.map((w) => w.key));
    const stale = active.filter((a) => !wantedKeys.has(a.dedupe_key)).map((a) => a.id);
    if (stale.length) await client.query(`UPDATE alerts SET status = 'resolved', resolved_at = now() WHERE id = ANY($1)`, [stale]);
    const activeKeys = new Set(active.map((a) => a.dedupe_key));
    let count = 0;
    for (const w of wanted.filter((x) => !activeKeys.has(x.key))) {
      const alert = (await client.query(
        `INSERT INTO alerts(type, severity, bank_id, loan_id, title, message, dedupe_key) VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING id`,
        [w.type, w.severity, w.bank_id ?? null, w.loan_id ?? null, w.title, w.message, w.key])).rows[0];
      count++;
      // A price hovering on a threshold must not send a message on every tick.
      const recent = await client.query(`SELECT 1 FROM alerts WHERE dedupe_key = $1 AND id <> $2 AND created_at > now() - interval '60 minutes' LIMIT 1`, [w.key, alert.id]);
      if (recent.rowCount) continue;
      await client.query(
        `INSERT INTO notifications(alert_id, user_id, channel, recipient, subject, body)
         SELECT $1::uuid, u.id, 'email', u.email, $2::text, $3::text FROM users u WHERE u.active AND u.notify_email AND u.role IN ('admin','manager','officer')
         UNION ALL
         SELECT $1::uuid, u.id, 'sms', u.phone, $2::text, $3::text FROM users u WHERE u.active AND u.notify_sms AND u.phone IS NOT NULL AND $4::text = 'critical' AND u.role IN ('admin','manager','officer')`,
        [alert.id, w.title, w.message, w.severity]);
    }
    return count + stale.length;
  });
  if (created) processOutbox().catch((err) => console.error('outbox failed', err));
}
