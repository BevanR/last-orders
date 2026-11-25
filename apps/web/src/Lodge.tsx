import { useState } from 'react';
import { api, type InspectResult, type View } from './api.js';
import { NOTICE_LABEL } from './labels.js';

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
    <section className="stack">
      <p className="muted">{view.act.intro}</p>
      {notices.length > 0 && (
        <div className="card gm-notices" aria-label="From the game master">
          <h3>From the game master</h3>
          <ul className="plain">
            {notices.map((n) => (
              <li key={n.id} className={`gm-notice ${n.kind}`} data-notice={n.kind}>
                <span className="badge">{NOTICE_LABEL[n.kind]}</span> {n.text}
              </li>
            ))}
          </ul>
        </div>
      )}
      <details className="card map">
        <summary>Map of the lodge</summary>
        <p>{view.layout}</p>
      </details>
      {error && <p className="error">{error}</p>}
      {view.locations.map((l) => (
        <article key={l.id} className={l.highlighted ? 'card highlighted' : 'card'} data-location={l.id}>
          <h3>
            {l.name}
            {l.highlighted && <span className="badge accent">Worth a look</span>}
          </h3>
          <p>{l.description}</p>
          <div className="actions">
            {l.actions.map((a) => (
              <button
                key={a.id}
                data-action={a.id}
                disabled={busy !== '' || !canAct(l.id)}
                onClick={() => void inspect(l.id, a.id)}
              >
                {a.label}
                {a.done && <span className="muted small"> (done)</span>}
              </button>
            ))}
          </div>
          {l.actions.map((a) => {
            const r = results[`${l.id}/${a.id}`];
            if (!r) return null;
            return (
              <div key={a.id} className="result">
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
            );
          })}
        </article>
      ))}
    </section>
  );
}
