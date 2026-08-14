import { Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { isRatingAllowed } from './ratings';

/**
 * Parental control for everything that serves the content itself, as opposed
 * to the catalog that lists it.
 *
 * Filtering only the catalog leaves the control advisory: the media, stream
 * and subtitle endpoints were reachable with any valid token, so a link from
 * history or a bookmark played a blocked title regardless of the profile.
 *
 * The profile is read from the JWT rather than a query parameter on purpose.
 * A parameter is something the caller chooses, so dropping it would drop the
 * restriction; a claim inside a signed token is not the caller's to edit, and
 * it rides along on requests that have nowhere to put a parameter -- the HLS
 * segment URLs come out of a playlist we do not rewrite.
 */
@Injectable()
export class ContentAccessService {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * Throws 404 if the profile in this request may not watch this media file.
   *
   * 404 rather than 403, matching CatalogService: a restricted profile should
   * not be able to confirm that blocked content exists in the library.
   */
  async assertMediaFileAllowed(
    user: { profileId?: string } | undefined,
    mediaFileId: string,
  ): Promise<void> {
    // No profile on the token means an unscoped session -- the account owner
    // browsing or a script hitting the API. Those are unrestricted by design;
    // the restriction exists once a session is bound to a profile.
    if (!user?.profileId) return;

    const profile = await this.prisma.profile.findUnique({
      where: { id: user.profileId },
      select: { maxRating: true },
    });
    if (!profile?.maxRating) return;

    const mediaFile = await this.prisma.mediaFile.findUnique({
      where: { id: mediaFileId },
      select: {
        title: { select: { rating: true } },
        episode: { select: { title: { select: { rating: true } } } },
      },
    });

    if (!mediaFile) {
      throw new NotFoundException(`Media file ${mediaFileId} not found`);
    }

    // A file hangs off either a movie title or an episode, and for an episode
    // the rating lives on the series it belongs to.
    const rating = mediaFile.title?.rating ?? mediaFile.episode?.title?.rating ?? null;

    if (!isRatingAllowed(rating, profile.maxRating)) {
      throw new NotFoundException(`Media file ${mediaFileId} not found`);
    }
  }
}
