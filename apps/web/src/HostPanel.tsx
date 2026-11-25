import { useState } from 'react';
import { api, local, type View } from './api.js';
import { CopyLink, inviteLink } from './CopyLink.js';

export function HostPanel({ code, view, onChange }: { code: string; view: View; onChange: () => void }) {
  const [error, setError] = useState('');
  const [hint, setHint] = useState('');
  const [confirmEnd, setConfirmEnd] = useState(false);
  const hostUrl = local.get(`lo:host:${code}`);
  const fail = (e: Error) => setError(e.message);
  const advance = () => api.advance(code).then(onChange, fail);
  const giveHint = () =>
    api.hint(code).then((r) => {
      setHint(r.text);
      onChange();
    }, fail);
  const end = () => {
    if (!confirmEnd) return setConfirmEnd(true);
    return api.end(code).then(onChange, fail);
  };
  const suggestions = view.notices.filter((n) => n.kind === 'suggest_advance');
  const submitted = view.accusation.submitted;

  return (
    <section className="host">
      <div className="section-head">
        <h2>The host's desk</h2>
        <p className="muted small">Only you see this tab. The game runs itself; these are your overrides.</p>
      </div>
      {suggestions.length > 0 && (
        <div className="telegram host-suggestion" data-notice="suggest_advance">
          <span className="telegram-label">From the game master · for the host</span>
          {suggestions.map((n) => (
            <span key={n.id} className="telegram-text">
              {n.text}
            </span>
          ))}
        </div>
      )}
      <div className="host-grid">
        <div className="card control">
          <h3>Acts</h3>
          <ol className="act-steps" aria-label={`Act ${view.act.number} of ${view.actsTotal}`}>
            {Array.from({ length: view.actsTotal }, (_, i) => (
              <li key={i} className={i + 1 < view.act.number ? 'past' : i + 1 === view.act.number ? 'now' : ''}>
                {i + 1}
              </li>
            ))}
          </ol>
          <p>
            Now: act {view.act.number}, {view.act.name}.
          </p>
          {view.host?.canAdvance ? (
            <button className="primary" onClick={() => void advance()}>
              Advance to: {view.host.nextAct}
            </button>
          ) : (
            <p className="muted">This is the final act.</p>
          )}
        </div>
        <div className="card control">
          <h3>Hints</h3>
          <p className="muted small">The game master gives hints when the group stalls. You can give the next one now.</p>
          <button disabled={!view.host?.canHint} onClick={() => void giveHint()}>
            Give the next hint
          </button>
          {hint && <p className="small sent">Sent to everyone: {hint}</p>}
        </div>
        <div className="card control end">
          <h3>End the investigation</h3>
          <p className="muted small">
            {submitted
              ? `${submitted.by} has submitted the group's accusation. Ending shows everyone the reveal.`
              : 'No accusation yet. Ending now shows everyone the reveal without one.'}
          </p>
          <button className={confirmEnd ? 'primary danger' : 'danger-outline'} disabled={!view.host?.canEnd} onClick={() => void end()}>
            {confirmEnd ? 'Confirm: end and reveal' : 'End the investigation'}
          </button>
        </div>
        <div className="card control">
          <h3>Players</h3>
          <ul className="plain roster-list">
            {view.players.map((p, i) => (
              <li key={p.id}>
                <span className="roster-no">{String(i + 1).padStart(2, '0')}</span>
                <span className="roster-name">{p.name}</span>
                {p.isHost && <span className="badge">host</span>}
              </li>
            ))}
          </ul>
        </div>
      </div>
      {error && <p className="error">{error}</p>}
      <div className="links">
        <CopyLink label="Invite link (players)" url={inviteLink(code)} />
        {hostUrl && (
          <CopyLink
            label="Host link (keep private: it lets you back in as host)"
            url={window.location.origin + hostUrl}
          />
        )}
      </div>
    </section>
  );
}
