import { Decimal } from 'decimal.js';
import { config } from '../config.js';
import { pool, q, tx } from '../db.js';
import { afterChange } from './hooks.js';

export interface Quote { symbol: string; price: string; as_of?: string }

/**
 * Price feed. A provider returns quotes for the symbols we hold; everything downstream
 * (history, valuation, alerts, live screen refresh) is the same whatever the source.
 * To connect a licensed market-data vendor, implement PriceProvider and select it here,
 * or have the vendor/treasury system push to POST /api/v1/prices.
 */
export interface PriceProvider { name: string; fetch(securities: { symbol: string; last_price: string | null }[]): Promise<Quote[]> }

/** Demo only: a small random walk around the last price. Clearly labelled in the UI. */
const simulated: PriceProvider = {
  name: 'simulated',
  async fetch(securities) {
    return securities.filter((s) => s.last_price).map((s) => {
      const move = (Math.random() - 0.5) * 0.012; // +/-0.6% per tick
      const next = Decimal.max(new Decimal(s.last_price!).mul(1 + move), '0.01');
      return { symbol: s.symbol, price: next.toFixed(2) };
    });
  },
};
const providers: Record<string, PriceProvider | null> = { simulated, manual: null };
export const activeProvider = () => config.priceProvider;

/** Stores quotes in history and updates the latest price. Unknown symbols are reported, not created. */
export async function recordPrices(quotes: Quote[], source: string, createdBy: string | null = null) {
  const result = await tx(async (client) => {
    const known = new Map((await q(client, 'SELECT id, symbol, last_price, last_price_at FROM securities WHERE symbol = ANY($1) FOR UPDATE', [quotes.map((x) => x.symbol)])).map((s) => [s.symbol, s]));
    const unknown: string[] = [];
    let accepted = 0;
    for (const quote of quotes) {
      const sec = known.get(quote.symbol);
      if (!sec) { unknown.push(quote.symbol); continue; }
      const asOf = quote.as_of ? new Date(quote.as_of) : new Date();
      await client.query('INSERT INTO prices(security_id, price, as_of, source, created_by) VALUES ($1,$2,$3,$4,$5)', [sec.id, quote.price, asOf, source, createdBy]);
      // A late-arriving older quote is kept in history but does not overwrite a newer price.
      if (!sec.last_price_at || asOf >= sec.last_price_at) {
        await client.query('UPDATE securities SET last_price = $2, last_price_at = $3, last_price_source = $4 WHERE id = $1', [sec.id, quote.price, asOf, source]);
      }
      accepted++;
    }
    return { accepted, unknown };
  });
  if (result.accepted) afterChange('prices');
  return result;
}

export const feedStatus = { provider: config.priceProvider, last_run_at: null as string | null, last_error: null as string | null, quotes: 0 };

export async function pollPrices() {
  const provider = providers[config.priceProvider];
  if (!provider) return;
  try {
    // Only securities we actually hold need a live price.
    const held = await q(pool, `SELECT s.symbol, s.last_price FROM securities s WHERE s.active AND EXISTS (SELECT 1 FROM holdings h WHERE h.security_id = s.id)`);
    const quotes = await provider.fetch(held);
    if (quotes.length) await recordPrices(quotes, provider.name);
    Object.assign(feedStatus, { last_run_at: new Date().toISOString(), last_error: null, quotes: quotes.length });
  } catch (err) {
    feedStatus.last_error = (err as Error).message;
    console.error('price poll failed', err);
  }
}
