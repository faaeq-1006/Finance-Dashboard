import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { CartesianGrid, Line, LineChart, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';
import { api, dateTime, qty, today } from '../api';
import { Badge, Card, DEC, Empty, ErrorBox, Field, Form, Loading, Modal, Page, useCan, useCommand } from '../ui';

function History({ security, onClose }: { security: any; onClose: () => void }) {
  const [days, setDays] = useState(30);
  const { data, isPending } = useQuery({ queryKey: ['prices', security.id, days], queryFn: () => api(`/api/securities/${security.id}/prices?days=${days}`) });
  const points = (data ?? []).map((p: any) => ({ t: new Date(p.as_of).getTime(), price: Number(p.price), source: p.source }));
  const from = new Date(Date.now() - days * 86_400_000).toLocaleDateString('en-CA');
  return (
    <Modal title={`${security.symbol} ${security.name}: price history`} onClose={onClose} wide>
      <div className="actions" style={{ marginBottom: 12 }}>
        {[7, 30, 90, 365].map((d) => <button key={d} className={`btn sm ${days === d ? 'primary' : ''}`} onClick={() => setDays(d)}>{d === 365 ? '1 year' : `${d} days`}</button>)}
        <a className="btn sm" href={`/api/reports/price-history.xlsx?security_id=${security.id}&from=${from}&to=${today()}`}>Export to Excel</a>
      </div>
      {isPending ? <Loading /> : points.length ? (
        <div style={{ height: 280 }}><ResponsiveContainer>
          <LineChart data={points} margin={{ top: 4, right: 12, left: 0, bottom: 0 }}>
            <CartesianGrid strokeDasharray="3 3" stroke="#e2d5c3" />
            <XAxis dataKey="t" type="number" scale="time" domain={['dataMin', 'dataMax']} tick={{ fontSize: 11 }} tickFormatter={(t) => new Date(t).toLocaleDateString('en-GB', { day: '2-digit', month: 'short' })} />
            <YAxis domain={['auto', 'auto']} tick={{ fontSize: 11 }} width={56} tickFormatter={(v) => v.toFixed(2)} />
            <Tooltip labelFormatter={(t) => dateTime(new Date(Number(t)).toISOString())} formatter={(v: any, _n, item: any) => [`${Number(v).toFixed(2)} (${item.payload.source})`, 'Price']} />
            <Line type="monotone" dataKey="price" stroke="#8b4513" dot={false} strokeWidth={2} isAnimationActive={false} />
          </LineChart></ResponsiveContainer></div>
      ) : <Empty>No prices recorded in this period.</Empty>}
      <p className="muted small">Every price received is kept with its time and source for audit. Long periods are thinned on this chart only.</p>
    </Modal>
  );
}

export default function Prices() {
  const can = useCan();
  const run = useCommand();
  const [modal, setModal] = useState<{ kind: string; s?: any } | null>(null);
  const { data, error, isPending } = useQuery({ queryKey: ['securities'], queryFn: () => api('/api/securities') });
  const settings = useQuery({ queryKey: ['settings'], queryFn: () => api('/api/settings') });
  if (isPending) return <Loading />;
  if (error) return <ErrorBox error={error} />;
  const close = () => setModal(null);
  const feed = settings.data?.system.price_feed;
  return (
    <Page title="Share prices" sub="Latest price for every share, with full history. Share values and coverage update as soon as a price changes."
      actions={can('write') && <button className="btn primary" onClick={() => setModal({ kind: 'security' })}>New share</button>}>
      {feed?.provider === 'simulated' && <div className="warn">Prices are coming from the built-in simulator for demonstration. They are not market prices. Connect a licensed market-data feed or push prices through the API before relying on these figures.</div>}
      {feed?.provider === 'manual' && <div className="note">No automatic feed is connected. Prices are entered here or pushed by another system through the API (POST /api/v1/prices).</div>}
      <Card flush>
        <div className="table-wrap"><table>
          <thead><tr><th>Symbol</th><th>Name</th><th>Exchange</th><th className="num">Last price</th><th className="num">Change vs previous day</th><th>Updated</th><th>Source</th><th className="num">Shares held</th><th /></tr></thead>
          <tbody>{data.map((s: any) => {
            const chg = s.last_price && s.previous_close ? (Number(s.last_price) / Number(s.previous_close) - 1) * 100 : null;
            return (
              <tr key={s.id}><td><strong>{s.symbol}</strong> {!s.active && <Badge tone="neutral">inactive</Badge>}</td><td>{s.name}</td><td>{s.exchange}</td>
                <td className="num">{s.last_price ? Number(s.last_price).toFixed(2) : <Badge tone="bad">no price</Badge>}</td>
                <td className="num">{chg === null ? '–' : <span className={chg < 0 ? 'neg' : 'pos'}>{chg > 0 ? '+' : ''}{chg.toFixed(2)}%</span>}</td>
                <td>{dateTime(s.last_price_at)}</td><td>{s.last_price_source ?? '–'}</td><td className="num">{qty(s.total_quantity)}</td>
                <td className="num"><span className="actions" style={{ justifyContent: 'flex-end' }}><button className="btn sm" onClick={() => setModal({ kind: 'history', s })}>History</button>
                  {can('write') && <><button className="btn sm" onClick={() => setModal({ kind: 'price', s })}>Set price</button><button className="btn sm" onClick={() => setModal({ kind: 'security', s })}>Edit</button></>}</span></td></tr>);
          })}
            {!data.length && <tr><td colSpan={9}><Empty>No shares yet. Add the shares you hold.</Empty></td></tr>}</tbody>
        </table></div>
      </Card>
      {modal?.kind === 'history' && <History security={modal.s} onClose={close} />}
      {modal?.kind === 'price' && <Modal title={`Set price: ${modal.s.symbol}`} onClose={close}>
        <Form onCancel={close} submit="Set price" onSubmit={async (v) => { await run('price.manual', { security_id: modal.s.id, price: v.price }, 'Price updated'); close(); }}>
          <Field label="Price" hint="Recorded in the price history as a manual entry under your name."><input name="price" required {...DEC} defaultValue={modal.s.last_price ? Number(modal.s.last_price) : ''} autoFocus /></Field>
        </Form></Modal>}
      {modal?.kind === 'security' && <Modal title={modal.s ? `Edit ${modal.s.symbol}` : 'New share'} onClose={close}>
        <Form onCancel={close} onSubmit={async (v) => { await run('security.save', { id: modal.s?.id, symbol: v.symbol, name: v.name, exchange: v.exchange, active: v.active === 'on' }); close(); }}>
          <div className="form-grid">
            <Field label="Symbol" hint="As used by your price feed, e.g. 2222."><input name="symbol" required maxLength={20} defaultValue={modal.s?.symbol} /></Field>
            <Field label="Exchange"><input name="exchange" required defaultValue={modal.s?.exchange ?? 'TADAWUL'} /></Field>
            <Field label="Name" full><input name="name" required defaultValue={modal.s?.name} /></Field>
            <label className="full"><input type="checkbox" name="active" defaultChecked={modal.s?.active ?? true} />Active (included in the price feed)</label>
          </div>
        </Form></Modal>}
    </Page>
  );
}
