import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { Game } from './Game.js';
import { HostClaim, Home, Join } from './Lobby.js';
import { usePath } from './nav.js';
// Self-hosted fonts: Latin and Latin Extended subsets only (macrons in Kōtuku, Kererū).
import '@fontsource/source-serif-4/latin-400.css';
import '@fontsource/source-serif-4/latin-ext-400.css';
import '@fontsource/source-serif-4/latin-400-italic.css';
import '@fontsource/source-serif-4/latin-ext-400-italic.css';
import '@fontsource/source-serif-4/latin-600.css';
import '@fontsource/source-serif-4/latin-ext-600.css';
import '@fontsource/playfair-display/latin-700.css';
import '@fontsource/playfair-display/latin-ext-700.css';
import '@fontsource/playfair-display/latin-400-italic.css';
import '@fontsource/playfair-display/latin-ext-400-italic.css';
import '@fontsource/special-elite/latin-400.css';
import '@fontsource/special-elite/latin-ext-400.css';
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
