'use client';

import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { api, clearToken, setToken, type AuthResult } from '@/lib/api';

export default function LoginPage() {
  const router = useRouter();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    setError(null);
    setBusy(true);
    try {
      const result = await api.post<AuthResult>('/auth/login', { email, password });
      // A browser can be shared by multiple accounts. Never carry the last
      // account's selected profile into the new session.
      clearToken();
      setToken(result.accessToken);
      router.push('/select-profile');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Login failed');
    } finally {
      setBusy(false);
    }
  }

  return (
    <main className="login-page" id="main-content">
      <section className="login-copy">
        <span className="eyebrow">Кино у дома</span>
        <h1>Твоята библиотека.<br />Без излишния шум.</h1>
        <p>Филми, сериали и продължаване оттам, докъдето си стигнал.</p>
      </section>
      <form onSubmit={submit} className="card login-card shadow-lg" style={{ display: 'grid', gap: 12 }}>
        <div>
          <span className="eyebrow">Добре дошъл</span>
          <h2>Вход</h2>
        </div>
        <label>
          <div className="muted" style={{ marginBottom: 6 }}>
            Имейл
          </div>
          <input
            type="email"
            placeholder="you@example.com"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            autoComplete="username"
            required
          />
        </label>
        <label>
          <div className="muted" style={{ marginBottom: 6 }}>
            Парола
          </div>
          <input
            type="password"
            placeholder="••••••••"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            autoComplete="current-password"
            required
          />
        </label>
        {error && <div className="alert alert-danger">{error}</div>}
        <button type="submit" disabled={busy}>
          {busy ? 'Влизане...' : 'Влез'}
        </button>
      </form>
    </main>
  );
}
