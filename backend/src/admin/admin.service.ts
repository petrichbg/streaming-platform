import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { execFile } from 'child_process';
import { promisify } from 'util';
import { readdir, readFile, stat, statfs } from 'fs/promises';
import * as path from 'path';
import { PrismaService } from '../prisma/prisma.service';

interface StorageSummary {
  path: string;
  totalBytes: number | null;
  freeBytes: number | null;
}

const execFileAsync = promisify(execFile);
const PROJECT_ROOT = path.resolve(process.cwd(), '..');
const LOG_ROOT = path.join(PROJECT_ROOT, 'var', 'logs');
const BACKUP_ROOT = process.env.BACKUP_ROOT ?? 'G:\\My Drive\\StreamingPlatformBackups';

@Injectable()
export class AdminService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly config: ConfigService,
  ) {}

  async overview() {
    const mediaRoot = this.config.get<string>('media.root')!;
    const transcodeRoot = this.config.get<string>('transcode.outputRoot')!;
    const [titles, mediaFiles, profiles, users, failedJobs, mediaStorage, transcodeStorage] = await Promise.all([
      this.prisma.title.count(),
      this.prisma.mediaFile.count(),
      this.prisma.profile.count(),
      this.prisma.user.count(),
      this.prisma.transcodeJob.count({ where: { status: 'FAILED' } }),
      storageSummary(mediaRoot),
      storageSummary(transcodeRoot),
    ]);

    return {
      status: 'ok',
      checkedAt: new Date().toISOString(),
      uptimeSec: Math.floor(process.uptime()),
      catalog: { titles, mediaFiles, profiles, users },
      transcode: { failedJobs },
      storage: { media: mediaStorage, transcode: transcodeStorage },
    };
  }

  async diagnostics() {
    const recentFailed = await this.prisma.transcodeJob.findMany({
      where: { status: 'FAILED' }, orderBy: { createdAt: 'desc' }, take: 5,
      select: { id: true, createdAt: true, encoder: true, targetHeight: true, error: true, mediaFile: { select: { sourcePath: true } } },
    });
    return {
      checkedAt: new Date().toISOString(),
      runtime: { node: process.version, platform: process.platform, arch: process.arch, pid: process.pid, uptimeSec: Math.floor(process.uptime()), memory: process.memoryUsage() },
      configuration: {
        tmdbConfigured: Boolean(this.config.get<string>('tmdb.accessToken')),
        mediaRoot: this.config.get<string>('media.root'),
        transcodeRoot: this.config.get<string>('transcode.outputRoot'),
      },
      recentFailed,
    };
  }

  async logs(requested?: string) {
    let files: string[];
    try { files = (await readdir(LOG_ROOT)).filter((name) => /^(backend|web|supervisor|cloudflared)-[\w.-]+\.log$|^supervisor\.log$/.test(name)); } catch { return { files: [], selected: null, lines: [] }; }
    files.sort().reverse();
    const selected = requested && files.includes(requested) ? requested : files[0] ?? null;
    if (!selected) return { files, selected: null, lines: [] };
    const content = await readFile(path.join(LOG_ROOT, selected), 'utf8');
    return { files, selected, lines: content.split(/\r?\n/).slice(-300) };
  }

  async backups() {
    try {
      const names = (await readdir(BACKUP_ROOT)).filter((name) => /^streaming-backup-\d{4}-\d{2}-\d{2}_\d{6}\.7z$/.test(name));
      return Promise.all(names.sort().reverse().map(async (name) => {
        const info = await stat(path.join(BACKUP_ROOT, name));
        return { name, sizeBytes: info.size, createdAt: info.mtime.toISOString() };
      }));
    } catch { return []; }
  }

  async createBackup() {
    const script = path.join(PROJECT_ROOT, 'scripts', 'backup.ps1');
    const { stdout } = await execFileAsync('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', script, '-BackupRoot', BACKUP_ROOT], { cwd: PROJECT_ROOT, timeout: 15 * 60_000, windowsHide: true });
    return { created: true, output: stdout.trim(), backups: await this.backups() };
  }

  async verifyBackup(name: string) {
    if (!/^streaming-backup-\d{4}-\d{2}-\d{2}_\d{6}\.7z$/.test(name)) throw new BadRequestException('Invalid backup name');
    const archive = path.join(BACKUP_ROOT, name);
    try { await stat(archive); } catch { throw new NotFoundException('Backup not found'); }
    const script = path.join(PROJECT_ROOT, 'scripts', 'restore-test.ps1');
    const { stdout } = await execFileAsync('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', script, '-BackupRoot', BACKUP_ROOT, '-ArchivePath', archive], { cwd: PROJECT_ROOT, timeout: 15 * 60_000, windowsHide: true });
    return { verified: true, name, output: stdout.trim() };
  }

  metadataTitles() {
    return this.prisma.title.findMany({ orderBy: { name: 'asc' }, select: { id: true, name: true, type: true, overview: true, releaseYear: true, rating: true, genres: true, director: true, cast: true, tmdbId: true, posterPath: true } });
  }

  async updateMetadata(titleId: string, body: { name?: string; overview?: string | null; releaseYear?: number | null; rating?: string | null; genres?: string[]; director?: string | null; cast?: string[]; dryRun?: boolean; confirmation?: string }) {
    const current = await this.prisma.title.findUnique({ where: { id: titleId } });
    if (!current) throw new NotFoundException('Title not found');
    const data = {
      ...(body.name !== undefined ? { name: body.name.trim() } : {}),
      ...(body.overview !== undefined ? { overview: body.overview?.trim() || null } : {}),
      ...(body.releaseYear !== undefined ? { releaseYear: body.releaseYear } : {}),
      ...(body.rating !== undefined ? { rating: body.rating?.trim() || null } : {}),
      ...(body.genres !== undefined ? { genres: body.genres.map((value) => value.trim()).filter(Boolean).slice(0, 20) } : {}),
      ...(body.director !== undefined ? { director: body.director?.trim() || null } : {}),
      ...(body.cast !== undefined ? { cast: body.cast.map((value) => value.trim()).filter(Boolean).slice(0, 30) } : {}),
    };
    if ('name' in data && !data.name) throw new BadRequestException('Name cannot be empty');
    if (body.dryRun !== false) return { dryRun: true, before: current, after: { ...current, ...data }, requiredConfirmation: current.name };
    if (body.confirmation !== current.name) throw new BadRequestException('Confirmation must exactly match the current title name');
    return this.prisma.title.update({ where: { id: titleId }, data });
  }
}

async function storageSummary(path: string): Promise<StorageSummary> {
  try {
    const stats = await statfs(path);
    return {
      path,
      totalBytes: stats.blocks * stats.bsize,
      freeBytes: stats.bavail * stats.bsize,
    };
  } catch {
    return { path, totalBytes: null, freeBytes: null };
  }
}
