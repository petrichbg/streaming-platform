'use client';

import { useEffect, useMemo, useState } from 'react';
import { api } from '@/lib/api';

interface Storage { path: string; totalBytes: number | null; freeBytes: number | null }
interface Overview { storage: { media: Storage; transcode: Storage } }
interface MetadataTitle { id: string; name: string; type: 'MOVIE' | 'SERIES'; overview: string | null; releaseYear: number | null; rating: string | null; genres: string[]; director: string | null; cast: string[]; tmdbId: number | null; posterPath: string | null }
interface Backup { name: string; sizeBytes: number; createdAt: string }
interface Logs { files: string[]; selected: string | null; lines: string[] }
interface Diagnostics { checkedAt: string; runtime: { node: string; platform: string; arch: string; pid: number; uptimeSec: number; memory: { rss: number; heapUsed: number } }; configuration: { tmdbConfigured: boolean; mediaRoot: string; transcodeRoot: string }; recentFailed: Array<{ id: string; error: string | null; mediaFile: { sourcePath: string } }> }

export default function AdminOpsCenter({ overview, notify }: { overview: Overview | null; notify: (message: string, error?: boolean) => void }) {
  const [tab, setTab] = useState<'metadata' | 'storage' | 'backups' | 'diagnostics'>('metadata');
  const [titles, setTitles] = useState<MetadataTitle[]>([]);
  const [selectedId, setSelectedId] = useState('');
  const [draft, setDraft] = useState<MetadataTitle | null>(null);
  const [preview, setPreview] = useState<{ before: MetadataTitle; after: MetadataTitle; requiredConfirmation: string } | null>(null);
  const [confirmation, setConfirmation] = useState('');
  const [backups, setBackups] = useState<Backup[]>([]);
  const [backupConfirm, setBackupConfirm] = useState<string | null>(null);
  const [diagnostics, setDiagnostics] = useState<Diagnostics | null>(null);
  const [logs, setLogs] = useState<Logs | null>(null);
  const [busy, setBusy] = useState<string | null>(null);

  async function load() {
    const [metadata, backupList, diagnosticData, logData] = await Promise.all([
      api.get<MetadataTitle[]>('/admin/metadata'), api.get<Backup[]>('/admin/backups'),
      api.get<Diagnostics>('/admin/diagnostics'), api.get<Logs>('/admin/logs'),
    ]);
    setTitles(metadata); setBackups(backupList); setDiagnostics(diagnosticData); setLogs(logData);
  }
  useEffect(() => { void load().catch((error) => notify(error instanceof Error ? error.message : 'Административните данни не могат да се заредят.', true)); }, []);

  const selected = useMemo(() => titles.find((title) => title.id === selectedId) ?? null, [titles, selectedId]);
  useEffect(() => { setDraft(selected ? { ...selected, genres: [...selected.genres], cast: [...selected.cast] } : null); setPreview(null); setConfirmation(''); }, [selected]);

  async function previewMetadata() {
    if (!draft) return;
    setBusy('metadata-preview');
    try { setPreview(await api.patch(`/admin/metadata/${draft.id}`, metadataPayload(draft, true))); }
    catch (error) { notify(message(error), true); } finally { setBusy(null); }
  }
  async function saveMetadata() {
    if (!draft || !preview) return;
    setBusy('metadata-save');
    try {
      const saved = await api.patch<MetadataTitle>(`/admin/metadata/${draft.id}`, { ...metadataPayload(draft, false), confirmation });
      setTitles((items) => items.map((item) => item.id === saved.id ? saved : item));
      setPreview(null); setConfirmation(''); notify('Метаданните са записани.');
    } catch (error) { notify(message(error), true); } finally { setBusy(null); }
  }
  async function createBackup() {
    setBusy('backup-create');
    try { await api.post('/admin/backups', {}); setBackups(await api.get('/admin/backups')); notify('Криптираният backup е създаден и проверен.'); }
    catch (error) { notify(message(error), true); } finally { setBusy(null); }
  }
  async function verifyBackup(name: string) {
    setBusy(`verify:${name}`);
    try { await api.post(`/admin/backups/${encodeURIComponent(name)}/verify`, {}); setBackupConfirm(null); notify('Restore тестът завърши успешно в изолирана база.'); }
    catch (error) { notify(message(error), true); } finally { setBusy(null); }
  }
  async function selectLog(file: string) {
    try { setLogs(await api.get(`/admin/logs?file=${encodeURIComponent(file)}`)); } catch (error) { notify(message(error), true); }
  }

  return <section className="settings-section admin-ops-center" id="admin-center">
    <div className="section-heading"><div><span className="eyebrow">Управление без конзола</span><h2>Администраторски център</h2><p className="muted">Каталог, съхранение, възстановяване и диагностика на едно място.</p></div></div>
    <div className="ops-tabs" role="tablist" aria-label="Администраторски инструменти">
      {([['metadata','Метаданни'],['storage','Дискове'],['backups','Backup и restore'],['diagnostics','Логове и диагностика']] as const).map(([id,label]) => <button key={id} role="tab" aria-selected={tab === id} className={tab === id ? 'active' : ''} onClick={() => setTab(id)}>{label}</button>)}
    </div>

    {tab === 'metadata' && <div className="metadata-workbench">
      <label className="ops-field">Заглавие<select value={selectedId} onChange={(event) => setSelectedId(event.target.value)}><option value="">Избери заглавие за проверка</option>{titles.map((title) => <option value={title.id} key={title.id}>{title.name} ({title.releaseYear ?? '—'})</option>)}</select></label>
      {draft && <div className="metadata-editor">
        <div className="metadata-poster">{draft.posterPath ? <img src={`${process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:3000'}${draft.posterPath}`} alt="" /> : <span>Без постер</span>}<small>{draft.tmdbId ? `TMDB ${draft.tmdbId}` : 'Без TMDB съвпадение'}</small></div>
        <div className="metadata-fields">
          <label>Заглавие<input value={draft.name} onChange={(event) => setDraft({ ...draft, name: event.target.value })} /></label>
          <div className="metadata-field-row"><label>Година<input type="number" value={draft.releaseYear ?? ''} onChange={(event) => setDraft({ ...draft, releaseYear: event.target.value ? Number(event.target.value) : null })} /></label><label>Рейтинг<input value={draft.rating ?? ''} onChange={(event) => setDraft({ ...draft, rating: event.target.value || null })} /></label></div>
          <label>Жанрове<input value={draft.genres.join(', ')} onChange={(event) => setDraft({ ...draft, genres: split(event.target.value) })} /></label>
          <label>Режисьор<input value={draft.director ?? ''} onChange={(event) => setDraft({ ...draft, director: event.target.value || null })} /></label>
          <label>Актьори<input value={draft.cast.join(', ')} onChange={(event) => setDraft({ ...draft, cast: split(event.target.value) })} /></label>
          <label>Описание<textarea rows={5} value={draft.overview ?? ''} onChange={(event) => setDraft({ ...draft, overview: event.target.value || null })} /></label>
          <button disabled={Boolean(busy)} onClick={() => void previewMetadata()}>{busy === 'metadata-preview' ? 'Проверка…' : 'Прегледай промените'}</button>
        </div>
        {preview && <div className="safe-confirm"><strong>Потвърждение преди запис</strong><p>Промените засягат само каталожните данни. Медийният файл и историята на гледане няма да бъдат изтривани.</p><label>Напиши <b>{preview.requiredConfirmation}</b><input value={confirmation} onChange={(event) => setConfirmation(event.target.value)} /></label><div><button className="secondary-button" onClick={() => setPreview(null)}>Назад</button><button disabled={confirmation !== preview.requiredConfirmation || Boolean(busy)} onClick={() => void saveMetadata()}>{busy === 'metadata-save' ? 'Записване…' : 'Запиши промените'}</button></div></div>}
      </div>}
    </div>}

    {tab === 'storage' && <div className="storage-list">{overview && [overview.storage.media, overview.storage.transcode].map((disk, index) => <StorageRow key={disk.path} label={index ? 'Транскодирани версии' : 'Оригинална библиотека'} storage={disk} />)}</div>}

    {tab === 'backups' && <div className="backup-panel"><div className="backup-toolbar"><div><strong>Криптирани архиви</strong><p>Backup включва базата, конфигурацията и recovery metadata. Restore проверката използва отделна временна база.</p></div><button disabled={Boolean(busy)} onClick={() => void createBackup()}>{busy === 'backup-create' ? 'Създаване…' : 'Създай backup'}</button></div>{backups.length === 0 ? <p className="muted">Няма открити архиви или backup дискът не е наличен.</p> : <div className="backup-list">{backups.map((backup) => <article key={backup.name}><div><strong>{backup.name}</strong><span>{bytes(backup.sizeBytes)} · {new Date(backup.createdAt).toLocaleString('bg-BG')}</span></div>{backupConfirm === backup.name ? <div className="inline-confirm"><span>Ще се създаде временна база и архивът ще бъде възстановен в нея.</span><button className="secondary-button" onClick={() => setBackupConfirm(null)}>Назад</button><button disabled={Boolean(busy)} onClick={() => void verifyBackup(backup.name)}>{busy === `verify:${backup.name}` ? 'Проверка…' : 'Потвърди restore тест'}</button></div> : <button className="secondary-button" onClick={() => setBackupConfirm(backup.name)}>Провери възстановяване</button>}</article>)}</div>}</div>}

    {tab === 'diagnostics' && <div className="diagnostics-layout">{diagnostics && <div className="diagnostic-facts"><div><span>Runtime</span><strong>Node {diagnostics.runtime.node}</strong><small>{diagnostics.runtime.platform} · {diagnostics.runtime.arch} · PID {diagnostics.runtime.pid}</small></div><div><span>Памет</span><strong>{bytes(diagnostics.runtime.memory.rss)}</strong><small>Heap {bytes(diagnostics.runtime.memory.heapUsed)}</small></div><div><span>TMDB</span><strong>{diagnostics.configuration.tmdbConfigured ? 'Конфигуриран' : 'Липсва token'}</strong><small>Проверено {new Date(diagnostics.checkedAt).toLocaleTimeString('bg-BG')}</small></div></div>}<div className="log-viewer"><div className="log-toolbar"><label>Лог<select value={logs?.selected ?? ''} onChange={(event) => void selectLog(event.target.value)}>{logs?.files.map((file) => <option key={file}>{file}</option>)}</select></label><span>Последни {logs?.lines.length ?? 0} реда</span></div><pre>{logs?.lines.join('\n') || 'Няма налични логове.'}</pre></div></div>}
  </section>;
}

function StorageRow({ label, storage }: { label: string; storage: Storage }) {
  const used = storage.totalBytes !== null && storage.freeBytes !== null ? storage.totalBytes - storage.freeBytes : null;
  const percent = used !== null && storage.totalBytes ? Math.round(used / storage.totalBytes * 100) : 0;
  return <article><div><strong>{label}</strong><span>{storage.path}</span></div><div className="storage-meter"><span style={{ width: `${percent}%` }} /></div><div><strong>{percent}% използвани</strong><span>{storage.freeBytes === null ? 'Няма данни' : `${bytes(storage.freeBytes)} свободни от ${bytes(storage.totalBytes!)}`}</span></div></article>;
}
function metadataPayload(draft: MetadataTitle, dryRun: boolean) { return { name: draft.name, overview: draft.overview, releaseYear: draft.releaseYear, rating: draft.rating, genres: draft.genres, director: draft.director, cast: draft.cast, dryRun }; }
function split(value: string) { return value.split(',').map((item) => item.trim()).filter(Boolean); }
function bytes(value: number) { const units = ['B','KB','MB','GB','TB']; let size = value; let unit = 0; while (size >= 1024 && unit < units.length - 1) { size /= 1024; unit++; } return `${size.toLocaleString('bg-BG', { maximumFractionDigits: 1 })} ${units[unit]}`; }
function message(error: unknown) { return error instanceof Error ? error.message : 'Операцията е неуспешна.'; }
