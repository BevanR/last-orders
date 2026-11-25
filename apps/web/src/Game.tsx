import { useCallback, useEffect, useMemo, useRef, useState, type FormEvent } from 'react';
import { api, ApiError, local, type GameView, type InspectResult, type Interview, type Message } from './api.js';
import { navigate } from './nav.js';

type View = GameView & { cursor: number };
type Tab = 'lodge' | 'suspects' | 'board' | 'host';
type MessageEvent = { suspectId: string; message: Message };

/** Everything a player sees once they are in a room. */
export function Game({ code }: { code: string }) {
  const [view, setView] = useState<View | null>(null);
  const [error, setError] = useState('');
  const [tab, setTab] = useState<Tab>('lodge');
  const [notice, setNotice] = useState('');
  const messages = useMemo(() => new EventTarget(), []);

  const refresh = useCallback(async () => {
    try {
      setView((await api.state(code)) as View);
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
      if (type === 'board_item') setNotice(`${payload.sharedBy} pinned "${payload.evidence.name}" to the board.`);
      if (type === 'act_changed') setNotice(`Act ${payload.act.number}: ${payload.act.name}`);
      if (type === 'game_started') setNotice('The investigation has begun.');
    };
    return () => es.close();
  }, [code, connected, messages, refresh]);

  useEffect(() => {
    if (!notice) return;
    const t = setTimeout(() => setNotice(''), 4000);
    return () => clearTimeout(t);
  }, [notice]);

  if (!view)
    return (
      <main className="shell">{error ? <p className="error">{error}</p> : <p className="muted">Loading…</p>}</main>
    );

  const isHost = !!view.host;
  const tabs: [Tab, string][] = [
    ['lodge', 'The Lodge'],
    ['suspects', 'Suspects'],
    ['board', `Board${view.board.length ? ` (${view.board.length})` : ''}`],
  ];
  if (isHost) tabs.push(['host', 'Host']);

  return (
    <main className="shell">
      <header className="topbar">
        <div>
          <div className="brand small">{view.title}</div>
          <div className="muted small">
            Act {view.act.number} of {view.actsTotal}: {view.act.name}
          </div>
        </div>
        <div className="room-code" title="Room code">
          {code}
        </div>
      </header>
      {notice && (
        <div className="notice" role="status">
          {notice}
        </div>
      )}
      {error && <p className="error">{error}</p>}

      {view.status === 'lobby' ? (
        <WaitingRoom code={code} view={view} onError={setError} />
      ) : (
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
          {tab === 'host' && isHost && <HostPanel code={code} view={view} onChange={refresh} />}
        </>
      )}
    </main>
  );
}

function inviteLink(code: string) {
  return `${window.location.origin}/r/${code}`;
}

function CopyLink({ label, url }: { label: string; url: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <div className="copy">
      <span className="muted small">{label}</span>
      <div className="copy-row">
        <input readOnly value={url} onFocus={(e) => e.currentTarget.select()} />
        <button
          onClick={() =>
            navigator.clipboard?.writeText(url).then(
              () => setCopied(true),
              () => {},
            )
          }
        >
          {copied ? 'Copied' : 'Copy'}
        </button>
      </div>
    </div>
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

function Lodge({ code, view, onChange }: { code: string; view: View; onChange: () => void }) {
  const [results, setResults] = useState<Record<string, InspectResult>>({});
  const [busy, setBusy] = useState('');
  const [error, setError] = useState('');
  const inspect = async (id: string) => {
    setBusy(id);
    setError('');
    try {
      const r = await api.inspect(code, id);
      setResults((prev) => ({ ...prev, [id]: r }));
      onChange();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy('');
    }
  };
  return (
    <section className="stack">
      <p className="muted">{view.act.intro}</p>
      {error && <p className="error">{error}</p>}
      {view.locations.map((l) => {
        const r = results[l.id];
        return (
          <article key={l.id} className="card" data-location={l.id}>
            <h3>{l.name}</h3>
            <p>{l.description}</p>
            <button disabled={busy === l.id || !view.actions.inspect.includes(l.id)} onClick={() => inspect(l.id)}>
              {l.visited ? 'Search again' : 'Inspect'}
            </button>
            {r && (
              <div className="result">
                <p className="muted">{r.text}</p>
                {r.found.length === 0 ? (
                  <p className="muted small">Nothing new.</p>
                ) : (
                  r.found.map((e) => (
                    <p key={e.id} className="found">
                      <strong>Found: {e.name}.</strong> {e.text}{' '}
                      <span className="muted small">(Added to your notebook.)</span>
                    </p>
                  ))
                )}
              </div>
            )}
          </article>
        );
      })}
    </section>
  );
}

function Board({ code, view, onChange }: { code: string; view: View; onChange: () => void }) {
  const [error, setError] = useState('');
  const share = (id: string) => api.share(code, id).then(onChange, (e: Error) => setError(e.message));
  return (
    <section className="stack">
      <h2>Evidence board</h2>
      {view.board.length === 0 && <p className="muted">Nothing pinned yet. Share what you find.</p>}
      <div className="cards">
        {view.board.map((e) => (
          <article key={e.id} className="evidence" data-evidence={e.id}>
            <h3>{e.name}</h3>
            <p>{e.description}</p>
            <p className="muted small">Pinned by {e.sharedBy}</p>
          </article>
        ))}
      </div>
      <h2>Your notebook</h2>
      {error && <p className="error">{error}</p>}
      {view.notebook.length === 0 && <p className="muted">You have not found anything yet.</p>}
      <div className="cards">
        {view.notebook.map((e) => (
          <article key={e.id} className="evidence private" data-notebook={e.id}>
            <h3>{e.name}</h3>
            <p>{e.description}</p>
            {e.shared ? (
              <p className="muted small">On the board.</p>
            ) : (
              <button onClick={() => void share(e.id)}>Share to board</button>
            )}
          </article>
        ))}
      </div>
    </section>
  );
}

function Suspects({ code, view, messages }: { code: string; view: View; messages: EventTarget }) {
  const [open, setOpen] = useState<string | null>(null);
  const suspect = view.suspects.find((s) => s.id === open);
  if (suspect)
    return <InterviewRoom code={code} view={view} suspect={suspect} messages={messages} onBack={() => setOpen(null)} />;
  return (
    <section className="stack">
      {view.suspects.map((s) => (
        <article key={s.id} className="card suspect" data-suspect={s.id}>
          <h3>
            {s.name} <span className="muted small">{s.role}</span>
          </h3>
          <p>{s.description}</p>
          <button onClick={() => setOpen(s.id)}>Interview</button>
        </article>
      ))}
    </section>
  );
}

function InterviewRoom(props: {
  code: string;
  view: View;
  suspect: View['suspects'][number];
  messages: EventTarget;
  onBack: () => void;
}) {
  const { code, view, suspect, messages } = props;
  const [iv, setIv] = useState<Interview | null>(null);
  const [text, setText] = useState('');
  const [evidenceId, setEvidenceId] = useState('');
  const [error, setError] = useState('');
  const endRef = useRef<HTMLDivElement>(null);

  const add = useCallback((m: Message) => {
    setIv((prev) => {
      if (!prev || prev.messages.some((x) => x.id === m.id)) return prev;
      const all = [...prev.messages, m].sort((a, b) => Number(a.id) - Number(b.id));
      return { ...prev, messages: all, waiting: all[all.length - 1]!.role === 'player' };
    });
  }, []);

  useEffect(() => {
    api.interview(code, suspect.id).then(setIv, (e: Error) => setError(e.message));
    const on = (ev: Event) => {
      const d = (ev as CustomEvent<MessageEvent>).detail;
      if (d.suspectId === suspect.id) add(d.message);
    };
    messages.addEventListener('message', on);
    return () => messages.removeEventListener('message', on);
  }, [code, suspect.id, messages, add]);

  useEffect(() => {
    endRef.current?.scrollIntoView({ block: 'end' });
  }, [iv?.messages.length, iv?.waiting]);

  const cards = new Map([...view.notebook, ...view.board].map((e) => [e.id, e.name]));
  const presentable = view.actions.present.map((id) => ({ id, name: cards.get(id) ?? id }));
  const waiting = iv?.waiting ?? false;

  const send = async (e: FormEvent) => {
    e.preventDefault();
    const t = text.trim();
    if (!t) return;
    setError('');
    try {
      const r = await api.say(code, suspect.id, t);
      setText('');
      add(r.message);
    } catch (err) {
      setError((err as Error).message);
    }
  };
  const present = async () => {
    if (!evidenceId) return;
    setError('');
    try {
      const r = await api.present(code, suspect.id, evidenceId);
      setEvidenceId('');
      add(r.message);
    } catch (err) {
      setError((err as Error).message);
    }
  };

  return (
    <section className="interview">
      <div className="interview-head">
        <button className="link" onClick={props.onBack}>
          ← Suspects
        </button>
        <h2>{suspect.name}</h2>
        <span className="muted small">Private: only you see this conversation.</span>
      </div>
      <div className="chat" aria-live="polite">
        {iv?.messages.length === 0 && <p className="muted">Ask {suspect.name} anything.</p>}
        {iv?.messages.map((m) => (
          <div key={m.id} className={`bubble ${m.role}`} data-role={m.role}>
            {m.presentedEvidenceId && <span className="badge evidence-badge">Evidence</span>}
            {m.text}
            {m.simulated && <span className="badge">simulated</span>}
          </div>
        ))}
        {waiting && <div className="bubble suspect typing">{suspect.name} is thinking…</div>}
        <div ref={endRef} />
      </div>
      {error && <p className="error">{error}</p>}
      <form className="composer" onSubmit={send}>
        <input
          name="message"
          value={text}
          maxLength={500}
          placeholder={`Ask ${suspect.name}…`}
          onChange={(e) => setText(e.target.value)}
          disabled={waiting}
        />
        <button className="primary" disabled={waiting || !text.trim()}>
          Ask
        </button>
      </form>
      <div className="present">
        <select name="evidence" value={evidenceId} onChange={(e) => setEvidenceId(e.target.value)} disabled={waiting}>
          <option value="">Present evidence…</option>
          {presentable.map((e) => (
            <option key={e.id} value={e.id}>
              {e.name}
            </option>
          ))}
        </select>
        <button onClick={() => void present()} disabled={waiting || !evidenceId}>
          Present
        </button>
      </div>
    </section>
  );
}

function HostPanel({ code, view, onChange }: { code: string; view: View; onChange: () => void }) {
  const [error, setError] = useState('');
  const hostUrl = local.get(`lo:host:${code}`);
  const advance = () => api.advance(code).then(onChange, (e: Error) => setError(e.message));
  return (
    <section className="stack">
      <CopyLink label="Invite link (players)" url={inviteLink(code)} />
      {hostUrl && (
        <CopyLink
          label="Host link (keep private: it lets you back in as host)"
          url={window.location.origin + hostUrl}
        />
      )}
      <div className="card">
        <h3>Acts</h3>
        <p>
          Now: act {view.act.number}, {view.act.name}.
        </p>
        {view.host?.canAdvance ? (
          <button onClick={() => void advance()}>Advance to: {view.host.nextAct}</button>
        ) : (
          <p className="muted">This is the final act.</p>
        )}
        {error && <p className="error">{error}</p>}
      </div>
      <div className="card">
        <h3>Players</h3>
        <ul className="plain">
          {view.players.map((p) => (
            <li key={p.id}>{p.name}</li>
          ))}
        </ul>
      </div>
    </section>
  );
}
