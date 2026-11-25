import type { View } from './api.js';

export type Connection = 'connecting' | 'open' | 'reconnecting' | 'closed';

/** What this browser has seen on the live stream. Kept client-side; nothing here comes from hidden state. */
export interface StreamStats {
  connection: Connection;
  lastEventId: string;
  lastType: string;
  lastAt: number | null;
  events: number;
  reconnects: number;
  replies: { live: number; simulated: number };
}

const CONNECTION_LABEL: Record<Connection, string> = {
  connecting: 'Connecting',
  open: 'Open',
  reconnecting: 'Reconnecting',
  closed: 'Closed',
};

/**
 * The demo's developer view: the state of this browser's live connection and what kind of replies
 * it has received. It shows only what the client already holds.
 */
export function BehindScenes({ stats, view, code }: { stats: StreamStats; view: View; code: string }) {
  const ago = stats.lastAt ? Math.max(0, Math.round((Date.now() - stats.lastAt) / 1000)) : null;
  const commentary = view.commentary ? (view.commentary.simulated ? 'Simulated' : 'Live model') : '—';
  return (
    <section className="bts" aria-label="Behind the scenes">
      <div className="bts-head">
        <h2>Behind the scenes</h2>
        <span className="muted small">What this browser knows. No hidden game state.</span>
      </div>
      <dl className="bts-grid">
        <div>
          <dt>Live updates (SSE)</dt>
          <dd>
            <span className={`dot ${stats.connection}`} aria-hidden="true" /> {CONNECTION_LABEL[stats.connection]}
            {stats.reconnects > 0 && (
              <span className="muted">
                {' '}
                · {stats.reconnects} {stats.reconnects === 1 ? 'reconnect' : 'reconnects'}
              </span>
            )}
          </dd>
        </div>
        <div>
          <dt>Last event id</dt>
          <dd>
            <code>{stats.lastEventId || String(view.cursor)}</code>
            {stats.lastType && <span className="muted"> · {stats.lastType}</span>}
            {ago !== null && <span className="muted"> · {ago}s ago</span>}
          </dd>
        </div>
        <div>
          <dt>Events this session</dt>
          <dd>
            <code>{stats.events}</code>
          </dd>
        </div>
        <div>
          <dt>Suspect replies seen</dt>
          <dd>
            <code>{stats.replies.live}</code> live model · <code>{stats.replies.simulated}</code> simulated
          </dd>
        </div>
        <div>
          <dt>Room</dt>
          <dd>
            <code>{code}</code> · {view.status} · act {view.act.number}/{view.actsTotal} · {view.players.length}{' '}
            {view.players.length === 1 ? 'player' : 'players'}
          </dd>
        </div>
        <div>
          <dt>Reveal commentary</dt>
          <dd>{commentary}</dd>
        </div>
      </dl>
      <p className="bts-pipe small">
        <span>Browser</span> ⇄ <span>Fly app · SSE</span> → <span>Postgres (MPG)</span> ← <span>Sprite agent</span> →{' '}
        <span>Claude via connector</span>
      </p>
    </section>
  );
}
