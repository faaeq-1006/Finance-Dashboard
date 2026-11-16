// Thin API client. Amounts travel as decimal strings; they are only turned into numbers for display.
let csrf = '';
export const setCsrf = (token: string) => { csrf = token; };

export class ApiError extends Error {
  constructor(public status: number, message: string, public code?: string) { super(message); }
}
export const onUnauthorized: { handler: () => void } = { handler: () => {} };

// The server extends the session only for requests made while someone is using the app,
// so a screen left open on live prices still signs itself out after the idle period.
let lastActivity = Date.now();
if (typeof window !== 'undefined') {
  for (const evt of ['pointerdown', 'keydown', 'wheel', 'touchstart']) window.addEventListener(evt, () => { lastActivity = Date.now(); }, { passive: true, capture: true });
}

export async function api<T = any>(path: string, init: RequestInit & { json?: unknown } = {}): Promise<T> {
  const headers: Record<string, string> = { accept: 'application/json' };
  const method = init.method ?? (init.json !== undefined || init.body ? 'POST' : 'GET');
  if (init.json !== undefined) headers['content-type'] = 'application/json';
  if (method !== 'GET') headers['x-csrf-token'] = csrf;
  if (Date.now() - lastActivity < 120_000) headers['x-user-active'] = '1';
  const res = await fetch(path, { ...init, method, headers, body: init.json !== undefined ? JSON.stringify(init.json) : init.body, credentials: 'same-origin' });
  if (res.status === 401 && !path.startsWith('/api/auth/login')) onUnauthorized.handler();
  const data = res.headers.get('content-type')?.includes('json') ? await res.json() : null;
  if (!res.ok) throw new ApiError(res.status, data?.message ?? `Request failed (${res.status})`, data?.error);
  return data as T;
}

export interface CommandResult { status: 'applied' | 'pending'; entity_id?: string; summary?: string }
export const command = (name: string, payload: unknown) => api<CommandResult>(`/api/commands/${name}`, { json: payload });

// ---- formatting ----
const n2 = new Intl.NumberFormat('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const n0 = new Intl.NumberFormat('en-US', { maximumFractionDigits: 4 });
export const money = (v: string | number | null | undefined) => (v === null || v === undefined || v === '' ? '–' : n2.format(Number(v)));
export const qty = (v: string | number | null | undefined) => (v === null || v === undefined || v === '' ? '–' : n0.format(Number(v)));
export const pct = (v: string | number | null | undefined, digits = 0) => (v === null || v === undefined || v === '' ? '–' : `${Number(v).toFixed(digits)}%`);
export const date = (v: string | null | undefined) => {
  if (!v) return '–';
  const d = new Date(v.length === 10 ? `${v}T00:00:00` : v);
  return d.toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric' });
};
export const dateTime = (v: string | null | undefined) => (v ? new Date(v).toLocaleString('en-GB', { day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' }) : '–');
export const today = () => new Date().toLocaleDateString('en-CA');
export const daysUntil = (d: string) => Math.round((new Date(`${d}T00:00:00`).getTime() - new Date(`${today()}T00:00:00`).getTime()) / 86_400_000);
export const signClass = (v: string | number) => (Number(v) < 0 ? 'neg' : 'pos');

export const STATUS_LABEL: Record<string, string> = { ok: 'Covered', watch: 'Early warning', shortfall: 'Shortfall', top_up: 'Top-up level', margin_call: 'Margin call' };
export const statusTone = (s: string) => (s === 'ok' ? 'ok' : s === 'watch' ? 'watch' : 'bad');
