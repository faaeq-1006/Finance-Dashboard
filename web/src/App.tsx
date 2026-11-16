import { useEffect, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { NavLink, Navigate, Route, Routes, useLocation } from 'react-router-dom';
import { api, onUnauthorized, setCsrf } from './api';
import { Loading, MeContext, type Me } from './ui';
import Login from './pages/Login';
import Dashboard from './pages/Dashboard';
import Coverage from './pages/Coverage';
import { LoanDetail, Loans } from './pages/Loans';
import { BankDetail, Banks } from './pages/Banks';
import Portfolios from './pages/Portfolios';
import Prices from './pages/Prices';
import Simulation from './pages/Simulation';
import Allocation from './pages/Allocation';
import { Alerts, Approvals, KeyDates } from './pages/Workflow';
import { Audit, Reports } from './pages/Reporting';
import { Account, Admin } from './pages/Admin';

function useLiveUpdates() {
  const qc = useQueryClient();
  const [live, setLive] = useState(false);
  useEffect(() => {
    const es = new EventSource('/api/stream');
    let timer: ReturnType<typeof setTimeout> | undefined;
    const refresh = () => { clearTimeout(timer); timer = setTimeout(() => qc.invalidateQueries(), 250); };
    es.onopen = () => setLive(true);
    es.onerror = () => setLive(false);
    for (const topic of ['prices', 'data', 'approvals']) es.addEventListener(topic, refresh);
    return () => { es.close(); clearTimeout(timer); };
  }, [qc]);
  return live;
}

function Shell({ me }: { me: Me }) {
  const qc = useQueryClient();
  const live = useLiveUpdates();
  const [open, setOpen] = useState(false);
  const location = useLocation();
  useEffect(() => setOpen(false), [location.pathname]);
  const counts = useQuery({ queryKey: ['counts'], queryFn: () => api('/api/counts'), enabled: !me.must_change_password });
  const can = (p: string) => me.permissions.includes(p);
  const logout = async () => { await api('/api/auth/logout', { method: 'POST' }).catch(() => {}); qc.clear(); window.location.assign('/'); };

  if (me.must_change_password) return <div className="main" style={{ maxWidth: 560, margin: '40px auto' }}><Account forced /></div>;

  const link = (to: string, label: string, count?: number, crit?: boolean) => (
    <NavLink to={to} end={to === '/'}>{label}{count ? <span className={`count ${crit ? 'crit' : ''}`}>{count}</span> : null}</NavLink>
  );
  return (
    <div className="shell">
      <div className="topbar"><button onClick={() => setOpen(!open)} aria-label="Menu">☰</button>Borrowings System</div>
      <aside className={`sidebar ${open ? 'open' : ''}`}>
        <div className="brand"><span className="brand-mark">B</span>Borrowings System</div>
        <nav className="nav" aria-label="Main">
          <div className="nav-group">Overview</div>
          {link('/', 'Dashboard')}
          {link('/coverage', 'Coverage view')}
          {link('/alerts', 'Alerts', counts.data?.open_alerts, true)}
          {link('/key-dates', 'Key dates')}
          <div className="nav-group">Register</div>
          {link('/loans', 'Loans')}
          {link('/banks', 'Banks & terms')}
          {link('/portfolios', 'Portfolios & shares')}
          {link('/prices', 'Share prices')}
          <div className="nav-group">Planning</div>
          {link('/simulation', 'What-if simulation')}
          {link('/allocation', 'Collateral allocation')}
          <div className="nav-group">Control</div>
          {link('/approvals', 'Approvals', counts.data?.pending_approvals)}
          {link('/reports', 'Reports')}
          {can('audit.read') && link('/audit', 'Audit trail')}
          {can('admin') && link('/admin', 'Administration')}
        </nav>
        <div className="side-foot">
          <div className="live"><span className={`dot ${live ? '' : 'off'}`} />{live ? 'Live updates on' : 'Reconnecting…'}</div>
          <div style={{ marginTop: 8 }}><NavLink to="/account" style={{ color: '#fff', fontWeight: 600 }}>{me.name}</NavLink></div>
          <div style={{ textTransform: 'capitalize', color: '#b39c82' }}>{me.role}</div>
          <button onClick={logout}>Sign out</button>
        </div>
      </aside>
      <main className="main">
        <Routes>
          <Route path="/" element={<Dashboard />} />
          <Route path="/coverage" element={<Coverage />} />
          <Route path="/alerts" element={<Alerts />} />
          <Route path="/key-dates" element={<KeyDates />} />
          <Route path="/loans" element={<Loans />} />
          <Route path="/loans/:id" element={<LoanDetail />} />
          <Route path="/banks" element={<Banks />} />
          <Route path="/banks/:id" element={<BankDetail />} />
          <Route path="/portfolios" element={<Portfolios />} />
          <Route path="/prices" element={<Prices />} />
          <Route path="/simulation" element={<Simulation />} />
          <Route path="/allocation" element={<Allocation />} />
          <Route path="/approvals" element={<Approvals />} />
          <Route path="/reports" element={<Reports />} />
          <Route path="/audit" element={can('audit.read') ? <Audit /> : <Navigate to="/" replace />} />
          <Route path="/admin" element={can('admin') ? <Admin /> : <Navigate to="/" replace />} />
          <Route path="/account" element={<Account />} />
          <Route path="*" element={<Navigate to="/" replace />} />
        </Routes>
      </main>
    </div>
  );
}

export default function App() {
  const qc = useQueryClient();
  const me = useQuery<Me | null>({
    queryKey: ['me'],
    queryFn: async () => {
      try {
        const data = await api<Me>('/api/auth/me');
        setCsrf(data.csrf_token);
        return data;
      } catch (err: any) {
        if (err?.status === 401) return null;
        throw err;
      }
    },
    staleTime: Infinity, retry: false,
  });
  useEffect(() => {
    onUnauthorized.handler = () => { if (qc.getQueryData(['me'])) qc.setQueryData(['me'], null); };
  }, [qc]);

  if (me.isPending) return <Loading />;
  if (me.isError) return <div className="login"><div className="card"><div className="card-body">The service is unavailable. Try again shortly.</div></div></div>;
  if (!me.data) return <Login onDone={() => me.refetch()} />;
  return <MeContext.Provider value={me.data}><Shell me={me.data} /></MeContext.Provider>;
}
