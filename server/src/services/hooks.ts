// Tiny event hub so services stay decoupled: data changes -> re-evaluate alerts -> tell browsers.
type Listener = (topic: string) => void;
const listeners = new Set<Listener>();
export const onBroadcast = (fn: Listener) => { listeners.add(fn); return () => listeners.delete(fn); };
export const broadcast = (topic: string) => { for (const fn of listeners) fn(topic); };

let afterChangeImpl: () => Promise<void> = async () => {};
export const setAfterChange = (fn: () => Promise<void>) => { afterChangeImpl = fn; };
/** Call after a committed change to positions, terms or prices. Never throws. */
export function afterChange(topic = 'data') {
  afterChangeImpl().catch((err) => console.error('afterChange failed', err)).finally(() => broadcast(topic));
}
