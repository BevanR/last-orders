import { useState } from 'react';
import { api, type InspectResult, type View } from './api.js';
import { NOTICE_LABEL } from './labels.js';

/** One line of atmosphere per room. Flavour only: nothing here bears on the case. */
const ATMOSPHERE: Record<string, string> = {
  'dining-room': 'The candles are still lit for a toast nobody made.',
  'wine-cellar': 'Fourteen steps down, and every one of them cold.',
  kitchen: 'The radio is still on. Nobody has had the heart to turn it off.',
  office: 'A desk lamp left on, lighting nobody.',
  'boot-room': 'Gumboots in pairs, mostly. Helen\u2019s sign has opinions.',
  woodshed: 'The weka has seen everything and will say nothing.',
};

/** The rooms of the lodge, their visible actions, the map, and the game master's notices. */
export function Lodge({ code, view, onChange }: { code: string; view: View; onChange: () => void }) {
  const [results, setResults] = useState<Record<string, InspectResult>>({});
  const [busy, setBusy] = useState('');
  const [error, setError] = useState('');
  const canAct = (locationId: string) => view.actions.inspect.includes(locationId);
  const inspect = async (locationId: string, actionId: string) => {
    const key = `${locationId}/${actionId}`;
    setBusy(key);
    setError('');
    try {
      const r = await api.inspect(code, locationId, actionId);
      setResults((prev) => ({ ...prev, [key]: r }));
      onChange();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy('');
    }
  };
  const notices = view.notices.filter((n) => n.kind !== 'suggest_advance');
  return (
    <section className="lodge">
      <p className="dispatch">
        <span className="dispatch-label">
          Act {view.act.number} · {view.act.name}
        </span>
        {view.act.intro}
      </p>
      {notices.length > 0 && (
        <section className="gm-notices" aria-label="From the game master">
          <h2 className="section-label">From the game master</h2>
          <ul className="plain telegrams">
            {[...notices].reverse().map((n) => (
              <li key={n.id} className={`telegram gm-notice ${n.kind}`} data-notice={n.kind}>
                <span className="telegram-label">{NOTICE_LABEL[n.kind]}</span>
                <span className="telegram-text">{n.text}</span>
              </li>
            ))}
          </ul>
        </section>
      )}
      <details className="card map">
        <summary>
          <span>Map of the lodge</span>
          <span className="muted small">How the rooms connect</span>
        </summary>
        <p>{view.layout}</p>
      </details>
      {error && <p className="error">{error}</p>}
      <div className="rooms">
        {view.locations.map((l, i) => (
          <article
            key={l.id}
            className={`card room${l.highlighted ? ' highlighted' : ''}${l.visited ? ' visited' : ''}`}
            data-location={l.id}
          >
            <header className="room-head">
              <span className="room-no">Room {String(i + 1).padStart(2, '0')}</span>
              {l.highlighted && <span className="badge accent">Worth a look</span>}
            </header>
            <h3>{l.name}</h3>
            {ATMOSPHERE[l.id] && <p className="atmos">{ATMOSPHERE[l.id]}</p>}
            <p className="room-desc">{l.description}</p>
            <div className="actions">
              {l.actions.map((a) => (
                <button
                  key={a.id}
                  data-action={a.id}
                  className={a.done ? 'inspect done' : 'inspect'}
                  disabled={busy !== '' || !canAct(l.id)}
                  onClick={() => void inspect(l.id, a.id)}
                >
                  <svg className="btn-icon" viewBox="0 0 24 24" aria-hidden="true">
                    {a.done ? <path d="M5 12.5l4.5 4.5L19 7.5" /> : <><circle cx="10.5" cy="10.5" r="6" /><path d="M15 15l5 5" /></>}
                  </svg>
                  <span>{a.label}</span>
                  {a.done && <span className="done-note"> (done)</span>}
                </button>
              ))}
            </div>
            {l.actions.map((a) => {
              const r = results[`${l.id}/${a.id}`];
              if (!r) return null;
              return (
                <div key={a.id} className="result">
                  <p className="result-text">{r.text}</p>
                  {r.found.length === 0 ? (
                    <p className="muted small">Nothing new.</p>
                  ) : (
                    r.found.map((e) => (
                      <div key={e.id} className="found evidence-tag">
                        <p className="tag-label">
                          Exhibit {e.id.toUpperCase()} · added to your notebook
                        </p>
                        <p>
                          <strong>Found: {e.name}.</strong> {e.text}
                        </p>
                      </div>
                    ))
                  )}
                </div>
              );
            })}
          </article>
        ))}
      </div>
    </section>
  );
}
