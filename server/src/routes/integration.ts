import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { auditNow } from '../audit.js';
import { pool, q } from '../db.js';
import { actorOf, requireApiKey } from '../security/auth.js';
import { currentCoverage } from '../services/coverage.js';
import { recordPrices } from '../services/prices.js';

/**
 * Integration API (v1) for accounting, treasury and custody systems.
 * Auth: `Authorization: Bearer <api key>`; keys are issued by an administrator with scopes.
 */
export const openapi = {
  openapi: '3.0.3',
  info: { title: 'Borrowings System Integration API', version: '1.0.0', description: 'Read positions and coverage, and push market prices. All amounts are decimal strings to avoid rounding.' },
  servers: [{ url: '/api/v1' }],
  components: { securitySchemes: { apiKey: { type: 'http', scheme: 'bearer', description: 'API key issued in Administration > API keys' } } },
  security: [{ apiKey: [] }],
  paths: {
    '/banks': { get: { summary: 'Banks and their collateral terms', description: 'Scope: read', responses: { 200: { description: 'List of banks' } } } },
    '/loans': { get: { summary: 'Loan register', description: 'Scope: read', responses: { 200: { description: 'List of loans' } } } },
    '/loans/{id}/transactions': { get: { summary: 'Drawdowns and repayments for a loan', description: 'Scope: read', parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string', format: 'uuid' } }], responses: { 200: { description: 'List of transactions' } } } },
    '/finance-charges': { get: { summary: 'Finance charge schedule', description: 'Scope: read. Optional ?status=due|paid|cancelled', responses: { 200: { description: 'List of charges' } } } },
    '/holdings': { get: { summary: 'Shares held per bank, portfolio and loan', description: 'Scope: read', responses: { 200: { description: 'List of holdings' } } } },
    '/coverage': { get: { summary: 'Live coverage: surplus / shortfall per loan, per bank and in total', description: 'Scope: read', responses: { 200: { description: 'Coverage position' } } } },
    '/prices': {
      get: { summary: 'Latest price for every share', description: 'Scope: read', responses: { 200: { description: 'List of prices' } } },
      post: {
        summary: 'Push prices from a market-data or custody system', description: 'Scope: prices:write. Up to 1,000 quotes per call. Unknown symbols are returned, not created.',
        requestBody: { required: true, content: { 'application/json': { schema: { type: 'object', required: ['quotes'], properties: { source: { type: 'string', example: 'tadawul' }, quotes: { type: 'array', items: { type: 'object', required: ['symbol', 'price'], properties: { symbol: { type: 'string', example: '2222' }, price: { type: 'string', example: '27.85' }, as_of: { type: 'string', format: 'date-time' } } } } } } } } },
        responses: { 200: { description: 'Number accepted and any unknown symbols' } },
      },
    },
  },
};

export default async function integrationRoutes(app: FastifyInstance) {
  const read = { preHandler: requireApiKey('read') };

  app.get('/api/v1/openapi.json', async () => openapi);
  app.get('/api/v1/banks', read, async () => q(pool, 'SELECT id, name, code, coverage_ratio, top_up_ratio, margin_call_ratio, eligibility_mode, active FROM banks ORDER BY name'));
  app.get('/api/v1/loans', read, async () => q(pool,
    `SELECT l.id, b.code AS bank_code, b.name AS bank, l.loan_no, l.facility_type, l.currency, l.limit_amount, l.used_amount, l.start_date, l.maturity_date, l.review_date, l.renewal_date,
            l.rate_type, l.rate_pct, l.benchmark, l.margin_pct, COALESCE(l.coverage_ratio, b.coverage_ratio) AS coverage_ratio, l.status
       FROM loans l JOIN banks b ON b.id = l.bank_id ORDER BY b.name, l.loan_no`));
  app.get('/api/v1/loans/:id/transactions', read, async (req) => {
    const id = z.uuid().parse((req.params as any).id);
    return q(pool, 'SELECT id, type, amount, value_date, reference, balance_after, created_at FROM loan_transactions WHERE loan_id = $1 ORDER BY value_date, created_at', [id]);
  });
  app.get('/api/v1/finance-charges', read, async (req) => {
    const status = z.enum(['due', 'paid', 'cancelled']).optional().parse((req.query as any).status);
    return q(pool,
      `SELECT c.id, c.loan_id, l.loan_no, b.code AS bank_code, c.charge_type, c.due_date, c.amount, c.status, c.paid_date, c.reference
         FROM finance_charges c JOIN loans l ON l.id = c.loan_id JOIN banks b ON b.id = l.bank_id WHERE ($1::text IS NULL OR c.status = $1) ORDER BY c.due_date LIMIT 5000`, [status ?? null]);
  });
  app.get('/api/v1/holdings', read, async () => q(pool,
    `SELECT h.id, b.code AS bank_code, p.name AS portfolio, p.custody_account, l.loan_no, s.symbol, h.quantity, s.last_price, round(h.quantity * COALESCE(s.last_price, 0), 2) AS market_value
       FROM holdings h JOIN portfolios p ON p.id = h.portfolio_id JOIN securities s ON s.id = h.security_id LEFT JOIN banks b ON b.id = p.bank_id LEFT JOIN loans l ON l.id = p.loan_id
      ORDER BY b.code NULLS LAST, p.name, s.symbol`));
  app.get('/api/v1/coverage', read, async () => {
    const { coverage } = await currentCoverage();
    return { as_of: new Date().toISOString(), ...coverage };
  });
  app.get('/api/v1/prices', read, async () => q(pool, 'SELECT symbol, name, last_price AS price, last_price_at AS as_of, last_price_source AS source FROM securities WHERE active ORDER BY symbol'));

  app.post('/api/v1/prices', { preHandler: requireApiKey('prices:write'), config: { rateLimit: { max: 120, timeWindow: '1 minute' } } }, async (req) => {
    const body = z.object({
      source: z.string().trim().regex(/^[\w.\-]{1,30}$/).default('api'),
      quotes: z.array(z.object({
        symbol: z.string().trim().min(1).max(20).transform((s) => s.toUpperCase()),
        price: z.string().regex(/^\d{1,12}(\.\d{1,4})?$/).refine((p) => Number(p) > 0, 'Price must be greater than zero'),
        as_of: z.iso.datetime({ offset: true }).optional().refine((d) => !d || Date.parse(d) <= Date.now() + 300_000, 'as_of is in the future'),
      })).min(1).max(1000),
    }).parse(req.body);
    const result = await recordPrices(body.quotes, body.source);
    await auditNow(actorOf(req), { action: 'price.pushed', meta: { source: body.source, accepted: result.accepted, unknown: result.unknown } });
    return result;
  });
}
