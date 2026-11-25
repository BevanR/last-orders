import { useCallback, useEffect, useRef, useState, type FormEvent } from 'react';
import { api, type Interview, type Message, type View } from './api.js';
import type { MessageEvent } from './Game.js';
import { Silhouette } from './Silhouette.js';

/**
 * Splits a reply for display. A simulated reply arrives as `[simulated] Name: (stage) "words"`; the
 * transcript already names the speaker and labels the reply simulated, so only the words are shown,
 * with any stage direction apart. Other text is shown as it is.
 */
export function replyParts(m: Message, speaker: string): { stage: string; words: string } {
  if (!m.simulated || m.role !== 'suspect') return { stage: '', words: m.text };
  let t = m.text.replace(/^\[simulated\]\s*/, '');
  if (t.startsWith(`${speaker}:`)) t = t.slice(speaker.length + 1).trim();
  const stage = /^\(([^)]*)\)\s*/.exec(t);
  if (stage) t = t.slice(stage[0].length);
  const quoted = /^"([\s\S]*)"$/.exec(t);
  return { stage: stage?.[1] ?? '', words: quoted ? quoted[1]! : t };
}

export function Suspects({ code, view, messages }: { code: string; view: View; messages: EventTarget }) {
  const [open, setOpen] = useState<string | null>(null);
  const suspect = view.suspects.find((s) => s.id === open);
  if (suspect)
    return <InterviewRoom code={code} view={view} suspect={suspect} messages={messages} onBack={() => setOpen(null)} />;
  return (
    <section className="suspects">
      <p className="section-intro muted">
        Four people sat at that dinner or cooked it. Each interview is private to you.
      </p>
      <div className="dossiers">
        {view.suspects.map((s, i) => (
          <article key={s.id} className="dossier" data-suspect={s.id}>
            <div className="dossier-tab">File {String(i + 1).padStart(2, '0')}</div>
            <div className="dossier-body">
              <Silhouette id={s.id} />
              <div className="dossier-text">
                <h3>{s.name}</h3>
                <p className="dossier-role">{s.role}</p>
                <p>{s.description}</p>
              </div>
            </div>
            <button className="primary" onClick={() => setOpen(s.id)}>
              Interview
            </button>
          </article>
        ))}
      </div>
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

  const me = view.me?.name ?? 'You';

  return (
    <section className="interview">
      <div className="interview-head">
        <button className="link back" onClick={props.onBack}>
          ← Suspects
        </button>
        <div className="interview-who">
          <Silhouette id={suspect.id} size="sm" />
          <div>
            <h2>{suspect.name}</h2>
            <p className="dossier-role">{suspect.role}</p>
          </div>
        </div>
        <span className="private-note">Private: only you see this conversation.</span>
      </div>
      <div className="transcript paper">
        <p className="file-label">
          <span>Interview transcript</span>
          <span>{suspect.name}</span>
        </p>
        <div className="chat" aria-live="polite">
          {iv?.messages.length === 0 && (
            <div className="empty-chat">
              <p>Ask {suspect.name} anything, or start with their account of the evening.</p>
              <button className="ink" disabled={closed} onClick={() => void say('Tell me what happened tonight.')}>
                Ask for their account
              </button>
            </div>
          )}
          {iv?.messages.map((m) => {
            if (m.presentedEvidenceId)
              return (
                <div key={m.id} className={`bubble ${m.role} exhibit-shown`} data-role={m.role}>
                  <span className="tag-label">
                    {m.role === 'player' ? `${me} presents` : 'Presented'} · Exhibit {m.presentedEvidenceId.toUpperCase()}
                  </span>
                  <span className="words">{m.text}</span>
                </div>
              );
            const { stage, words } = replyParts(m, suspect.name);
            return (
              <div key={m.id} className={`bubble ${m.role}`} data-role={m.role}>
                <span className="speaker">
                  {m.role === 'player' ? me : m.role === 'suspect' ? suspect.name : 'Note'}
                  {m.simulated && <span className="badge sim">simulated</span>}
                </span>
                {stage && <span className="stage">({stage})</span>}
                <span className="words">{words}</span>
              </div>
            );
          })}
          {waiting && (
            <div className="bubble suspect typing">
              <span className="speaker">{suspect.name}</span>
              <span className="words">
                {suspect.name} is thinking<span className="dots" aria-hidden="true" />
              </span>
            </div>
          )}
          <div ref={endRef} />
        </div>
      </div>
      {error && <p className="error">{error}</p>}
      {closed ? (
        <p className="muted">The accusation is in. Interviews are closed.</p>
      ) : (
        <div className="desk">
          <form className="composer" onSubmit={send}>
            <label className="sr-only" htmlFor="ask-input">
              Your question
            </label>
            <input
              id="ask-input"
              name="message"
              value={text}
              maxLength={500}
              autoComplete="off"
              placeholder={`Ask ${suspect.name}…`}
              onChange={(e) => setText(e.target.value)}
              disabled={waiting}
            />
            <button className="primary" disabled={waiting || !text.trim()}>
              Ask
            </button>
          </form>
          <div className="present">
            <label className="sr-only" htmlFor="present-select">
              Evidence to show
            </label>
            <select
              id="present-select"
              name="evidence"
              value={evidenceId}
              onChange={(e) => setEvidenceId(e.target.value)}
              disabled={waiting}
            >
              <option value="">{presentable.length ? 'Show an exhibit…' : 'No exhibits yet'}</option>
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
        </div>
      )}
    </section>
  );
}
