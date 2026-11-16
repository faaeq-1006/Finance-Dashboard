import { hash, verify } from '@node-rs/argon2';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { config } from '../config.js';
import { one, pool, q } from '../db.js';
import { badRequest, forbidden, unauthorized } from '../errors.js';
import { randomToken, safeEqual, sha256 } from './crypto.js';
import type { Actor } from '../audit.js';

export type Role = 'admin' | 'manager' | 'officer' | 'auditor';
export type Permission = 'read' | 'write' | 'approve' | 'audit.read' | 'admin';

const ROLE_PERMS: Record<Role, Permission[]> = {
  admin: ['read', 'write', 'approve', 'audit.read', 'admin'],
  manager: ['read', 'write', 'approve', 'audit.read'],
  officer: ['read', 'write'],
  auditor: ['read', 'audit.read'],
};
export const can = (role: Role, perm: Permission) => ROLE_PERMS[role]?.includes(perm) ?? false;
export const permissionsOf = (role: Role) => ROLE_PERMS[role] ?? [];

export interface SessionUser {
  id: string; email: string; name: string; role: Role; must_change_password: boolean; totp_enabled: boolean;
  session_id: string; csrf_token: string;
}
declare module 'fastify' {
  interface FastifyRequest {
    user?: SessionUser;
    apiKey?: { id: string; name: string; scopes: string[] };
  }
}

// OWASP-recommended Argon2id parameters.
const ARGON = { memoryCost: 19_456, timeCost: 2, parallelism: 1 };
export const hashPassword = (pw: string) => hash(pw, ARGON);
export const verifyPassword = (stored: string, pw: string) => verify(stored, pw).catch(() => false);
// Verified against when the account does not exist, so response time does not reveal which emails are registered.
const DUMMY_HASH = await hashPassword(randomToken());
export const burnPasswordCheck = (pw: string) => verifyPassword(DUMMY_HASH, pw);

const COMMON = new Set(['password1234', '123456789012', 'qwertyuiopas', 'passwordpassword', 'letmeinletmein']);
export function assertPasswordPolicy(pw: string, email: string) {
  if (pw.length < 12) throw badRequest('Password must be at least 12 characters');
  if (pw.length > 200) throw badRequest('Password is too long');
  if (!/[a-z]/.test(pw) || !/[A-Z]/.test(pw) || !/\d/.test(pw)) throw badRequest('Password must include upper-case, lower-case and a number');
  const local = email.split('@')[0];
  if (COMMON.has(pw.toLowerCase()) || (local.length >= 4 && pw.toLowerCase().includes(local))) throw badRequest('Password is too easy to guess');
}

export const COOKIE = config.cookieSecure ? '__Host-bs_sid' : 'bs_sid';
const cookieOpts = { httpOnly: true, secure: config.cookieSecure, sameSite: 'strict' as const, path: '/' };

export async function createSession(reply: FastifyReply, userId: string, req: FastifyRequest): Promise<string> {
  const token = randomToken();
  const csrf = randomToken(24);
  await pool.query(
    `INSERT INTO sessions(token_hash, user_id, csrf_token, ip, user_agent, expires_at) VALUES ($1,$2,$3,$4,$5, now() + ($6 || ' milliseconds')::interval)`,
    [sha256(token), userId, csrf, req.ip, String(req.headers['user-agent'] ?? '').slice(0, 300), String(config.sessionAbsoluteMs)],
  );
  reply.setCookie(COOKIE, token, cookieOpts);
  return csrf;
}

export async function destroySession(req: FastifyRequest, reply: FastifyReply) {
  const token = req.cookies[COOKIE];
  if (token) await pool.query('DELETE FROM sessions WHERE token_hash = $1', [sha256(token)]);
  reply.clearCookie(COOKIE, cookieOpts);
}
export const destroyOtherSessions = (userId: string, keepSessionId?: string) =>
  pool.query('DELETE FROM sessions WHERE user_id = $1 AND id IS DISTINCT FROM $2', [userId, keepSessionId ?? null]);

async function loadSession(req: FastifyRequest): Promise<SessionUser | undefined> {
  const token = req.cookies[COOKIE];
  if (!token) return undefined;
  // Idle timeout is enforced in the same statement that slides it. Only requests made while the person is
  // actually using the app (the client marks them) extend the session: background refreshes on an
  // unattended screen do not keep it alive.
  const active = req.headers['x-user-active'] === '1' || !['GET', 'HEAD'].includes(req.method);
  return one<SessionUser>(pool,
    `UPDATE sessions s SET last_seen_at = CASE WHEN $3 THEN now() ELSE s.last_seen_at END
       FROM users u
      WHERE s.token_hash = $1 AND u.id = s.user_id AND u.active
        AND s.expires_at > now() AND s.last_seen_at > now() - ($2 || ' milliseconds')::interval
  RETURNING u.id, u.email, u.name, u.role, u.must_change_password, u.totp_enabled, s.id AS session_id, s.csrf_token`,
    [sha256(token), String(config.sessionIdleMs), active]);
}

/** Browser session auth + CSRF check on every state-changing request. */
export async function requireUser(req: FastifyRequest) {
  const user = await loadSession(req);
  if (!user) throw unauthorized();
  if (!['GET', 'HEAD', 'OPTIONS'].includes(req.method)) {
    const sent = req.headers['x-csrf-token'];
    if (typeof sent !== 'string' || !safeEqual(sent, user.csrf_token)) throw forbidden('Security token missing or expired. Refresh the page and try again.');
  }
  req.user = user;
}

export const requirePerm = (perm: Permission) => async (req: FastifyRequest) => {
  if (!req.user) await requireUser(req);
  const user = req.user!;
  // A user on a temporary password can do nothing until it is changed.
  if (user.must_change_password) throw forbidden('Change your temporary password first');
  if (!can(user.role, perm)) throw forbidden();
};

export const actorOf = (req: FastifyRequest): Actor =>
  req.user ? { type: 'user', id: req.user.id, label: req.user.email, ip: req.ip, role: req.user.role }
    : { type: 'api_key', id: req.apiKey!.id, label: `api:${req.apiKey!.name}`, ip: req.ip };

/** Integration API auth: `Authorization: Bearer bsk_...`. Keys are stored hashed. */
export const requireApiKey = (scope: string) => async (req: FastifyRequest) => {
  const header = req.headers.authorization ?? '';
  const key = header.startsWith('Bearer ') ? header.slice(7).trim() : '';
  if (!key.startsWith('bsk_')) throw unauthorized('API key required');
  const row = await one(pool, `UPDATE api_keys SET last_used_at = now() WHERE key_hash = $1 AND revoked_at IS NULL RETURNING id, name, scopes`, [sha256(key)]);
  if (!row) throw unauthorized('Invalid API key');
  if (!row.scopes.includes(scope)) throw forbidden(`API key lacks the "${scope}" scope`);
  req.apiKey = row;
};

export const purgeExpiredSessions = () =>
  q(pool, `DELETE FROM sessions WHERE expires_at < now() OR last_seen_at < now() - ($1 || ' milliseconds')::interval`, [String(config.sessionIdleMs)]);
