import { Body, Controller, Param, Post, Req, UseGuards } from '@nestjs/common';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { DevicePairingService } from './device-pairing.service';

@Controller('device-pairing')
export class DevicePairingController {
  constructor(private readonly pairing: DevicePairingService) {}

  @Post()
  create(@Body() body: { deviceName?: string }) { return this.pairing.create(body?.deviceName); }

  @Post(':pairingId/poll')
  poll(@Req() req: any, @Param('pairingId') pairingId: string, @Body() body: { secret?: string }) {
    return this.pairing.poll(pairingId, String(body?.secret ?? ''), sessionContext(req));
  }

  @UseGuards(JwtAuthGuard)
  @Post('claim/code')
  claim(@Req() req: any, @Body() body: { code?: string }) { return this.pairing.claim(req.user.sub, String(body?.code ?? '')); }
}

function sessionContext(req: any) { return { userAgent: String(req.headers?.['user-agent'] ?? '').slice(0, 300) || null, ipAddress: String(req.ip ?? req.socket?.remoteAddress ?? '').slice(0, 80) || null }; }
