import { pool, q, type Db } from '../db.js';

export interface Settings {
  require_approval: boolean;
  warn_buffer_pct: number;
  maturity_reminder_days: number[];
  review_reminder_days: number[];
  charge_reminder_days: number[];
  document_expiry_reminder_days: number[];
}
export async function getSettings(db: Db = pool): Promise<Settings> {
  const rows = await q<{ key: string; value: unknown }>(db, 'SELECT key, value FROM settings');
  return Object.fromEntries(rows.map((r) => [r.key, r.value])) as unknown as Settings;
}
