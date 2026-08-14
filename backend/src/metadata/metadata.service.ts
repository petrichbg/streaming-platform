import { Injectable, Logger, NotFoundException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import * as fs from 'fs/promises';
import * as path from 'path';
import { PrismaService } from '../prisma/prisma.service';
import { TmdbService } from './tmdb.service';

export interface EnrichResult {
  titleId: string;
  name: string;
  matched: boolean;
  rating: string | null;
  posterSaved: boolean;
}

export interface RefreshStats {
  considered: number;
  matched: number;
  unmatched: number;
  failed: number;
}

@Injectable()
export class MetadataService {
  private readonly logger = new Logger(MetadataService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly tmdb: TmdbService,
    private readonly config: ConfigService,
  ) {}

  /**
   * Enriches every title that has no rating yet. Already-enriched titles are
   * skipped unless `force` is set, so re-running is cheap and does not burn
   * API quota on work already done.
   */
  async refreshAll(force = false): Promise<RefreshStats> {
    const titles = await this.prisma.title.findMany({
      where: force ? {} : { rating: null },
      select: { id: true },
    });

    const stats: RefreshStats = {
      considered: titles.length,
      matched: 0,
      unmatched: 0,
      failed: 0,
    };

    for (const { id } of titles) {
      try {
        const result = await this.enrichTitle(id);
        if (result.matched) stats.matched++;
        else stats.unmatched++;
      } catch (err) {
        this.logger.error(`Enrichment failed for title ${id}: ${(err as Error).message}`);
        stats.failed++;
      }
    }

    return stats;
  }

  async enrichTitle(titleId: string): Promise<EnrichResult> {
    const title = await this.prisma.title.findUnique({ where: { id: titleId } });
    if (!title) {
      throw new NotFoundException(`Title ${titleId} not found`);
    }

    if (!this.tmdb.isConfigured) {
      throw new NotFoundException(
        'TMDB_ACCESS_TOKEN is not set in backend/.env -- enrichment is disabled.',
      );
    }

    const kind = title.type === 'SERIES' ? 'tv' : 'movie';
    const match =
      kind === 'movie'
        ? await this.tmdb.searchMovie(title.name, title.releaseYear)
        : await this.tmdb.searchSeries(title.name);

    if (!match) {
      this.logger.warn(`No TMDB match for "${title.name}"`);
      return { titleId, name: title.name, matched: false, rating: null, posterSaved: false };
    }

    // TMDB may identify this as a film the catalogue already holds under its
    // canonical name -- two paths for one movie, or a repaired title meeting
    // the enriched one. Title is unique on (name, type), so renaming into an
    // existing name would simply fail and leave a duplicate behind.
    const duplicate = await this.prisma.title.findFirst({
      where: { name: match.name, type: title.type, id: { not: titleId } },
      select: { id: true, name: true, _count: { select: { watchProgress: true, watchlist: true } } },
    });

    if (duplicate) {
      // Viewer history is keyed on the title, and the unique constraints on
      // WatchProgress and WatchlistItem make moving it a merge of its own.
      // Rather than guess which position survives, leave both titles alone
      // and say so.
      if (duplicate._count.watchProgress > 0 || duplicate._count.watchlist > 0) {
        this.logger.warn(
          `"${title.name}" is the same as "${duplicate.name}", which has viewer history; not merging`,
        );
        return { titleId, name: title.name, matched: false, rating: null, posterSaved: false };
      }

      await this.prisma.$transaction([
        this.prisma.mediaFile.updateMany({ where: { titleId }, data: { titleId: duplicate.id } }),
        this.prisma.episode.updateMany({ where: { titleId }, data: { titleId: duplicate.id } }),
        this.prisma.title.delete({ where: { id: titleId } }),
      ]);

      this.logger.log(`Merged "${title.name}" into existing "${duplicate.name}"`);
      return { titleId: duplicate.id, name: duplicate.name, matched: true, rating: null, posterSaved: false };
    }

    const rating = await this.tmdb.fetchCertification(kind, match.tmdbId);
    const posterSaved = match.posterPath
      ? await this.savePoster(titleId, match.posterPath)
      : false;

    await this.prisma.title.update({
      where: { id: titleId },
      data: {
        // The name from the filename parser is a guess; TMDB's is canonical.
        name: match.name,
        overview: match.overview,
        releaseYear: match.releaseYear ?? title.releaseYear,
        rating,
        genres: match.genres,
        posterPath: posterSaved ? `/metadata/posters/${titleId}.jpg` : title.posterPath,
      },
    });

    this.logger.log(`Enriched "${title.name}" -> "${match.name}" (rating: ${rating ?? 'none'})`);

    return { titleId, name: match.name, matched: true, rating, posterSaved };
  }

  /** Absolute path of a downloaded poster, for the serving endpoint. */
  posterFilePath(titleId: string): string {
    const posterRoot = this.config.get<string>('tmdb.posterRoot')!;
    return path.join(posterRoot, `${titleId}.jpg`);
  }

  private async savePoster(titleId: string, posterPath: string): Promise<boolean> {
    try {
      const bytes = await this.tmdb.downloadPoster(posterPath);
      const target = this.posterFilePath(titleId);
      await fs.mkdir(path.dirname(target), { recursive: true });
      await fs.writeFile(target, bytes);
      return true;
    } catch (err) {
      // A missing poster is cosmetic; it must not fail the whole enrichment.
      this.logger.warn(`Poster download failed for ${titleId}: ${(err as Error).message}`);
      return false;
    }
  }
}
