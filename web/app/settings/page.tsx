'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useCallback, useEffect, useState } from 'react';
import { api, clearToken } from '@/lib/api';

interface SessionUser { sub: string; email: string; isAdmin: boolean; profileId?: string }
interface Job {
  id: string;
  status: 'QUEUED' | 'RUNNING' | 'DONE' | 'FAILED' | 'CANCELLED';
  encoder: string;
  fallbackFrom: string | null;
  attempt: number;
  targetHeight: number;
  createdAt: string;
  startedAt: string | null;
  finishedAt: string | null;
  error: string | null;
  mediaFile: { sourcePath: string };
}

const statusCopy: Record<Job['status'], { icon: string; label: string }> = {
  QUEUED: { icon: '○', label: 'В изчакване' },
  RUNNING: { icon: '◉', label: 'Работи' },
  DONE: { icon: '✓', label: 'Готов' },
  FAILED: { icon: '!', label: 'Неуспешен' },
  CANCELLED: { icon: '×', label: 'Отказан' },
};

export default function SettingsPage() {
  const router = useRouter();
  const [user, setUser] = useState<SessionUser | null>(null);
  const [jobs, setJobs] = useState<Job[]>([]);
  const [queueStatus, setQueueStatus] = useState<Record<string, number>>({});
  const [busy, setBusy] = useState<string | null>(null);
  const [confirmRequeue, setConfirmRequeue] = useState<string | null>(null);
  const [result, setResult] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [currentPassword, setCurrentPassword] = useState('');
  const [newPassword, setNewPassword] = useState('');

  const load = useCallback(async () => {
    const current = await api.get<SessionUser>('/auth/me');
    setUser(current);
    if (current.isAdmin) {
      const [recent, status] = await Promise.all([
        api.get<Job[]>('/transcode/jobs'),
        api.get<{ queue: Record<string, number> }>('/transcode/status'),
      ]);
      setJobs(recent);
      setQueueStatus(status.queue);
    }
  }, []);

  useEffect(() => {
    void load().catch((err) => setError(err instanceof Error ? err.message : 'Настройките не могат да се заредят.'));
    const timer = window.setInterval(() => void load().catch(() => undefined), 5000);
    return () => window.clearInterval(timer);
  }, [load]);

  async function run(name: string, action: () => Promise<unknown>, message?: string) {
    setBusy(name); setError(null); setResult(null);
    try {
      const response = await action();
      setResult(message ?? JSON.stringify(response, null, 2));
      setConfirmRequeue(null);
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Действието е неуспешно.');
    } finally { setBusy(null); }
  }

  async function changePassword(event: React.FormEvent) {
    event.preventDefault();
    setBusy('password'); setError(null);
    try {
      await api.post('/auth/change-password', { currentPassword, newPassword });
      clearToken();
      router.push('/login');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Паролата не може да бъде сменена.');
      setBusy(null);
    }
  }

  function jobAction(job: Job) {
    const actionBusy = busy?.endsWith(job.id);
    if (job.status === 'QUEUED' || job.status === 'RUNNING') {
      return <button className="job-action job-action-danger" disabled={Boolean(busy)} onClick={() => void run(`cancel:${job.id}`, () => api.post(`/transcode/jobs/${job.id}/cancel`, {}), 'Job-ът е отказан и временните HLS файлове са почистени.')}>{actionBusy ? 'Отказване…' : 'Откажи'}</button>;
    }
    return <div className="job-actions">
      {(job.status === 'FAILED' || job.status === 'CANCELLED') && <button className="job-action" disabled={Boolean(busy)} onClick={() => void run(`retry:${job.id}`, () => api.post(`/transcode/jobs/${job.id}/retry`, {}), 'Нов опит е добавен в опашката със същия encoder.')}>{busy === `retry:${job.id}` ? 'Добавяне…' : 'Опитай пак'}</button>}
      {confirmRequeue === job.id
        ? <span className="requeue-confirm"><span>Старият HLS ще бъде изтрит.</span><button className="job-action job-action-danger" disabled={Boolean(busy)} onClick={() => void run(`requeue:${job.id}`, () => api.post(`/transcode/jobs/${job.id}/requeue`, {}), 'Rendition-ът е почистен и добавен отново в опашката.')}>Потвърди</button><button className="job-action" onClick={() => setConfirmRequeue(null)}>Назад</button></span>
        : <button className="job-action" disabled={Boolean(busy)} onClick={() => setConfirmRequeue(job.id)}>Requeue</button>}
    </div>;
  }

  return <main className="container-fluid page settings-page" id="main-content">
    <header className="collection-header"><div><span className="eyebrow">Система</span><h1>Настройки</h1></div><Link className="back-link" href="/">← Библиотека</Link></header>
    <div aria-live="polite" aria-atomic="true">{error && <div className="alert alert-danger">{error}</div>}{result && <div className="alert alert-success">{result}</div>}</div>
    {user && <section className="password-panel card"><div><span className="eyebrow">Акаунт</span><h2>Смяна на парола</h2><p className="muted">Използвай поне 10 знака. Промяната прекратява всички активни сесии.</p></div><form onSubmit={changePassword}><input type="password" autoComplete="current-password" placeholder="Текуща парола" value={currentPassword} onChange={(e) => setCurrentPassword(e.target.value)}/><input type="password" autoComplete="new-password" placeholder="Нова парола" value={newPassword} onChange={(e) => setNewPassword(e.target.value)}/><button disabled={Boolean(busy) || newPassword.length < 10}>{busy === 'password' ? 'Запазване…' : 'Смени паролата'}</button></form></section>}
    {user && !user.isAdmin && <div className="empty-state"><div><h2>Само за администратори</h2><p className="muted">Този профил няма права за системни операции.</p></div></div>}
    {user?.isAdmin && <>
      <section className="admin-actions" aria-label="Административни действия">
        <article className="admin-card"><span className="admin-index">01</span><h2>Библиотека</h2><p>Открива нови файлове и ги добавя в каталога.</p><button disabled={Boolean(busy)} onClick={() => void run('scan', () => api.post('/media/scan', {}))}>{busy === 'scan' ? 'Сканиране…' : 'Сканирай сега'}</button></article>
        <article className="admin-card"><span className="admin-index">02</span><h2>Метаданни</h2><p>Допълва описания, рейтинги, жанрове и постери от TMDB.</p><button disabled={Boolean(busy)} onClick={() => void run('metadata', () => api.post('/metadata/refresh', {}))}>{busy === 'metadata' ? 'Обновяване…' : 'Обнови липсващите'}</button></article>
        <article className="admin-card"><span className="admin-index">03</span><h2>Транскодиране</h2><p>Проверява какво не може да се пусне директно. Не добавя jobs.</p><button disabled={Boolean(busy)} onClick={() => void run('transcode', () => api.post('/transcode/missing', { dryRun: true, limit: 10 }))}>{busy === 'transcode' ? 'Проверка…' : 'Провери липсващите'}</button></article>
      </section>
      <section className="jobs-section">
        <div className="jobs-heading"><div><span className="eyebrow">Последни 50</span><h2>Transcode jobs</h2></div><button className="secondary-button" disabled={Boolean(busy)} onClick={() => void load()}>Обнови</button></div>
        <div className="queue-strip" aria-label="Състояние на опашката">{Object.entries(queueStatus).map(([name, count]) => <div key={name}><span>{name}</span><strong>{count}</strong></div>)}</div>
        {jobs.length === 0 ? <div className="empty-state"><div><h3>Опашката е празна</h3><p className="muted">Новите jobs ще се появят тук с действия за управление.</p></div></div> : <div className="jobs-table" role="list">{jobs.map((job) => {
          const status = statusCopy[job.status];
          return <article key={job.id} role="listitem">
            <span className={`status status-${job.status.toLowerCase()}`}><span aria-hidden="true">{status.icon}</span> {status.label}</span>
            <div className="job-file"><strong title={job.mediaFile.sourcePath}>{job.mediaFile.sourcePath}</strong>{job.error && <details><summary>Диагностика</summary><pre>{job.error}</pre></details>}</div>
            <span className="job-encoder">{job.encoder} · {job.targetHeight}p{job.fallbackFrom && <small>fallback от {job.fallbackFrom}</small>}</span>
            <span className="job-attempt">Опит {job.attempt}</span>
            <time dateTime={job.createdAt}>{new Date(job.createdAt).toLocaleString('bg-BG')}</time>
            {jobAction(job)}
          </article>;
        })}</div>}
      </section>
    </>}
  </main>;
}
