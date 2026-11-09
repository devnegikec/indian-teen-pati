import { useCallback, useEffect, useState } from 'react';
import { clearSession, getName, getToken, signInAsGuest } from './api';
import { Lobby } from './screens/Lobby';
import { Table } from './screens/Table';
import { RankingEditor } from './screens/RankingEditor';
import { Sandbox } from './screens/Sandbox';

export type Route =
  | { name: 'lobby' }
  | { name: 'join'; code: string }
  | { name: 'room'; roomId: string }
  | { name: 'rankings' }
  | { name: 'sandbox' };

function parseRoute(): Route {
  const hash = window.location.hash.replace(/^#\/?/, '');
  const parts = hash.split('/').filter(Boolean);
  if (parts[0] === 'room' && parts[1]) return { name: 'room', roomId: parts[1] };
  if (parts[0] === 'join' && parts[1]) return { name: 'join', code: parts[1].toUpperCase() };
  if (parts[0] === 'rankings') return { name: 'rankings' };
  if (parts[0] === 'sandbox') return { name: 'sandbox' };
  return { name: 'lobby' };
}

export function navigate(path: string): void {
  window.location.hash = path;
}

export function App() {
  const [route, setRoute] = useState<Route>(parseRoute);
  const [token, setToken] = useState<string | null>(getToken());
  const [name, setName] = useState<string>(getName());
  const [nameInput, setNameInput] = useState('');
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    const onHash = () => setRoute(parseRoute());
    window.addEventListener('hashchange', onHash);
    return () => window.removeEventListener('hashchange', onHash);
  }, []);

  const signIn = useCallback(async () => {
    setBusy(true);
    try {
      const user = await signInAsGuest(nameInput || 'Player');
      setToken(user.token);
      setName(user.name);
    } catch (error) {
      alert((error as Error).message);
    } finally {
      setBusy(false);
    }
  }, [nameInput]);

  if (!token) {
    return (
      <div className="gate">
        <div className="gate__card">
          <h1 className="brand">
            Teen <span>Patti</span>
          </h1>
          <p className="muted">
            A private, chip-only Teen Patti table with configurable house rankings, Muflis, assumed cards and
            administrator dispute resolution. No money, ever.
          </p>
          <label className="field">
            <span>Your name</span>
            <input
              value={nameInput}
              maxLength={24}
              autoFocus
              placeholder="e.g. Ravi"
              onChange={(e) => setNameInput(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') void signIn();
              }}
            />
          </label>
          <button className="btn btn--primary btn--wide" disabled={busy} onClick={() => void signIn()}>
            {busy ? 'Entering…' : 'Enter the lobby'}
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="app">
      <header className="topbar">
        <button className="brand brand--button" onClick={() => navigate('/')}>
          Teen <span>Patti</span>
        </button>
        <nav className="topbar__nav">
          <button className="link" onClick={() => navigate('/')}>
            Lobby
          </button>
          <button className="link" onClick={() => navigate('/rankings')}>
            Ranking editor
          </button>
          <button className="link" onClick={() => navigate('/sandbox')}>
            Test &amp; ordering
          </button>
        </nav>
        <div className="topbar__user">
          <span className="chip chip--you">{name}</span>
          <button
            className="link link--dim"
            onClick={() => {
              clearSession();
              setToken(null);
              setName('');
            }}
          >
            switch
          </button>
        </div>
      </header>

      <main className="main">
        {route.name === 'lobby' && <Lobby initialCode={undefined} />}
        {route.name === 'join' && <Lobby initialCode={route.code} />}
        {route.name === 'room' && <Table roomId={route.roomId} key={route.roomId} />}
        {route.name === 'rankings' && <RankingEditor />}
        {route.name === 'sandbox' && <Sandbox />}
      </main>
    </div>
  );
}
