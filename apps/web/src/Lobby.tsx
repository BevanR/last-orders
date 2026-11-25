import { useEffect, useState, type FormEvent } from 'react';
import { api, ApiError, local } from './api.js';
import { navigate } from './nav.js';

function NameForm(props: { label: string; busy: boolean; error: string; onSubmit: (name: string) => void }) {
  const [name, setName] = useState(local.get('lo:name') ?? '');
  const submit = (e: FormEvent) => {
    e.preventDefault();
    const n = name.trim();
    if (!n) return;
    local.set('lo:name', n);
    props.onSubmit(n);
  };
  return (
    <form className="stack" onSubmit={submit}>
      <label className="field">
        <span>Your name</span>
        <input
          name="displayName"
          value={name}
          maxLength={40}
          autoComplete="nickname"
          onChange={(e) => setName(e.target.value)}
          placeholder="e.g. Hana"
        />
      </label>
      <button className="primary" disabled={props.busy || !name.trim()}>
        {props.label}
      </button>
      {props.error && <p className="error">{props.error}</p>}
    </form>
  );
}

/** The premise from the case bible, section 1. Public: every player reads it before the game. */
const PREMISE = [
  'Tarakihi Head Lodge sits alone on a headland on the West Coast of the South Island, forty minutes of gravel road from the nearest town. Tonight Helen Marsh, who has run the lodge for thirty-one years, held her retirement dinner: whitebait fritters, blue cod, a pavlova, and a 1991 magnum of pinot noir she has been saving since the year she bought the place.',
  'At ten to four the storm took out the Kōtuku Creek bridge, so nobody is going anywhere. At ten past ten Helen was found at the foot of her cellar stairs.',
  'You are trampers stuck in the lodge\u2019s bunk wing, and the police sergeant on the phone has asked you to keep everyone apart and find out what you can before first light. Four people sat at that dinner or cooked it. Every one of them is hiding something. Only one of them is hiding a killing.',
];

/** A rain-dark window looking out at the lodge on its headland. Decorative. */
export function StormWindow() {
  return (
    <div className="storm-window" aria-hidden="true">
      <svg className="headland" viewBox="0 0 400 100" preserveAspectRatio="xMaxYMax slice">
        <path className="sea" d="M0 88 C60 84 120 92 180 87 C240 82 300 90 400 85 L400 100 L0 100 Z" />
        <path
          className="land"
          d="M0 100 L0 93 C80 91 160 87 220 81 C260 77 290 72 320 73 C350 74 380 80 400 84 L400 100 Z"
        />
        <path className="land" d="M296 75 L296 59 L324 47 L352 59 L352 75 Z" />
        <path className="land" d="M350 75 L350 63 L378 63 L378 77 Z" />
        <rect className="lit" x="304" y="63" width="7" height="6" />
        <rect className="lit dim" x="336" y="63" width="7" height="6" />
      </svg>
      <div className="rain far" />
      <div className="rain near" />
    </div>
  );
}

function Shell(props: { children: React.ReactNode }) {
  return (
    <main className="lobby">
      <header className="lobby-hero">
        <StormWindow />
        <div className="lobby-title">
          <p className="kicker">A murder mystery for friends</p>
          <h1 className="brand">Last Orders</h1>
          <p className="tagline">Six people. Four suspects. One liar who can actually be caught.</p>
        </div>
      </header>
      <div className="lobby-grid">
        <div className="lobby-entry">{props.children}</div>
        <article className="paper brief">
          <span className="stamp" aria-hidden="true">
            Do not leave
          </span>
          <p className="file-label">
            <span>Case brief</span>
            <span>Tarakihi Head Lodge</span>
          </p>
          {PREMISE.map((p, i) => (
            <p key={p.slice(0, 20)} className={i === 0 ? 'lede' : undefined}>
              {p}
            </p>
          ))}
        </article>
        <ol className="how" aria-label="How it plays">
          <li>
            <strong>Search the lodge.</strong> Six rooms, each with something to inspect.
          </li>
          <li>
            <strong>Interview the four.</strong> AI plays each suspect, in private, from what they know.
          </li>
          <li>
            <strong>Pin and present.</strong> Share cards on the board. Show one to a suspect to test a story.
          </li>
          <li>
            <strong>Accuse together.</strong> One name, the cards that prove it, and no second go.
          </li>
        </ol>
      </div>
    </main>
  );
}

export function Home() {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const create = async (name: string) => {
    setBusy(true);
    setError('');
    try {
      const r = await api.createRoom(name);
      local.set(`lo:host:${r.roomCode}`, r.hostUrl);
      navigate(`/g/${r.roomCode}`);
    } catch (e) {
      setError((e as Error).message);
      setBusy(false);
    }
  };
  return (
    <Shell>
      <section className="card entry">
        <h2>Open a case</h2>
        <p className="muted small">You host. You get an invite link for everyone else.</p>
        <NameForm label="Create room" busy={busy} error={error} onSubmit={create} />
        <p className="muted small invite-note">Have an invite link? Open it to join a room.</p>
      </section>
    </Shell>
  );
}

export function Join(props: { code: string }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  useEffect(() => {
    // Already in this room on this browser: go straight in.
    api.state(props.code).then(
      () => navigate(`/g/${props.code}`),
      () => {},
    );
  }, [props.code]);
  const join = async (name: string) => {
    setBusy(true);
    setError('');
    try {
      await api.join(props.code, name);
      navigate(`/g/${props.code}`);
    } catch (e) {
      setError(e instanceof ApiError && e.status === 404 ? 'That room does not exist.' : (e as Error).message);
      setBusy(false);
    }
  };
  return (
    <Shell>
      <section className="card entry">
        <h2>
          Join room <span className="code-chip">{props.code}</span>
        </h2>
        <NameForm label="Join" busy={busy} error={error} onSubmit={join} />
      </section>
    </Shell>
  );
}

export function HostClaim(props: { token: string }) {
  const [error, setError] = useState('');
  useEffect(() => {
    api.claimHost(props.token).then(
      (r) => {
        local.set(`lo:host:${r.roomCode}`, `/h/${props.token}`);
        navigate(`/g/${r.roomCode}`);
      },
      (e: Error) => setError(e.message),
    );
  }, [props.token]);
  return (
    <Shell>
      <section className="card entry">
        {error ? <p className="error">{error}</p> : <p className="muted">Opening your room…</p>}
      </section>
    </Shell>
  );
}
