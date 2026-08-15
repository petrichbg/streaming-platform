import { Injectable, NestMiddleware } from '@nestjs/common';
import { NextFunction, Request, Response } from 'express';

interface Bucket { count: number; resetAt: number }

@Injectable()
export class RateLimitMiddleware implements NestMiddleware {
  private readonly buckets = new Map<string, Bucket>();
  use(req: Request, res: Response, next: NextFunction) {
    const login = req.path === '/auth/login' || req.path === '/auth/register';
    const windowMs = login ? 15 * 60_000 : 60_000;
    const limit = login ? 10 : 240;
    const key = `${req.ip}:${login ? 'auth' : 'api'}`;
    const now = Date.now();
    let bucket = this.buckets.get(key);
    if (!bucket || bucket.resetAt <= now) { bucket = { count: 0, resetAt: now + windowMs }; this.buckets.set(key, bucket); }
    bucket.count++;
    res.setHeader('RateLimit-Limit', String(limit));
    res.setHeader('RateLimit-Remaining', String(Math.max(0, limit - bucket.count)));
    res.setHeader('RateLimit-Reset', String(Math.ceil(bucket.resetAt / 1000)));
    if (bucket.count > limit) {
      res.setHeader('Retry-After', String(Math.ceil((bucket.resetAt - now) / 1000)));
      return res.status(429).json({ statusCode: 429, message: 'Too many requests. Please try again later.' });
    }
    if (this.buckets.size > 10_000) for (const [id, value] of this.buckets) if (value.resetAt <= now) this.buckets.delete(id);
    next();
  }
}
