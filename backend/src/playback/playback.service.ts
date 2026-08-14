import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';

export interface SaveProgressInput {
  titleId?: string;
  episodeId?: string;
  positionSec: number;
  durationSec?: number;
}

@Injectable()
export class PlaybackService {
  constructor(private readonly prisma: PrismaService) {}

  async saveProgress(profileId: string, input: SaveProgressInput) {
    if (!input.titleId && !input.episodeId) {
      throw new BadRequestException('Either titleId or episodeId is required');
    }
    if (!Number.isFinite(input.positionSec) || input.positionSec < 0) {
      throw new BadRequestException('positionSec must be a non-negative number');
    }

    // Deliberately NOT using prisma.upsert on @@unique([profileId, titleId,
    // episodeId]): in Postgres NULL != NULL, so for movies (episodeId null)
    // the unique index does not dedupe and upsert would keep inserting new
    // rows. Explicit find-then-write is correct for nullable compound keys.
    const existing = await this.prisma.watchProgress.findFirst({
      where: {
        profileId,
        titleId: input.titleId ?? null,
        episodeId: input.episodeId ?? null,
      },
    });

    if (existing) {
      return this.prisma.watchProgress.update({
        where: { id: existing.id },
        data: {
          positionSec: Math.round(input.positionSec),
          durationSec: input.durationSec ? Math.round(input.durationSec) : undefined,
        },
      });
    }

    return this.prisma.watchProgress.create({
      data: {
        profileId,
        titleId: input.titleId,
        episodeId: input.episodeId,
        positionSec: Math.round(input.positionSec),
        durationSec: input.durationSec ? Math.round(input.durationSec) : undefined,
      },
    });
  }

  continueWatching(profileId: string) {
    return this.prisma.watchProgress.findMany({
      where: { profileId },
      orderBy: { updatedAt: 'desc' },
      take: 20,
      include: {
        title: { include: { mediaFiles: true } },
        episode: { include: { title: true, mediaFiles: true } },
      },
    });
  }

  async addToWatchlist(profileId: string, titleId: string) {
    const title = await this.prisma.title.findUnique({ where: { id: titleId } });
    if (!title) {
      throw new NotFoundException(`Title ${titleId} not found`);
    }

    // This compound key has no nullable columns, so upsert is safe here.
    return this.prisma.watchlistItem.upsert({
      where: { profileId_titleId: { profileId, titleId } },
      create: { profileId, titleId },
      update: {},
    });
  }

  getWatchlist(profileId: string) {
    return this.prisma.watchlistItem.findMany({
      where: { profileId },
      orderBy: { addedAt: 'desc' },
      include: { title: true },
    });
  }

  async removeFromWatchlist(profileId: string, titleId: string): Promise<void> {
    const item = await this.prisma.watchlistItem.findUnique({
      where: { profileId_titleId: { profileId, titleId } },
    });
    if (!item) {
      throw new NotFoundException('Watchlist item not found');
    }
    await this.prisma.watchlistItem.delete({ where: { id: item.id } });
  }
}
