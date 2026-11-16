import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { audit } from '../audit.js';
import { one, pool, q, tx } from '../db.js';
import { badRequest, conflict, notFound } from '../errors.js';
import { actorOf, assertPasswordPolicy, hashPassword, requirePerm } from '../security/auth.js';
import { randomToken, sha256 } from '../security/crypto.js';
import { afterChange } from '../services/hooks.js';
import { getSettings } from '../services/settings.js';
import { feedStatus } from '../services/prices.js';
import { channels } from '../services/notify.js';

const USER_COLS = 'id, email, name, role, active, totp_enabled, must_change_password, locked_until, last_login_at, created_at';
const roles = z.enum(['admin', 'manager', 'officer', 'auditor']);
export const API_SCOPES = ['read', 'prices:write'] as const;

export default async function adminRoutes(app: FastifyInstance) {
  const admin = { preHandler: requirePerm('admin') };
  const uuid = z.uuid();

  app.get('/api/admin/users', admin, async () => q(pool, `SELECT ${USER_COLS} FROM users ORDER BY name`));

  app.post('/api/admin/users', admin, async (req) => {
    const b = z.object({ email: z.email().trim().toLowerCase().max(200), name: z.string().trim().min(1).max(120), role: roles, password: z.string().max(200) }).parse(req.body);
    assertPasswordPolicy(b.password, b.email);
    const hash = await hashPassword(b.password);
    return tx(async (client) => {
      // The administrator sets a temporary password; the user must replace it at first sign-in.
      const user = await one(client, `INSERT INTO users(email, name, role, password_hash, must_change_password) VALUES ($1,$2,$3,$4,true) RETURNING ${USER_COLS}`, [b.email, b.name, b.role, hash]);
      await audit(client, actorOf(req), { action: 'user.created', entityType: 'user', entityId: user.id, after: { email: user.email, name: user.name, role: user.role } });
      return user;
    });
  });

  app.put('/api/admin/users/:id', admin, async (req) => {
    const id = uuid.parse((req.params as any).id);
    const b = z.object({ name: z.string().trim().min(1).max(120), role: roles, active: z.boolean(), unlock: z.boolean().default(false), reset_mfa: z.boolean().default(false), new_password: z.string().max(200).optional().or(z.literal('')) }).parse(req.body);
    return tx(async (client) => {
      const before = await one(client, `SELECT ${USER_COLS} FROM users WHERE id = $1 FOR UPDATE`, [id]);
      if (!before) throw notFound('User');
      if (id === req.user!.id && (b.role !== 'admin' || !b.active)) throw badRequest('You cannot remove your own administrator access');
      if (before.role === 'admin' && (b.role !== 'admin' || !b.active)) {
        const others = await one(client, `SELECT count(*)::int AS n FROM users WHERE role = 'admin' AND active AND id <> $1`, [id]);
        if (!others.n) throw conflict('At least one active administrator is required');
      }
      let passwordHash: string | null = null;
      if (b.new_password) {
        assertPasswordPolicy(b.new_password, before.email);
        passwordHash = await hashPassword(b.new_password);
      }
      const after = await one(client,
        `UPDATE users SET name=$2, role=$3, active=$4,
                failed_attempts = CASE WHEN $5 THEN 0 ELSE failed_attempts END, locked_until = CASE WHEN $5 THEN NULL ELSE locked_until END,
                totp_enabled = CASE WHEN $6 THEN false ELSE totp_enabled END, totp_secret_enc = CASE WHEN $6 THEN NULL ELSE totp_secret_enc END,
                password_hash = COALESCE($7, password_hash), must_change_password = CASE WHEN $7::text IS NOT NULL THEN true ELSE must_change_password END, updated_at = now()
          WHERE id = $1 RETURNING ${USER_COLS}`, [id, b.name, b.role, b.active, b.unlock, b.reset_mfa, passwordHash]);
      // Any change to access ends the user's existing sessions.
      if (!b.active || passwordHash || b.role !== before.role || b.reset_mfa) await client.query('DELETE FROM sessions WHERE user_id = $1 AND id <> $2', [id, req.user!.session_id]);
      await audit(client, actorOf(req), { action: 'user.updated', entityType: 'user', entityId: id, before, after, meta: { password_reset: !!passwordHash, unlocked: b.unlock, mfa_reset: b.reset_mfa } });
      return after;
    });
  });

  // --- API keys for system integrations. The key is shown once; only its hash is stored. ---
  app.get('/api/admin/api-keys', admin, async () => q(pool, `SELECT k.id, k.name, k.prefix, k.scopes, k.created_at, k.last_used_at, k.revoked_at, u.name AS created_by FROM api_keys k LEFT JOIN users u ON u.id = k.created_by ORDER BY k.created_at DESC`));
  app.post('/api/admin/api-keys', admin, async (req) => {
    const b = z.object({ name: z.string().trim().min(1).max(80), scopes: z.array(z.enum(API_SCOPES)).min(1) }).parse(req.body);
    const key = `bsk_${randomToken(32)}`;
    return tx(async (client) => {
      const row = await one(client, 'INSERT INTO api_keys(name, prefix, key_hash, scopes, created_by) VALUES ($1,$2,$3,$4,$5) RETURNING id, name, prefix, scopes', [b.name, key.slice(0, 12), sha256(key), [...new Set(b.scopes)], req.user!.id]);
      await audit(client, actorOf(req), { action: 'api_key.created', entityType: 'api_key', entityId: row.id, after: { name: row.name, scopes: row.scopes } });
      return { ...row, key };
    });
  });
  app.delete('/api/admin/api-keys/:id', admin, async (req) => {
    const id = uuid.parse((req.params as any).id);
    return tx(async (client) => {
      const row = await one(client, 'UPDATE api_keys SET revoked_at = now() WHERE id = $1 AND revoked_at IS NULL RETURNING id, name', [id]);
      if (!row) throw notFound('Active API key');
      await audit(client, actorOf(req), { action: 'api_key.revoked', entityType: 'api_key', entityId: id, before: { name: row.name } });
      return { ok: true };
    });
  });

  // --- Settings ---
  const days = z.array(z.number().int().min(0).max(365)).min(1).max(8);
  const settingsSchema = z.object({
    require_approval: z.boolean(), warn_buffer_pct: z.number().min(0).max(100),
    maturity_reminder_days: days, review_reminder_days: days, charge_reminder_days: days, document_expiry_reminder_days: days,
  });
  app.get('/api/settings', { preHandler: requirePerm('read') }, async () => ({ ...(await getSettings()), system: { price_feed: feedStatus, channels } }));
  app.put('/api/admin/settings', admin, async (req) => {
    const b = settingsSchema.parse(req.body);
    await tx(async (client) => {
      const before = await getSettings(client);
      for (const [key, value] of Object.entries(b)) {
        await client.query('INSERT INTO settings(key, value, updated_by) VALUES ($1,$2,$3) ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now(), updated_by = EXCLUDED.updated_by', [key, JSON.stringify(value), req.user!.id]);
      }
      await audit(client, actorOf(req), { action: 'settings.updated', entityType: 'settings', entityId: 'global', before, after: b });
    });
    afterChange();
    return { ok: true };
  });
}
