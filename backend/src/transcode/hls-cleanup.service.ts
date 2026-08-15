import { Injectable, Logger, OnApplicationShutdown, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import * as fs from 'fs/promises';
import * as path from 'path';
import { PrismaService } from '../prisma/prisma.service';

const ABANDONED_MS = 60 * 60 * 1000;

@Injectable()
export class HlsCleanupService implements OnModuleInit, OnApplicationShutdown {
  private readonly logger = new Logger(HlsCleanupService.name);
  private timer?: NodeJS.Timeout;

  constructor(private readonly config: ConfigService, private readonly prisma: PrismaService) {}

  async onModuleInit() {
    await this.cleanupAbandoned();
    this.timer = setInterval(() => void this.cleanupAbandoned().catch((error) => this.logger.error(`Scheduled HLS cleanup failed: ${error.message}`)), 60 * 60_000);
    this.timer.unref();
  }

  onApplicationShutdown() { if (this.timer) clearInterval(this.timer); }

  finalDir(mediaFileId: string, height: number) {
    return path.join(this.root(), mediaFileId, `${height}p`);
  }

  workDir(mediaFileId: string, height: number, jobId: string) {
    return path.join(this.root(), mediaFileId, `${height}p.work-${jobId}`);
  }

  async prepare(mediaFileId: string, height: number, jobId: string) {
    const dir = this.workDir(mediaFileId, height, jobId);
    await fs.rm(dir, { recursive: true, force: true });
    await fs.mkdir(dir, { recursive: true });
    return dir;
  }

  async discardWork(mediaFileId: string, height: number, jobId: string) {
    await fs.rm(this.workDir(mediaFileId, height, jobId), { recursive: true, force: true });
  }

  async removeRendition(mediaFileId: string, height: number) {
    await fs.rm(this.finalDir(mediaFileId, height), { recursive: true, force: true });
  }

  async publish(mediaFileId: string, height: number, jobId: string) {
    const work = this.workDir(mediaFileId, height, jobId);
    await this.validate(work);
    const final = this.finalDir(mediaFileId, height);
    const stale = `${final}.stale-${jobId}`;
    await fs.rm(stale, { recursive: true, force: true });
    if (await exists(final)) await fs.rename(final, stale);
    try {
      await fs.rename(work, final);
      await fs.rm(stale, { recursive: true, force: true });
    } catch (error) {
      if (!(await exists(final)) && (await exists(stale))) await fs.rename(stale, final);
      throw error;
    }
    return path.join(final, 'master.m3u8');
  }

  async validate(dir: string) {
    const master = path.join(dir, 'master.m3u8');
    const masterText = await fs.readFile(master, 'utf8');
    const playlists = mediaLines(masterText).filter((line) => line.endsWith('.m3u8'));
    if (playlists.length === 0) throw new Error('HLS validation failed: master has no child playlists');
    for (const playlist of playlists) {
      if (!/^stream_\d{1,2}\.m3u8$/.test(playlist)) throw new Error(`HLS validation failed: unsafe playlist ${playlist}`);
      const text = await fs.readFile(path.join(dir, playlist), 'utf8');
      const segments = mediaLines(text).filter((line) => line.endsWith('.ts'));
      if (segments.length === 0) throw new Error(`HLS validation failed: ${playlist} has no segments`);
      for (const segment of segments) {
        if (!/^stream_\d{1,2}_\d{5}\.ts$/.test(segment)) throw new Error(`HLS validation failed: unsafe segment ${segment}`);
        const stat = await fs.stat(path.join(dir, segment));
        if (stat.size === 0) throw new Error(`HLS validation failed: empty segment ${segment}`);
      }
    }
  }

  async cleanupAbandoned() {
    const root = this.root();
    await fs.mkdir(root, { recursive: true });
    const mediaDirs = await fs.readdir(root, { withFileTypes: true });
    for (const mediaDir of mediaDirs) {
      if (!mediaDir.isDirectory() || !/^[0-9a-f-]{36}$/i.test(mediaDir.name)) continue;
      const parent = path.join(root, mediaDir.name);
      const mediaExists = await this.prisma.mediaFile.count({ where: { id: mediaDir.name } });
      if (!mediaExists) {
        const info = await fs.stat(parent);
        if (Date.now() - info.mtimeMs >= 7 * 24 * 60 * 60_000) {
          await fs.rm(parent, { recursive: true, force: true });
          this.logger.warn(`Removed orphan HLS directory ${parent}`);
        }
        continue;
      }
      for (const entry of await fs.readdir(parent, { withFileTypes: true })) {
        if (!entry.isDirectory()) continue;
        const dir = path.join(parent, entry.name);
        const stat = await fs.stat(dir);
        if (Date.now() - stat.mtimeMs < ABANDONED_MS) continue;
        if (/\.work-|\.stale-/.test(entry.name)) {
          await fs.rm(dir, { recursive: true, force: true });
          this.logger.warn(`Removed abandoned HLS work directory ${dir}`);
          continue;
        }
        if (/^\d+p$/.test(entry.name)) {
          const hasMaster = await exists(path.join(dir, 'master.m3u8'));
          const hasLegacyIndex = await exists(path.join(dir, 'index.m3u8'));
          let invalid = !hasMaster && !hasLegacyIndex;
          if (hasMaster) {
            try { await this.validate(dir); } catch { invalid = true; }
          }
          if (invalid) {
            await fs.rm(dir, { recursive: true, force: true });
            this.logger.warn(`Removed incomplete or corrupt HLS rendition ${dir}`);
          }
        }
      }
    }
  }

  private root() {
    return this.config.get<string>('transcode.outputRoot')!;
  }
}

function mediaLines(playlist: string) {
  return playlist.split(/\r?\n/).map((line) => line.trim()).filter((line) => line && !line.startsWith('#'));
}

async function exists(filePath: string) {
  try { await fs.access(filePath); return true; } catch { return false; }
}
