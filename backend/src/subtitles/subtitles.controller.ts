import {
  BadRequestException,
  Body,
  Controller,
  Delete,
  Get,
  Header,
  Param,
  Patch,
  Post,
  Req,
  StreamableFile,
  UploadedFile,
  UseGuards,
  UseInterceptors,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { createReadStream } from 'fs';
import { AdminGuard } from '../auth/admin.guard';
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

  @Get('capabilities')
  getCapabilities() {
    return this.subtitles.getCapabilities();
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

  @UseGuards(AdminGuard)
  @Post('upload')
  @UseInterceptors(FileInterceptor('file', { limits: { fileSize: 5 * 1024 * 1024, files: 1 } }))
  async uploadTrack(
    @Req() req: any,
    @Param('mediaFileId') mediaFileId: string,
    @UploadedFile() file: { originalname: string; buffer: Buffer; size: number },
    @Body() body: { language?: string; forced?: string },
  ) {
    await this.access.assertMediaFileAllowed(req.user, mediaFileId);
    return this.subtitles.uploadExternal(mediaFileId, file, body.language ?? 'bul', body.forced === 'true');
  }

  @UseGuards(AdminGuard)
  @Get(':streamIndex/source')
  async getSource(
    @Req() req: any,
    @Param('mediaFileId') mediaFileId: string,
    @Param('streamIndex') streamIndex: string,
  ) {
    await this.access.assertMediaFileAllowed(req.user, mediaFileId);
    return this.subtitles.readExternalSource(mediaFileId, parseExternalIndex(streamIndex));
  }

  @UseGuards(AdminGuard)
  @Patch(':streamIndex/source')
  async updateSource(
    @Req() req: any,
    @Param('mediaFileId') mediaFileId: string,
    @Param('streamIndex') streamIndex: string,
    @Body() body: { content?: string },
  ) {
    await this.access.assertMediaFileAllowed(req.user, mediaFileId);
    return this.subtitles.updateExternalSource(mediaFileId, parseExternalIndex(streamIndex), body.content ?? '');
  }

  @UseGuards(AdminGuard)
  @Delete(':streamIndex')
  async deleteTrack(
    @Req() req: any,
    @Param('mediaFileId') mediaFileId: string,
    @Param('streamIndex') streamIndex: string,
  ) {
    await this.access.assertMediaFileAllowed(req.user, mediaFileId);
    const index = Number(streamIndex);
    if (!Number.isInteger(index) || index < 10_000) throw new BadRequestException('Only external subtitle tracks can be deleted');
    return this.subtitles.deleteExternal(mediaFileId, index);
  }
}

function parseExternalIndex(value: string): number {
  const index = Number(value);
  if (!Number.isInteger(index) || index < 10_000) throw new BadRequestException('External subtitle index is invalid');
  return index;
}
