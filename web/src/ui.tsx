import { createContext, useCallback, useContext, useEffect, useRef, useState, type FormEvent, type ReactNode } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { ApiError, command, STATUS_LABEL, statusTone } from './api';

// ---- session ----
export interface Me { id: string; email: string; name: string; role: string; permissions: string[]; must_change_password: boolean; totp_enabled: boolean; csrf_token: string }
export const MeContext = createContext<Me>(null as unknown as Me);
export const useMe = () => useContext(MeContext);
export const useCan = () => {
  const me = useMe();
  return (perm: string) => me.permissions.includes(perm);
};

// ---- toasts ----
type Toast = { id: number; text: string; err?: boolean };
const ToastContext = createContext<(text: string, err?: boolean) => void>(() => {});
export const useToast = () => useContext(ToastContext);
export function ToastProvider({ children }: { children: ReactNode }) {
  const [items, setItems] = useState<Toast[]>([]);
  const push = useCallback((text: string, err = false) => {
    const id = Date.now() + Math.random();
    setItems((x) => [...x, { id, text, err }]);
    setTimeout(() => setItems((x) => x.filter((t) => t.id !== id)), err ? 7000 : 4500);
  }, []);
  return (
    <ToastContext.Provider value={push}>
      {children}
      <div className="toasts" role="status" aria-live="polite">{items.map((t) => <div key={t.id} className={`toast ${t.err ? 'err' : ''}`}>{t.text}</div>)}</div>
    </ToastContext.Provider>
  );
}

/** Runs a business command, then tells the user whether it was saved or sent for approval. */
export function useCommand() {
  const qc = useQueryClient();
  const toast = useToast();
  return useCallback(async (name: string, payload: unknown, done = 'Saved') => {
    const r = await command(name, payload);
    toast(r.status === 'pending' ? 'Sent for approval. It takes effect once a second person approves it.' : done);
    await qc.invalidateQueries();
    return r;
  }, [qc, toast]);
}

// ---- layout pieces ----
export function Page({ title, sub, actions, crumbs, children }: { title: ReactNode; sub?: ReactNode; actions?: ReactNode; crumbs?: ReactNode; children: ReactNode }) {
  return (
    <>
      {crumbs && <div className="crumbs">{crumbs}</div>}
      <div className="page-head">
        <div><h1>{title}</h1>{sub && <p>{sub}</p>}</div>
        {actions && <div className="actions">{actions}</div>}
      </div>
      {children}
    </>
  );
}
export function Card({ title, actions, children, flush }: { title?: ReactNode; actions?: ReactNode; children: ReactNode; flush?: boolean }) {
  return (
    <section className="card">
      {(title || actions) && <div className="card-head"><h2>{title}</h2><div className="actions">{actions}</div></div>}
      {flush ? children : <div className="card-body">{children}</div>}
    </section>
  );
}
export function Stat({ label, value, hint, dark, tone }: { label: string; value: ReactNode; hint?: ReactNode; dark?: boolean; tone?: string }) {
  return <div className={`stat ${dark ? 'dark' : ''}`}><div className="label">{label}</div><div className={`value ${tone ?? ''}`}>{value}</div>{hint && <div className="hint">{hint}</div>}</div>;
}
export const Badge = ({ tone, children }: { tone: string; children: ReactNode }) => <span className={`badge ${tone}`}>{children}</span>;
export const StatusBadge = ({ status }: { status: string }) => <Badge tone={statusTone(status)}>{STATUS_LABEL[status] ?? status}</Badge>;
export const Empty = ({ children }: { children: ReactNode }) => <div className="empty">{children}</div>;
export const Loading = () => <div className="empty">Loading…</div>;
export const ErrorBox = ({ error }: { error: unknown }) => <div className="error" role="alert">{error instanceof Error ? error.message : 'Something went wrong'}</div>;

export function Tabs({ tabs, value, onChange }: { tabs: [string, string][]; value: string; onChange: (v: string) => void }) {
  return <div className="tabs" role="tablist">{tabs.map(([id, label]) => <button key={id} role="tab" aria-selected={value === id} onClick={() => onChange(id)}>{label}</button>)}</div>;
}

export function Modal({ title, onClose, children, wide }: { title: string; onClose: () => void; children: ReactNode; wide?: boolean }) {
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const d = ref.current!;
    if (!d.open) d.showModal();
    return () => d.close();
  }, []);
  return (
    <dialog ref={ref} className={wide ? 'wide' : ''} onCancel={(e) => { e.preventDefault(); onClose(); }} aria-label={title}>
      <div className="dlg-head"><h2>{title}</h2><button className="x" onClick={onClose} aria-label="Close">×</button></div>
      <div className="dlg-body">{children}</div>
    </dialog>
  );
}

export function Field({ label, hint, full, children }: { label: string; hint?: string; full?: boolean; children: ReactNode }) {
  return <label className={`field ${full ? 'full' : ''}`}>{label}{children}{hint && <span className="hint">{hint}</span>}</label>;
}

/** Form that collects named inputs, shows the server's error, and disables itself while saving. */
export function Form({ onSubmit, children, submit = 'Save', onCancel, danger }: { onSubmit: (values: Record<string, string>) => Promise<unknown>; children: ReactNode; submit?: string; onCancel?: () => void; danger?: boolean }) {
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  async function handle(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const values: Record<string, string> = {};
    new FormData(e.currentTarget).forEach((v, k) => { if (typeof v === 'string') values[k] = v.trim(); });
    setBusy(true);
    setError('');
    try {
      await onSubmit(values);
    } catch (err) {
      setError(err instanceof ApiError || err instanceof Error ? err.message : 'Could not save');
    } finally {
      setBusy(false);
    }
  }
  return (
    <form onSubmit={handle} noValidate={false}>
      {error && <div className="error" role="alert">{error}</div>}
      {children}
      <div className="form-actions">
        {onCancel && <button type="button" className="btn" onClick={onCancel}>Cancel</button>}
        <button type="submit" className={`btn ${danger ? 'danger' : 'primary'}`} disabled={busy}>{busy ? 'Working…' : submit}</button>
      </div>
    </form>
  );
}

export function Confirm({ title, text, action, onConfirm, onClose, danger }: { title: string; text: ReactNode; action: string; onConfirm: () => Promise<unknown>; onClose: () => void; danger?: boolean }) {
  return (
    <Modal title={title} onClose={onClose}>
      <Form onSubmit={async () => { await onConfirm(); onClose(); }} submit={action} onCancel={onClose} danger={danger}><p style={{ marginTop: 0 }}>{text}</p></Form>
    </Modal>
  );
}

export const Money = ({ v, signed }: { v: string | number | null | undefined; signed?: boolean }) => {
  if (v === null || v === undefined || v === '') return <>–</>;
  const n = Number(v);
  const text = new Intl.NumberFormat('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(n);
  return signed ? <span className={n < 0 ? 'neg' : 'pos'}>{n > 0 ? '+' : ''}{text}</span> : <>{text}</>;
};
export const DEC = { inputMode: 'decimal' as const, pattern: '\\d+(\\.\\d+)?', autoComplete: 'off' };
