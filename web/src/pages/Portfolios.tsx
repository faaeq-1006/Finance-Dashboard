import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import { api, money, qty } from '../api';
import { Badge, Card, Confirm, DEC, Empty, ErrorBox, Field, Form, Loading, Modal, Page, useCan, useCommand } from '../ui';

function PortfolioForm({ portfolio, banks, loans, onClose }: { portfolio?: any; banks: any[]; loans: any[]; onClose: () => void }) {
  const run = useCommand();
  const [bankId, setBankId] = useState<string>(portfolio?.bank_id ?? '');
  const bankLoans = loans.filter((l) => l.bank_id === bankId && l.status === 'active');
  return (
    <Modal title={portfolio ? `Edit ${portfolio.name}` : 'New portfolio'} onClose={onClose}>
      <Form onCancel={onClose} onSubmit={async (v) => { await run('portfolio.save', { ...v, id: portfolio?.id }); onClose(); }}>
        <div className="form-grid">
          <Field label="Portfolio name" full><input name="name" required defaultValue={portfolio?.name} /></Field>
          <Field label="Held at bank" hint="Leave empty if the shares are not at a lending bank."><select name="bank_id" value={bankId} onChange={(e) => setBankId(e.target.value)}><option value="">Not at a bank (unpledged)</option>{banks.map((b) => <option key={b.id} value={b.id}>{b.name}</option>)}</select></Field>
          <Field label="Pledged to loan" hint="Pledged shares count towards this loan's coverage."><select name="loan_id" defaultValue={portfolio?.loan_id ?? ''} key={bankId} disabled={!bankId}><option value="">Not pledged</option>{bankLoans.map((l) => <option key={l.id} value={l.id}>{l.loan_no}</option>)}</select></Field>
          <Field label="Custody account (optional)" full><input name="custody_account" defaultValue={portfolio?.custody_account ?? ''} /></Field>
        </div>
      </Form>
    </Modal>
  );
}

export default function Portfolios() {
  const can = useCan();
  const run = useCommand();
  const [modal, setModal] = useState<{ kind: string; p?: any; h?: any } | null>(null);
  const portfolios = useQuery({ queryKey: ['portfolios'], queryFn: () => api('/api/portfolios') });
  const banks = useQuery({ queryKey: ['banks'], queryFn: () => api('/api/banks') });
  const loans = useQuery({ queryKey: ['loans'], queryFn: () => api('/api/loans') });
  const securities = useQuery({ queryKey: ['securities'], queryFn: () => api('/api/securities') });
  if (portfolios.isPending) return <Loading />;
  if (portfolios.error) return <ErrorBox error={portfolios.error} />;
  const close = () => setModal(null);
  const w = can('write');
  return (
    <Page title="Portfolios & shares" sub="Shares are held in portfolios. A portfolio pledged to a loan counts towards that loan's coverage. Move shares between portfolios to top up or release collateral."
      actions={w && <button className="btn primary" onClick={() => setModal({ kind: 'portfolio' })}>New portfolio</button>}>
      {portfolios.data.map((p: any) => (
        <Card key={p.id} flush title={<>{p.name} {p.loan_no ? <Badge tone="ok">pledged to <Link to={`/loans/${p.loan_id}`}>{p.bank} {p.loan_no}</Link></Badge> : p.bank ? <Badge tone="info">at {p.bank}, not pledged</Badge> : <Badge tone="neutral">unpledged</Badge>}</>}
          actions={w && <><button className="btn sm primary" onClick={() => setModal({ kind: 'holding', p })}>Add shares</button><button className="btn sm" onClick={() => setModal({ kind: 'portfolio', p })}>Edit / pledge</button>{!p.holdings.length && <button className="btn sm danger" onClick={() => setModal({ kind: 'delete', p })}>Delete</button>}</>}>
          <div className="table-wrap"><table>
            <thead><tr><th>Share</th><th className="num">No. of shares</th><th className="num">Price</th><th className="num">Value</th><th /></tr></thead>
            <tbody>{p.holdings.map((h: any) => (
              <tr key={h.id}><td>{h.symbol} <span className="muted">{h.name}</span></td><td className="num">{qty(h.quantity)}</td><td className="num">{h.price ? Number(h.price).toFixed(2) : '–'}</td><td className="num">{money(h.value)}</td>
                <td className="num">{w && <span className="actions" style={{ justifyContent: 'flex-end' }}><button className="btn sm" onClick={() => setModal({ kind: 'transfer', p, h })}>Transfer</button><button className="btn sm" onClick={() => setModal({ kind: 'holding', p, h })}>Change quantity</button></span>}</td></tr>))}
              {!p.holdings.length && <tr><td colSpan={5}><Empty>No shares in this portfolio.</Empty></td></tr>}
            </tbody>
          </table></div>
        </Card>))}
      {!portfolios.data.length && <Card><Empty>No portfolios yet. Create one, then add the shares it holds.</Empty></Card>}

      {modal?.kind === 'portfolio' && <PortfolioForm portfolio={modal.p} banks={banks.data ?? []} loans={loans.data ?? []} onClose={close} />}
      {modal?.kind === 'delete' && <Confirm title="Delete portfolio" danger action="Delete" text={`Delete the empty portfolio ${modal.p.name}?`} onClose={close} onConfirm={() => run('portfolio.delete', { id: modal.p.id }, 'Portfolio deleted')} />}
      {modal?.kind === 'holding' && <Modal title={modal.h ? `Change ${modal.h.symbol} in ${modal.p.name}` : `Add shares to ${modal.p.name}`} onClose={close}>
        <Form onCancel={close} onSubmit={async (v) => { await run('holding.set', { portfolio_id: modal.p.id, security_id: modal.h?.security_id ?? v.security_id, quantity: v.quantity }); close(); }}>
          <div className="form-grid">
            {!modal.h && <Field label="Share" full><select name="security_id" required defaultValue=""><option value="" disabled>Select a share</option>{(securities.data ?? []).filter((s: any) => s.active).map((s: any) => <option key={s.id} value={s.id}>{s.symbol} {s.name}</option>)}</select></Field>}
            <Field label="Number of shares" hint={modal.h ? 'Enter 0 to remove this share from the portfolio.' : 'If the portfolio already holds this share, this replaces the quantity.'} full><input name="quantity" required {...DEC} defaultValue={modal.h ? Number(modal.h.quantity) : ''} autoFocus /></Field>
          </div>
        </Form></Modal>}
      {modal?.kind === 'transfer' && <Modal title={`Transfer ${modal.h.symbol} from ${modal.p.name}`} onClose={close}>
        <Form onCancel={close} submit="Transfer" onSubmit={async (v) => { await run('holding.transfer', { holding_id: modal.h.id, quantity: v.quantity, to_portfolio_id: v.to_portfolio_id }, 'Shares transferred'); close(); }}>
          <div className="form-grid">
            <Field label="Number of shares" hint={`${qty(modal.h.quantity)} available`}><input name="quantity" required {...DEC} defaultValue={Number(modal.h.quantity)} /></Field>
            <Field label="To portfolio"><select name="to_portfolio_id" required defaultValue=""><option value="" disabled>Select</option>{portfolios.data.filter((x: any) => x.id !== modal.p.id).map((x: any) => <option key={x.id} value={x.id}>{x.name}{x.loan_no ? ` (${x.bank} ${x.loan_no})` : x.bank ? ` (${x.bank}, not pledged)` : ' (unpledged)'}</option>)}</select></Field>
          </div>
        </Form></Modal>}
    </Page>
  );
}
