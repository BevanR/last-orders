import type { View } from './api.js';

/** Shown to everyone once the host ends the investigation. */
export function RevealScreen({ view }: { view: View }) {
  const r = view.reveal;
  if (!r) return <p className="muted">Loading the reveal…</p>;
  const followed = r.redHerrings.filter((h) => h.followed);
  const missed = r.redHerrings.filter((h) => !h.followed);
  return (
    <section className="reveal">
      <article className="paper report">
        <p className="file-label">
          <span>Final case report</span>
          <span>Tarakihi Head Lodge</span>
        </p>
        <div className={`verdict ${r.verdict.verdict}`} data-verdict={r.verdict.outcome}>
          <span className="stamp verdict-stamp">Case closed</span>
          <h2>{r.verdict.title}</h2>
          <p>{r.verdict.text}</p>
          {r.accusation ? (
            <p className="accused-line">
              {r.accusation.by} named <strong>{r.accusation.suspect.name}</strong>
              {r.accusation.evidence.length > 0 && <>, citing {r.accusation.evidence.map((e) => e.name).join(', ')}</>}.
              {r.accusation.reasoning && <> “{r.accusation.reasoning}”</>}
            </p>
          ) : null}
        </div>

        <section className="report-section">
          <h3 className="report-h">
            <span className="report-no">I.</span> What happened
          </h3>
          <p className="narration">{r.narration}</p>
          <p>{r.summary}</p>
        </section>

        <section className="report-section">
          <h3 className="report-h">
            <span className="report-no">II.</span> What the clues meant
          </h3>
          <dl className="clues">
            {r.clues.map((k) => (
              <div key={k.title}>
                <dt>{k.title}</dt>
                <dd>{k.text}</dd>
              </div>
            ))}
          </dl>
        </section>

        <section className="report-section">
          <h3 className="report-h">
            <span className="report-no">III.</span> Red herrings
          </h3>
          {followed.length > 0 ? (
            <p className="paper-muted small">
              The group followed {followed.length === 1 ? 'one' : followed.length} of these.
            </p>
          ) : (
            <p className="paper-muted small">The group did not chase any of these.</p>
          )}
          <dl className="clues">
            {[...followed, ...missed].map((h) => (
              <div key={h.id} data-herring={h.id} data-followed={h.followed}>
                <dt>
                  {h.title} {h.followed && <span className="badge accent">you followed this</span>}
                </dt>
                <dd>{h.text}</dd>
              </div>
            ))}
          </dl>
        </section>
      </article>

      <aside className="card commentary" data-commentary={view.commentary ? 'ready' : 'pending'}>
        <h3>
          Commentary <span className="badge">{view.commentary?.simulated ? 'simulated' : 'AI'}</span>
        </h3>
        {view.commentary ? (
          <p className="commentary-text">{view.commentary.text}</p>
        ) : (
          <p className="muted small">The game master is writing a few words…</p>
        )}
        <p className="muted small">Commentary is written by a model after the reveal. The verdict above is not.</p>
      </aside>
    </section>
  );
}
