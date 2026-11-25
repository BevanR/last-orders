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
          placeholder="Inspector …"
        />
      </label>
      <button className="primary" disabled={props.busy || !name.trim()}>
        {props.label}
      </button>
      {props.error && <p className="error">{props.error}</p>}
    </form>
  );
}

function Shell(props: { children: React.ReactNode }) {
  return (
    <main className="shell narrow">
      <h1 className="brand">Last Orders</h1>
      <p className="muted">A murder at the lodge. Nobody leaves until it is solved.</p>
      {props.children}
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
      <section className="card">
        <h2>Host a game</h2>
        <NameForm label="Create room" busy={busy} error={error} onSubmit={create} />
      </section>
      <p className="muted small">Have an invite link? Open it to join a room.</p>
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
      <section className="card">
        <h2>Join room {props.code}</h2>
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
  return <Shell>{error ? <p className="error">{error}</p> : <p className="muted">Opening your room…</p>}</Shell>;
}
