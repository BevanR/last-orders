import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Accusation } from './Accusation.js';
import { api, ApiError, local, type Message, type View } from './api.js';
import { BehindScenes, type StreamStats } from './BehindScenes.js';
import { Board } from './Board.js';
import { CopyLink, inviteLink } from './CopyLink.js';
import { HostPanel } from './HostPanel.js';
import { NOTICE_LABEL } from './labels.js';
import { Lodge } from './Lodge.js';
import { navigate } from './nav.js';
import { RevealScreen } from './Reveal.js';
import { Suspects } from './Suspects.js';

type Tab = 'lodge' | 'suspects' | 'board' | 'accuse' | 'host';
export type MessageEvent = { suspectId: string; message: Message };

/** Everything a player sees once they are in a room. */
export function Game({ code }: { code: string }) {
  const [view, setView] = useState<View | null>(null);
  const [error, setError] = useState('');
  const [tab, setTab] = useState<Tab>('lodge');
  const [toast, setToast] = useState<{ label: string; text: string } | null>(null);
  const [bts, setBts] = useState(local.get('lo:bts') === '1');
  const [stats, setStats] = useState<StreamStats>({
    connection: 'connecting',
    lastEventId: '',
    lastType: '',
    lastAt: null,
    events: 0,
    reconnects: 0,
    replies: { live: 0, simulated: 0 },
  });
  const messages = useMemo(() => new EventTarget(), []);
  const toggleBts = () =>
    setBts((on) => {
      local.set('lo:bts', on ? '0' : '1');
      return !on;
    });

  const refresh = useCallback(async () => {
    try {
      setView(await api.state(code));
      setError('');
    } catch (e) {
      if (e instanceof ApiError && (e.status === 401 || e.status === 403)) navigate(`/r/${code}`);
      else setError((e as Error).message);
    }
  }, [code]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  // Live updates. The first state load gives the cursor; the browser resends Last-Event-ID on reconnect.
  const cursor = view?.cursor;
  const connected = cursor !== undefined;
  const cursorRef = useRef(0);
  if (cursor !== undefined && cursorRef.current === 0) cursorRef.current = cursor;
  useEffect(() => {
    if (!connected) return;
    const es = new EventSource(`${api.eventsUrl(code)}?lastEventId=${cursorRef.current}`);
    let opened = false;
    es.onopen = () => {
      setStats((s) => ({ ...s, connection: 'open', reconnects: opened ? s.reconnects + 1 : s.reconnects }));
      opened = true;
    };
    es.onerror = () =>
      setStats((s) => ({ ...s, connection: es.readyState === EventSource.CLOSED ? 'closed' : 'reconnecting' }));
    es.onmessage = (ev) => {
      const { type, payload } = JSON.parse(ev.data as string) as { type: string; payload: any };
      const reply = type === 'message' && payload?.message?.role === 'suspect';
      setStats((s) => ({
        ...s,
        connection: 'open',
        lastEventId: ev.lastEventId,
        lastType: type,
        lastAt: Date.now(),
        events: s.events + 1,
        replies: reply
          ? payload.message.simulated
            ? { ...s.replies, simulated: s.replies.simulated + 1 }
            : { ...s.replies, live: s.replies.live + 1 }
          : s.replies,
      }));
      if (type === 'message') {
        messages.dispatchEvent(new CustomEvent<MessageEvent>('message', { detail: payload }));
        return;
      }
      void refresh();
      if (type === 'board_item')
        setToast({ label: 'Board', text: `${payload.sharedBy} pinned "${payload.evidence.name}".` });
      if (type === 'act_changed')
        setToast({ label: `Act ${payload.act.number}: ${payload.act.name}`, text: payload.act.intro });
      if (type === 'game_started') setToast({ label: 'The investigation has begun', text: payload.act.intro });
      if (type === 'gm_notice') setToast({ label: NOTICE_LABEL[payload.kind] ?? 'Note', text: payload.text });
      if (type === 'accusation')
        setToast({ label: 'Accusation', text: `${payload.by} named ${payload.suspect.name}.` });
      if (type === 'game_ended') setToast({ label: 'The investigation is over', text: 'Here is what happened.' });
    };
    return () => es.close();
  }, [code, connected, messages, refresh]);

  useEffect(() => {
    if (!toast) return;
    const t = setTimeout(() => setToast(null), 7000);
    return () => clearTimeout(t);
  }, [toast]);

  if (!view)
    return (
      <main className="shell">
        {error ? <p className="error">{error}</p> : <p className="muted loading">Opening the case file…</p>}
      </main>
    );

  const isHost = !!view.host;
  const accuseVisible = view.accusation.open || view.accusation.submitted !== null;
  const tabs: [Tab, string][] = [
    ['lodge', 'The Lodge'],
    ['suspects', 'Suspects'],
    ['board', `Board${view.board.length ? ` (${view.board.length})` : ''}`],
  ];
  if (accuseVisible) tabs.push(['accuse', 'Accuse']);
  if (isHost) tabs.push(['host', 'Host']);
  const active = view.status === 'active';

  return (
    <div className={active ? 'app has-tabs' : 'app'}>
      <header className="masthead">
        <div className="rain far" aria-hidden="true" />
        <div className="rain near" aria-hidden="true" />
        <div className="masthead-inner">
          <div className="masthead-title">
            <div className="brand small">{view.title}</div>
            <div className="act-line">
              {view.status === 'ended'
                ? 'The reveal'
                : view.status === 'lobby'
                  ? 'The waiting room'
                  : `Act ${view.act.number} of ${view.actsTotal}: ${view.act.name}`}
            </div>
          </div>
          <div className="masthead-tools">
            <div className="room-code" title="Room code">
              <span className="room-label">Room</span>
              {code}
            </div>
            <button
              className={bts ? 'icon-btn on' : 'icon-btn'}
              aria-pressed={bts}
              aria-label="Behind the scenes"
              title="Behind the scenes"
              onClick={toggleBts}
            >
              <svg viewBox="0 0 24 24" aria-hidden="true">
                <path d="M4 7h10M18 7h2M4 17h4M12 17h8" />
                <circle cx="16" cy="7" r="2" />
                <circle cx="10" cy="17" r="2" />
              </svg>
            </button>
          </div>
        </div>
        {active && (
          <nav className="tabs" role="tablist" aria-label="Case file sections">
            {tabs.map(([id, label]) => (
              <button
                key={id}
                role="tab"
                aria-selected={tab === id}
                className={tab === id ? 'tab active' : 'tab'}
                onClick={() => setTab(id)}
              >
                <TabIcon id={id} />
                <span>{label}</span>
              </button>
            ))}
          </nav>
        )}
      </header>
      {toast && (
        <div className="telegram toast" role="status" key={toast.label + toast.text}>
          <span className="telegram-label">{toast.label}</span>
          <span className="telegram-text">{toast.text}</span>
        </div>
      )}
      <main className="shell">
        {bts && <BehindScenes stats={stats} view={view} code={code} />}
        {error && <p className="error">{error}</p>}

        {view.status === 'lobby' && <WaitingRoom code={code} view={view} onError={setError} />}
        {view.status === 'ended' && <RevealScreen view={view} />}
        {active && (
          <div className="tab-panel" key={tab}>
            {tab === 'lodge' && <Lodge code={code} view={view} onChange={refresh} />}
            {tab === 'suspects' && <Suspects code={code} view={view} messages={messages} />}
            {tab === 'board' && <Board code={code} view={view} onChange={refresh} />}
            {tab === 'accuse' && accuseVisible && <Accusation code={code} view={view} onChange={refresh} />}
            {tab === 'host' && isHost && <HostPanel code={code} view={view} onChange={refresh} />}
          </div>
        )}
      </main>
    </div>
  );
}

function TabIcon({ id }: { id: Tab }) {
  const paths: Record<Tab, React.ReactNode> = {
    lodge: <path d="M3 11 12 4l9 7M5 10v10h14V10M10 20v-5h4v5" />,
    suspects: (
      <>
        <circle cx="9" cy="8" r="3.2" />
        <path d="M3 20c0-3.6 2.7-6 6-6s6 2.4 6 6" />
        <path d="M15.5 5.2a3 3 0 0 1 0 5.6M17 14.3c2.3.6 4 2.6 4 5.7" />
      </>
    ),
    board: (
      <>
        <rect x="3" y="4" width="18" height="16" rx="1" />
        <circle cx="9" cy="9" r="1.4" />
        <circle cx="15.5" cy="13" r="1.4" />
        <path d="M9 9l6.5 4" />
      </>
    ),
    accuse: (
      <>
        <circle cx="12" cy="12" r="8" />
        <circle cx="12" cy="12" r="3" />
        <path d="M12 2v4M12 18v4M2 12h4M18 12h4" />
      </>
    ),
    host: <path d="M4 6h9M17 6h3M4 12h3M11 12h9M4 18h11M19 18h1M15 4v4M7 10v4M15 16v4" />,
  };
  return (
    <svg className="tab-icon" viewBox="0 0 24 24" aria-hidden="true">
      {paths[id]}
    </svg>
  );
}

function WaitingRoom({ code, view, onError }: { code: string; view: View; onError: (m: string) => void }) {
  return (
    <section className="waiting">
      <article className="paper brief">
        <p className="file-label">
          <span>Case brief</span>
          <span>Read before you start</span>
        </p>
        <p className="lede">{view.intro}</p>
      </article>
      <div className="waiting-side">
        <div className="card roster">
          <h2>Investigators</h2>
          <ul className="plain roster-list">
            {view.players.map((p, i) => (
              <li key={p.id}>
                <span className="roster-no">{String(i + 1).padStart(2, '0')}</span>
                <span className="roster-name">{p.name}</span>
                {p.isHost && <span className="badge">host</span>}
                {p.id === view.me?.id && <span className="badge accent">you</span>}
              </li>
            ))}
          </ul>
        </div>
        <CopyLink label="Invite link: send it to the others" url={inviteLink(code)} />
        {view.host?.canStart ? (
          <button className="primary big" onClick={() => api.start(code).catch((e: Error) => onError(e.message))}>
            Start the game
          </button>
        ) : (
          <p className="muted waiting-note">Waiting for the host to start…</p>
        )}
      </div>
    </section>
  );
}
