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
        mediaFiles: true,
        episodes: {
          orderBy: [{ seasonNumber: 'asc' }, { episodeNumber: 'asc' }],
          include: { mediaFiles: true },
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

    return title;
  }
}
