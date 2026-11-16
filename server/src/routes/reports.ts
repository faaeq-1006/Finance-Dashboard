import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { auditNow } from '../audit.js';
import { actorOf, requirePerm } from '../security/auth.js';
import { bankStatementPdf, coverageWorkbook, managementPdf, priceHistoryWorkbook } from '../services/reports.js';

const XLSX = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
const stamp = () => new Date().toISOString().slice(0, 10);

export default async function reportRoutes(app: FastifyInstance) {
  const guard = { preHandler: requirePerm('read'), config: { rateLimit: { max: 30, timeWindow: '1 minute' } } };
  const send = async (req: FastifyRequest, reply: FastifyReply, name: string, type: string, body: Buffer) => {
    await auditNow(actorOf(req), { action: 'report.exported', meta: { report: name } });
    return reply.header('content-type', type).header('content-disposition', `attachment; filename="${name}"`).header('cache-control', 'no-store').send(body);
  };
  app.get('/api/reports/coverage.xlsx', guard, async (req, reply) => send(req, reply, `coverage-${stamp()}.xlsx`, XLSX, await coverageWorkbook()));
  app.get('/api/reports/management.pdf', guard, async (req, reply) => send(req, reply, `management-report-${stamp()}.pdf`, 'application/pdf', await managementPdf()));
  app.get('/api/reports/bank-statement/:id.pdf', guard, async (req, reply) => {
    const id = z.uuid().parse((req.params as any).id);
    return send(req, reply, `collateral-statement-${stamp()}.pdf`, 'application/pdf', await bankStatementPdf(id));
  });
  app.get('/api/reports/price-history.xlsx', guard, async (req, reply) => {
    const p = z.object({ security_id: z.uuid().optional().or(z.literal('').transform(() => undefined)), from: z.iso.date(), to: z.iso.date() }).parse(req.query);
    return send(req, reply, `price-history-${p.from}-to-${p.to}.xlsx`, XLSX, await priceHistoryWorkbook(p.security_id ?? null, p.from, p.to));
  });
}
