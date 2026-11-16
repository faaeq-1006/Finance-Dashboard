import { useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import { api, date, dateTime, daysUntil, money } from '../api';
import { Badge, Card, Empty, ErrorBox, Field, Form, Loading, Modal, Page, Tabs, useCan, useMe, useToast } from '../ui';
import { KIND_LABEL } from './Dashboard';

export function Alerts() {
  const can = useCan();
  const qc = useQueryClient();
  const toast = useToast();
  const [tab, setTab] = useState('active');
  const { data, error, isPending } = useQuery({ queryKey: ['alerts', tab], queryFn: () => api(`/api/alerts?status=${tab}`) });
  const settings = useQuery({ queryKey: ['settings'], queryFn: () => api('/api/settings') });
  const ack = async (id: string) => { try { await api(`/api/alerts/${id}/ack`, { method: 'POST' }); await qc.invalidateQueries(); } catch (e: any) { toast(e.message, true); } };
  const ch = settings.data?.system.channels;
  return (
    <Page title="Alerts" sub="Early warnings before a shortfall, breaches of top-up and margin call levels, and reminders for maturities, reviews, finance charges and expiring documents.">
      {ch && (!ch.email || !ch.sms) && <div className="note">Alerts always appear here. {!ch.email && !ch.sms ? 'Email and SMS delivery are not configured on this server yet.' : !ch.email ? 'Email delivery is not configured on this server yet.' : 'SMS delivery is not configured on this server yet.'}</div>}
      <Tabs value={tab} onChange={setTab} tabs={[['active', 'Active'], ['resolved', 'Resolved']]} />
      {isPending ? <Loading /> : error ? <ErrorBox error={error} /> : (
        <Card flush>
          <div className="table-wrap"><table>
            <thead><tr><th>Severity</th><th>Alert</th><th>Raised</th><th>Status</th><th /></tr></thead>
            <tbody>{data.map((a: any) => (
              <tr key={a.id}><td><Badge tone={a.severity === 'critical' ? 'bad' : a.severity === 'warning' ? 'watch' : 'info'}>{a.severity}</Badge></td>
                <td className="wrap"><strong>{a.loan_id ? <Link to={`/loans/${a.loan_id}`}>{a.title}</Link> : a.title}</strong><div className="muted">{a.message}</div></td>
                <td style={{ whiteSpace: 'nowrap' }}>{dateTime(a.created_at)}</td>
                <td>{a.status === 'open' ? <Badge tone="bad">open</Badge> : a.status === 'acknowledged' ? <Badge tone="info">acknowledged by {a.acknowledged_by_name}</Badge> : <Badge tone="ok">resolved {dateTime(a.resolved_at)}</Badge>}</td>
                <td className="num">{a.status === 'open' && can('write') && <button className="btn sm" onClick={() => ack(a.id)}>Acknowledge</button>}</td></tr>))}
              {!data.length && <tr><td colSpan={5}><Empty>{tab === 'active' ? 'No active alerts. All loans are covered and nothing is due soon.' : 'No resolved alerts yet.'}</Empty></td></tr>}</tbody>
          </table></div>
        </Card>)}
    </Page>
  );
}

export function KeyDates() {
  const { data, error, isPending } = useQuery({ queryKey: ['calendar'], queryFn: () => api('/api/calendar') });
  const [kind, setKind] = useState('all');
  if (isPending) return <Loading />;
  if (error) return <ErrorBox error={error} />;
  const rows = data.filter((k: any) => kind === 'all' || k.kind === kind);
  return (
    <Page title="Key dates" sub="Loan maturities, facility reviews, renewals, finance charge payments and document expiries for the next 12 months."
      actions={<label className="field">Show<select value={kind} onChange={(e) => setKind(e.target.value)}><option value="all">Everything</option>{Object.entries(KIND_LABEL).map(([k, v]) => <option key={k} value={k}>{v}</option>)}</select></label>}>
      <Card flush>
        <div className="table-wrap"><table>
          <thead><tr><th>Date</th><th>When</th><th>Event</th><th>Bank</th><th>Loan</th><th className="num">Amount</th></tr></thead>
          <tbody>{rows.map((k: any, i: number) => {
            const d = daysUntil(k.date);
            return (
              <tr key={i}><td style={{ whiteSpace: 'nowrap' }}>{date(k.date)}</td><td><Badge tone={d < 0 ? 'bad' : d <= 7 ? 'watch' : 'neutral'}>{d < 0 ? `${-d} days overdue` : d === 0 ? 'today' : `in ${d} days`}</Badge></td>
                <td>{KIND_LABEL[k.kind]}{k.label ? `: ${k.label}` : ''}</td><td>{k.bank}</td><td><Link to={`/loans/${k.loan_id}`}>{k.loan_no}</Link></td><td className="num">{k.amount ? money(k.amount) : ''}</td></tr>);
          })}
            {!rows.length && <tr><td colSpan={6}><Empty>Nothing scheduled.</Empty></td></tr>}</tbody>
        </table></div>
      </Card>
    </Page>
  );
}

const LABELS: Record<string, string> = {
  'bank.create': 'New bank', 'bank.update': 'Bank terms', 'bank.set_eligibility': 'Eligible shares', 'loan.create': 'New loan', 'loan.update': 'Loan change', 'loan.close': 'Close loan',
  'loan.transaction': 'Drawdown / repayment', 'portfolio.save': 'Portfolio / pledge', 'portfolio.delete': 'Delete portfolio', 'holding.set': 'Share quantity', 'holding.transfer': 'Share transfer',
};

export function Approvals() {
  const me = useMe();
  const can = useCan();
  const qc = useQueryClient();
  const [tab, setTab] = useState('pending');
  const [modal, setModal] = useState<{ cr: any; decision: 'approve' | 'reject' | 'cancel' } | null>(null);
  const { data, error, isPending } = useQuery({ queryKey: ['approvals', tab], queryFn: () => api(`/api/approvals?status=${tab}`) });
  const toast = useToast();
  return (
    <Page title="Approvals" sub="Changes to loans, bank terms, pledges and share positions take effect only after a second person approves them. Nobody can approve their own request.">
      <Tabs value={tab} onChange={setTab} tabs={[['pending', 'Waiting for approval'], ['decided', 'Decided']]} />
      {isPending ? <Loading /> : error ? <ErrorBox error={error} /> : (
        <Card flush>
          <div className="table-wrap"><table>
            <thead><tr><th>Requested</th><th>By</th><th>Type</th><th>Change</th><th>{tab === 'pending' ? '' : 'Outcome'}</th></tr></thead>
            <tbody>{data.map((c: any) => (
              <tr key={c.id}><td style={{ whiteSpace: 'nowrap' }}>{dateTime(c.requested_at)}</td><td>{c.requested_by_name}</td><td>{LABELS[c.command] ?? c.command}</td>
                <td className="wrap"><strong>{c.summary}</strong><details><summary className="muted small" style={{ cursor: 'pointer' }}>Details</summary><pre className="json">{JSON.stringify(c.payload, null, 2)}</pre></details></td>
                <td className="num">{c.status === 'pending' ? <span className="actions" style={{ justifyContent: 'flex-end' }}>
                  {c.requested_by === me.id ? <><Badge tone="neutral">your request</Badge><button className="btn sm" onClick={() => setModal({ cr: c, decision: 'cancel' })}>Withdraw</button></>
                    : can('approve') ? <><button className="btn sm primary" onClick={() => setModal({ cr: c, decision: 'approve' })}>Approve</button><button className="btn sm danger" onClick={() => setModal({ cr: c, decision: 'reject' })}>Reject</button></>
                      : <Badge tone="neutral">waiting for an approver</Badge>}</span>
                  : <div style={{ textAlign: 'left' }}><Badge tone={c.status === 'approved' ? 'ok' : c.status === 'rejected' ? 'bad' : 'neutral'}>{c.status}</Badge><div className="muted small">{c.decided_by_name ? `${c.decided_by_name}, ` : ''}{dateTime(c.decided_at)}{c.decision_note ? `: ${c.decision_note}` : ''}</div></div>}</td></tr>))}
              {!data.length && <tr><td colSpan={5}><Empty>{tab === 'pending' ? 'Nothing is waiting for approval.' : 'No decisions yet.'}</Empty></td></tr>}</tbody>
          </table></div>
        </Card>)}
      {modal && <Modal title={modal.decision === 'approve' ? 'Approve change' : modal.decision === 'reject' ? 'Reject change' : 'Withdraw request'} onClose={() => setModal(null)}>
        <Form onCancel={() => setModal(null)} danger={modal.decision !== 'approve'} submit={modal.decision === 'approve' ? 'Approve and apply' : modal.decision === 'reject' ? 'Reject' : 'Withdraw'}
          onSubmit={async (v) => {
            const r = await api(`/api/approvals/${modal.cr.id}/decide`, { json: { decision: modal.decision, note: v.note || null } });
            await qc.invalidateQueries();
            toast(r.status === 'approved' ? 'Approved and applied' : r.status === 'rejected' ? 'Rejected' : 'Withdrawn');
            setModal(null);
          }}>
          <p style={{ marginTop: 0 }}><strong>{modal.cr.summary}</strong><br /><span className="muted">Requested by {modal.cr.requested_by_name} on {dateTime(modal.cr.requested_at)}</span></p>
          {modal.decision !== 'cancel' && <Field label={modal.decision === 'reject' ? 'Reason for rejecting' : 'Note (optional)'}><textarea name="note" required={modal.decision === 'reject'} maxLength={500} /></Field>}
        </Form></Modal>}
    </Page>
  );
}
