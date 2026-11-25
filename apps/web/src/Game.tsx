import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Accusation } from './Accusation.js';
import { api, ApiError, type Message, type View } from './api.js';
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
  const messages = useMemo(() => new EventTarget(), []);

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
    es.onmessage = (ev) => {
      const { type, payload } = JSON.parse(ev.data as string) as { type: string; payload: any };
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
      <main className="shell">{error ? <p className="error">{error}</p> : <p className="muted">Loading…</p>}</main>
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

  return (
    <main className="shell">
      <header className="topbar">
        <div>
          <div className="brand small">{view.title}</div>
          <div className="muted small">
            {view.status === 'ended' ? 'The reveal' : `Act ${view.act.number} of ${view.actsTotal}: ${view.act.name}`}
          </div>
        </div>
        <div className="room-code" title="Room code">
          {code}
        </div>
      </header>
      {toast && (
        <div className="notice" role="status">
          <strong>{toast.label}.</strong> {toast.text}
        </div>
      )}
      {error && <p className="error">{error}</p>}

      {view.status === 'lobby' && <WaitingRoom code={code} view={view} onError={setError} />}
      {view.status === 'ended' && <RevealScreen view={view} />}
      {view.status === 'active' && (
        <>
          <nav className="tabs" role="tablist">
            {tabs.map(([id, label]) => (
              <button
                key={id}
                role="tab"
                aria-selected={tab === id}
                className={tab === id ? 'tab active' : 'tab'}
                onClick={() => setTab(id)}
              >
                {label}
              </button>
            ))}
          </nav>
          {tab === 'lodge' && <Lodge code={code} view={view} onChange={refresh} />}
          {tab === 'suspects' && <Suspects code={code} view={view} messages={messages} />}
          {tab === 'board' && <Board code={code} view={view} onChange={refresh} />}
          {tab === 'accuse' && accuseVisible && <Accusation code={code} view={view} onChange={refresh} />}
          {tab === 'host' && isHost && <HostPanel code={code} view={view} onChange={refresh} />}
        </>
      )}
    </main>
  );
}

function WaitingRoom({ code, view, onError }: { code: string; view: View; onError: (m: string) => void }) {
  return (
    <section className="stack">
      <p>{view.intro}</p>
      <div className="card">
        <h2>Players</h2>
        <ul className="plain">
          {view.players.map((p) => (
            <li key={p.id}>
              {p.name}
              {p.isHost && <span className="badge">host</span>}
              {p.id === view.me?.id && <span className="badge">you</span>}
            </li>
          ))}
        </ul>
      </div>
      <CopyLink label="Invite link" url={inviteLink(code)} />
      {view.host?.canStart ? (
        <button className="primary" onClick={() => api.start(code).catch((e: Error) => onError(e.message))}>
          Start the game
        </button>
      ) : (
        <p className="muted">Waiting for the host to start…</p>
      )}
    </section>
  );
}
