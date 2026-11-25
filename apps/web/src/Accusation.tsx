import { useState, type FormEvent } from 'react';
import { api, type View } from './api.js';
import { Silhouette } from './Silhouette.js';

/**
 * The group's accusation: one suspect, up to the case's limit of cards, and optional reasoning.
 * Any player can submit it for the group; it is final, and its verdict stays hidden until the
 * host ends the investigation.
 */
export function Accusation({ code, view, onChange }: { code: string; view: View; onChange: () => void }) {
  const [suspectId, setSuspectId] = useState('');
  const [picked, setPicked] = useState<string[]>([]);
  const [reasoning, setReasoning] = useState('');
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const a = view.accusation;

  if (a.submitted)
    return (
      <section className="stack">
        <div className="paper accusation-summary" data-accusation="submitted">
          <p className="file-label">
            <span>Charge sheet</span>
            <span>Submitted</span>
          </p>
          <span className="stamp" aria-hidden="true">
            Filed
          </span>
          <h2>The group's accusation</h2>
          <p>
            <strong>{a.submitted.by}</strong> named <strong>{a.submitted.suspectName}</strong>.
          </p>
          {a.submitted.evidence.length > 0 && (
            <ul className="plain exhibit-list">
              {a.submitted.evidence.map((e) => (
                <li key={e.id}>
                  <span className="tag-label">Exhibit {e.id.toUpperCase()}</span> {e.name}
                </li>
              ))}
            </ul>
          )}
          {a.submitted.reasoning && <blockquote>{a.submitted.reasoning}</blockquote>}
          <p className="paper-muted">Waiting for the host to end the investigation and reveal what happened.</p>
        </div>
      </section>
    );

  const held = new Map([...view.notebook, ...view.board].map((e) => [e.id, e]));
  const cards = view.actions.present.flatMap((id) => (held.get(id) ? [held.get(id)!] : []));
  const toggle = (id: string) =>
    setPicked((prev) =>
      prev.includes(id) ? prev.filter((x) => x !== id) : prev.length < a.maxEvidence ? [...prev, id] : prev,
    );
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (!suspectId) return;
    if (!confirming) {
      setConfirming(true);
      return;
    }
    setBusy(true);
    setError('');
    try {
      await api.accuse(code, suspectId, picked, reasoning.trim());
      onChange();
    } catch (err) {
      setError((err as Error).message);
      setConfirming(false);
    } finally {
      setBusy(false);
    }
  };
  const name = view.suspects.find((s) => s.id === suspectId)?.name;

  return (
    <form className="accuse paper" onSubmit={submit}>
      <p className="file-label">
        <span>Charge sheet</span>
        <span>One name. No second go.</span>
      </p>
      <h2>Accuse</h2>
      <p className="paper-muted">
        Agree as a group, then one of you submits. Name one suspect and cite up to {a.maxEvidence} cards. This is final.
      </p>
      <fieldset>
        <legend>Who killed Helen Marsh?</legend>
        <div className="suspect-choices">
          {view.suspects.map((s) => (
            <label key={s.id} className={suspectId === s.id ? 'choice suspect-choice picked' : 'choice suspect-choice'}>
              <input
                type="radio"
                name="suspect"
                value={s.id}
                checked={suspectId === s.id}
                onChange={() => {
                  setSuspectId(s.id);
                  setConfirming(false);
                }}
              />
              <Silhouette id={s.id} size="sm" />
              <span>{s.name}</span>
            </label>
          ))}
        </div>
      </fieldset>
      <fieldset>
        <legend>
          Evidence ({picked.length} of {a.maxEvidence})
        </legend>
        {cards.length === 0 && <p className="paper-muted">You hold no cards. Share finds to the board first.</p>}
        <div className="exhibit-choices">
          {cards.map((e) => (
            <label key={e.id} className={picked.includes(e.id) ? 'choice exhibit-choice picked' : 'choice exhibit-choice'}>
              <input
                type="checkbox"
                name="evidence"
                value={e.id}
                checked={picked.includes(e.id)}
                disabled={!picked.includes(e.id) && picked.length >= a.maxEvidence}
                onChange={() => {
                  toggle(e.id);
                  setConfirming(false);
                }}
              />
              <span className="tag-label">{e.id.toUpperCase()}</span>
              <span>{e.name}</span>
            </label>
          ))}
        </div>
      </fieldset>
      <label className="field">
        <span className="legend-like">Your reasoning (optional)</span>
        <textarea
          name="reasoning"
          value={reasoning}
          maxLength={1000}
          rows={4}
          placeholder="Why them, and what the cards show."
          onChange={(e) => setReasoning(e.target.value)}
        />
      </label>
      {error && <p className="error on-paper">{error}</p>}
      <button className={confirming ? 'stamp-btn confirming' : 'stamp-btn'} disabled={!suspectId || busy}>
        {confirming ? `Confirm: accuse ${name}` : 'Submit the accusation'}
      </button>
      {confirming && <p className="paper-muted small">Press again to file it. Nobody can change it after.</p>}
    </form>
  );
}
