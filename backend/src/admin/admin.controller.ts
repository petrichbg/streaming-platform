import { Body, Controller, Get, Param, Patch, Post, Query, UseGuards } from '@nestjs/common';
import { AdminGuard } from '../auth/admin.guard';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { AdminService } from './admin.service';

@UseGuards(JwtAuthGuard, AdminGuard)
@Controller('admin')
export class AdminController {
  constructor(private readonly admin: AdminService) {}

  @Get('overview')
  overview() {
    return this.admin.overview();
  }

  @Get('diagnostics')
  diagnostics() { return this.admin.diagnostics(); }

  @Get('logs')
  logs(@Query('file') file?: string) { return this.admin.logs(file); }

  @Get('backups')
  backups() { return this.admin.backups(); }

  @Post('backups')
  createBackup() { return this.admin.createBackup(); }

  @Post('backups/:name/verify')
  verifyBackup(@Param('name') name: string) { return this.admin.verifyBackup(name); }

  @Get('metadata')
  metadata() { return this.admin.metadataTitles(); }

  @Patch('metadata/:titleId')
  updateMetadata(
    @Param('titleId') titleId: string,
    @Body() body: { name?: string; overview?: string | null; releaseYear?: number | null; rating?: string | null; genres?: string[]; director?: string | null; cast?: string[]; dryRun?: boolean; confirmation?: string },
  ) { return this.admin.updateMetadata(titleId, body); }
}
