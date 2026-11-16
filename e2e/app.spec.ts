import { createHmac } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { chromium, type Browser, type BrowserContext, type Page } from 'playwright';
import ExcelJS from 'exceljs';
import pg from 'pg';

const BASE = process.env.E2E_BASE!;
const PASSWORD = 'Treasury-Demo-2026';
let browser: Browser;
const ctx: Record<string, BrowserContext> = {};
const page: Record<string, Page> = {};

async function signIn(role: string, email = `${role}@demo.local`, password = PASSWORD) {
  ctx[role] = await browser.newContext({ viewport: { width: 1440, height: 900 }, acceptDownloads: true });
  const p = (page[role] = await ctx[role].newPage());
  await p.goto(BASE);
  await p.fill('input[name=email]', email);
  await p.fill('input[name=password]', password);
  await p.click('button[type=submit]');
  return p;
}
/** Calls the API with this role's session cookie and CSRF token, as the browser app does. */
async function call(role: string, method: string, path: string, data?: unknown, csrf = true) {
  const me = await (await ctx[role].request.get(`${BASE}/api/auth/me`)).json();
  return ctx[role].request.fetch(BASE + path, { method, data, headers: csrf ? { 'x-csrf-token': me.csrf_token } : {} });
}
const loanRow = (p: Page, loan: string) => p.locator('tbody tr', { has: p.locator(`a:text-is("${loan}")`) }).first();
const ids: Record<string, string> = {};
function totp(secret: string) {
  const A = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
  let bits = '';
  for (const c of secret) bits += A.indexOf(c).toString(2).padStart(5, '0');
  const key = Buffer.from(bits.match(/.{8}/g)!.map((b) => parseInt(b, 2)));
  const counter = Buffer.alloc(8);
  counter.writeBigUInt64BE(BigInt(Math.floor(Date.now() / 30000)));
  const mac = createHmac('sha1', key).update(counter).digest();
  const o = mac[19] & 15;
  return String((mac.readUInt32BE(o) & 0x7fffffff) % 1e6).padStart(6, '0');
}

beforeAll(async () => { browser = await chromium.launch(); });
afterAll(async () => { await browser?.close(); });

describe('sign-in and session security', () => {
  it('rejects the API without a session', async () => {
    for (const path of ['/api/coverage', '/api/loans', '/api/audit', '/api/admin/users', '/api/reports/coverage.xlsx', '/api/stream']) {
      expect((await fetch(BASE + path)).status, path).toBe(401);
    }
    expect((await fetch(`${BASE}/api/v1/coverage`)).status).toBe(401);
  });
  it('rejects a wrong password with a generic message', async () => {
    const c = await browser.newContext();
    const p = await c.newPage();
    await p.goto(BASE);
    await p.fill('input[name=email]', 'officer@demo.local');
    await p.fill('input[name=password]', 'wrong-password-123A');
    await p.click('button[type=submit]');
    await p.getByText('Email or password is incorrect').waitFor();
    const unknown = await fetch(`${BASE}/api/auth/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email: 'nobody@demo.local', password: 'x' }) });
    expect((await unknown.json()).message).toBe('Email or password is incorrect');
    await c.close();
  });
  it('signs in each role', async () => {
    for (const role of ['officer', 'manager', 'admin', 'auditor']) {
      const p = await signIn(role);
      await p.getByRole('heading', { name: 'Dashboard' }).waitFor();
    }
    const cookie = (await ctx.officer.cookies()).find((c) => c.name.includes('bs_sid'))!;
    expect(cookie.httpOnly).toBe(true);
    expect(cookie.sameSite).toBe('Strict');
  });
  it('sends security headers and never caches API data', async () => {
    const res = await ctx.officer.request.get(`${BASE}/api/coverage`);
    expect(res.headers()['cache-control']).toBe('no-store');
    const html = await fetch(BASE);
    expect(html.headers.get('content-security-policy')).toContain("script-src 'self'");
    expect(html.headers.get('content-security-policy')).toContain("frame-ancestors 'none'");
    expect(html.headers.get('x-content-type-options')).toBe('nosniff');
  });
  it('blocks state changes without the CSRF token', async () => {
    const res = await call('officer', 'POST', '/api/commands/price.manual', { security_id: crypto.randomUUID(), price: '1' }, false);
    expect(res.status()).toBe(403);
  });
});

describe('coverage view matches the requirements deck', () => {
  it('shows Loan 1 short by 1,500 and the other two in surplus', async () => {
    const p = page.officer;
    await p.goto(`${BASE}/coverage`);
    await p.getByRole('heading', { name: 'Coverage view' }).waitFor();
    const l1 = loanRow(p, 'Loan 1');
    await expect.poll(() => l1.innerText()).toContain('6,000.00');
    expect(await l1.innerText()).toMatch(/-1,500\.00[\s\S]*Shortfall/);
    expect(await loanRow(p, 'Loan 2').innerText()).toMatch(/1,300\.00[\s\S]*\+1,200\.00[\s\S]*Covered/);
    expect(await loanRow(p, 'Loan 3').innerText()).toMatch(/3,500\.00[\s\S]*\+2,000\.00[\s\S]*Covered/);
    expect(await p.locator('tr.total', { hasText: 'Bank A total' }).innerText()).toMatch(/300[\s\S]*4,500\.00/);
    await p.getByText('Total shortfall across loans: 1,500.00').waitFor();
  });
  it('raised a critical shortfall alert for Loan 1', async () => {
    const alerts = await (await ctx.officer.request.get(`${BASE}/api/alerts`)).json();
    const a = alerts.find((x: any) => x.type === 'coverage');
    expect(a.severity).toBe('critical');
    expect(a.title).toBe('Coverage shortfall: Bank A Loan 1');
    expect(a.message).toContain('repay 1,000.00');
  });
  it('drills down from bank to loan to share', async () => {
    const p = page.officer;
    await p.locator('a:text-is("Loan 1")').first().click();
    await p.getByText('Shares backing this loan').waitFor();
    await p.getByText('To cure it, pledge eligible shares worth 1,500.00 or repay 1,000.00').waitFor();
    expect(await p.locator('tr', { hasText: 'Portfolio A3' }).innerText()).toMatch(/SHRC[\s\S]*100[\s\S]*20\.00[\s\S]*2,000\.00/);
    ids.loan1 = p.url().split('/').pop()!;
  });
});

describe('maker-checker approval', () => {
  it('rejects a drawdown above the limit when it is requested', async () => {
    const res = await call('officer', 'POST', '/api/commands/loan.transaction', { loan_id: ids.loan1, type: 'drawdown', amount: '1000.01', value_date: '2026-11-16' });
    expect(res.status()).toBe(400);
    expect((await res.json()).message).toContain('Available headroom is 1000.00');
  });
  it('holds an officer repayment until someone else approves it', async () => {
    const p = page.officer;
    await p.getByRole('button', { name: 'Repayment' }).click();
    await p.fill('input[name=amount]', '1000');
    await p.fill('input[name=reference]', 'E2E-REPAY-1');
    await p.getByRole('button', { name: 'Record' }).click();
    await p.getByText('Sent for approval').waitFor();
    const loan = await (await ctx.officer.request.get(`${BASE}/api/loans/${ids.loan1}`)).json();
    expect(loan.loan.used_amount).toBe('4000.00'); // nothing applied yet
    const pending = await (await ctx.officer.request.get(`${BASE}/api/approvals`)).json();
    ids.cr = pending[0].id;
    expect(pending[0].summary).toBe('Repayment of 1,000.00 on Loan 1 (Bank A)');
  });
  it('does not let the officer approve (no approval right)', async () => {
    const res = await call('officer', 'POST', `/api/approvals/${ids.cr}/decide`, { decision: 'approve' });
    expect(res.status()).toBe(403);
  });
  it('applies the change when the manager approves, and coverage updates', async () => {
    const p = page.manager;
    await p.goto(`${BASE}/approvals`);
    await p.getByText('Repayment of 1,000.00 on Loan 1 (Bank A)').waitFor();
    await p.getByRole('button', { name: 'Approve' }).click();
    await p.getByRole('button', { name: 'Approve and apply' }).click();
    await p.getByText('Approved and applied').waitFor();
    await p.goto(`${BASE}/coverage`);
    // 4,500 of shares against 3,000 x 150% = 4,500: exactly covered, inside the early-warning band.
    await expect.poll(() => loanRow(p, 'Loan 1').innerText()).toMatch(/3,000\.00[\s\S]*4,500\.00[\s\S]*0\.00[\s\S]*Early warning/);
  });
  it('shows the officer the result live, without a reload', async () => {
    const p = page.officer; // still on the Loan 1 page from before
    await p.getByText('Early warning: a fall of 0.0%').waitFor({ timeout: 10_000 });
    await p.getByRole('tab', { name: /Drawdowns & repayments \(2\)/ }).click();
    await p.getByText('E2E-REPAY-1').waitFor();
  });
  it('never lets anyone approve their own request', async () => {
    const req = await call('manager', 'POST', '/api/commands/loan.transaction', { loan_id: ids.loan1, type: 'drawdown', amount: '10', value_date: '2026-11-16' });
    const { change_request_id } = await req.json();
    const self = await call('manager', 'POST', `/api/approvals/${change_request_id}/decide`, { decision: 'approve' });
    expect(self.status()).toBe(403);
    expect((await self.json()).message).toContain('cannot decide your own request');
    const rejected = await call('admin', 'POST', `/api/approvals/${change_request_id}/decide`, { decision: 'reject', note: 'e2e' });
    expect((await rejected.json()).status).toBe('rejected');
    const again = await call('admin', 'POST', `/api/approvals/${change_request_id}/decide`, { decision: 'approve' });
    expect(again.status()).toBe(409); // cannot be decided twice
  });
});

describe('prices, simulation and allocation', () => {
  it('re-values coverage as soon as a price changes and keeps the history', async () => {
    const securities = await (await ctx.officer.request.get(`${BASE}/api/securities`)).json();
    ids.shra = securities.find((s: any) => s.symbol === 'SHRA').id;
    const p = page.manager; // on the coverage view
    const res = await call('officer', 'POST', '/api/commands/price.manual', { security_id: ids.shra, price: '9' });
    expect((await res.json()).status).toBe('applied');
    // Share A 100 x 9 = 900 -> Loan 1 collateral 4,400 vs 4,500 required.
    await expect.poll(() => loanRow(p, 'Loan 1').innerText(), { timeout: 10_000 }).toMatch(/-100\.00[\s\S]*Shortfall/);
    const history = await (await ctx.officer.request.get(`${BASE}/api/securities/${ids.shra}/prices?days=1`)).json();
    expect(history.at(-1)).toMatchObject({ price: '9.0000', source: 'manual' });
    await call('officer', 'POST', '/api/commands/price.manual', { security_id: ids.shra, price: '10' });
  });
  it('rejects invalid prices', async () => {
    for (const price of ['0', '-5', 'abc', '1e9', '1.123456']) {
      const res = await call('officer', 'POST', '/api/commands/price.manual', { security_id: ids.shra, price });
      expect(res.status(), price).toBe(400);
    }
  });
  it('what-if: a 30% fall shows the new shortfalls without changing real data', async () => {
    const p = page.officer;
    await p.goto(`${BASE}/simulation`);
    await p.getByRole('button', { name: '-30%' }).click();
    // Loan 1: 4,500 x 0.7 = 3,150 vs 4,500 -> -1,350. Loan 2: 1,750 vs 1,300 -> +450.
    await expect.poll(() => loanRow(p, 'Loan 1').innerText()).toMatch(/3,150\.00[\s\S]*-1,350\.00/);
    expect(await loanRow(p, 'Loan 2').innerText()).toMatch(/1,750\.00[\s\S]*\+450\.00/);
    const real = await (await ctx.officer.request.get(`${BASE}/api/coverage`)).json();
    expect(real.totals.collateral_value).toBe('12500.00');
  });
  it('allocation suggests surplus shares and a requested transfer needs approval', async () => {
    const p = page.officer;
    await p.goto(`${BASE}/allocation`);
    await p.getByText('Suggested moves').waitFor();
    expect(await loanRow(p, 'Loan 1').innerText()).toMatch(/450\.00[\s\S]*450\.00[\s\S]*0\.00/); // restore the 10% buffer on 4,500
    await p.getByRole('button', { name: 'Request transfer' }).first().click();
    await p.getByText('Sent for approval').waitFor();
    const pending = await (await ctx.manager.request.get(`${BASE}/api/approvals`)).json();
    expect(pending[0].command).toBe('holding.transfer');
    const ok = await call('manager', 'POST', `/api/approvals/${pending[0].id}/decide`, { decision: 'approve' });
    expect((await ok.json()).status).toBe('approved');
    const cov = await (await ctx.manager.request.get(`${BASE}/api/coverage`)).json();
    const loans = cov.banks.flatMap((b: any) => b.loans);
    expect(loans.find((l: any) => l.loan_no === 'Loan 1').status).toBe('ok');
    expect(loans.every((l: any) => l.status === 'ok')).toBe(true); // the donor loan was not put at risk
    expect(cov.totals.market_value).toBe('12500.00'); // shares moved, none created or lost
  });
});

describe('bank terms engine', () => {
  it('applies a bank term change to the coverage calculation once approved', async () => {
    const banks = await (await ctx.officer.request.get(`${BASE}/api/banks`)).json();
    const b = banks.find((x: any) => x.name === 'Bank B');
    const req = await call('officer', 'POST', '/api/commands/bank.update', { id: b.id, name: b.name, code: b.code, coverage_ratio: '300', top_up_ratio: null, margin_call_ratio: null });
    const { change_request_id } = await req.json();
    await call('manager', 'POST', `/api/approvals/${change_request_id}/decide`, { decision: 'approve' });
    const cov = await (await ctx.officer.request.get(`${BASE}/api/coverage`)).json();
    const loan2 = cov.banks.find((x: any) => x.name === 'Bank B').loans[0];
    expect(loan2.coverage_required).toBe('3000.00');
    expect(loan2.status).toBe('shortfall');
    ids.loan2 = loan2.id;
  });
  it('lets one loan carry its own terms, different from its bank', async () => {
    const { loan } = await (await ctx.officer.request.get(`${BASE}/api/loans/${ids.loan2}`)).json();
    const req = await call('officer', 'POST', '/api/commands/loan.update', { ...loan, coverage_ratio: '130' });
    await call('manager', 'POST', `/api/approvals/${(await req.json()).change_request_id}/decide`, { decision: 'approve' });
    const cov = await (await ctx.officer.request.get(`${BASE}/api/coverage`)).json();
    const loan2 = cov.banks.find((x: any) => x.name === 'Bank B').loans[0];
    expect(loan2).toMatchObject({ coverage_ratio: '130.00', terms_source: 'loan', coverage_required: '1300.00', status: 'ok' });
  });
  it('refuses inconsistent levels (margin call above coverage)', async () => {
    const banks = await (await ctx.officer.request.get(`${BASE}/api/banks`)).json();
    const b = banks[0];
    const res = await call('officer', 'POST', '/api/commands/bank.update', { id: b.id, name: b.name, code: b.code, coverage_ratio: '150', margin_call_ratio: '160' });
    expect(res.status()).toBe(400);
  });
});

describe('loan documents', () => {
  const pdf = (text: string) => Buffer.from(`%PDF-1.4\n% ${text}\n%%EOF\n`);
  it('uploads a document, adds a version, and downloads the exact bytes', async () => {
    const p = page.officer;
    await p.goto(`${BASE}/loans/${ids.loan1}`);
    await p.getByRole('tab', { name: /Documents/ }).click();
    await p.getByRole('button', { name: 'Upload document' }).click();
    await p.fill('input[name=title]', 'Facility agreement');
    await p.fill('input[name=expiry_date]', new Date(Date.now() + 5 * 86400000).toISOString().slice(0, 10));
    await p.setInputFiles('input[name=file]', { name: 'agreement.pdf', mimeType: 'application/pdf', buffer: pdf('version one') });
    await p.getByRole('button', { name: 'Upload', exact: true }).click();
    await p.getByText('v1 agreement.pdf').waitFor();
    await p.getByText('5d left').waitFor(); // expiry reminder badge

    await p.getByRole('button', { name: 'New version' }).click();
    await p.fill('input[name=note]', 'Signed copy');
    await p.setInputFiles('input[name=file]', { name: 'agreement-signed.pdf', mimeType: 'application/pdf', buffer: pdf('version two') });
    await p.getByRole('button', { name: 'Upload', exact: true }).click();
    await p.getByText('v2 agreement-signed.pdf').waitFor();
    await p.getByText('v1 agreement.pdf').waitFor(); // the earlier version is kept

    const { documents } = await (await ctx.officer.request.get(`${BASE}/api/loans/${ids.loan1}`)).json();
    ids.doc = documents[0].id;
    const v1 = await ctx.officer.request.get(`${BASE}/api/documents/${ids.doc}/versions/1/download`);
    expect(Buffer.compare(await v1.body(), pdf('version one'))).toBe(0);
    expect(v1.headers()['content-disposition']).toContain('attachment');
    const alerts = await (await ctx.officer.request.get(`${BASE}/api/alerts`)).json();
    expect(alerts.some((a: any) => a.type === 'document' && a.title.includes('Facility agreement'))).toBe(true);
  });
  it('stores documents encrypted on disk', async () => {
    const { readdirSync, readFileSync } = await import('node:fs');
    const dir = '../storage/test-documents';
    const files = readdirSync(new URL(dir, import.meta.url));
    expect(files.length).toBe(2);
    for (const f of files) expect(readFileSync(new URL(`${dir}/${f}`, import.meta.url)).includes('%PDF')).toBe(false);
  });
  it('refuses disguised and disallowed files', async () => {
    const me = await (await ctx.officer.request.get(`${BASE}/api/auth/me`)).json();
    const send = (name: string, buffer: Buffer) => ctx.officer.request.post(`${BASE}/api/loans/${ids.loan1}/documents`, { headers: { 'x-csrf-token': me.csrf_token }, multipart: { title: 'x', file: { name, mimeType: 'application/pdf', buffer } } });
    expect((await send('malware.exe', Buffer.from('MZ...'))).status()).toBe(400);
    expect((await send('fake.pdf', Buffer.from('<html><script>alert(1)</script>'))).status()).toBe(400);
    expect((await send('../../etc/passwd.pdf', pdf('x'))).status()).toBe(200); // accepted, but the name is reduced to its base name
    const { documents } = await (await ctx.officer.request.get(`${BASE}/api/loans/${ids.loan1}`)).json();
    expect(documents.flatMap((d: any) => d.versions).every((v: any) => !v.filename.includes('/'))).toBe(true);
  });
});

describe('roles and permissions', () => {
  it('auditor can read everything, including the audit trail, but change nothing', async () => {
    const p = page.auditor;
    await p.goto(`${BASE}/loans/${ids.loan1}`);
    await p.getByText('Shares backing this loan').waitFor();
    expect(await p.getByRole('button', { name: 'Drawdown' }).count()).toBe(0);
    expect(await p.getByRole('button', { name: 'Edit' }).count()).toBe(0);
    await p.goto(`${BASE}/audit`);
    await p.getByRole('heading', { name: 'Audit trail' }).waitFor();
    for (const [method, path, body] of [
      ['POST', '/api/commands/loan.transaction', { loan_id: ids.loan1, type: 'drawdown', amount: '1', value_date: '2026-11-16' }],
      ['POST', '/api/commands/price.manual', { security_id: ids.shra, price: '1' }],
      ['POST', `/api/alerts/${crypto.randomUUID()}/ack`, {}],
      ['PUT', `/api/documents/${ids.doc}`, { title: 'x', category: 'other', expiry_date: null }],
      ['GET', '/api/admin/users', undefined], ['PUT', '/api/admin/settings', {}],
    ] as const) expect((await call('auditor', method, path, body)).status(), path).toBe(403);
  });
  it('officer cannot reach the audit trail or administration', async () => {
    for (const path of ['/api/audit', '/api/audit/export.csv', '/api/admin/users', '/api/admin/api-keys', '/api/notifications']) {
      expect((await call('officer', 'GET', path)).status(), path).toBe(403);
    }
    const p = page.officer;
    await p.goto(`${BASE}/admin`);
    await p.getByRole('heading', { name: 'Dashboard' }).waitFor(); // redirected away
    expect(await p.getByRole('link', { name: 'Administration' }).count()).toBe(0);
  });
  it('never returns password hashes or MFA secrets', async () => {
    const body = await (await call('admin', 'GET', '/api/admin/users')).text();
    expect(body).not.toMatch(/password_hash|totp_secret|argon2/);
  });
});

describe('audit trail', () => {
  it('records who changed what, with before and after', async () => {
    const rows = await (await call('auditor', 'GET', '/api/audit?action=loan.transaction')).json();
    const r = rows.find((x: any) => x.after?.transaction?.reference === 'E2E-REPAY-1');
    expect(r.actor_label).toBe('manager@demo.local'); // the approver applied it
    expect(r.before.used_amount).toBe('4000.00');
    expect(r.after.used_amount).toBe('3000.00');
    const failed = await (await call('auditor', 'GET', '/api/audit?action=auth.login_failed')).json();
    expect(failed.length).toBeGreaterThanOrEqual(2);
  });
  it('verifies as an intact chain, and the database refuses edits and deletes', async () => {
    expect(await (await call('auditor', 'GET', '/api/audit/verify')).json()).toMatchObject({ ok: true });
    const db = new pg.Client({ connectionString: process.env.DATABASE_URL });
    await db.connect();
    await expect(db.query(`UPDATE audit_log SET actor_label = 'nobody' WHERE id = 1`)).rejects.toThrow('append-only');
    await expect(db.query('DELETE FROM audit_log')).rejects.toThrow('append-only');
    await expect(db.query('TRUNCATE audit_log')).rejects.toThrow('append-only');
    // If someone with superuser rights bypassed the trigger, verification would catch it:
    await db.query('ALTER TABLE audit_log DISABLE TRIGGER audit_log_no_change').catch(() => {});
    const tampered = await db.query(`UPDATE audit_log SET after = '{"used_amount":"1.00"}' WHERE id = 5`).then(() => true).catch(() => false);
    if (tampered) {
      expect(await (await call('auditor', 'GET', '/api/audit/verify')).json()).toMatchObject({ ok: false, broken_at_id: '5' });
    }
    await db.end();
  });
});

describe('administration', () => {
  it('forces a new user to replace the temporary password', async () => {
    const weak = await call('admin', 'POST', '/api/admin/users', { email: 'new.user@demo.local', name: 'New User', role: 'officer', password: 'short' });
    expect(weak.status()).toBe(400);
    const p = page.admin;
    await p.goto(`${BASE}/admin`);
    await p.getByRole('button', { name: 'New user' }).click();
    await p.fill('input[name=name]', 'New User');
    await p.fill('input[name=email]', 'new.user@demo.local');
    await p.fill('input[name=password]', 'Temp-Password-4821');
    await p.getByRole('button', { name: 'Save' }).click();
    await p.getByText('temporary password').waitFor();

    const u = await signIn('newuser', 'new.user@demo.local', 'Temp-Password-4821');
    await u.getByRole('heading', { name: 'Choose a new password' }).waitFor();
    expect((await call('newuser', 'GET', '/api/coverage')).status()).toBe(403); // locked out of data until changed
    await u.fill('input[name=current_password]', 'Temp-Password-4821');
    await u.fill('input[name=new_password]', 'My-Own-Password-7753');
    await u.fill('input[name=confirm]', 'My-Own-Password-7753');
    await u.getByRole('button', { name: 'Change password' }).click();
    await u.getByRole('heading', { name: 'Dashboard' }).waitFor();
  });
  it('two-step verification: required at sign-in once turned on', async () => {
    const u = page.newuser;
    await u.goto(`${BASE}/account`);
    await u.getByRole('button', { name: 'Set up' }).click();
    const secret = (await u.getByTestId('totp-secret').innerText()).trim();
    await u.fill('input[name=code]', totp(secret));
    await u.getByRole('button', { name: 'Turn on' }).click();
    await u.getByText('Two-step verification is on').waitFor();
    await ctx.newuser.close();

    const c = await browser.newContext();
    const p = await c.newPage();
    await p.goto(BASE);
    await p.fill('input[name=email]', 'new.user@demo.local');
    await p.fill('input[name=password]', 'My-Own-Password-7753');
    await p.click('button[type=submit]');
    await p.fill('input[name=totp]', '000000');
    await p.getByRole('button', { name: 'Verify' }).click();
    await p.getByText('Authenticator code is incorrect').waitFor();
    expect((await c.request.get(`${BASE}/api/coverage`)).status()).toBe(401); // password alone is not enough
    await p.fill('input[name=totp]', totp(secret));
    await p.getByRole('button', { name: 'Verify' }).click();
    await p.getByRole('heading', { name: 'Dashboard' }).waitFor();
    await c.close();
  });
  it('locks an account after repeated wrong passwords', async () => {
    const attempt = () => fetch(`${BASE}/api/auth/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email: 'new.user@demo.local', password: 'Wrong-Password-0000' }) });
    for (let i = 0; i < 5; i++) expect((await attempt()).status).toBe(401);
    expect((await attempt()).status).toBe(429);
    const right = await fetch(`${BASE}/api/auth/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email: 'new.user@demo.local', password: 'My-Own-Password-7753' }) });
    expect(right.status).toBe(429); // still locked even with the right password
  });
  it('integration API: scoped keys read coverage and push prices; revoked keys stop working', async () => {
    const p = page.admin;
    await p.goto(`${BASE}/admin`);
    await p.getByRole('tab', { name: 'API keys' }).click();
    await p.getByRole('button', { name: 'New API key' }).click();
    await p.fill('input[name=name]', 'ERP read only');
    await p.getByRole('button', { name: 'Create key' }).click();
    const readKey = (await p.getByTestId('api-key').innerText()).trim();
    await p.getByRole('button', { name: 'Done' }).click();
    const v1 = (path: string, key: string, init: RequestInit = {}) => fetch(`${BASE}/api/v1${path}`, { ...init, headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json' } });

    const cov = await (await v1('/coverage', readKey)).json();
    expect(cov.totals.used_amount).toBe('5750.00');
    expect((await (await v1('/loans', readKey)).json()).length).toBe(3);
    const push = { method: 'POST', body: JSON.stringify({ source: 'e2e-feed', quotes: [{ symbol: 'SHRD', price: '26.5' }, { symbol: 'NOPE', price: '1' }] }) };
    expect((await v1('/prices', readKey, push)).status).toBe(403); // read-only key cannot write

    const made = await (await call('admin', 'POST', '/api/admin/api-keys', { name: 'Market data', scopes: ['prices:write'] })).json();
    expect(await (await v1('/prices', made.key, push)).json()).toEqual({ accepted: 1, unknown: ['NOPE'] });
    const after = await (await v1('/prices', readKey)).json();
    expect(after.find((x: any) => x.symbol === 'SHRD')).toMatchObject({ price: '26.5000', source: 'e2e-feed' });
    expect((await v1('/coverage', made.key)).status).toBe(403); // write-only key cannot read

    expect((await call('admin', 'DELETE', `/api/admin/api-keys/${made.id}`)).status()).toBe(200);
    expect((await v1('/prices', made.key, push)).status).toBe(401);
    expect((await v1('/coverage', 'bsk_not-a-real-key')).status).toBe(401);
    const stored = await (await call('admin', 'GET', '/api/admin/api-keys')).text();
    expect(stored).not.toContain(readKey.slice(14)); // only a prefix is ever shown again
  });
});

describe('reports and layout', () => {
  it('exports the coverage workbook with the same numbers as the screen', async () => {
    const res = await ctx.manager.request.get(`${BASE}/api/reports/coverage.xlsx`);
    expect(res.status()).toBe(200);
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(await res.body() as any);
    const ws = wb.getWorksheet('Coverage')!;
    const cells: any[] = [];
    ws.eachRow((r) => r.eachCell((c) => cells.push(c.value)));
    expect(cells).toContain('Bank A total');
    expect(cells).toContain(5750); // total borrowed
    expect(wb.getWorksheet('Loan register')!.rowCount).toBe(4);
  });
  it('produces the management report and bank statement as PDF', async () => {
    const banks = await (await ctx.manager.request.get(`${BASE}/api/banks`)).json();
    for (const path of ['/api/reports/management.pdf', `/api/reports/bank-statement/${banks[0].id}.pdf`]) {
      const res = await ctx.manager.request.get(BASE + path);
      expect(res.status()).toBe(200);
      expect((await res.body()).subarray(0, 5).toString()).toBe('%PDF-');
    }
  });
  it('fits a phone screen without sideways scrolling', async () => {
    const c = await browser.newContext({ viewport: { width: 390, height: 844 } });
    const p = await c.newPage();
    await p.goto(BASE);
    await p.fill('input[name=email]', 'auditor@demo.local');
    await p.fill('input[name=password]', PASSWORD);
    await p.click('button[type=submit]');
    await p.getByRole('heading', { name: 'Dashboard' }).waitFor();
    for (const path of ['/', '/coverage', '/loans', `/loans/${ids.loan1}`, '/simulation', '/key-dates']) {
      await p.goto(BASE + path);
      await p.locator('h1').first().waitFor();
      await p.waitForTimeout(300);
      const overflow = await p.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
      expect(overflow, path).toBeLessThanOrEqual(1);
    }
    await p.getByRole('button', { name: 'Menu' }).click();
    await p.getByRole('link', { name: 'Alerts' }).click();
    await p.getByRole('heading', { name: 'Alerts' }).waitFor();
    await c.close();
  });
  it('signing out ends the session on the server', async () => {
    const cookies = await ctx.auditor.cookies();
    await page.auditor.goto(BASE);
    await page.auditor.getByRole('button', { name: 'Sign out' }).click();
    await page.auditor.locator('input[name=password]').waitFor();
    const replay = await fetch(`${BASE}/api/coverage`, { headers: { cookie: cookies.map((c) => `${c.name}=${c.value}`).join('; ') } });
    expect(replay.status).toBe(401); // the old cookie is dead, not just forgotten by the browser
  });
});
