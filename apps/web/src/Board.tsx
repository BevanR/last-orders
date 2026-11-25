import { useState } from 'react';
import { api, type View } from './api.js';

export function Board({ code, view, onChange }: { code: string; view: View; onChange: () => void }) {
  const [error, setError] = useState('');
  const share = (id: string) => api.share(code, id).then(onChange, (e: Error) => setError(e.message));
  return (
    <section className="board-tab">
      <div className="section-head">
        <h2>Evidence board</h2>
        <p className="muted small">Shared with everyone in the room. Anyone can present a pinned card.</p>
      </div>
      <div className="corkboard">
        {view.board.length === 0 && <p className="cork-empty">Nothing pinned yet. Share what you find.</p>}
        <div className="cards">
          {view.board.map((e) => (
            <article key={e.id} className="evidence pinned" data-evidence={e.id}>
              <span className="pin" aria-hidden="true" />
              <p className="tag-label">Exhibit {e.id.toUpperCase()}</p>
              <h3>{e.name}</h3>
              <p className="card-text">{e.description}</p>
              <p className="pinned-by">Pinned by {e.sharedBy}</p>
            </article>
          ))}
        </div>
      </div>
      <div className="section-head">
        <h2>Your notebook</h2>
        <p className="muted small">What you found. Private until you share it.</p>
      </div>
      {error && <p className="error">{error}</p>}
      {view.notebook.length === 0 && <p className="muted">You have not found anything yet. Try the Lodge.</p>}
      <div className="cards notebook">
        {view.notebook.map((e) => (
          <article key={e.id} className={e.shared ? 'evidence private shared' : 'evidence private'} data-notebook={e.id}>
            <p className="tag-label">
              Exhibit {e.id.toUpperCase()} · {e.shared ? 'on the board' : 'private'}
            </p>
            <h3>{e.name}</h3>
            <p className="card-text">{e.description}</p>
            {e.shared ? (
              <p className="pinned-by">On the board.</p>
            ) : (
              <button className="ink" onClick={() => void share(e.id)}>
                Share to board
              </button>
            )}
          </article>
        ))}
      </div>
    </section>
  );
}
