'use client';

import Link from 'next/link';
import { useEffect, useState } from 'react';
import { api, clearToken } from '@/lib/api';

interface SessionUser { sub: string; email: string; isAdmin: boolean; profileId?: string }
interface Job { id: string; status: string; encoder: string; targetHeight: number; createdAt: string; error: string | null; mediaFile: { sourcePath: string } }

export default function SettingsPage() {
  const [user, setUser] = useState<SessionUser | null>(null);
  const [jobs, setJobs] = useState<Job[]>([]);
  const [queueStatus, setQueueStatus] = useState<Record<string, number>>({});
  const [busy, setBusy] = useState<string | null>(null);
  const [result, setResult] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [currentPassword, setCurrentPassword] = useState('');
  const [newPassword, setNewPassword] = useState('');

  async function load() {
    const current = await api.get<SessionUser>('/auth/me');
    setUser(current);
    if (current.isAdmin) {
      const [recent, status] = await Promise.all([api.get<Job[]>('/transcode/jobs'), api.get<{ queue: Record<string, number> }>('/transcode/status')]);
      setJobs(recent); setQueueStatus(status.queue);
    }
  }
  useEffect(() => { void load().catch((err) => setError(err instanceof Error ? err.message : 'Настройките не могат да се заредят.')); }, []);

  async function run(name: string, action: () => Promise<unknown>) {
    setBusy(name); setError(null); setResult(null);
    try { const response = await action(); setResult(JSON.stringify(response, null, 2)); await load(); }
    catch (err) { setError(err instanceof Error ? err.message : 'Действието е неуспешно.'); }
    finally { setBusy(null); }
  }

  async function changePassword(event: React.FormEvent) {
    event.preventDefault();
    setBusy('password'); setError(null);
    try {
      await api.post('/auth/change-password', { currentPassword, newPassword });
      clearToken();
      window.location.assign('/login');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Паролата не може да бъде сменена.');
      setBusy(null);
    }
  }

  return <main className="page settings-page" id="main-content">
    <header className="collection-header"><div><span className="eyebrow">Система</span><h1>Настройки</h1></div><Link className="back-link" href="/">← Библиотека</Link></header>
    {error && <div className="player-message error">{error}</div>}
    {user && <section className="password-panel card"><div><span className="eyebrow">Акаунт</span><h2>Смяна на парола</h2><p className="muted">Използвай поне 10 знака и различна парола от текущата. След промяната всички устройства ще трябва да влязат отново.</p></div><form onSubmit={changePassword}><input type="password" autoComplete="current-password" placeholder="Текуща парола" value={currentPassword} onChange={(e) => setCurrentPassword(e.target.value)}/><input type="password" autoComplete="new-password" placeholder="Нова парола" value={newPassword} onChange={(e) => setNewPassword(e.target.value)}/><button disabled={Boolean(busy) || newPassword.length < 10}>{busy === 'password' ? 'Запазване…' : 'Смени паролата'}</button></form></section>}
    {user && !user.isAdmin && <div className="empty-state"><div><h2>Само за администратори</h2><p className="muted">Този профил няма права за системни операции.</p></div></div>}
    {user?.isAdmin && <>
      <section className="admin-actions">
        <article className="admin-card"><span className="admin-index">01</span><h2>Библиотека</h2><p>Открива нови файлове и ги добавя в каталога.</p><button disabled={Boolean(busy)} onClick={() => void run('scan', () => api.post('/media/scan', {}))}>{busy === 'scan' ? 'Сканиране…' : 'Сканирай сега'}</button></article>
        <article className="admin-card"><span className="admin-index">02</span><h2>Метаданни</h2><p>Допълва описания, рейтинги, жанрове и постери от TMDB.</p><button disabled={Boolean(busy)} onClick={() => void run('metadata', () => api.post('/metadata/refresh', {}))}>{busy === 'metadata' ? 'Обновяване…' : 'Обнови липсващите'}</button></article>
        <article className="admin-card"><span className="admin-index">03</span><h2>Транскодиране</h2><p>Показва какво не може да се пусне директно. Това е безопасен dry run.</p><button disabled={Boolean(busy)} onClick={() => void run('transcode', () => api.post('/transcode/missing', { dryRun: true, limit: 10 }))}>{busy === 'transcode' ? 'Проверка…' : 'Провери липсващите'}</button></article>
      </section>
      {result && <section className="admin-result"><div className="section-heading"><span className="eyebrow">Последен резултат</span><h2>Отговор</h2></div><pre>{result}</pre></section>}
      <section className="jobs-section"><div className="section-heading"><span className="eyebrow">Последни 50</span><h2>Transcode jobs</h2></div><div className="queue-metrics">{Object.entries(queueStatus).map(([name,count]) => <div key={name}><strong>{count}</strong><span>{name}</span></div>)}</div>{jobs.length === 0 ? <p className="muted">Все още няма jobs.</p> : <div className="jobs-table">{jobs.map((job) => <article key={job.id}><span className={`status status-${job.status.toLowerCase()}`}>{job.status}</span><strong>{job.mediaFile.sourcePath}</strong><span>{job.encoder} · {job.targetHeight}p</span><time>{new Date(job.createdAt).toLocaleString('bg-BG')}</time></article>)}</div>}</section>
    </>}
  </main>;
}
