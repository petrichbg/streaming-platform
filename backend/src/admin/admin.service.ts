import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { statfs } from 'fs/promises';
import { PrismaService } from '../prisma/prisma.service';

interface StorageSummary {
  path: string;
  totalBytes: number | null;
  freeBytes: number | null;
}

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
