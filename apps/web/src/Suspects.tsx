import { useCallback, useEffect, useRef, useState, type FormEvent } from 'react';
import { api, type Interview, type Message, type View } from './api.js';
import type { MessageEvent } from './Game.js';

export function Suspects({ code, view, messages }: { code: string; view: View; messages: EventTarget }) {
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
  const closed = !view.actions.interview.includes(suspect.id);

  const say = async (t: string) => {
    setError('');
    try {
      const r = await api.say(code, suspect.id, t);
      setText('');
      add(r.message);
    } catch (err) {
      setError((err as Error).message);
    }
  };
  const send = (e: FormEvent) => {
    e.preventDefault();
    const t = text.trim();
    if (t) void say(t);
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
        {iv?.messages.length === 0 && (
          <div className="empty-chat">
            <p className="muted">Ask {suspect.name} anything, or start with their account of the evening.</p>
            <button disabled={closed} onClick={() => void say('Tell me what happened tonight.')}>
              Ask for their account
            </button>
          </div>
        )}
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
      {closed ? (
        <p className="muted">The accusation is in. Interviews are closed.</p>
      ) : (
        <>
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
            <select
              name="evidence"
              value={evidenceId}
              onChange={(e) => setEvidenceId(e.target.value)}
              disabled={waiting}
            >
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
        </>
      )}
    </section>
  );
}
