import {
  BadRequestException,
  Body,
  Controller,
  Delete,
  Get,
  Param,
  Post,
  Put,
  Req,
  UseGuards,
} from '@nestjs/common';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { ProfilesService } from '../profiles/profiles.service';
import { PlaybackService } from './playback.service';

interface SaveProgressBody {
  titleId?: string;
  episodeId?: string;
  positionSec?: number;
  durationSec?: number;
}

interface WatchlistBody {
  titleId?: string;
}

@UseGuards(JwtAuthGuard)
@Controller('profiles/:profileId')
export class PlaybackController {
  constructor(
    private readonly playback: PlaybackService,
    private readonly profiles: ProfilesService,
  ) {}

  @Put('progress')
  async saveProgress(
    @Req() req: any,
    @Param('profileId') profileId: string,
    @Body() body: SaveProgressBody,
  ) {
    await this.assertOwnsProfile(req, profileId);
    if (body.positionSec === undefined) {
      throw new BadRequestException('positionSec is required');
    }
    return this.playback.saveProgress(profileId, {
      titleId: body.titleId,
      episodeId: body.episodeId,
      positionSec: body.positionSec,
      durationSec: body.durationSec,
    });
  }

  @Get('continue-watching')
  async continueWatching(@Req() req: any, @Param('profileId') profileId: string) {
    await this.assertOwnsProfile(req, profileId);
    return this.playback.continueWatching(profileId);
  }

  @Post('watchlist')
  async addToWatchlist(
    @Req() req: any,
    @Param('profileId') profileId: string,
    @Body() body: WatchlistBody,
  ) {
    await this.assertOwnsProfile(req, profileId);
    if (!body.titleId) {
      throw new BadRequestException('titleId is required');
    }
    return this.playback.addToWatchlist(profileId, body.titleId);
  }

  @Get('watchlist')
  async getWatchlist(@Req() req: any, @Param('profileId') profileId: string) {
    await this.assertOwnsProfile(req, profileId);
    return this.playback.getWatchlist(profileId);
  }

  @Delete('watchlist/:titleId')
  async removeFromWatchlist(
    @Req() req: any,
    @Param('profileId') profileId: string,
    @Param('titleId') titleId: string,
  ) {
    await this.assertOwnsProfile(req, profileId);
    return this.playback.removeFromWatchlist(profileId, titleId);
  }

  /**
   * Throws 404 unless the profile belongs to the authenticated user, so one
   * account can never read or write another account's playback state.
   */
  private assertOwnsProfile(req: any, profileId: string) {
    return this.profiles.findOneForUser(req.user.sub, profileId);
  }
}
