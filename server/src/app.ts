import Fastify from 'fastify';
import cookie from '@fastify/cookie';
import helmet from '@fastify/helmet';
import multipart from '@fastify/multipart';
import rateLimit from '@fastify/rate-limit';
import fastifyStatic from '@fastify/static';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ZodError } from 'zod';
import { config } from './config.js';
import { pool } from './db.js';
import { AppError } from './errors.js';
import adminRoutes from './routes/admin.js';
import authRoutes from './routes/auth.js';
import dataRoutes from './routes/data.js';
import documentRoutes from './routes/documents.js';
import integrationRoutes from './routes/integration.js';
import reportRoutes from './routes/reports.js';

const PG_ERRORS: Record<string, [number, string]> = {
  '23505': [409, 'A record with the same name or number already exists'],
  '23503': [409, 'This record is still referenced by other records'],
  '23514': [400, 'The values are not allowed for this record'],
  '22P02': [400, 'Invalid value'],
  '22003': [400, 'Number is out of range'],
};

export async function buildApp() {
  const app = Fastify({
    logger: config.env === 'test' ? false : { level: 'info', redact: ['req.headers.cookie', 'req.headers.authorization', 'req.headers["x-csrf-token"]'] },
    trustProxy: config.trustProxy,
    bodyLimit: 1_048_576,
    genReqId: () => crypto.randomUUID(),
  });

  await app.register(helmet, {
    contentSecurityPolicy: {
      directives: {
        defaultSrc: ["'self'"], scriptSrc: ["'self'"], styleSrc: ["'self'"], styleSrcAttr: ["'unsafe-inline'"], imgSrc: ["'self'", 'data:'], connectSrc: ["'self'"],
        objectSrc: ["'none'"], frameAncestors: ["'none'"], baseUri: ["'self'"], formAction: ["'self'"],
        upgradeInsecureRequests: config.cookieSecure ? [] : null,
      },
    },
    hsts: config.cookieSecure ? { maxAge: 31_536_000, includeSubDomains: true } : false,
    referrerPolicy: { policy: 'no-referrer' },
  });
  await app.register(cookie);
  await app.register(rateLimit, { max: config.rateLimit, timeWindow: '1 minute' });
  await app.register(multipart, { limits: { fileSize: config.maxUploadBytes, files: 1, fields: 10 } });

  // API responses carry financial data: never cache them.
  app.addHook('onSend', async (req, reply) => {
    if (req.url.startsWith('/api/')) reply.header('cache-control', 'no-store');
  });

  app.setErrorHandler((err: any, req, reply) => {
    if (err instanceof AppError) return reply.code(err.status).send({ error: err.code, message: err.message });
    if (err instanceof ZodError) {
      const first = err.issues[0];
      return reply.code(400).send({ error: 'bad_request', message: `${first.path.join('.') || 'Request'}: ${first.message}` });
    }
    if (err.code && PG_ERRORS[err.code]) return reply.code(PG_ERRORS[err.code][0]).send({ error: 'rejected', message: PG_ERRORS[err.code][1] });
    if (err.code === 'FST_REQ_FILE_TOO_LARGE') return reply.code(413).send({ error: 'too_large', message: `File is larger than ${config.maxUploadBytes / 1_048_576} MB` });
    if (typeof err.statusCode === 'number' && err.statusCode < 500) return reply.code(err.statusCode).send({ error: 'bad_request', message: err.statusCode === 429 ? 'Too many requests. Wait a moment and try again.' : err.message });
    // Unknown failure: log everything, tell the client nothing about internals.
    req.log.error({ err }, 'unhandled error');
    return reply.code(500).send({ error: 'internal', message: 'Something went wrong on our side. Quote this reference to support.', reference: req.id });
  });

  app.get('/api/health', async (_req, reply) => {
    try {
      await pool.query('SELECT 1');
      return { status: 'ok' };
    } catch {
      return reply.code(503).send({ status: 'database unavailable' });
    }
  });

  await app.register(authRoutes);
  await app.register(dataRoutes);
  await app.register(documentRoutes);
  await app.register(adminRoutes);
  await app.register(reportRoutes);
  await app.register(integrationRoutes);

  // Serve the built web app (production). In development Vite serves it and proxies /api here.
  const here = path.dirname(fileURLToPath(import.meta.url));
  const webDir = [path.join(here, '../web/dist'), path.join(here, '../../web/dist')].find((d) => existsSync(d));
  if (webDir) {
    await app.register(fastifyStatic, { root: webDir, index: ['index.html'] });
    app.setNotFoundHandler((req, reply) => {
      if (req.url.startsWith('/api/')) return reply.code(404).send({ error: 'not_found', message: 'Not found' });
      return reply.header('cache-control', 'no-cache').sendFile('index.html');
    });
  }
  return app;
}
