import { Controller, Get, Param, Query, Req, UseGuards } from '@nestjs/common';
import { TitleType } from '@prisma/client';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { ProfilesService } from '../profiles/profiles.service';
import { CatalogService } from './catalog.service';

@UseGuards(JwtAuthGuard)
@Controller('titles')
export class CatalogController {
  constructor(
    private readonly catalog: CatalogService,
    private readonly profiles: ProfilesService,
  ) {}

  @Get()
  async findAll(
    @Req() req: any,
    @Query('search') search?: string,
    @Query('type') type?: string,
    @Query('profileId') profileId?: string,
  ) {
    return this.catalog.findAll({
      search,
      type: normalizeType(type),
      maxRating: await this.resolveMaxRating(req, profileId),
    });
  }

  @Get(':id')
  async findOne(
    @Req() req: any,
    @Param('id') id: string,
    @Query('profileId') profileId?: string,
  ) {
    return this.catalog.findOne(id, await this.resolveMaxRating(req, profileId));
  }

  /**
   * Resolves the parental-control cap for this request. Omitting profileId
   * browses unrestricted — that's intentional for the account owner's own
   * management views; the restriction applies when browsing *as* a profile.
   * findOneForUser() 404s if the profile isn't the caller's, so a profileId
   * can't be used to probe other accounts.
   */
  private async resolveMaxRating(req: any, profileId?: string): Promise<string | null> {
    // A session bound to a profile wins over the query parameter. Otherwise a
    // restricted session could ask for an unrestricted profile by id and get
    // the full catalog back, which is the same hole the token binding closes
    // on the streaming routes.
    const effective = req.user?.profileId ?? profileId;
    if (!effective) return null;

    const profile = await this.profiles.findOneForUser(req.user.sub, effective);
    return profile.maxRating;
  }
}

function normalizeType(type?: string): TitleType | undefined {
  if (!type) return undefined;
  const upper = type.toUpperCase();
  return upper === 'MOVIE' || upper === 'SERIES' ? (upper as TitleType) : undefined;
}
