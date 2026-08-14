import {
  BadRequestException,
  Controller,
  Get,
  Header,
  NotFoundException,
  Param,
  Post,
  Query,
  StreamableFile,
  UseGuards,
} from '@nestjs/common';
import { createReadStream } from 'fs';
import { access } from 'fs/promises';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { AdminGuard } from '../auth/admin.guard';
import { MetadataService } from './metadata.service';

const POSTER_FILE = /^([0-9a-fA-F-]{36})\.jpg$/;

@Controller('metadata')
export class MetadataController {
  constructor(private readonly metadata: MetadataService) {}

  @UseGuards(JwtAuthGuard, AdminGuard)
  @Post('refresh')
  refreshAll(@Query('force') force?: string) {
    return this.metadata.refreshAll(force === 'true');
  }

  @UseGuards(JwtAuthGuard, AdminGuard)
  @Post('refresh/:titleId')
  refreshOne(@Param('titleId') titleId: string) {
    return this.metadata.enrichTitle(titleId);
  }

  /**
   * Deliberately NOT behind JwtAuthGuard: browsers cannot attach an
   * Authorization header to a plain <img src>, so guarding this would break
   * every poster in the UI. The tradeoff is acceptable because these are
   * public promotional images from TMDB, not user data -- the only thing an
   * unauthenticated caller learns is that some title id exists.
   */
  @Get('posters/:file')
  @Header('Content-Type', 'image/jpeg')
  @Header('Cache-Control', 'public, max-age=86400')
  async getPoster(@Param('file') file: string): Promise<StreamableFile> {
    const match = POSTER_FILE.exec(file);
    if (!match) {
      throw new BadRequestException('Invalid poster name');
    }

    const filePath = this.metadata.posterFilePath(match[1]);
    try {
      await access(filePath);
    } catch {
      throw new NotFoundException('Poster not found');
    }

    return new StreamableFile(createReadStream(filePath));
  }

  @Get('backdrops/:file')
  @Header('Content-Type', 'image/jpeg')
  @Header('Cache-Control', 'public, max-age=86400')
  async getBackdrop(@Param('file') file: string): Promise<StreamableFile> {
    const match = POSTER_FILE.exec(file);
    if (!match) throw new BadRequestException('Invalid backdrop name');
    const filePath = this.metadata.backdropFilePath(match[1]);
    try { await access(filePath); } catch { throw new NotFoundException('Backdrop not found'); }
    return new StreamableFile(createReadStream(filePath));
  }
}
