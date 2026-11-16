import type pg from 'pg';
import { sha256 } from './security/crypto.js';
import { pool, tx } from './db.js';

export interface Actor {
  type: 'user' | 'api_key' | 'system';
  id: string | null;
  label: string;
  ip?: string;
  role?: string;
}
export const SYSTEM: Actor = { type: 'system', id: null, label: 'system' };

export interface AuditEntry {
  action: string;
  entityType?: string;
  entityId?: string;
  before?: unknown;
  after?: unknown;
  meta?: unknown;
}

// Stable JSON so the hash is reproducible when the chain is verified.
export function canonical(value: unknown): string {
  if (value === null || value === undefined) return 'null';
  if (value instanceof Date) return JSON.stringify(value.toISOString());
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (typeof value === 'object') {
    const obj = value as Record<string, unknown>;
    return `{${Object.keys(obj).sort().map((k) => `${JSON.stringify(k)}:${canonical(obj[k])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

function entryHash(prev: string, row: Record<string, unknown>): string {
  return sha256(prev + canonical(row));
}

/** Writes one audit row inside the caller's transaction, chained to the previous row. */
export async function audit(client: pg.PoolClient, actor: Actor, e: AuditEntry): Promise<void> {
  await client.query('SELECT pg_advisory_xact_lock(7001)');
  const last = (await client.query('SELECT hash FROM audit_log ORDER BY id DESC LIMIT 1')).rows[0];
  const prev = last?.hash ?? 'GENESIS';
  const at = new Date();
  const row = {
    at: at.toISOString(), actor_type: actor.type, actor_id: actor.id, actor_label: actor.label, action: e.action,
    entity_type: e.entityType ?? null, entity_id: e.entityId ?? null,
    before: e.before ?? null, after: e.after ?? null, meta: e.meta ?? null, ip: actor.ip ?? null,
  };
  // Round-trip through JSON so the hashed form equals what jsonb will give back.
  const normalised = JSON.parse(JSON.stringify(row));
  await client.query(
    `INSERT INTO audit_log(at, actor_type, actor_id, actor_label, action, entity_type, entity_id, before, after, meta, ip, prev_hash, hash)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)`,
    [at, row.actor_type, row.actor_id, row.actor_label, row.action, row.entity_type, row.entity_id,
      JSON.stringify(normalised.before), JSON.stringify(normalised.after), JSON.stringify(normalised.meta), row.ip, prev, entryHash(prev, normalised)],
  );
}

export const auditNow = (actor: Actor, e: AuditEntry) => tx((c) => audit(c, actor, e));

/** Recomputes the whole chain; reports the first row that does not match. */
export async function verifyAuditChain(): Promise<{ ok: boolean; rows: number; broken_at_id?: string }> {
  const client = await pool.connect();
  try {
    let prev = 'GENESIS';
    let lastId = '0';
    let count = 0;
    for (;;) {
      const { rows } = await client.query('SELECT * FROM audit_log WHERE id > $1 ORDER BY id LIMIT 2000', [lastId]);
      if (!rows.length) break;
      for (const r of rows) {
        const row = {
          at: r.at.toISOString(), actor_type: r.actor_type, actor_id: r.actor_id, actor_label: r.actor_label, action: r.action,
          entity_type: r.entity_type, entity_id: r.entity_id, before: r.before, after: r.after, meta: r.meta, ip: r.ip,
        };
        if (r.prev_hash !== prev || r.hash !== entryHash(prev, row)) return { ok: false, rows: count, broken_at_id: String(r.id) };
        prev = r.hash;
        lastId = r.id;
        count++;
      }
    }
    return { ok: true, rows: count };
  } finally {
    client.release();
  }
}
