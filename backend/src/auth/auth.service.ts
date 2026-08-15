import { BadRequestException, ConflictException, Injectable, NotFoundException, UnauthorizedException } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import * as bcrypt from 'bcryptjs';
import { PrismaService } from '../prisma/prisma.service';

export interface AuthResult {
  accessToken: string;
  user: { id: string; email: string; isAdmin: boolean };
}

interface UserRecord {
  id: string;
  email: string;
  passwordHash: string;
  isAdmin: boolean;
  sessionVersion: number;
}

@Injectable()
export class AuthService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly jwt: JwtService,
  ) {}

  async register(email: string, password: string, context?: { userAgent: string | null; ipAddress: string | null }): Promise<AuthResult> {
    const existing = await this.prisma.user.findUnique({ where: { email } });
    if (existing) {
      throw new ConflictException('Email already registered');
    }

    // First account created on a fresh install becomes admin. Everyone
    // after that registers as a regular user; promote via DB/future admin
    // UI if needed.
    const userCount = await this.prisma.user.count();
    const passwordHash = await bcrypt.hash(password, 12);

    const user = await this.prisma.user.create({
      data: { email, passwordHash, isAdmin: userCount === 0 },
    });

    await this.recordSession(user.id, context);
    return this.issueToken(user);
  }

  async login(email: string, password: string, context?: { userAgent: string | null; ipAddress: string | null }): Promise<AuthResult> {
    const user = await this.prisma.user.findUnique({ where: { email } });
    if (!user) {
      throw new UnauthorizedException('Invalid credentials');
    }

    const valid = await bcrypt.compare(password, user.passwordHash);
    if (!valid) {
      throw new UnauthorizedException('Invalid credentials');
    }

    await this.recordSession(user.id, context);
    return this.issueToken(user);
  }

  async changePassword(userId: string, currentPassword: string, newPassword: string): Promise<void> {
    const user = await this.prisma.user.findUnique({ where: { id: userId } });
    if (!user || !(await bcrypt.compare(currentPassword, user.passwordHash))) {
      throw new UnauthorizedException('Current password is incorrect');
    }
    if (await bcrypt.compare(newPassword, user.passwordHash)) {
      throw new ConflictException('New password must be different');
    }
    await this.prisma.user.update({
      where: { id: userId },
      data: {
        passwordHash: await bcrypt.hash(newPassword, 12),
        sessionVersion: { increment: 1 },
      },
    });
  }

  listUsers() {
    return this.prisma.user.findMany({
      orderBy: { createdAt: 'asc' },
      select: {
        id: true,
        email: true,
        isAdmin: true,
        createdAt: true,
        sessionVersion: true,
        _count: { select: { profiles: true } },
      },
    });
  }

  listSessions() {
    return this.prisma.loginSession.findMany({
      where: { revokedAt: null, expiresAt: { gt: new Date() } },
      orderBy: { createdAt: 'desc' }, take: 200,
      select: { id: true, userId: true, userAgent: true, ipAddress: true, createdAt: true, expiresAt: true, user: { select: { email: true } } },
    });
  }

  async updateUserRole(actorId: string, userId: string, isAdmin: boolean) {
    const user = await this.prisma.user.findUnique({ where: { id: userId } });
    if (!user) throw new NotFoundException('User not found');
    if (actorId === userId && !isAdmin) {
      throw new BadRequestException('You cannot remove your own administrator role');
    }
    if (user.isAdmin && !isAdmin) {
      const adminCount = await this.prisma.user.count({ where: { isAdmin: true } });
      if (adminCount <= 1) throw new ConflictException('The last administrator cannot be demoted');
    }

    return this.prisma.user.update({
      where: { id: userId },
      data: { isAdmin, sessionVersion: { increment: 1 } },
      select: { id: true, email: true, isAdmin: true },
    });
  }

  async revokeSessions(userId: string): Promise<{ revoked: true }> {
    const [result] = await this.prisma.$transaction([
      this.prisma.user.updateMany({ where: { id: userId }, data: { sessionVersion: { increment: 1 } } }),
      this.prisma.loginSession.updateMany({ where: { userId, revokedAt: null }, data: { revokedAt: new Date() } }),
    ]);
    if (result.count === 0) throw new NotFoundException('User not found');
    return { revoked: true };
  }

  async createDeviceSession(userId: string, context?: { userAgent: string | null; ipAddress: string | null }): Promise<AuthResult> {
    const user = await this.prisma.user.findUnique({ where: { id: userId } });
    if (!user) throw new NotFoundException('User not found');
    await this.recordSession(user.id, context);
    return this.issueToken(user);
  }

  private async recordSession(userId: string, context?: { userAgent: string | null; ipAddress: string | null }) {
    await this.prisma.loginSession.create({ data: { userId, userAgent: context?.userAgent, ipAddress: context?.ipAddress, expiresAt: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000) } });
  }

  private issueToken(user: UserRecord): AuthResult {
    const accessToken = this.jwt.sign({
      sub: user.id,
      email: user.email,
      isAdmin: user.isAdmin,
      sv: user.sessionVersion,
    });

    return {
      accessToken,
      user: { id: user.id, email: user.email, isAdmin: user.isAdmin },
    };
  }
}
