import { useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { api, dateTime } from '../api';
import { Badge, Card, Confirm, Empty, ErrorBox, Field, Form, Loading, Modal, Page, Tabs, useMe, useToast } from '../ui';

const ROLES: [string, string][] = [['admin', 'Administrator: everything, including users and settings'], ['manager', 'Manager: enters and approves changes'], ['officer', 'Officer: enters changes, cannot approve'], ['auditor', 'Auditor: read-only, including the audit trail']];

function Users() {
  const qc = useQueryClient();
  const [modal, setModal] = useState<{ u?: any } | null>(null);
  const { data, error, isPending } = useQuery({ queryKey: ['users'], queryFn: () => api('/api/admin/users') });
  if (isPending) return <Loading />;
  if (error) return <ErrorBox error={error} />;
  const u = modal?.u;
  return (
    <Card flush title="Users" actions={<button className="btn sm primary" onClick={() => setModal({})}>New user</button>}>
      <div className="table-wrap"><table>
        <thead><tr><th>Name</th><th>Email</th><th>Role</th><th>Two-step verification</th><th>Last sign-in</th><th>Status</th><th /></tr></thead>
        <tbody>{data.map((x: any) => (
          <tr key={x.id}><td>{x.name}</td><td>{x.email}</td><td style={{ textTransform: 'capitalize' }}>{x.role}</td><td>{x.totp_enabled ? <Badge tone="ok">on</Badge> : <Badge tone="watch">off</Badge>}</td><td>{dateTime(x.last_login_at)}</td>
            <td>{!x.active ? <Badge tone="neutral">disabled</Badge> : x.locked_until && new Date(x.locked_until) > new Date() ? <Badge tone="bad">locked</Badge> : x.must_change_password ? <Badge tone="info">temporary password</Badge> : <Badge tone="ok">active</Badge>}</td>
            <td className="num"><button className="btn sm" onClick={() => setModal({ u: x })}>Edit</button></td></tr>))}</tbody>
      </table></div>
      {modal && <Modal title={u ? `Edit ${u.name}` : 'New user'} onClose={() => setModal(null)}>
        <Form onCancel={() => setModal(null)} onSubmit={async (v) => {
          if (u) await api(`/api/admin/users/${u.id}`, { method: 'PUT', json: { name: v.name, role: v.role, active: v.active === 'on', unlock: v.unlock === 'on', reset_mfa: v.reset_mfa === 'on', new_password: v.new_password || '' } });
          else await api('/api/admin/users', { json: { name: v.name, email: v.email, role: v.role, password: v.password } });
          await qc.invalidateQueries();
          setModal(null);
        }}>
          <div className="form-grid">
            <Field label="Full name"><input name="name" required defaultValue={u?.name} /></Field>
            {!u && <Field label="Email"><input name="email" type="email" required autoComplete="off" /></Field>}
            <Field label="Role" full><select name="role" defaultValue={u?.role ?? 'officer'}>{ROLES.map(([r, l]) => <option key={r} value={r}>{l}</option>)}</select></Field>
            {u ? <>
              <Field label="Set a new temporary password (optional)" hint="At least 12 characters with upper-case, lower-case and a number. The user must change it at next sign-in." full><input name="new_password" type="password" autoComplete="new-password" /></Field>
              <label className="full"><input type="checkbox" name="active" defaultChecked={u.active} />Account is active</label>
              <label className="full"><input type="checkbox" name="unlock" />Unlock after failed sign-in attempts</label>
              <label className="full"><input type="checkbox" name="reset_mfa" />Reset two-step verification (lost phone)</label>
            </> : <Field label="Temporary password" hint="At least 12 characters with upper-case, lower-case and a number. The user must change it at first sign-in." full><input name="password" type="password" required autoComplete="new-password" /></Field>}
          </div>
        </Form></Modal>}
    </Card>
  );
}

function ApiKeys() {
  const qc = useQueryClient();
  const [modal, setModal] = useState<any>(null);
  const { data, error, isPending } = useQuery({ queryKey: ['api-keys'], queryFn: () => api('/api/admin/api-keys') });
  if (isPending) return <Loading />;
  if (error) return <ErrorBox error={error} />;
  return (
    <Card flush title="API keys for other systems" actions={<><a className="btn sm" href="/api/v1/openapi.json" target="_blank" rel="noreferrer">API specification</a><button className="btn sm primary" onClick={() => setModal({ kind: 'new' })}>New API key</button></>}>
      <div className="card-body" style={{ paddingBottom: 0 }}><p className="muted" style={{ margin: 0 }}>Accounting, treasury and custody systems use these keys to read loans, holdings and coverage, and to push share prices. Base address: <span className="mono">/api/v1</span>. Send the key as <span className="mono">Authorization: Bearer …</span></p></div>
      <div className="table-wrap"><table>
        <thead><tr><th>Name</th><th>Key starts with</th><th>Access</th><th>Created</th><th>Last used</th><th>Status</th><th /></tr></thead>
        <tbody>{data.map((k: any) => (
          <tr key={k.id}><td>{k.name}</td><td className="mono">{k.prefix}…</td><td>{k.scopes.map((s: string) => <Badge key={s} tone="neutral">{s === 'read' ? 'read data' : 'push prices'}</Badge>)}</td><td>{dateTime(k.created_at)}<div className="muted small">{k.created_by}</div></td><td>{dateTime(k.last_used_at)}</td>
            <td>{k.revoked_at ? <Badge tone="neutral">revoked</Badge> : <Badge tone="ok">active</Badge>}</td><td className="num">{!k.revoked_at && <button className="btn sm danger" onClick={() => setModal({ kind: 'revoke', k })}>Revoke</button>}</td></tr>))}
          {!data.length && <tr><td colSpan={7}><Empty>No API keys yet.</Empty></td></tr>}</tbody>
      </table></div>
      {modal?.kind === 'new' && <Modal title="New API key" onClose={() => setModal(null)}>
        <Form onCancel={() => setModal(null)} submit="Create key" onSubmit={async (v) => {
          const scopes = [v.read === 'on' && 'read', v.prices === 'on' && 'prices:write'].filter(Boolean);
          if (!scopes.length) throw new Error('Choose at least one kind of access');
          const r = await api('/api/admin/api-keys', { json: { name: v.name, scopes } });
          await qc.invalidateQueries();
          setModal({ kind: 'show', key: r.key });
        }}>
          <div className="grid">
            <Field label="Name of the system using this key"><input name="name" required maxLength={80} placeholder="e.g. ERP general ledger" /></Field>
            <label><input type="checkbox" name="read" defaultChecked />Read loans, holdings, prices and coverage</label>
            <label><input type="checkbox" name="prices" />Push share prices</label>
          </div>
        </Form></Modal>}
      {modal?.kind === 'show' && <Modal title="Copy this key now" onClose={() => setModal(null)}>
        <div className="warn">This is the only time the key is shown. Store it in the other system's secret store.</div>
        <pre className="json" data-testid="api-key">{modal.key}</pre>
        <div className="form-actions"><button className="btn" onClick={() => navigator.clipboard?.writeText(modal.key)}>Copy</button><button className="btn primary" onClick={() => setModal(null)}>Done</button></div>
      </Modal>}
      {modal?.kind === 'revoke' && <Confirm title="Revoke API key" danger action="Revoke" text={`Revoke "${modal.k.name}"? The system using it loses access immediately. This cannot be undone.`} onClose={() => setModal(null)}
        onConfirm={async () => { await api(`/api/admin/api-keys/${modal.k.id}`, { method: 'DELETE' }); await qc.invalidateQueries(); }} />}
    </Card>
  );
}

function Settings() {
  const qc = useQueryClient();
  const toast = useToast();
  const { data, error, isPending } = useQuery({ queryKey: ['settings'], queryFn: () => api('/api/settings') });
  const notifications = useQuery({ queryKey: ['notifications'], queryFn: () => api('/api/notifications') });
  if (isPending) return <Loading />;
  if (error) return <ErrorBox error={error} />;
  const list = (s: string) => s.split(',').map((x) => Number(x.trim())).filter((n) => Number.isInteger(n) && n >= 0);
  return (
    <>
      <Card title="Controls and reminders">
        <Form submit="Save settings" onSubmit={async (v) => {
          await api('/api/admin/settings', { method: 'PUT', json: {
            require_approval: v.require_approval === 'on', warn_buffer_pct: Number(v.warn_buffer_pct), maturity_reminder_days: list(v.maturity), review_reminder_days: list(v.review), charge_reminder_days: list(v.charge), document_expiry_reminder_days: list(v.document),
          } });
          await qc.invalidateQueries();
          toast('Settings saved');
        }}>
          <div className="form-grid">
            <label className="full"><input type="checkbox" name="require_approval" defaultChecked={data.require_approval} /><strong>Require a second person to approve</strong> changes to loans, bank terms, pledges and share positions</label>
            <Field label="Early-warning buffer %" hint="Warn when a loan's coverage is within this percentage above its requirement."><input name="warn_buffer_pct" type="number" min={0} max={100} step="0.5" required defaultValue={data.warn_buffer_pct} /></Field>
            <Field label="Loan maturity reminders (days before)"><input name="maturity" required defaultValue={data.maturity_reminder_days.join(', ')} /></Field>
            <Field label="Review and renewal reminders (days before)"><input name="review" required defaultValue={data.review_reminder_days.join(', ')} /></Field>
            <Field label="Finance charge reminders (days before)"><input name="charge" required defaultValue={data.charge_reminder_days.join(', ')} /></Field>
            <Field label="Document expiry reminders (days before)"><input name="document" required defaultValue={data.document_expiry_reminder_days.join(', ')} /></Field>
          </div>
        </Form>
      </Card>
      <Card title="System connections">
        <dl className="kv">
          <div><dt>Price feed</dt><dd>{data.system.price_feed.provider === 'simulated' ? <Badge tone="watch">simulated (demo)</Badge> : <Badge tone="info">manual entry and API push</Badge>}</dd></div>
          <div><dt>Last feed run</dt><dd>{dateTime(data.system.price_feed.last_run_at)}</dd></div>
          <div><dt>Email delivery</dt><dd>{data.system.channels.email ? <Badge tone="ok">connected</Badge> : <Badge tone="neutral">not configured</Badge>}</dd></div>
          <div><dt>SMS delivery</dt><dd>{data.system.channels.sms ? <Badge tone="ok">connected</Badge> : <Badge tone="neutral">not configured</Badge>}</dd></div>
        </dl>
        <p className="muted small" style={{ marginBottom: 0 }}>These are set on the server (price feed, SMTP and SMS gateway), not from this screen.</p>
      </Card>
      <Card title="Notification log" flush>
        <div className="table-wrap"><table><thead><tr><th>Created</th><th>Channel</th><th>To</th><th>Subject</th><th>Status</th></tr></thead>
          <tbody>{(notifications.data?.items ?? []).slice(0, 50).map((n: any) => <tr key={n.id}><td style={{ whiteSpace: 'nowrap' }}>{dateTime(n.created_at)}</td><td>{n.channel}</td><td>{n.recipient}</td><td>{n.subject}</td><td><Badge tone={n.status === 'sent' ? 'ok' : n.status === 'failed' ? 'bad' : 'neutral'}>{n.status}</Badge>{n.last_error && <div className="muted small">{n.last_error}</div>}</td></tr>)}
            {!notifications.data?.items.length && <tr><td colSpan={5}><Empty>No notifications yet.</Empty></td></tr>}</tbody></table></div>
      </Card>
    </>
  );
}

export function Admin() {
  const [tab, setTab] = useState('users');
  return (
    <Page title="Administration" sub="Users and roles, connections to other systems, and control settings.">
      <Tabs value={tab} onChange={setTab} tabs={[['users', 'Users & roles'], ['keys', 'API keys'], ['settings', 'Settings']]} />
      {tab === 'users' && <Users />}{tab === 'keys' && <ApiKeys />}{tab === 'settings' && <Settings />}
    </Page>
  );
}

export function Account({ forced }: { forced?: boolean }) {
  const me = useMe();
  const qc = useQueryClient();
  const toast = useToast();
  const [setup, setSetup] = useState<{ secret: string; qr_svg: string } | null>(null);
  const [disabling, setDisabling] = useState(false);
  const profile = useQuery({ queryKey: ['profile'], queryFn: () => api('/api/auth/profile'), enabled: !forced });
  const reload = () => qc.invalidateQueries({ queryKey: ['me'] });
  return (
    <Page title={forced ? 'Choose a new password' : 'My account'} sub={forced ? 'You signed in with a temporary password. Choose your own before continuing.' : `${me.name}, ${me.email}`}>
      <Card title="Password">
        <Form submit="Change password" onSubmit={async (v) => {
          if (v.new_password !== v.confirm) throw new Error('The two new passwords do not match');
          await api('/api/auth/change-password', { json: { current_password: v.current_password, new_password: v.new_password } });
          toast('Password changed. Other devices have been signed out.');
          await reload();
        }}>
          <div className="form-grid">
            <Field label={forced ? 'Temporary password' : 'Current password'} full><input name="current_password" type="password" required autoComplete="current-password" /></Field>
            <Field label="New password" hint="At least 12 characters with upper-case, lower-case and a number."><input name="new_password" type="password" required minLength={12} autoComplete="new-password" /></Field>
            <Field label="Repeat new password"><input name="confirm" type="password" required autoComplete="new-password" /></Field>
          </div>
        </Form>
      </Card>
      {!forced && <>
        <Card title="Two-step verification" actions={me.totp_enabled ? <Badge tone="ok">on</Badge> : <Badge tone="watch">off</Badge>}>
          {me.totp_enabled ? <>
            <p style={{ marginTop: 0 }}>You are asked for a code from your authenticator app each time you sign in.</p>
            <button className="btn danger" onClick={() => setDisabling(true)}>Turn off</button>
          </> : !setup ? <>
            <p style={{ marginTop: 0 }}>Add a second step at sign-in using an authenticator app such as Microsoft Authenticator or Google Authenticator. Strongly recommended for anyone who can change or approve loan data.</p>
            <button className="btn primary" onClick={async () => { try { setSetup(await api('/api/auth/mfa/setup', { method: 'POST' })); } catch (e: any) { toast(e.message, true); } }}>Set up</button>
          </> : (
            <Form submit="Turn on" onCancel={() => setSetup(null)} onSubmit={async (v) => { await api('/api/auth/mfa/enable', { json: { code: v.code } }); setSetup(null); toast('Two-step verification is on'); await reload(); }}>
              <p style={{ marginTop: 0 }}>1. Scan this code with your authenticator app, or type the key in by hand.</p>
              <div style={{ display: 'flex', gap: 18, alignItems: 'center', flexWrap: 'wrap' }}><img alt="QR code for the authenticator app" width={180} height={180} src={`data:image/svg+xml;utf8,${encodeURIComponent(setup.qr_svg)}`} /><div><div className="muted small">Key</div><div className="mono" style={{ wordBreak: 'break-all' }} data-testid="totp-secret">{setup.secret}</div></div></div>
              <p>2. Enter the 6-digit code the app shows.</p>
              <Field label="Code"><input name="code" inputMode="numeric" pattern="\d{6}" maxLength={6} required autoComplete="one-time-code" style={{ maxWidth: 160 }} /></Field>
            </Form>)}
        </Card>
        <Card title="Alert notifications">
          {profile.isPending ? <Loading /> : <Form submit="Save" onSubmit={async (v) => { await api('/api/auth/profile', { method: 'PUT', json: { phone: v.phone || null, notify_email: v.notify_email === 'on', notify_sms: v.notify_sms === 'on' } }); await qc.invalidateQueries({ queryKey: ['profile'] }); toast('Saved'); }}>
            <div className="grid">
              <label><input type="checkbox" name="notify_email" defaultChecked={profile.data?.notify_email} />Email me when an alert is raised</label>
              <label><input type="checkbox" name="notify_sms" defaultChecked={profile.data?.notify_sms} />Text me for critical alerts (shortfalls, margin calls, payments due)</label>
              <Field label="Mobile number for text messages"><input name="phone" type="tel" placeholder="+966 5x xxx xxxx" defaultValue={profile.data?.phone ?? ''} style={{ maxWidth: 260 }} /></Field>
            </div>
          </Form>}
        </Card>
      </>}
      {disabling && <Modal title="Turn off two-step verification" onClose={() => setDisabling(false)}>
        <Form danger submit="Turn off" onCancel={() => setDisabling(false)} onSubmit={async (v) => { await api('/api/auth/mfa/disable', { json: { password: v.password } }); setDisabling(false); toast('Two-step verification is off'); await reload(); }}>
          <Field label="Confirm with your password"><input name="password" type="password" required autoComplete="current-password" /></Field>
        </Form></Modal>}
    </Page>
  );
}
