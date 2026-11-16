import type { FastifyInstance } from 'fastify';
import QRCode from 'qrcode';
import { z } from 'zod';
import { auditNow } from '../audit.js';
import { config } from '../config.js';
import { one, pool } from '../db.js';
import { badRequest, unauthorized, AppError } from '../errors.js';
import {
  actorOf, assertPasswordPolicy, burnPasswordCheck, createSession, destroyOtherSessions, destroySession, hashPassword, permissionsOf, requireUser, verifyPassword,
} from '../security/auth.js';
import { decryptText, encryptText, newTotpSecret, totpVerify } from '../security/crypto.js';

const MAX_FAILURES = 5;
const LOCK_MINUTES = 15;

export default async function authRoutes(app: FastifyInstance) {
  const loginBody = z.object({ email: z.string().trim().toLowerCase().max(200), password: z.string().max(200), totp: z.string().trim().max(10).optional() });

  app.post('/api/auth/login', { config: { rateLimit: { max: config.loginRateLimit, timeWindow: '1 minute' } } }, async (req, reply) => {
    const body = loginBody.safeParse(req.body);
    if (!body.success) throw badRequest('Enter your email and password');
    const { email, password, totp } = body.data;
    const user = await one(pool, 'SELECT * FROM users WHERE email = $1', [email]);
    const generic = unauthorized('Email or password is incorrect');
    const actor = { type: 'user' as const, id: user?.id ?? null, label: email.slice(0, 120), ip: req.ip };

    if (!user || !user.active) {
      await burnPasswordCheck(password);
      await auditNow(actor, { action: 'auth.login_failed', meta: { reason: 'unknown_or_inactive' } });
      throw generic;
    }
    if (user.locked_until && user.locked_until > new Date()) {
      await burnPasswordCheck(password);
      await auditNow(actor, { action: 'auth.login_failed', entityType: 'user', entityId: user.id, meta: { reason: 'locked' } });
      throw new AppError(429, 'locked', `Too many failed attempts. Try again in ${LOCK_MINUTES} minutes or ask an administrator to unlock the account.`);
    }
    const passwordOk = await verifyPassword(user.password_hash, password);
    let mfaOk = true;
    if (passwordOk && user.totp_enabled) {
      if (!totp) return reply.code(200).send({ mfa_required: true });
      mfaOk = totpVerify(decryptText(user.totp_secret_enc), totp);
    }
    if (!passwordOk || !mfaOk) {
      const r = await one(pool,
        `UPDATE users SET failed_attempts = failed_attempts + 1,
                locked_until = CASE WHEN failed_attempts + 1 >= $2 THEN now() + ($3 || ' minutes')::interval ELSE locked_until END
          WHERE id = $1 RETURNING failed_attempts`, [user.id, MAX_FAILURES, String(LOCK_MINUTES)]);
      await auditNow(actor, { action: 'auth.login_failed', entityType: 'user', entityId: user.id, meta: { reason: passwordOk ? 'bad_mfa_code' : 'bad_password', failed_attempts: r.failed_attempts } });
      throw passwordOk ? unauthorized('Authenticator code is incorrect') : generic;
    }
    await pool.query('UPDATE users SET failed_attempts = 0, locked_until = NULL, last_login_at = now() WHERE id = $1', [user.id]);
    await createSession(reply, user.id, req);
    await auditNow(actor, { action: 'auth.login', entityType: 'user', entityId: user.id });
    return { ok: true };
  });

  app.get('/api/auth/me', { preHandler: requireUser }, async (req) => {
    const u = req.user!;
    return { id: u.id, email: u.email, name: u.name, role: u.role, permissions: permissionsOf(u.role), must_change_password: u.must_change_password, totp_enabled: u.totp_enabled, csrf_token: u.csrf_token };
  });

  app.post('/api/auth/logout', { preHandler: requireUser }, async (req, reply) => {
    await destroySession(req, reply);
    await auditNow(actorOf(req), { action: 'auth.logout', entityType: 'user', entityId: req.user!.id });
    return { ok: true };
  });

  app.post('/api/auth/change-password', { preHandler: requireUser, config: { rateLimit: { max: config.loginRateLimit, timeWindow: '1 minute' } } }, async (req) => {
    const body = z.object({ current_password: z.string().max(200), new_password: z.string().max(200) }).parse(req.body);
    const user = await one(pool, 'SELECT password_hash FROM users WHERE id = $1', [req.user!.id]);
    if (!(await verifyPassword(user.password_hash, body.current_password))) throw badRequest('Current password is incorrect');
    if (body.new_password === body.current_password) throw badRequest('Choose a password you have not just used');
    assertPasswordPolicy(body.new_password, req.user!.email);
    await pool.query('UPDATE users SET password_hash = $2, must_change_password = false, updated_at = now() WHERE id = $1', [req.user!.id, await hashPassword(body.new_password)]);
    await destroyOtherSessions(req.user!.id, req.user!.session_id);
    await auditNow(actorOf(req), { action: 'auth.password_changed', entityType: 'user', entityId: req.user!.id });
    return { ok: true };
  });

  // --- Two-step verification (TOTP authenticator app) ---
  app.post('/api/auth/mfa/setup', { preHandler: requireUser }, async (req) => {
    if (req.user!.totp_enabled) throw badRequest('Two-step verification is already on');
    const secret = newTotpSecret();
    await pool.query('UPDATE users SET totp_secret_enc = $2 WHERE id = $1', [req.user!.id, encryptText(secret)]);
    const uri = `otpauth://totp/${encodeURIComponent(`Borrowings System:${req.user!.email}`)}?secret=${secret}&issuer=${encodeURIComponent('Borrowings System')}`;
    return { secret, qr_svg: await QRCode.toString(uri, { type: 'svg', margin: 1, width: 180 }) };
  });
  app.post('/api/auth/mfa/enable', { preHandler: requireUser, config: { rateLimit: { max: config.loginRateLimit, timeWindow: '1 minute' } } }, async (req) => {
    const { code } = z.object({ code: z.string().trim() }).parse(req.body);
    const user = await one(pool, 'SELECT totp_secret_enc FROM users WHERE id = $1', [req.user!.id]);
    if (!user.totp_secret_enc || !totpVerify(decryptText(user.totp_secret_enc), code)) throw badRequest('That code is not correct. Check the time on your phone and try again.');
    await pool.query('UPDATE users SET totp_enabled = true WHERE id = $1', [req.user!.id]);
    await destroyOtherSessions(req.user!.id, req.user!.session_id);
    await auditNow(actorOf(req), { action: 'auth.mfa_enabled', entityType: 'user', entityId: req.user!.id });
    return { ok: true };
  });
  app.post('/api/auth/mfa/disable', { preHandler: requireUser, config: { rateLimit: { max: config.loginRateLimit, timeWindow: '1 minute' } } }, async (req) => {
    const { password } = z.object({ password: z.string().max(200) }).parse(req.body);
    const user = await one(pool, 'SELECT password_hash FROM users WHERE id = $1', [req.user!.id]);
    if (!(await verifyPassword(user.password_hash, password))) throw badRequest('Password is incorrect');
    await pool.query('UPDATE users SET totp_enabled = false, totp_secret_enc = NULL WHERE id = $1', [req.user!.id]);
    await auditNow(actorOf(req), { action: 'auth.mfa_disabled', entityType: 'user', entityId: req.user!.id });
    return { ok: true };
  });

  app.put('/api/auth/profile', { preHandler: requireUser }, async (req) => {
    const b = z.object({ phone: z.string().trim().regex(/^\+?[0-9 ]{7,20}$/, 'Enter a valid phone number').nullish().or(z.literal('')), notify_email: z.boolean(), notify_sms: z.boolean() }).parse(req.body);
    await pool.query('UPDATE users SET phone = $2, notify_email = $3, notify_sms = $4, updated_at = now() WHERE id = $1', [req.user!.id, b.phone || null, b.notify_email, b.notify_sms]);
    return { ok: true };
  });
  app.get('/api/auth/profile', { preHandler: requireUser }, async (req) =>
    one(pool, 'SELECT phone, notify_email, notify_sms FROM users WHERE id = $1', [req.user!.id]));
}
