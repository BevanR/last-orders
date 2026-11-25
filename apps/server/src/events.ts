import pg from 'pg';
import type { Tx } from './db.js';

export const EVENTS_CHANNEL = 'game_events';

export interface StoredEvent {
  seq: number;
  type: string;
  payload: unknown;
}

/**
 * Append an event to the game's log and notify listeners on commit. The caller's transaction
 * must hold the game row lock (see lockGame), so seq order matches commit order.
 */
export async function emit(tx: Tx, gameId: string, audience: string, type: string, payload: unknown) {
  const { rows } = await tx.query<{ event_seq: string }>(
    'UPDATE games SET event_seq = event_seq + 1 WHERE id = $1 RETURNING event_seq',
    [gameId],
  );
  const seq = Number(rows[0]!.event_seq);
  await tx.query('INSERT INTO game_events (game_id, seq, audience, type, payload) VALUES ($1, $2, $3, $4, $5)', [
    gameId,
    seq,
    audience,
    type,
    JSON.stringify(payload),
  ]);
  await tx.query('SELECT pg_notify($1, $2)', [EVENTS_CHANNEL, gameId]);
  return seq;
}

type Listener = () => void;

/**
 * One LISTEN connection per process. Fans notifications out to in-process subscribers by game
 * id. Reconnects with backoff; on reconnect every subscriber is poked so it re-reads the log.
 */
export class NotifyHub {
  private client: pg.Client | null = null;
  private subs = new Map<string, Set<Listener>>();
  private closed = false;
  private retryMs = 500;

  constructor(
    private readonly databaseUrl: string,
    private readonly log: (msg: string) => void = () => {},
  ) {}

  async start(): Promise<void> {
    const client = new pg.Client({ connectionString: this.databaseUrl });
    client.on('notification', (n) => {
      if (n.channel === EVENTS_CHANNEL && n.payload) this.poke(n.payload);
    });
    client.on('error', (err) => {
      this.log(`notify connection error: ${err.message}`);
      this.reconnect(client);
    });
    client.on('end', () => this.reconnect(client));
    await client.connect();
    await client.query(`LISTEN ${EVENTS_CHANNEL}`);
    this.client = client;
    this.retryMs = 500;
  }

  private reconnect(old: pg.Client) {
    if (this.closed || this.client !== old) return;
    this.client = null;
    old.removeAllListeners();
    old.end().catch(() => {});
    setTimeout(() => {
      this.start()
        .then(() => {
          for (const id of this.subs.keys()) this.poke(id);
        })
        .catch((err: Error) => {
          this.log(`notify reconnect failed: ${err.message}`);
          this.retryMs = Math.min(this.retryMs * 2, 10_000);
          this.client = old;
          this.reconnect(old);
        });
    }, this.retryMs);
  }

  subscribe(gameId: string, fn: Listener): () => void {
    let set = this.subs.get(gameId);
    if (!set) this.subs.set(gameId, (set = new Set()));
    set.add(fn);
    return () => {
      set.delete(fn);
      if (set.size === 0) this.subs.delete(gameId);
    };
  }

  poke(gameId: string) {
    for (const fn of this.subs.get(gameId) ?? []) fn();
  }

  async close() {
    this.closed = true;
    const c = this.client;
    this.client = null;
    if (c) {
      c.removeAllListeners();
      await c.end().catch(() => {});
    }
  }
}
