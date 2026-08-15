import { BadRequestException, Injectable, NotFoundException, UnauthorizedException } from '@nestjs/common';
import { createHash, randomBytes, randomInt } from 'crypto';
import { PrismaService } from '../prisma/prisma.service';
import { AuthService } from '../auth/auth.service';

const ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';

@Injectable()
export class DevicePairingService {
  constructor(private readonly prisma: PrismaService, private readonly auth: AuthService) {}

  async create(deviceName?: string) {
    await this.prisma.devicePairing.deleteMany({ where: { expiresAt: { lt: new Date() } } });
    const secret = randomBytes(32).toString('base64url');
    let code = makeCode();
    while (await this.prisma.devicePairing.findUnique({ where: { code } })) code = makeCode();
    const pairing = await this.prisma.devicePairing.create({ data: { code, secretHash: hash(secret), deviceName: deviceName?.trim().slice(0, 80) || 'Телевизор', expiresAt: new Date(Date.now() + 10 * 60_000) } });
    return { pairingId: pairing.id, secret, code, expiresAt: pairing.expiresAt, pollAfterSec: 3 };
  }

  async claim(userId: string, codeInput: string) {
    const code = normalizeCode(codeInput);
    const pairing = await this.prisma.devicePairing.findUnique({ where: { code } });
    if (!pairing || pairing.expiresAt <= new Date() || pairing.consumedAt) throw new NotFoundException('Кодът е невалиден или изтекъл');
    await this.prisma.devicePairing.update({ where: { id: pairing.id }, data: { userId, claimedAt: new Date() } });
    return { paired: true, deviceName: pairing.deviceName };
  }

  async poll(pairingId: string, secret: string, context?: { userAgent: string | null; ipAddress: string | null }) {
    const pairing = await this.prisma.devicePairing.findUnique({ where: { id: pairingId } });
    if (!pairing || pairing.secretHash !== hash(secret)) throw new UnauthorizedException('Invalid pairing secret');
    if (pairing.expiresAt <= new Date()) throw new BadRequestException('Pairing code expired');
    if (!pairing.userId) return { status: 'pending' as const, expiresAt: pairing.expiresAt };
    if (pairing.consumedAt) throw new BadRequestException('Pairing code already used');
    const session = await this.auth.createDeviceSession(pairing.userId, context);
    await this.prisma.devicePairing.update({ where: { id: pairing.id }, data: { consumedAt: new Date() } });
    return { status: 'approved' as const, ...session };
  }
}

function makeCode() { return Array.from({ length: 6 }, () => ALPHABET[randomInt(ALPHABET.length)]).join(''); }
function hash(value: string) { return createHash('sha256').update(value).digest('hex'); }
function normalizeCode(value: string) {
  const code = String(value ?? '').toUpperCase().replace(/[^A-Z0-9]/g, '');
  if (code.length !== 6) throw new BadRequestException('Кодът трябва да съдържа 6 символа');
  return code;
}
