'use client';

import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { api, getToken } from '@/lib/api';

export default function PairDevicePage() {
  const router = useRouter();
  const [code, setCode] = useState('');
  const [state, setState] = useState<'idle' | 'busy' | 'done'>('idle');
  const [error, setError] = useState<string | null>(null);
  useEffect(() => { if (!getToken()) router.replace('/login?next=%2Fpair'); }, [router]);
  async function submit(event: React.FormEvent) {
    event.preventDefault(); setState('busy'); setError(null);
    try { await api.post('/device-pairing/claim/code', { code }); setState('done'); }
    catch (err) { setError(err instanceof Error ? err.message : 'Невалиден код'); setState('idle'); }
  }
  return <main className="pair-page" id="main-content"><section className="card pair-card">
    <span className="eyebrow">Свързване на телевизор</span>
    {state === 'done' ? <><h1>Телевизорът е свързан</h1><p>Можеш да се върнеш към големия екран.</p><button onClick={() => router.push('/')}>Към каталога</button></> : <form onSubmit={submit}>
      <h1>Въведи кода от телевизора</h1>
      <input className="pair-code-input" value={code} onChange={(e) => setCode(e.target.value.toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 6))} inputMode="text" autoCapitalize="characters" autoFocus required minLength={6} maxLength={6} aria-label="Код за телевизора" />
      {error && <div className="alert alert-danger">{error}</div>}
      <button disabled={state === 'busy'}>{state === 'busy' ? 'Свързване…' : 'Свържи'}</button>
    </form>}
  </section></main>;
}
