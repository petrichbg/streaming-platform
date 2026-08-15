'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { api, clearToken, type SubtitleTrackInfo, type TitleDetail, type TitleListItem } from '@/lib/api';
import AdminOpsCenter from './AdminOpsCenter';

interface SessionUser { sub: string; email: string; isAdmin: boolean; profileId?: string }
interface AdminUser {
  id: string;
  email: string;
  isAdmin: boolean;
  createdAt: string;
  sessionVersion: number;
  _count: { profiles: number };
}
interface LoginSession { id: string; userId: string; userAgent: string | null; ipAddress: string | null; createdAt: string; expiresAt: string; user: { email: string } }
interface AdminOverview {
  status: 'ok';
  checkedAt: string;
  uptimeSec: number;
  catalog: { titles: number; mediaFiles: number; profiles: number; users: number };
  transcode: { failedJobs: number };
  storage: {
    media: { path: string; totalBytes: number | null; freeBytes: number | null };
    transcode: { path: string; totalBytes: number | null; freeBytes: number | null };
  };
}
interface Job {
  id: string;
  status: 'QUEUED' | 'RUNNING' | 'DONE' | 'FAILED' | 'CANCELLED';
  encoder: string;
  fallbackFrom: string | null;
  attempt: number;
  targetHeight: number;
  createdAt: string;
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
  const [users, setUsers] = useState<AdminUser[]>([]);
  const [sessions, setSessions] = useState<LoginSession[]>([]);
  const [jobs, setJobs] = useState<Job[]>([]);
  const [queueStatus, setQueueStatus] = useState<Record<string, number>>({});
  const [overview, setOverview] = useState<AdminOverview | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState<string | null>(null);
  const [confirmRequeue, setConfirmRequeue] = useState<string | null>(null);
  const [result, setResult] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [currentPassword, setCurrentPassword] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [titles, setTitles] = useState<TitleListItem[]>([]);
  const [subtitleTitleId, setSubtitleTitleId] = useState('');
  const [subtitleMediaId, setSubtitleMediaId] = useState('');
  const [subtitleMedia, setSubtitleMedia] = useState<TitleDetail | null>(null);
  const [subtitleTracks, setSubtitleTracks] = useState<SubtitleTrackInfo[]>([]);
  const [subtitleFile, setSubtitleFile] = useState<File | null>(null);
  const [subtitleLanguage, setSubtitleLanguage] = useState('bul');
  const [subtitleForced, setSubtitleForced] = useState(false);
  const [subtitleEditIndex, setSubtitleEditIndex] = useState<number | null>(null);
  const [subtitleEditContent, setSubtitleEditContent] = useState('');
  const [subtitleCapabilities, setSubtitleCapabilities] = useState<{ burnInFilterAvailable: boolean; ocrAvailable: boolean; bitmapPlaybackAvailable: boolean; bitmapReason: string } | null>(null);

  const loadAdmin = useCallback(async (includeUsers = false) => {
    const [recent, status, summary, accounts, catalogTitles, activeSessions] = await Promise.all([
      api.get<Job[]>('/transcode/jobs'),
      api.get<{ queue: Record<string, number> }>('/transcode/status'),
      api.get<AdminOverview>('/admin/overview'),
      includeUsers ? api.get<AdminUser[]>('/auth/users') : Promise.resolve(null),
      includeUsers ? api.get<TitleListItem[]>('/titles') : Promise.resolve(null),
      includeUsers ? api.get<LoginSession[]>('/auth/sessions') : Promise.resolve(null),
    ]);
    setJobs(recent);
    setQueueStatus(status.queue);
    setOverview(summary);
    if (accounts) setUsers(accounts);
    if (catalogTitles) setTitles(catalogTitles);
    if (activeSessions) setSessions(activeSessions);
  }, []);

  async function chooseSubtitleTitle(titleId: string) {
    setSubtitleTitleId(titleId);
    setSubtitleMediaId('');
    setSubtitleTracks([]);
    setSubtitleMedia(titleId ? await api.get<TitleDetail>(`/titles/${titleId}`) : null);
  }

  async function chooseSubtitleMedia(mediaId: string) {
    setSubtitleMediaId(mediaId);
    if (!mediaId) { setSubtitleTracks([]); setSubtitleCapabilities(null); return; }
    const [tracks, capabilities] = await Promise.all([
      api.get<SubtitleTrackInfo[]>(`/media/${mediaId}/subtitles`),
      api.get<{ burnInFilterAvailable: boolean; ocrAvailable: boolean; bitmapPlaybackAvailable: boolean; bitmapReason: string }>(`/media/${mediaId}/subtitles/capabilities`),
    ]);
    setSubtitleTracks(tracks); setSubtitleCapabilities(capabilities);
  }

  async function uploadSubtitle(event: React.FormEvent) {
    event.preventDefault();
    if (!subtitleMediaId || !subtitleFile) return;
    setBusy('subtitle-upload'); setError(null);
    try {
      const form = new FormData();
      form.append('file', subtitleFile);
      form.append('language', subtitleLanguage);
      form.append('forced', String(subtitleForced));
      setSubtitleTracks(await api.upload<SubtitleTrackInfo[]>(`/media/${subtitleMediaId}/subtitles/upload`, form));
      setSubtitleFile(null);
      setResult('Субтитрите са качени и ще бъдат конвертирани при първото пускане.');
    } catch (err) { setError(errorMessage(err, 'Субтитрите не могат да бъдат качени.')); }
    finally { setBusy(null); }
  }

  async function deleteSubtitle(index: number) {
    if (!subtitleMediaId) return;
    setBusy(`subtitle-delete:${index}`);
    try { setSubtitleTracks(await api.delete<SubtitleTrackInfo[]>(`/media/${subtitleMediaId}/subtitles/${index}`)); }
    catch (err) { setError(errorMessage(err, 'Субтитрите не могат да бъдат изтрити.')); }
    finally { setBusy(null); }
  }

  async function editSubtitle(index: number) {
    if (!subtitleMediaId) return;
    setBusy(`subtitle-read:${index}`);
    try {
      const source = await api.get<{ content: string }>(`/media/${subtitleMediaId}/subtitles/${index}/source`);
      setSubtitleEditIndex(index); setSubtitleEditContent(source.content);
    } catch (err) { setError(errorMessage(err, 'Subtitle файлът не може да бъде прочетен.')); }
    finally { setBusy(null); }
  }

  async function saveSubtitleEdit() {
    if (!subtitleMediaId || subtitleEditIndex === null) return;
    setBusy('subtitle-save');
    try {
      await api.patch(`/media/${subtitleMediaId}/subtitles/${subtitleEditIndex}/source`, { content: subtitleEditContent });
      setSubtitleEditIndex(null); setResult('Корекциите са записани като UTF-8 и кешът е обновен.');
      await chooseSubtitleMedia(subtitleMediaId);
    } catch (err) { setError(errorMessage(err, 'Корекциите не могат да бъдат записани.')); }
    finally { setBusy(null); }
  }

  async function enqueueAbrLadder() {
    if (!subtitleMediaId) return;
    setBusy('abr-ladder'); setError(null);
    try {
      const response = await api.post<{ heights: number[] }>(`/transcode/ladder`, {
        mediaFileId: subtitleMediaId,
        encoder: 'h264_amf',
        maxHeight: 1080,
      });
      setResult(`ABR стълбицата е добавена в опашката: ${response.heights.map((height) => `${height}p`).join(', ')}.`);
      await loadAdmin(false);
    } catch (err) { setError(errorMessage(err, 'ABR стълбицата не може да бъде добавена.')); }
    finally { setBusy(null); }
  }

  useEffect(() => {
    let disposed = false;
    let timer: number | undefined;
    void (async () => {
      try {
        const current = await api.get<SessionUser>('/auth/me');
        if (disposed) return;
        setUser(current);
        if (current.isAdmin) {
          await loadAdmin(true);
          timer = window.setInterval(() => {
            if (document.visibilityState === 'visible') void loadAdmin(false).catch(() => undefined);
          }, 5000);
        }
      } catch (err) {
        if (!disposed) setError(errorMessage(err, 'Настройките не могат да се заредят.'));
      } finally {
        if (!disposed) setLoading(false);
      }
    })();
    return () => {
      disposed = true;
      if (timer) window.clearInterval(timer);
    };
  }, [loadAdmin]);

  const queueTotal = useMemo(
    () => Object.values(queueStatus).reduce((sum, count) => sum + count, 0),
    [queueStatus],
  );

  async function run(name: string, action: () => Promise<unknown>, message: string) {
    setBusy(name);
    setError(null);
    setResult(null);
    try {
      const response = await action();
      const detail = response && typeof response === 'object' ? `\n${JSON.stringify(response, null, 2)}` : '';
      setResult(`${message}${detail}`);
      setConfirmRequeue(null);
      await loadAdmin(name.startsWith('role:') || name.startsWith('sessions:'));
    } catch (err) {
      setError(errorMessage(err, 'Действието е неуспешно.'));
    } finally {
      setBusy(null);
    }
  }

  async function changePassword(event: React.FormEvent) {
    event.preventDefault();
    setBusy('password');
    setError(null);
    try {
      await api.post('/auth/change-password', { currentPassword, newPassword });
      clearToken();
      router.replace('/login');
    } catch (err) {
      setError(errorMessage(err, 'Паролата не може да бъде сменена.'));
      setBusy(null);
    }
  }

  async function revokeOwnSessions() {
    setBusy('own-sessions');
    try {
      await api.post('/auth/revoke-sessions', {});
      clearToken();
      router.replace('/login');
    } catch (err) {
      setError(errorMessage(err, 'Сесиите не могат да бъдат прекратени.'));
      setBusy(null);
    }
  }

  function jobAction(job: Job) {
    const actionBusy = busy?.endsWith(job.id);
    if (job.status === 'QUEUED' || job.status === 'RUNNING') {
      return <button className="job-action job-action-danger" disabled={Boolean(busy)} onClick={() => void run(`cancel:${job.id}`, () => api.post(`/transcode/jobs/${job.id}/cancel`, {}), 'Задачата е отказана и временните файлове са почистени.')}>{actionBusy ? 'Отказване…' : 'Откажи'}</button>;
    }
    return <div className="job-actions">
      {(job.status === 'FAILED' || job.status === 'CANCELLED') && <button className="job-action" disabled={Boolean(busy)} onClick={() => void run(`retry:${job.id}`, () => api.post(`/transcode/jobs/${job.id}/retry`, {}), 'Нов опит е добавен в опашката.')}>{busy === `retry:${job.id}` ? 'Добавяне…' : 'Опитай пак'}</button>}
      {confirmRequeue === job.id
        ? <span className="requeue-confirm"><span>Старият HLS ще бъде заменен.</span><button className="job-action job-action-danger" disabled={Boolean(busy)} onClick={() => void run(`requeue:${job.id}`, () => api.post(`/transcode/jobs/${job.id}/requeue`, {}), 'Rendition-ът е добавен отново в опашката.')}>Потвърди</button><button className="job-action" onClick={() => setConfirmRequeue(null)}>Назад</button></span>
        : <button className="job-action" disabled={Boolean(busy)} onClick={() => setConfirmRequeue(job.id)}>Requeue</button>}
    </div>;
  }

  return <main className="container-fluid page settings-page" id="main-content">
    <header className="collection-header settings-header">
      <div><span className="eyebrow">Контролен център</span><h1>Акаунт и администрация</h1><p className="muted">Сигурност на акаунта, библиотека и надеждност на възпроизвеждането.</p></div>
      <Link className="back-link" href="/">← Библиотека</Link>
    </header>

    <nav className="settings-nav" aria-label="Секции на настройките">
      <a href="#account">Акаунт</a>
      {user?.isAdmin && <><a href="#operations">Операции</a><a href="#admin-center">Администраторски център</a><a href="#subtitles">Субтитри</a><a href="#users">Потребители</a><a href="#jobs">Transcode jobs</a></>}
    </nav>

    <div className="settings-feedback" aria-live="polite" aria-atomic="true">
      {error && <div className="alert alert-danger">{error}</div>}
      {result && <details className="alert alert-success"><summary>Действието завърши успешно</summary><pre>{result}</pre></details>}
    </div>

    {loading && <div className="settings-skeleton" aria-label="Зареждане на настройките"><span /><span /><span /></div>}

    {user && <section className="settings-section account-section" id="account">
      <div className="section-heading"><div><span className="eyebrow">Лични настройки</span><h2>Акаунт</h2></div><span className={`role-badge ${user.isAdmin ? 'role-admin' : ''}`}>{user.isAdmin ? 'Администратор' : 'Потребител'}</span></div>
      <div className="account-layout">
        <div className="account-identity"><span className="account-avatar" aria-hidden="true">{user.email.slice(0, 1).toUpperCase()}</span><div><strong>{user.email}</strong><span className="muted">ID {user.sub.slice(0, 8)}</span></div></div>
        <form className="account-password-form" onSubmit={changePassword}>
          <div><h3>Смяна на парола</h3><p className="muted">Минимум 10 знака. Всички издадени сесии ще бъдат прекратени.</p></div>
          <label>Текуща парола<input type="password" autoComplete="current-password" value={currentPassword} onChange={(event) => setCurrentPassword(event.target.value)} required /></label>
          <label>Нова парола<input type="password" autoComplete="new-password" value={newPassword} onChange={(event) => setNewPassword(event.target.value)} minLength={10} required /></label>
          <button disabled={Boolean(busy) || newPassword.length < 10}>{busy === 'password' ? 'Запазване…' : 'Смени паролата'}</button>
        </form>
        <div className="session-control"><div><h3>Активни сесии</h3><p className="muted">Излез от всички телефони, телевизори и браузъри, включително този.</p></div><button className="secondary-button danger-button" disabled={Boolean(busy)} onClick={() => void revokeOwnSessions()}>{busy === 'own-sessions' ? 'Прекратяване…' : 'Изход от всички устройства'}</button></div>
      </div>
    </section>}

    {user && !user.isAdmin && <div className="empty-state"><div><h2>Системните настройки са ограничени</h2><p className="muted">Акаунтът ти може да управлява профили, списък и история. Само администратор поддържа библиотеката и transcoding системата.</p></div></div>}

    {user?.isAdmin && <>
      <section className="settings-section" id="operations">
        <div className="section-heading"><div><span className="eyebrow">Само за администратори</span><h2>Системни операции</h2></div>{overview && <span className="system-state" title={`Проверено ${new Date(overview.checkedAt).toLocaleTimeString('bg-BG')}`}><i aria-hidden="true" /> API и база данни работят</span>}</div>
        {overview && <div className="overview-strip" aria-label="Системен преглед">
          <div><span>Заглавия</span><strong>{overview.catalog.titles}</strong></div>
          <div><span>Медийни файлове</span><strong>{overview.catalog.mediaFiles}</strong></div>
          <div><span>Профили</span><strong>{overview.catalog.profiles}</strong></div>
          <div><span>Неуспешни jobs</span><strong className={overview.transcode.failedJobs ? 'metric-danger' : ''}>{overview.transcode.failedJobs}</strong></div>
          <div><span>Свободен диск</span><strong>{formatBytes(overview.storage.transcode.freeBytes)}</strong></div>
        </div>}
        <div className="admin-actions" aria-label="Административни действия">
          <article className="admin-card"><span className="admin-index">01</span><div><h3>Сканиране</h3><p>Открива нови медийни файлове и ги добавя в каталога.</p></div><button disabled={Boolean(busy)} onClick={() => void run('scan', () => api.post('/media/scan', {}), 'Сканирането приключи.')}>{busy === 'scan' ? 'Сканиране…' : 'Сканирай библиотеката'}</button></article>
          <article className="admin-card"><span className="admin-index">02</span><div><h3>Поправка на каталога</h3><p>Показва как parser-ът би пренаредил несвързаните заглавия, без да променя данни.</p></div><button disabled={Boolean(busy)} onClick={() => void run('repair', () => api.post('/media/repair', { dryRun: true }), 'Dry-run проверката приключи.')}>{busy === 'repair' ? 'Проверка…' : 'Прегледай поправките'}</button></article>
          <article className="admin-card"><span className="admin-index">03</span><div><h3>Метаданни</h3><p>Допълва описания, жанрове, рейтинги, постери и backdrop изображения от TMDB.</p></div><button disabled={Boolean(busy)} onClick={() => void run('metadata', () => api.post('/metadata/refresh', {}), 'Липсващите метаданни са обработени.')}>{busy === 'metadata' ? 'Обновяване…' : 'Обнови липсващите'}</button></article>
          <article className="admin-card"><span className="admin-index">04</span><div><h3>Липсващи HLS версии</h3><p>Провери безопасно или добави до 10 несъвместими файла в transcode опашката.</p></div><div className="admin-card-actions"><button className="secondary-button" disabled={Boolean(busy)} onClick={() => void run('transcode-check', () => api.post('/transcode/missing', { dryRun: true, limit: 10 }), 'Проверката приключи.')}>{busy === 'transcode-check' ? 'Проверка…' : 'Само провери'}</button><button disabled={Boolean(busy)} onClick={() => { if (window.confirm('Да добавя до 10 файла в transcode опашката?')) void run('transcode-start', () => api.post('/transcode/missing', { dryRun: false, limit: 10 }), 'Файловете са добавени в опашката.'); }}>{busy === 'transcode-start' ? 'Добавяне…' : 'Добави в опашката'}</button></div></article>
          <article className="admin-card"><span className="admin-index">05</span><div><h3>Проверка на файловете</h3><p>Открива липсващи записи, orphan заглавия и вероятни дубликати. Deep проверката валидира всеки видеофайл с FFprobe.</p></div><div className="admin-card-actions"><button className="secondary-button" disabled={Boolean(busy)} onClick={() => void run('media-audit', () => api.post('/media/audit', { deep: false }), 'Проверката на библиотеката приключи.')}>{busy === 'media-audit' ? 'Проверка…' : 'Бърз audit'}</button><button disabled={Boolean(busy)} onClick={() => { if (window.confirm('Deep audit ще прочете всеки видеофайл и може да отнеме дълго време. Да продължа?')) void run('media-deep-audit', () => api.post('/media/audit', { deep: true }), 'Deep integrity проверката приключи.'); }}>{busy === 'media-deep-audit' ? 'Валидиране…' : 'Deep integrity audit'}</button></div></article>
        </div>
      </section>

      <AdminOpsCenter overview={overview} notify={(message, failed) => { if (failed) { setError(message); setResult(null); } else { setResult(message); setError(null); } }} />

      <section className="settings-section subtitle-admin" id="subtitles">
        <div className="section-heading"><div><span className="eyebrow">Езици и достъпност</span><h2>Субтитри</h2><p className="muted">Прегледай откритите писти или добави проверен SRT, ASS, SSA или VTT файл.</p></div></div>
        <div className="subtitle-admin-picker">
          <label>Заглавие<select value={subtitleTitleId} onChange={(event) => void chooseSubtitleTitle(event.target.value)}><option value="">Избери заглавие</option>{titles.map((title) => <option key={title.id} value={title.id}>{title.name}</option>)}</select></label>
          <label>Видео файл<select value={subtitleMediaId} disabled={!subtitleMedia} onChange={(event) => void chooseSubtitleMedia(event.target.value)}><option value="">Избери файл</option>{subtitleMedia?.mediaFiles.map((file) => <option key={file.id} value={file.id}>Филм · {file.container ?? 'video'}</option>)}{subtitleMedia?.episodes.flatMap((episode) => episode.mediaFiles.map((file) => <option key={file.id} value={file.id}>С{episode.seasonNumber} Е{episode.episodeNumber} · {episode.name ?? file.container ?? 'video'}</option>))}</select></label>
        </div>
        {subtitleMediaId && <div className="subtitle-admin-layout">
          <div className="subtitle-track-list">
            <h3>Открити писти <span>{subtitleTracks.length}</span></h3>
            {subtitleTracks.length === 0 ? <p className="muted">Няма намерени субтитри за този файл.</p> : subtitleTracks.map((track) => <article key={track.index}>
              <div><strong>{track.language === 'bul' ? 'Български' : track.language ?? 'Неизвестен'}{track.forced ? ' · Forced' : ''}</strong><span>{track.source === 'external' ? track.fileName : `Вградена писта ${track.index}`}</span></div>
              <span className={`status ${track.convertible ? 'status-done' : 'status-failed'}`}>{track.convertible ? 'Готова' : `Bitmap · ${track.codec}`}</span>
              {track.encoding && <span className="subtitle-encoding">{track.encoding}</span>}
              {track.source === 'external' && <div className="subtitle-row-actions"><button type="button" className="job-action" disabled={Boolean(busy)} onClick={() => void editSubtitle(track.index)}>Редактирай</button><button type="button" className="job-action job-action-danger" disabled={Boolean(busy)} onClick={() => void deleteSubtitle(track.index)}>Изтрий</button></div>}
            </article>)}
            {subtitleEditIndex !== null && <div className="subtitle-source-editor"><label>Съдържание<textarea value={subtitleEditContent} onChange={(event) => setSubtitleEditContent(event.target.value)} spellCheck={false} rows={16} /></label><div><button type="button" className="secondary-button" onClick={() => setSubtitleEditIndex(null)}>Отказ</button><button type="button" disabled={Boolean(busy)} onClick={() => void saveSubtitleEdit()}>{busy === 'subtitle-save' ? 'Запазване…' : 'Запази корекциите'}</button></div></div>}
          </div>
          <form className="subtitle-upload" onSubmit={uploadSubtitle}>
            <div><h3>Добавяне на файл</h3><p className="muted">Файлът се записва до видеото и се съпоставя автоматично.</p></div>
            <label>Файл<input type="file" accept=".srt,.ass,.ssa,.vtt" onChange={(event) => setSubtitleFile(event.target.files?.[0] ?? null)} required /></label>
            <label>Език<select value={subtitleLanguage} onChange={(event) => setSubtitleLanguage(event.target.value)}><option value="bul">Български</option><option value="eng">Английски</option><option value="rus">Руски</option><option value="ell">Гръцки</option></select></label>
            <label className="subtitle-forced"><input type="checkbox" checked={subtitleForced} onChange={(event) => setSubtitleForced(event.target.checked)} /> Forced писта</label>
            <button disabled={!subtitleFile || Boolean(busy)}>{busy === 'subtitle-upload' ? 'Качване…' : 'Качи субтитри'}</button>
            <div className="abr-admin-action"><strong>Адаптивно качество</strong><p>Създава 360p, 480p, 720p и 1080p до реалната височина на източника.</p><button type="button" className="secondary-button" disabled={Boolean(busy)} onClick={() => void enqueueAbrLadder()}>{busy === 'abr-ladder' ? 'Добавяне…' : 'Създай ABR стълбица'}</button></div>
            {subtitleCapabilities && <div className="bitmap-capability"><strong>PGS/VobSub</strong><span>{subtitleCapabilities.bitmapPlaybackAvailable ? 'Достъпни' : 'Не са достъпни'}</span><p>{subtitleCapabilities.bitmapReason}</p><small>FFmpeg burn-in filter: {subtitleCapabilities.burnInFilterAvailable ? 'наличен' : 'липсва'} · OCR: {subtitleCapabilities.ocrAvailable ? 'наличен' : 'липсва'}</small></div>}
          </form>
        </div>}
      </section>

      <section className="settings-section" id="users">
        <div className="section-heading"><div><span className="eyebrow">Достъп</span><h2>Потребители</h2><p className="muted">Ролите и сесиите се прилагат веднага. Промяна на роля прекратява старите сесии.</p></div><span className="section-count">{users.length}</span></div>
        <div className="users-table" role="list">
          {users.map((account) => <article key={account.id} role="listitem">
            <div className="user-main"><span className="user-avatar" aria-hidden="true">{account.email.slice(0, 1).toUpperCase()}</span><div><strong>{account.email}</strong><span>{account._count.profiles} {account._count.profiles === 1 ? 'профил' : 'профила'} · от {new Date(account.createdAt).toLocaleDateString('bg-BG')}</span></div></div>
            <span className={`role-badge ${account.isAdmin ? 'role-admin' : ''}`}>{account.isAdmin ? 'Администратор' : 'Потребител'}</span>
            <div className="user-actions">
              <button className="secondary-button" disabled={Boolean(busy) || account.id === user.sub} onClick={() => void run(`role:${account.id}`, () => api.patch(`/auth/users/${account.id}/role`, { isAdmin: !account.isAdmin }), account.isAdmin ? 'Администраторската роля е премахната.' : 'Потребителят вече е администратор.')}>{account.isAdmin ? 'Премахни admin' : 'Направи admin'}</button>
              <button className="secondary-button" disabled={Boolean(busy) || account.id === user.sub} onClick={() => void run(`sessions:${account.id}`, () => api.post(`/auth/users/${account.id}/revoke-sessions`, {}), 'Сесиите на потребителя са прекратени.')}>Прекрати сесиите</button>
            </div>
          </article>)}
        </div>
        <div className="active-session-register">
          <div className="section-heading"><div><h3>Активни входове</h3><p className="muted">Регистър на валидните входове от последните 7 дни. JWT съдържанието не се съхранява.</p></div><span className="section-count">{sessions.length}</span></div>
          {sessions.length === 0 ? <p className="muted">Няма регистрирани активни входове.</p> : <div className="session-table">{sessions.map((session) => <article key={session.id}><div><strong>{session.user.email}</strong><span>{session.userAgent ?? 'Неизвестно устройство'}</span></div><span>{session.ipAddress ?? 'IP неизвестен'}</span><time dateTime={session.createdAt}>{new Date(session.createdAt).toLocaleString('bg-BG')}</time></article>)}</div>}
        </div>
      </section>

      <section className="settings-section jobs-section" id="jobs">
        <div className="jobs-heading section-heading"><div><span className="eyebrow">Последни 50</span><h2>Transcode jobs</h2></div><div className="heading-actions"><span className="queue-total">{queueTotal} в опашката</span><button className="secondary-button" disabled={Boolean(busy)} onClick={() => void loadAdmin(true)}>Обнови</button></div></div>
        <div className="queue-strip" aria-label="Състояние на опашката">{Object.entries(queueStatus).map(([name, count]) => <div key={name}><span>{name}</span><strong>{count}</strong></div>)}</div>
        {jobs.length === 0 ? <div className="empty-state"><div><h3>Опашката е празна</h3><p className="muted">Новите задачи ще се появят тук.</p></div></div> : <div className="jobs-table" role="list">{jobs.map((job) => {
          const status = statusCopy[job.status];
          return <article key={job.id} role="listitem"><span className={`status status-${job.status.toLowerCase()}`}><span aria-hidden="true">{status.icon}</span> {status.label}</span><div className="job-file"><strong title={job.mediaFile.sourcePath}>{job.mediaFile.sourcePath}</strong>{job.error && <details><summary>Диагностика</summary><pre>{job.error}</pre></details>}</div><span className="job-encoder">{job.encoder} · {job.targetHeight}p{job.fallbackFrom && <small>fallback от {job.fallbackFrom}</small>}</span><span className="job-attempt">Опит {job.attempt}</span><time dateTime={job.createdAt}>{new Date(job.createdAt).toLocaleString('bg-BG')}</time>{jobAction(job)}</article>;
        })}</div>}
      </section>
    </>}
  </main>;
}

function errorMessage(error: unknown, fallback: string): string {
  return error instanceof Error ? error.message : fallback;
}

function formatBytes(value: number | null): string {
  if (value === null) return 'Няма данни';
  const gib = value / 1024 ** 3;
  return `${gib.toLocaleString('bg-BG', { maximumFractionDigits: gib >= 100 ? 0 : 1 })} GB`;
}
