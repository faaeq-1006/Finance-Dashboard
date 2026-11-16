// Runs the end-to-end suite against a throwaway database:
// reset schema -> seed deck data -> start the built app -> drive it in Chromium -> stop.
import { execFileSync, spawn } from 'node:child_process';
import { existsSync, openSync, rmSync } from 'node:fs';
import pg from 'pg';

if (!existsSync('.env.test')) { console.error('Create .env.test (see README, "Tests") pointing at a disposable database.'); process.exit(1); }
if (!existsSync('web/dist/index.html')) { console.error('Run "npm run build" first.'); process.exit(1); }
process.loadEnvFile('.env.test');
if (!/test/.test(new URL(process.env.DATABASE_URL).pathname)) { console.error('Refusing to wipe a database whose name does not contain "test".'); process.exit(1); }

const db = new pg.Client({ connectionString: process.env.DATABASE_URL });
await db.connect();
await db.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public;');
await db.end();
rmSync(process.env.UPLOAD_DIR, { recursive: true, force: true });
execFileSync('npx', ['tsx', '--env-file=.env.test', 'server/src/seed.ts'], { stdio: 'inherit' });

const server = spawn('npx', ['tsx', '--env-file=.env.test', 'server/src/index.ts'], { stdio: ['ignore', openSync('e2e/server.log', 'w'), 'inherit'], detached: true });
const base = `http://localhost:${process.env.PORT}`;
let up = false;
for (let i = 0; i < 60 && !up; i++) {
  await new Promise((r) => setTimeout(r, 500));
  up = await fetch(`${base}/api/health`).then((r) => r.ok).catch(() => false);
}
let code = 1;
try {
  if (!up) throw new Error('Server did not start');
  execFileSync('npx', ['vitest', 'run', '--config', 'e2e/vitest.config.ts', ...process.argv.slice(2)], { stdio: 'inherit', env: { ...process.env, E2E_BASE: base } });
  code = 0;
} catch (err) {
  if (!up) console.error(err.message);
} finally {
  try { process.kill(-server.pid, 'SIGTERM'); } catch {}
}
process.exit(code);
