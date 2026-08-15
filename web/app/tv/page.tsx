'use client';

import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { api, setToken, type AuthResult } from '@/lib/api';

type Pairing = { pairingId: string; secret: string; code: string; expiresAt: string };
type Poll = { status: 'pending' } | ({ status: 'approved' } & AuthResult);

export default function TvLoginPage() {
  const router = useRouter();
  const [pairing, setPairing] = useState<Pairing | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function create() {
    setError(null);
    try { setPairing(await api.post<Pairing>('/device-pairing', { deviceName: navigator.userAgent.slice(0, 80) })); }
    catch (err) { setError(err instanceof Error ? err.message : 'Неуспешно създаване на код'); }
  }

  useEffect(() => { localStorage.setItem('streaming_tv_mode', '1'); document.body.classList.add('tv-mode'); void create(); }, []);
  useEffect(() => {
    if (!pairing) return;
    const timer = window.setInterval(async () => {
      try {
        const result = await api.post<Poll>(`/device-pairing/${pairing.pairingId}/poll`, { secret: pairing.secret });
        if (result.status === 'approved') { window.clearInterval(timer); setToken(result.accessToken); router.replace('/select-profile?tv=1'); }
      } catch (err) { setError(err instanceof Error ? err.message : 'Кодът изтече'); window.clearInterval(timer); }
    }, 2500);
    return () => window.clearInterval(timer);
  }, [pairing, router]);

  return <main className="tv-pair-page" id="main-content">
    <section className="tv-pair-panel">
      <span className="eyebrow">Вход на телевизор</span>
      <h1>Свържи този екран</h1>
      <p>Отвори <strong>{typeof window === 'undefined' ? '/pair' : `${location.host}/pair`}</strong> на телефона си и въведи кода:</p>
      <div className="tv-pair-code" aria-label={`Код ${pairing?.code ?? ''}`}>{pairing?.code ?? '••••••'}</div>
      <p className="muted">Кодът е еднократен и е валиден 10 минути.</p>
      {error && <div className="alert alert-danger">{error}</div>}
      {error && <button onClick={create}>Нов код</button>}
    </section>
  </main>;
}
