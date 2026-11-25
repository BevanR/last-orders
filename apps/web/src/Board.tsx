import { useState } from 'react';
import { api, type View } from './api.js';

export function Board({ code, view, onChange }: { code: string; view: View; onChange: () => void }) {
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
            <p className="card-text">{e.description}</p>
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
            <p className="card-text">{e.description}</p>
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
