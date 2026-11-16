import { useState } from 'react';
import { api } from '../api';
import { Field, Form } from '../ui';

export default function Login({ onDone }: { onDone: () => void }) {
  const [mfa, setMfa] = useState<{ email: string; password: string } | null>(null);
  return (
    <div className="login">
      <div className="card">
        <div className="card-body">
          <div className="brand" style={{ color: 'var(--brown-900)', padding: 0, marginBottom: 6 }}><span className="brand-mark" style={{ background: 'var(--brown-900)', color: '#e3b98a' }}>B</span>Borrowings System</div>
          <p className="muted" style={{ marginTop: 0 }}>Loans, pledged shares and coverage in one place.</p>
          {!mfa ? (
            <Form submit="Sign in" onSubmit={async (v) => {
              const r = await api('/api/auth/login', { json: { email: v.email, password: v.password } });
              if (r.mfa_required) setMfa({ email: v.email, password: v.password }); else onDone();
            }}>
              <div className="grid">
                <Field label="Email"><input name="email" type="email" autoComplete="username" required autoFocus /></Field>
                <Field label="Password"><input name="password" type="password" autoComplete="current-password" required /></Field>
              </div>
            </Form>
          ) : (
            <Form submit="Verify" onCancel={() => setMfa(null)} onSubmit={async (v) => {
              await api('/api/auth/login', { json: { ...mfa, totp: v.totp } });
              onDone();
            }}>
              <Field label="Authenticator code" hint="Enter the 6-digit code from your authenticator app."><input name="totp" inputMode="numeric" pattern="\d{6}" maxLength={6} autoComplete="one-time-code" required autoFocus /></Field>
            </Form>
          )}
        </div>
      </div>
    </div>
  );
}
