/**
 * Demo data: the exact banks, portfolios, shares and loans from the requirements deck,
 * plus four users (one per role). Refuses to run on a database that already has users.
 */
import { SYSTEM } from './audit.js';
import { migrate, one, pool, q } from './db.js';
import { hashPassword } from './security/auth.js';
import { applyDirect } from './services/commands.js';

await migrate();
if (await one(pool, 'SELECT 1 FROM users LIMIT 1')) {
  console.log('Database already has users. Seed skipped.');
  await pool.end();
  process.exit(0);
}
if (process.env.NODE_ENV === 'production') {
  console.error('Refusing to seed demo users in production. Create the first administrator with a real password instead.');
  process.exit(1);
}

const PASSWORD = process.env.SEED_PASSWORD ?? 'Treasury-Demo-2026';
const hash = await hashPassword(PASSWORD);
for (const [email, name, role] of [['admin@demo.local', 'Aisha Admin', 'admin'], ['manager@demo.local', 'Mansour Manager', 'manager'], ['officer@demo.local', 'Omar Officer', 'officer'], ['auditor@demo.local', 'Amal Auditor', 'auditor']]) {
  await pool.query('INSERT INTO users(email, name, role, password_hash) VALUES ($1,$2,$3,$4)', [email, name, role, hash]);
}

const run = async (name: Parameters<typeof applyDirect>[0], payload: unknown) => (await applyDirect(name, payload, SYSTEM)).entityId;
const iso = (offsetDays: number) => new Date(Date.now() + offsetDays * 86_400_000).toISOString().slice(0, 10);

const sec: Record<string, string> = {};
for (const [symbol, name, price] of [['SHRA', 'Share A', '10'], ['SHRB', 'Share B', '15'], ['SHRC', 'Share C', '20'], ['SHRD', 'Share D', '25']]) {
  sec[symbol] = await run('security.save', { symbol, name });
  await run('price.manual', { security_id: sec[symbol], price });
}

const bankA = await run('bank.create', { name: 'Bank A', code: 'BKA', coverage_ratio: '150', margin_call_ratio: '110' });
const bankB = await run('bank.create', { name: 'Bank B', code: 'BKB', coverage_ratio: '130', top_up_ratio: '120', margin_call_ratio: '110' });
const bankC = await run('bank.create', { name: 'Bank C', code: 'BKC', coverage_ratio: '200', top_up_ratio: '180', margin_call_ratio: '160' });

const loan = (bank_id: string, loan_no: string, limit: string, used: string, maturityIn: number, rate: string) => run('loan.create', {
  bank_id, loan_no, facility_type: 'Murabaha', limit_amount: limit, used_amount: used, start_date: iso(-300), maturity_date: iso(maturityIn),
  review_date: iso(maturityIn - 45), rate_type: 'floating', rate_pct: rate, benchmark: 'SAIBOR 3M', margin_pct: '1.25',
});
const loan1 = await loan(bankA, 'Loan 1', '5000', '4000', 75, '6.85');
const loan2 = await loan(bankB, 'Loan 2', '3000', '1000', 180, '6.60');
const loan3 = await loan(bankC, 'Loan 3', '2000', '1750', 320, '7.10');

// The deck prices Share C at 20 for Bank A and 30 for Bank C (figures are illustrative). A share has one market
// price, so Bank C holds 150 Share C at 20 to give the same 3,000 value and the same coverage result as the deck.
const pledge = async (name: string, bank_id: string, loan_id: string, symbol: string, quantity: string) => {
  const portfolio_id = await run('portfolio.save', { name, bank_id, loan_id });
  await run('holding.set', { portfolio_id, security_id: sec[symbol], quantity });
};
await pledge('Portfolio A1', bankA, loan1, 'SHRA', '100');
await pledge('Portfolio A2', bankA, loan1, 'SHRB', '100');
await pledge('Portfolio A3', bankA, loan1, 'SHRC', '100');
await pledge('Portfolio B1', bankB, loan2, 'SHRA', '100');
await pledge('Portfolio B2', bankB, loan2, 'SHRB', '100');
await pledge('Portfolio C1', bankC, loan3, 'SHRC', '150');
await pledge('Portfolio C2', bankC, loan3, 'SHRD', '100');

for (const [loan_id, amount] of [[loan1, '68.50'], [loan2, '16.50'], [loan3, '31.06']]) {
  await run('charge.schedule', { loan_id, charge_type: 'profit', first_due_date: iso(5), months_between: 3, count: 4, amount });
}

// A little price history so charts are not empty on first run.
const secs = await q(pool, 'SELECT id, last_price FROM securities');
for (const s of secs) {
  await pool.query(
    `INSERT INTO prices(security_id, price, as_of, source)
     SELECT $1, round(($2::numeric * (1 + 0.04 * sin(n / 4.0) + (n - 30) * 0.0015))::numeric, 2), now() - make_interval(days => 30 - n), 'seed'
       FROM generate_series(0, 29) AS n`, [s.id, s.last_price]);
}

console.log(`Seeded demo data. Sign in with admin@demo.local, manager@demo.local, officer@demo.local or auditor@demo.local. Password: ${PASSWORD}`);
await pool.end();
