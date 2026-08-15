import { Controller, Get, ServiceUnavailableException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { execFile } from 'child_process';
import { promisify } from 'util';
import { access, readdir, stat, statfs } from 'fs/promises';
import * as path from 'path';
import Redis from 'ioredis';
import { PrismaService } from './prisma/prisma.service';

const execFileAsync = promisify(execFile);

@Controller('health')
export class HealthController {
  constructor(private readonly prisma: PrismaService, private readonly config: ConfigService) {}

  @Get()
  async check() {
    const checks: Record<string, { status: 'ok' | 'degraded'; detail?: string }> = {};
    try { await this.prisma.$queryRaw`SELECT 1`; checks.postgresql = { status: 'ok' }; } catch (error) { checks.postgresql = { status: 'degraded', detail: short(error) }; }
    const redis = new Redis(this.config.get<string>('redis.url')!, { lazyConnect: true, connectTimeout: 2500, commandTimeout: 2500, maxRetriesPerRequest: 0 });
    try { await redis.connect(); checks.redis = { status: await redis.ping() === 'PONG' ? 'ok' : 'degraded' }; } catch (error) { checks.redis = { status: 'degraded', detail: short(error) }; } finally { redis.disconnect(); }
    try { const { stdout } = await execFileAsync('ffmpeg', ['-version'], { timeout: 3000 }); checks.ffmpeg = { status: 'ok', detail: stdout.split(/\r?\n/)[0] }; } catch (error) { checks.ffmpeg = { status: 'degraded', detail: short(error) }; }
    for (const [name, root] of [['mediaStorage', this.config.get<string>('media.root')!], ['transcodeStorage', this.config.get<string>('transcode.outputRoot')!]] as const) {
      try { await access(root); const info = await statfs(root); const freePercent = info.blocks ? Math.round(info.bavail / info.blocks * 100) : 0; checks[name] = { status: freePercent >= 8 ? 'ok' : 'degraded', detail: `${freePercent}% free` }; } catch (error) { checks[name] = { status: 'degraded', detail: short(error) }; }
    }
    checks.backup = await backupHealth();
    const degraded = Object.values(checks).some((check) => check.status !== 'ok');
    const result = { status: degraded ? 'degraded' : 'ok', checks, uptimeSec: Math.floor(process.uptime()), timestamp: new Date().toISOString() };
    if (degraded && ['postgresql','redis','ffmpeg','mediaStorage','transcodeStorage'].some((name) => checks[name]?.status === 'degraded')) throw new ServiceUnavailableException(result);
    return result;
  }
}

async function backupHealth(): Promise<{ status: 'ok' | 'degraded'; detail?: string }> {
  const root = process.env.BACKUP_ROOT ?? 'G:\\My Drive\\StreamingPlatformBackups';
  try {
    const files = (await readdir(root)).filter((name) => /^streaming-backup-.*\.7z$/.test(name));
    if (!files.length) return { status: 'degraded', detail: 'No backup found' };
    const entries = await Promise.all(files.map(async (name) => ({ name, info: await stat(path.join(root, name)) })));
    const latest = entries.sort((a, b) => b.info.mtimeMs - a.info.mtimeMs)[0];
    const ageHours = Math.round((Date.now() - latest.info.mtimeMs) / 3_600_000);
    return { status: ageHours <= 30 && latest.info.size > 0 ? 'ok' : 'degraded', detail: `${latest.name}, ${ageHours}h old` };
  } catch (error) { return { status: 'degraded', detail: short(error) }; }
}
function short(error: unknown) { return (error instanceof Error ? error.message : String(error)).slice(0, 240); }
