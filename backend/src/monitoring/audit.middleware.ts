import { Injectable, Logger, NestMiddleware } from '@nestjs/common';
import type { NextFunction, Request, Response } from 'express';

type AuditEvent = 'login_failed' | 'playback_failed' | 'transcode_failed';

@Injectable()
export class AuditMiddleware implements NestMiddleware {
  private readonly logger = new Logger('Audit');

  use(req: Request, res: Response, next: NextFunction): void {
    const startedAt = Date.now();
    res.on('finish', () => {
      if (res.statusCode < 400) return;
      const event = classifyFailure(req.path);
      if (!event) return;
      this.write(event, req, res.statusCode, Date.now() - startedAt);
    });
    next();
  }

  private write(event: AuditEvent, req: Request, status: number, durationMs: number): void {
    const record = {
      marker: 'STREAMING_AUDIT',
      timestamp: new Date().toISOString(),
      event,
      method: req.method,
      path: req.path,
      status,
      durationMs,
      ip: req.ip,
      userAgent: String(req.headers['user-agent'] ?? '').slice(0, 200),
    };
    this.logger.warn(JSON.stringify(record));
  }
}

function classifyFailure(path: string): AuditEvent | null {
  if (path === '/auth/login') return 'login_failed';
  if (path.startsWith('/stream/') || /^\/media\/[^/]+\/subtitles(?:\/|$)/.test(path)) {
    return 'playback_failed';
  }
  if (path === '/transcode' || path.startsWith('/transcode/')) return 'transcode_failed';
  return null;
}
