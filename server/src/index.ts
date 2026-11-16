import { buildApp } from './app.js';
import { config } from './config.js';
import { migrate, pool } from './db.js';
import { purgeExpiredSessions } from './security/auth.js';
import { evaluateAlerts } from './services/alerts.js';
import { setAfterChange } from './services/hooks.js';
import { processOutbox } from './services/notify.js';
import { pollPrices } from './services/prices.js';

const applied = await migrate();
if (applied.length) console.log(`Applied migrations: ${applied.join(', ')}`);

setAfterChange(evaluateAlerts);
const app = await buildApp();
await app.listen({ port: config.port, host: config.host });

const safely = (name: string, fn: () => Promise<unknown>) => () => fn().catch((err) => app.log.error({ err }, `${name} failed`));
const timers = [
  setInterval(safely('price poll', pollPrices), config.pricePollMs),
  setInterval(safely('alert evaluation', evaluateAlerts), 15 * 60_000), // date-based reminders
  setInterval(safely('outbox', processOutbox), 60_000),
  setInterval(safely('session purge', purgeExpiredSessions), 10 * 60_000),
];
safely('alert evaluation', evaluateAlerts)();

let closing = false;
for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, async () => {
    if (closing) return;
    closing = true;
    timers.forEach(clearInterval);
    await app.close();
    await pool.end();
    process.exit(0);
  });
}
