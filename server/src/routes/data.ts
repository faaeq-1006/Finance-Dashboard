import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { auditNow, verifyAuditChain } from '../audit.js';
import { one, pool, q } from '../db.js';
import { badRequest, notFound } from '../errors.js';
import { effectiveTerms } from '../engine/coverage.js';
import { suggestAllocation } from '../engine/allocation.js';
import { actorOf, requirePerm } from '../security/auth.js';
import { decide, isCommand, submit } from '../services/commands.js';
import { currentCoverage } from '../services/coverage.js';
import { onBroadcast } from '../services/hooks.js';
import { channels } from '../services/notify.js';
import { feedStatus } from '../services/prices.js';

const uuid = z.uuid();
const idParam = (req: { params: unknown }) => {
  const r = uuid.safeParse((req.params as { id?: string }).id);
  if (!r.success) throw notFound();
  return r.data;
};

const KEY_DATES = `
  SELECT * FROM (
    SELECT 'maturity' AS kind, l.id AS loan_id, b.name AS bank, l.loan_no, l.maturity_date AS date, NULL::numeric AS amount, NULL::uuid AS ref_id, NULL AS label
      FROM loans l JOIN banks b ON b.id = l.bank_id WHERE l.status = 'active'
    UNION ALL SELECT 'review', l.id, b.name, l.loan_no, l.review_date, NULL, NULL, NULL FROM loans l JOIN banks b ON b.id = l.bank_id WHERE l.status = 'active' AND l.review_date IS NOT NULL
    UNION ALL SELECT 'renewal', l.id, b.name, l.loan_no, l.renewal_date, NULL, NULL, NULL FROM loans l JOIN banks b ON b.id = l.bank_id WHERE l.status = 'active' AND l.renewal_date IS NOT NULL
    UNION ALL SELECT 'finance_charge', l.id, b.name, l.loan_no, c.due_date, c.amount, c.id, c.charge_type FROM finance_charges c JOIN loans l ON l.id = c.loan_id JOIN banks b ON b.id = l.bank_id WHERE c.status = 'due'
    UNION ALL SELECT 'document_expiry', l.id, b.name, l.loan_no, d.expiry_date, NULL, d.id, d.title FROM documents d JOIN loans l ON l.id = d.loan_id JOIN banks b ON b.id = l.bank_id WHERE d.expiry_date IS NOT NULL AND NOT d.archived AND l.status = 'active'
  ) x`;

export default async function dataRoutes(app: FastifyInstance) {
  const read = { preHandler: requirePerm('read') };
  const write = { preHandler: requirePerm('write') };

  app.get('/api/coverage', read, async () => {
    const { coverage, settings } = await currentCoverage();
    return { ...coverage, warn_buffer_pct: settings.warn_buffer_pct, as_of: new Date().toISOString(), feed: feedStatus };
  });

  app.get('/api/dashboard', read, async () => {
    const [{ coverage, settings }, dates, alerts, approvals] = await Promise.all([
      currentCoverage(),
      q(pool, `${KEY_DATES} WHERE date <= current_date + 60 ORDER BY date LIMIT 12`),
      q(pool, `SELECT id, type, severity, title, message, loan_id, status, created_at FROM alerts WHERE status <> 'resolved' ORDER BY (severity = 'critical') DESC, created_at DESC LIMIT 8`),
      one(pool, `SELECT count(*)::int AS n FROM change_requests WHERE status = 'pending'`),
    ]);
    return {
      totals: coverage.totals, warn_buffer_pct: settings.warn_buffer_pct, feed: feedStatus, key_dates: dates, alerts, pending_approvals: approvals.n,
      banks: coverage.banks.map((b) => ({ id: b.id, name: b.name, used_amount: b.used_amount, limit_amount: b.limit_amount, collateral_value: b.collateral_value, coverage_required: b.coverage_required, surplus: b.surplus, worst_status: b.worst_status })),
      loans: coverage.banks.flatMap((b) => b.loans.map(({ portfolios, ...l }) => ({ ...l, bank: b.name }))),
    };
  });

  // Counters for the navigation badges.
  app.get('/api/counts', read, async () => one(pool,
    `SELECT (SELECT count(*)::int FROM alerts WHERE status = 'open') AS open_alerts,
            (SELECT count(*)::int FROM change_requests WHERE status = 'pending') AS pending_approvals`));

  app.get('/api/banks', read, async () => q(pool,
    `SELECT b.*, (SELECT count(*)::int FROM loans l WHERE l.bank_id = b.id AND l.status = 'active') AS active_loans,
            (SELECT count(*)::int FROM bank_eligible_securities e WHERE e.bank_id = b.id) AS listed_securities
       FROM banks b ORDER BY b.name`));
  app.get('/api/banks/:id', read, async (req) => {
    const id = idParam(req);
    const bank = await one(pool, 'SELECT * FROM banks WHERE id = $1', [id]);
    if (!bank) throw notFound('Bank');
    const eligibility = await q(pool, `SELECT e.security_id, e.haircut_pct, s.symbol, s.name FROM bank_eligible_securities e JOIN securities s ON s.id = e.security_id WHERE e.bank_id = $1 ORDER BY s.symbol`, [id]);
    return { ...bank, eligibility };
  });

  app.get('/api/loans', read, async () => q(pool, `SELECT l.*, b.name AS bank, b.coverage_ratio AS bank_coverage_ratio FROM loans l JOIN banks b ON b.id = l.bank_id ORDER BY (l.status = 'active') DESC, b.name, l.loan_no`));
  app.get('/api/loans/:id', read, async (req) => {
    const id = idParam(req);
    const loan = await one(pool, 'SELECT * FROM loans WHERE id = $1', [id]);
    if (!loan) throw notFound('Loan');
    const [bank, transactions, charges, documents, history, { coverage }] = await Promise.all([
      one(pool, 'SELECT * FROM banks WHERE id = $1', [loan.bank_id]),
      q(pool, `SELECT t.*, u.name AS created_by_name FROM loan_transactions t LEFT JOIN users u ON u.id = t.created_by WHERE t.loan_id = $1 ORDER BY t.value_date DESC, t.created_at DESC LIMIT 500`, [id]),
      q(pool, `SELECT * FROM finance_charges WHERE loan_id = $1 ORDER BY due_date LIMIT 500`, [id]),
      q(pool,
        `SELECT d.*, COALESCE((SELECT json_agg(json_build_object('version_no', v.version_no, 'filename', v.filename, 'size_bytes', v.size_bytes, 'sha256', v.sha256, 'note', v.note,
                  'uploaded_at', v.uploaded_at, 'uploaded_by', u.name) ORDER BY v.version_no DESC)
                  FROM document_versions v LEFT JOIN users u ON u.id = v.uploaded_by WHERE v.document_id = d.id), '[]') AS versions
           FROM documents d WHERE d.loan_id = $1 AND NOT d.archived ORDER BY d.created_at DESC`, [id]),
      q(pool, `SELECT id, at, actor_label, action, before, after, meta FROM audit_log WHERE entity_type = 'loan' AND entity_id = $1 ORDER BY id DESC LIMIT 100`, [id]),
      currentCoverage(),
    ]);
    const position = coverage.banks.flatMap((b) => b.loans).find((l) => l.id === id) ?? null;
    return { loan, bank, terms: effectiveTerms(bank, loan), position, transactions, charges, documents, history };
  });

  app.get('/api/portfolios', read, async () => q(pool,
    `SELECT p.*, b.name AS bank, l.loan_no,
            COALESCE((SELECT json_agg(json_build_object('id', h.id, 'security_id', h.security_id, 'symbol', s.symbol, 'name', s.name, 'quantity', h.quantity::text,
                      'price', s.last_price::text, 'value', round(h.quantity * COALESCE(s.last_price, 0), 2)::text) ORDER BY s.symbol)
                      FROM holdings h JOIN securities s ON s.id = h.security_id WHERE h.portfolio_id = p.id), '[]') AS holdings
       FROM portfolios p LEFT JOIN banks b ON b.id = p.bank_id LEFT JOIN loans l ON l.id = p.loan_id ORDER BY b.name NULLS LAST, p.name`));

  app.get('/api/securities', read, async () => q(pool,
    `SELECT s.*, COALESCE((SELECT sum(h.quantity) FROM holdings h WHERE h.security_id = s.id), 0)::text AS total_quantity,
            (SELECT p.price FROM prices p WHERE p.security_id = s.id AND p.as_of < date_trunc('day', now()) ORDER BY p.as_of DESC LIMIT 1) AS previous_close
       FROM securities s ORDER BY s.symbol`));
  app.get('/api/securities/:id/prices', read, async (req) => {
    const id = idParam(req);
    const days = z.coerce.number().int().min(1).max(3650).default(30).parse((req.query as { days?: string }).days);
    // Thin long ranges to at most ~600 evenly spaced points; the full history stays in the database.
    return q(pool,
      `WITH pts AS (SELECT price, as_of, source, row_number() OVER (ORDER BY as_of) AS rn, count(*) OVER () AS total
                      FROM prices WHERE security_id = $1 AND as_of >= now() - make_interval(days => $2))
       SELECT price, as_of, source FROM pts WHERE total <= 600 OR rn % ceil(total / 600.0)::int = 0 OR rn = total ORDER BY as_of`, [id, days]);
  });

  app.post('/api/simulate', read, async (req) => {
    const body = z.object({
      shock_pct: z.number().min(-100).max(100).default(0),
      security_shocks: z.record(uuid, z.number().min(-100).max(100)).default({}),
    }).parse(req.body);
    const [base, shocked] = await Promise.all([currentCoverage(), currentCoverage({ shockPct: body.shock_pct, securityShocks: body.security_shocks })]);
    return { base: base.coverage, shocked: shocked.coverage };
  });

  app.get('/api/allocation', read, async (req) => {
    const target = z.enum(['required', 'buffer']).default('buffer').parse((req.query as { target?: string }).target);
    const { snapshot, coverage, settings } = await currentCoverage();
    return { ...suggestAllocation(coverage, snapshot, settings.warn_buffer_pct, target), warn_buffer_pct: settings.warn_buffer_pct };
  });

  app.get('/api/alerts', read, async (req) => {
    const status = z.enum(['active', 'resolved', 'all']).default('active').parse((req.query as { status?: string }).status);
    return q(pool,
      `SELECT a.*, b.name AS bank, l.loan_no, u.name AS acknowledged_by_name FROM alerts a
         LEFT JOIN banks b ON b.id = a.bank_id LEFT JOIN loans l ON l.id = a.loan_id LEFT JOIN users u ON u.id = a.acknowledged_by
        WHERE ($1 = 'all' OR ($1 = 'active' AND a.status <> 'resolved') OR ($1 = 'resolved' AND a.status = 'resolved'))
        ORDER BY (a.status = 'open') DESC, a.created_at DESC LIMIT 300`, [status]);
  });
  app.post('/api/alerts/:id/ack', write, async (req) => {
    const id = idParam(req);
    const r = await one(pool, `UPDATE alerts SET status = 'acknowledged', acknowledged_by = $2, acknowledged_at = now() WHERE id = $1 AND status = 'open' RETURNING id`, [id, req.user!.id]);
    if (!r) throw notFound('Open alert');
    await auditNow(actorOf(req), { action: 'alert.acknowledged', entityType: 'alert', entityId: id });
    return { ok: true };
  });
  app.get('/api/notifications', { preHandler: requirePerm('audit.read') }, async () => ({
    channels,
    items: await q(pool, `SELECT n.id, n.channel, n.recipient, n.subject, n.status, n.attempts, n.last_error, n.created_at, n.sent_at FROM notifications n ORDER BY n.created_at DESC LIMIT 200`),
  }));

  app.get('/api/calendar', read, async () => q(pool, `${KEY_DATES} WHERE date <= current_date + 365 ORDER BY date LIMIT 500`));

  // --- Commands and approvals ---
  app.post('/api/commands/:name', write, async (req) => {
    const { name } = req.params as { name: string };
    if (!isCommand(name)) throw notFound('Command');
    return submit(name, req.body, actorOf(req));
  });
  app.get('/api/approvals', read, async (req) => {
    const status = z.enum(['pending', 'decided']).default('pending').parse((req.query as { status?: string }).status);
    return q(pool,
      `SELECT c.*, r.name AS requested_by_name, d.name AS decided_by_name FROM change_requests c
         JOIN users r ON r.id = c.requested_by LEFT JOIN users d ON d.id = c.decided_by
        WHERE ($1 = 'pending') = (c.status = 'pending') ORDER BY c.requested_at DESC LIMIT 200`, [status]);
  });
  app.post('/api/approvals/:id/decide', write, async (req) => {
    const id = idParam(req);
    const body = z.object({ decision: z.enum(['approve', 'reject', 'cancel']), note: z.string().trim().max(500).nullish() }).parse(req.body);
    if (body.decision !== 'cancel') await requirePerm('approve')(req);
    return decide(id, body.decision, body.note || null, actorOf(req));
  });

  // --- Audit trail ---
  const auditGuard = { preHandler: requirePerm('audit.read') };
  const auditFilter = z.object({
    action: z.string().max(60).optional(), entity_type: z.string().max(40).optional(), actor: z.string().max(120).optional(),
    before_id: z.coerce.number().int().positive().optional(), limit: z.coerce.number().int().min(1).max(200).default(50),
  });
  const auditQuery = (f: z.infer<typeof auditFilter>, limit: number) => q(pool,
    `SELECT id, at, actor_type, actor_label, action, entity_type, entity_id, before, after, meta, ip, hash FROM audit_log
      WHERE ($1::text IS NULL OR action LIKE $1 || '%') AND ($2::text IS NULL OR entity_type = $2) AND ($3::text IS NULL OR actor_label ILIKE '%' || $3 || '%')
        AND ($4::bigint IS NULL OR id < $4) ORDER BY id DESC LIMIT $5`,
    [f.action || null, f.entity_type || null, f.actor ? f.actor.replace(/[%_\\]/g, '\\$&') : null, f.before_id ?? null, limit]);
  app.get('/api/audit', auditGuard, async (req) => {
    const f = auditFilter.parse(req.query);
    return auditQuery(f, f.limit);
  });
  app.get('/api/audit/verify', auditGuard, async () => verifyAuditChain());
  app.get('/api/audit/export.csv', auditGuard, async (req, reply) => {
    const rows = await auditQuery(auditFilter.parse(req.query), 20_000);
    // Neutralise spreadsheet formula injection, then CSV-quote.
    const cell = (v: unknown) => {
      let s = v === null || v === undefined ? '' : typeof v === 'object' ? JSON.stringify(v) : String(v);
      if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`;
      return `"${s.replace(/"/g, '""')}"`;
    };
    const lines = [['id', 'at', 'actor', 'action', 'entity_type', 'entity_id', 'before', 'after', 'meta', 'ip', 'hash'].join(',')];
    for (const r of rows) lines.push([r.id, r.at.toISOString(), r.actor_label, r.action, r.entity_type, r.entity_id, r.before, r.after, r.meta, r.ip, r.hash].map(cell).join(','));
    await auditNow(actorOf(req), { action: 'audit.exported', meta: { rows: rows.length } });
    return reply.header('content-type', 'text/csv; charset=utf-8').header('content-disposition', 'attachment; filename="audit-log.csv"').send(lines.join('\r\n'));
  });

  // --- Live updates (server-sent events) ---
  let streams = 0;
  app.get('/api/stream', read, (req, reply) => {
    if (streams >= 200) throw badRequest('Too many live connections');
    streams++;
    reply.hijack();
    reply.raw.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache, no-transform', connection: 'keep-alive', 'x-accel-buffering': 'no' });
    reply.raw.write('retry: 5000\n\n');
    const off = onBroadcast((topic) => reply.raw.write(`event: ${topic}\ndata: {}\n\n`));
    const ping = setInterval(() => reply.raw.write(': ping\n\n'), 25_000);
    req.raw.on('close', () => { streams--; off(); clearInterval(ping); });
  });
}
