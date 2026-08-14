import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Dirent } from 'fs';
import * as fs from 'fs/promises';
import * as path from 'path';
import { PrismaService } from '../prisma/prisma.service';
import { FfprobeService } from './ffprobe.service';
import { isSamplePath, parseMediaPath } from './filename-parser';

const VIDEO_EXTENSIONS = new Set(['.mkv', '.mp4', '.avi', '.m4v', '.ts', '.mov']);

export interface RepairReport {
  dryRun: boolean;
  retitled: Array<{ sourcePath: string; from: string | null; to: string; year: number | null }>;
  removedSamples: Array<{ sourcePath: string; wasTitle: string | null }>;
  /** Titles left in place because the viewer has history against them. */
  keptForSafety: string[];
  deletedTitles: number;
}

export interface ScanStats {
  scanned: number;
  imported: number;
  skipped: number;
  failed: number;
}

@Injectable()
export class MediaScannerService {
  private readonly logger = new Logger(MediaScannerService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly ffprobe: FfprobeService,
    private readonly config: ConfigService,
  ) {}

  async scan(): Promise<ScanStats> {
    const mediaRoot = this.config.get<string>('media.root')!;
    const stats: ScanStats = { scanned: 0, imported: 0, skipped: 0, failed: 0 };

    for await (const filePath of this.walk(mediaRoot)) {
      stats.scanned++;
      const relativePath = path.relative(mediaRoot, filePath);

      // Checked against the whole relative path: a sample clip is often put
      // in a Sample/ directory under the release's own cryptic name.
      if (isSamplePath(relativePath)) {
        this.logger.log(`Skipped sample clip: ${relativePath}`);
        stats.skipped++;
        continue;
      }

      const existing = await this.prisma.mediaFile.findFirst({
        where: { sourcePath: relativePath },
      });
      if (existing) {
        stats.skipped++;
        continue;
      }

      try {
        await this.importFile(mediaRoot, relativePath);
        stats.imported++;
      } catch (err) {
        this.logger.error(`Failed to import ${relativePath}: ${(err as Error).message}`);
        stats.failed++;
      }
    }

    return stats;
  }

  /**
   * Re-applies the current parser to files already in the database.
   *
   * Scanning only ever inserts, so improving the parser leaves every existing
   * row with the title it was first given -- a fix that never reaches the
   * catalogue is no fix. This walks what is stored, re-parses each path, moves
   * the file to the title it should have had, and drops what the parser now
   * recognises as a sample.
   *
   * A title is only deleted once nothing points at it. Watch progress and
   * watchlist entries count as pointing at it: those are the viewer's data,
   * and losing them to a metadata cleanup would be a poor trade, so such a
   * title is reported and left alone.
   */
  async repair(dryRun = true): Promise<RepairReport> {
    const mediaFiles = await this.prisma.mediaFile.findMany({
      select: {
        id: true,
        sourcePath: true,
        titleId: true,
        episodeId: true,
        title: { select: { name: true, overview: true, posterPath: true } },
      },
    });

    const report: RepairReport = { dryRun, retitled: [], removedSamples: [], keptForSafety: [], deletedTitles: 0 };

    for (const mediaFile of mediaFiles) {
      if (isSamplePath(mediaFile.sourcePath)) {
        report.removedSamples.push({ sourcePath: mediaFile.sourcePath, wasTitle: mediaFile.title?.name ?? null });
        if (!dryRun) await this.prisma.mediaFile.delete({ where: { id: mediaFile.id } });
        continue;
      }

      // Episodes are left alone: their titles come from an SxxExx file name,
      // which the path rules do not change.
      if (mediaFile.episodeId) continue;

      // A title TMDB has already identified carries a proper name, overview
      // and poster -- usually in Bulgarian, which no file name resembles.
      // Renaming it back to whatever the path says would throw that away, so
      // repairing is limited to the titles the match never reached.
      if (mediaFile.title?.overview || mediaFile.title?.posterPath) continue;

      const parsed = parseMediaPath(mediaFile.sourcePath);
      if (parsed.type !== 'movie' || !parsed.title) continue;
      if (mediaFile.title?.name === parsed.title) continue;

      report.retitled.push({
        sourcePath: mediaFile.sourcePath,
        from: mediaFile.title?.name ?? null,
        to: parsed.title,
        year: parsed.year ?? null,
      });

      if (dryRun) continue;

      const title = await this.prisma.title.upsert({
        where: { name_type: { name: parsed.title, type: 'MOVIE' } },
        create: { type: 'MOVIE', name: parsed.title, releaseYear: parsed.year },
        update: {},
      });
      await this.prisma.mediaFile.update({
        where: { id: mediaFile.id },
        data: { titleId: title.id },
      });
    }

    if (!dryRun) {
      const orphans = await this.prisma.title.findMany({
        where: {
          mediaFiles: { none: {} },
          episodes: { none: {} },
        },
        select: { id: true, name: true, _count: { select: { watchProgress: true, watchlist: true } } },
      });

      for (const orphan of orphans) {
        if (orphan._count.watchProgress > 0 || orphan._count.watchlist > 0) {
          report.keptForSafety.push(orphan.name);
          continue;
        }
        await this.prisma.title.delete({ where: { id: orphan.id } });
        report.deletedTitles++;
      }
    }

    return report;
  }

  private async *walk(dir: string): AsyncGenerator<string> {
    let entries: Dirent[];
    try {
      entries = await fs.readdir(dir, { withFileTypes: true });
    } catch (err) {
      this.logger.error(`Cannot read directory ${dir}: ${(err as Error).message}`);
      return;
    }

    for (const entry of entries) {
      const fullPath = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        yield* this.walk(fullPath);
      } else if (VIDEO_EXTENSIONS.has(path.extname(entry.name).toLowerCase())) {
        yield fullPath;
      }
    }
  }

  private async importFile(mediaRoot: string, relativePath: string): Promise<void> {
    const fullPath = path.join(mediaRoot, relativePath);
    const probe = await this.ffprobe.probe(fullPath);

    const videoStream = probe.streams.find((s) => s.codec_type === 'video');
    const audioStreams = probe.streams.filter((s) => s.codec_type === 'audio');
    const subtitleStreams = probe.streams.filter((s) => s.codec_type === 'subtitle');

    const durationSec = probe.format.duration
      ? Math.round(parseFloat(probe.format.duration))
      : undefined;

    // The directory often carries the real title while the file is named
    // after the release group, so the whole path is parsed, not the basename.
    const parsed = parseMediaPath(relativePath);

    const audioTracks = audioStreams.map((s) => ({
      index: s.index,
      codec: s.codec_name ?? null,
      language: s.tags?.language ?? null,
    }));
    const subtitleTracks = subtitleStreams.map((s) => ({
      index: s.index,
      codec: s.codec_name ?? null,
      language: s.tags?.language ?? null,
      forced: s.disposition?.forced === 1,
    }));

    let titleId: string;
    let episodeId: string | undefined;

    if (parsed.type === 'episode') {
      const title = await this.prisma.title.upsert({
        where: { name_type: { name: parsed.title, type: 'SERIES' } },
        create: { type: 'SERIES', name: parsed.title },
        update: {},
      });
      titleId = title.id;

      const episode = await this.prisma.episode.upsert({
        where: {
          titleId_seasonNumber_episodeNumber: {
            titleId: title.id,
            seasonNumber: parsed.season!,
            episodeNumber: parsed.episode!,
          },
        },
        create: {
          titleId: title.id,
          seasonNumber: parsed.season!,
          episodeNumber: parsed.episode!,
        },
        update: {},
      });
      episodeId = episode.id;
    } else {
      const title = await this.prisma.title.upsert({
        where: { name_type: { name: parsed.title, type: 'MOVIE' } },
        create: { type: 'MOVIE', name: parsed.title, releaseYear: parsed.year },
        update: {},
      });
      titleId = title.id;
    }

    await this.prisma.mediaFile.create({
      data: {
        titleId: episodeId ? undefined : titleId,
        episodeId,
        sourcePath: relativePath,
        container: path.extname(relativePath).slice(1),
        videoCodec: videoStream?.codec_name,
        audioTracks,
        subtitleTracks,
        durationSec,
      },
    });

    this.logger.log(`Imported: ${relativePath} -> ${parsed.type} "${parsed.title}"`);
  }
}
