import { Injectable, NotFoundException } from '@nestjs/common';
import { TitleType } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { isRatingAllowed } from './ratings';

export interface TitleListItem {
  id: string;
  type: TitleType;
  name: string;
  releaseYear: number | null;
  genres: string[];
  posterPath: string | null;
  backdropPath: string | null;
  episodeCount: number;
  mediaFileCount: number;
  createdAt: Date;
  popularity: number;
}

export interface FindAllParams {
  search?: string;
  type?: TitleType;
  /**
   * Parental control cap from the viewing profile. Filtering happens in
   * application code rather than SQL because the rating ladders are
   * ordered scales, not lexicographic — see ratings.ts.
   */
  maxRating?: string | null;
}

@Injectable()
export class CatalogService {
  constructor(private readonly prisma: PrismaService) {}

  async findAll(params: FindAllParams): Promise<TitleListItem[]> {
    const titles = await this.prisma.title.findMany({
      where: {
        ...(params.search
          ? { name: { contains: params.search, mode: 'insensitive' as const } }
          : {}),
        ...(params.type ? { type: params.type } : {}),
      },
      orderBy: { name: 'asc' },
      include: {
        _count: { select: { episodes: true, mediaFiles: true, watchProgress: true, watchlist: true } },
      },
    });

    return titles
      .filter((t) => isRatingAllowed(t.rating, params.maxRating))
      .map((t) => ({
        id: t.id,
        type: t.type,
        name: t.name,
        releaseYear: t.releaseYear,
        genres: t.genres,
        posterPath: t.posterPath,
        backdropPath: t.backdropPath,
        episodeCount: t._count.episodes,
        mediaFileCount: t._count.mediaFiles,
        createdAt: t.createdAt,
        popularity: t._count.watchProgress + t._count.watchlist,
      }));
  }

  async findOne(id: string, maxRating?: string | null) {
    const title = await this.prisma.title.findUnique({
      where: { id },
      include: {
        mediaFiles: { include: { transcodeJobs: { where: { status: 'DONE' } } } },
        episodes: {
          orderBy: [{ seasonNumber: 'asc' }, { episodeNumber: 'asc' }],
          include: { mediaFiles: { include: { transcodeJobs: { where: { status: 'DONE' } } } } },
        },
      },
    });

    if (!title) {
      throw new NotFoundException(`Title ${id} not found`);
    }

    // Same 404 as "doesn't exist" rather than 403: a restricted profile
    // shouldn't be able to confirm that blocked content is in the library.
    if (!isRatingAllowed(title.rating, maxRating)) {
      throw new NotFoundException(`Title ${id} not found`);
    }

    const candidates = await this.prisma.title.findMany({
      where: { id: { not: id } },
      include: { _count: { select: { episodes: true, mediaFiles: true, watchProgress: true, watchlist: true } } },
      take: 60,
    });
    const related = candidates
      .filter((candidate) => isRatingAllowed(candidate.rating, maxRating))
      .map((candidate) => ({
        candidate,
        score: candidate.genres.filter((genre) => title.genres.includes(genre)).length * 4
          + (candidate.type === title.type ? 2 : 0)
          + candidate._count.watchProgress + candidate._count.watchlist,
      }))
      .filter(({ score }) => score > 0)
      .sort((a, b) => b.score - a.score)
      .slice(0, 8)
      .map(({ candidate }) => ({
        id: candidate.id, type: candidate.type, name: candidate.name,
        releaseYear: candidate.releaseYear, genres: candidate.genres,
        posterPath: candidate.posterPath, backdropPath: candidate.backdropPath,
        episodeCount: candidate._count.episodes, mediaFileCount: candidate._count.mediaFiles,
        createdAt: candidate.createdAt,
        popularity: candidate._count.watchProgress + candidate._count.watchlist,
      }));

    return {
      ...title,
      mediaFiles: title.mediaFiles.map(toCatalogMedia),
      episodes: title.episodes.map((episode) => ({ ...episode, mediaFiles: episode.mediaFiles.map(toCatalogMedia) })),
      related,
    };
  }
}

function toCatalogMedia(media: any) {
  const audioTracks = Array.isArray(media.audioTracks) ? media.audioTracks : [];
  const subtitleTracks = Array.isArray(media.subtitleTracks) ? media.subtitleTracks : [];
  const maxHeight = Math.max(0, ...media.transcodeJobs.map((job: any) => job.targetHeight));
  return {
    id: media.id,
    sourcePath: media.sourcePath,
    container: media.container,
    videoCodec: media.videoCodec,
    durationSec: media.durationSec,
    quality: maxHeight ? `${maxHeight}p` : null,
    audioLanguages: [...new Set(audioTracks.map((track: any) => track.language).filter(Boolean))],
    subtitleLanguages: [...new Set(subtitleTracks.map((track: any) => track.language).filter(Boolean))],
    hdrFormat: null,
  };
}
