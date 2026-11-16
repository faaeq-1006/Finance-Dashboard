import nodemailer from 'nodemailer';
import { config } from '../config.js';
import { pool, q } from '../db.js';

/**
 * Outbox: alerts enqueue rows, this sender delivers them. Email goes through SMTP_URL,
 * SMS through SMS_WEBHOOK_URL (any gateway that accepts {to, body} JSON). With neither
 * configured, rows are marked "skipped" so nothing is silently lost or pretended sent.
 */
const mailer = config.smtpUrl ? nodemailer.createTransport(config.smtpUrl) : null;
export const channels = { email: !!mailer, sms: !!config.smsWebhookUrl };

async function deliver(n: { channel: string; recipient: string; subject: string; body: string }) {
  if (n.channel === 'email') {
    await mailer!.sendMail({ from: config.mailFrom, to: n.recipient, subject: n.subject, text: n.body });
  } else {
    const res = await fetch(config.smsWebhookUrl!, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...(config.smsWebhookToken ? { authorization: `Bearer ${config.smsWebhookToken}` } : {}) },
      body: JSON.stringify({ to: n.recipient, body: `${n.subject}. ${n.body}`.slice(0, 480) }),
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) throw new Error(`SMS gateway responded ${res.status}`);
  }
}

let running = false;
export async function processOutbox() {
  if (running) return;
  running = true;
  try {
    const batch = await q(pool, `SELECT * FROM notifications WHERE status = 'pending' OR (status = 'failed' AND attempts < 5) ORDER BY created_at LIMIT 50`);
    for (const n of batch) {
      if (!channels[n.channel as 'email' | 'sms']) {
        await pool.query(`UPDATE notifications SET status = 'skipped', last_error = $2 WHERE id = $1`, [n.id, `${n.channel} transport not configured`]);
        continue;
      }
      try {
        await deliver(n);
        await pool.query(`UPDATE notifications SET status = 'sent', sent_at = now(), attempts = attempts + 1, last_error = NULL WHERE id = $1`, [n.id]);
      } catch (err) {
        await pool.query(`UPDATE notifications SET status = 'failed', attempts = attempts + 1, last_error = $2 WHERE id = $1`, [n.id, String((err as Error).message).slice(0, 500)]);
      }
    }
  } finally {
    running = false;
  }
}
