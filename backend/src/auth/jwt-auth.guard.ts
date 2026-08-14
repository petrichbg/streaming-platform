import { CanActivate, ExecutionContext, Injectable, UnauthorizedException } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { PrismaService } from '../prisma/prisma.service';

export interface JwtPayload {
  sub: string;
  email: string;
  isAdmin: boolean;
  /**
   * The profile this session is watching as, when it is bound to one.
   *
   * It lives in the token rather than in a query parameter because it carries
   * the parental-control cap: a parameter is the caller's to omit, a signed
   * claim is not. Absent means an unscoped session, which is unrestricted --
   * see ContentAccessService.
   */
  profileId?: string;
  scope?: 'playback';
  mediaFileId?: string;
  sv: number;
}

// The guard below assigns request.user, so express's own Request type is
// taught about it here rather than every controller casting to `any`.
declare module 'express' {
  interface Request {
    user?: JwtPayload;
  }
}

@Injectable()
export class JwtAuthGuard implements CanActivate {
  constructor(private readonly jwt: JwtService, private readonly prisma: PrismaService) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest();
    const authHeader: string | undefined = request.headers?.authorization;

    // The query fallback exists because <video src> and <img src> cannot send
    // an Authorization header, and a multi-gigabyte file cannot be pulled into
    // a blob the way subtitles are. Tradeoff: the token then shows up in access
    // logs and browser history. Acceptable on a locked LAN; the proper upgrade
    // is a separate short-lived playback token.
    const token = authHeader?.startsWith('Bearer ')
      ? authHeader.slice(7)
      : (request.query?.token as string | undefined);

    if (!token) {
      throw new UnauthorizedException('Missing bearer token');
    }

    try {
      request.user = await this.jwt.verifyAsync<JwtPayload>(token);
      const user = await this.prisma.user.findUnique({
        where: { id: request.user.sub },
        select: { sessionVersion: true },
      });
      if (!user || request.user.sv !== user.sessionVersion) {
        throw new UnauthorizedException('Session has been revoked');
      }
      if (request.user.scope === 'playback') {
        const requestedMediaId = request.params?.mediaFileId;
        if (!requestedMediaId || requestedMediaId !== request.user.mediaFileId) {
          throw new UnauthorizedException('Playback token is not valid for this resource');
        }
      }
      return true;
    } catch {
      throw new UnauthorizedException('Invalid or expired token');
    }
  }
}
