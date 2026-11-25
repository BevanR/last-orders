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
    <section className="stack">
      {suggestions.length > 0 && (
        <div className="card host-suggestion" data-notice="suggest_advance">
          <h3>From the game master</h3>
          {suggestions.map((n) => (
            <p key={n.id}>{n.text}</p>
          ))}
        </div>
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
      </div>
      <div className="card">
        <h3>Hints</h3>
        <p className="muted small">The game master gives hints when the group stalls. You can give the next one now.</p>
        <button disabled={!view.host?.canHint} onClick={() => void giveHint()}>
          Give the next hint
        </button>
        {hint && <p className="small">Sent to everyone: {hint}</p>}
      </div>
      <div className="card">
        <h3>End the investigation</h3>
        <p className="muted small">
          {submitted
            ? `${submitted.by} has submitted the group's accusation. Ending shows everyone the reveal.`
            : 'No accusation yet. Ending now shows everyone the reveal without one.'}
        </p>
        <button className={confirmEnd ? 'primary danger' : ''} disabled={!view.host?.canEnd} onClick={() => void end()}>
          {confirmEnd ? 'Confirm: end and reveal' : 'End the investigation'}
        </button>
      </div>
      {error && <p className="error">{error}</p>}
      <CopyLink label="Invite link (players)" url={inviteLink(code)} />
      {hostUrl && (
        <CopyLink
          label="Host link (keep private: it lets you back in as host)"
          url={window.location.origin + hostUrl}
        />
      )}
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
