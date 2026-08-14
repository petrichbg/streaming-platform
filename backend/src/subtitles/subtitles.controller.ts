import {
  BadRequestException,
  Controller,
  Get,
  Header,
  Param,
  Req,
  StreamableFile,
  UseGuards,
} from '@nestjs/common';
import { createReadStream } from 'fs';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { ContentAccessService } from '../catalog/content-access.service';
import { SubtitlesService } from './subtitles.service';

@UseGuards(JwtAuthGuard)
@Controller('media/:mediaFileId/subtitles')
export class SubtitlesController {
  constructor(
    private readonly subtitles: SubtitlesService,
    private readonly access: ContentAccessService,
  ) {}

  // Subtitles are content too: dialogue of a blocked film is still the film.
  @Get()
  async listTracks(@Req() req: any, @Param('mediaFileId') mediaFileId: string) {
    await this.access.assertMediaFileAllowed(req.user, mediaFileId);
    return this.subtitles.listTracks(mediaFileId);
  }

  @Get(':streamIndex')
  @Header('Content-Type', 'text/vtt; charset=utf-8')
  async getTrack(
    @Req() req: any,
    @Param('mediaFileId') mediaFileId: string,
    @Param('streamIndex') streamIndex: string,
  ): Promise<StreamableFile> {
    await this.access.assertMediaFileAllowed(req.user, mediaFileId);

    const index = Number(streamIndex);
    if (!Number.isInteger(index) || index < 0) {
      throw new BadRequestException('streamIndex must be a non-negative integer');
    }

    const vttPath = await this.subtitles.getVttPath(mediaFileId, index);
    return new StreamableFile(createReadStream(vttPath));
  }
}
