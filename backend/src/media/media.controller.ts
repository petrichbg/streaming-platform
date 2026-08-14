import { Body, Controller, Get, NotFoundException, Param, Post, Req, UseGuards } from '@nestjs/common';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { AdminGuard } from '../auth/admin.guard';
import { ContentAccessService } from '../catalog/content-access.service';
import { PrismaService } from '../prisma/prisma.service';
import { MediaScannerService } from './media-scanner.service';

@Controller('media')
export class MediaController {
  constructor(
    private readonly scanner: MediaScannerService,
    // Injected directly for the trivial read below; a dedicated query service
    // would be ceremony for a single findUnique.
    private readonly prisma: PrismaService,
    private readonly access: ContentAccessService,
  ) {}

  // A scan walks the whole library and runs ffprobe over every new file, so it
  // is guarded like everything else rather than left open to the network.
  @UseGuards(JwtAuthGuard, AdminGuard)
  @Post('scan')
  async scan() {
    return this.scanner.scan();
  }

  /**
   * Re-applies the parser to what is already imported.
   *
   * Defaults to a dry run: it moves files between titles and deletes the
   * titles left empty, so seeing the plan has to come before running it.
   */
  @UseGuards(JwtAuthGuard, AdminGuard)
  @Post('repair')
  async repair(@Body() body: { dryRun?: boolean }) {
    return this.scanner.repair(body?.dryRun !== false);
  }

  /**
   * The player only knows a mediaFileId, but watch progress is keyed on
   * titleId/episodeId, so it needs this lookup to know what it is playing.
   */
  @UseGuards(JwtAuthGuard)
  @Get(':mediaFileId')
  async findOne(@Req() req: any, @Param('mediaFileId') mediaFileId: string) {
    await this.access.assertMediaFileAllowed(req.user, mediaFileId);

    const mediaFile = await this.prisma.mediaFile.findUnique({
      where: { id: mediaFileId },
      select: {
        id: true,
        titleId: true,
        episodeId: true,
        container: true,
        videoCodec: true,
        durationSec: true,
      },
    });

    if (!mediaFile) {
      throw new NotFoundException(`Media file ${mediaFileId} not found`);
    }
    return mediaFile;
  }
}
