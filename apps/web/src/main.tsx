import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { Game } from './Game.js';
import { HostClaim, Home, Join } from './Lobby.js';
import { usePath } from './nav.js';
import './styles.css';

function App() {
  const path = usePath();
  let m: RegExpExecArray | null;
  if ((m = /^\/g\/([A-Za-z0-9]+)\/?$/.exec(path))) return <Game code={m[1]!.toUpperCase()} />;
  if ((m = /^\/r\/([A-Za-z0-9]+)\/?$/.exec(path))) return <Join code={m[1]!.toUpperCase()} />;
  if ((m = /^\/h\/([A-Za-z0-9_-]+)\/?$/.exec(path))) return <HostClaim token={m[1]!} />;
  return <Home />;
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
