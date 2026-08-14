import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const scriptDir = dirname(fileURLToPath(import.meta.url));
require('dotenv').config({ path: join(scriptDir, '..', '.env') });
const { PrismaClient } = require('@prisma/client');
const Redis = require('ioredis');

const prisma = new PrismaClient();
const redis = new Redis(process.env.REDIS_URL, {
  connectTimeout: 3000,
  commandTimeout: 3000,
  maxRetriesPerRequest: 0,
  lazyConnect: true,
});

const result = {
  postgres: false,
  redis: false,
  queue: { queued: 0, running: 0, failed24h: 0, oldestActiveMinutes: 0 },
};

try {
  await prisma.$queryRawUnsafe('SELECT 1');
  result.postgres = true;
  const [queued, running, failed24h, oldest] = await Promise.all([
    prisma.transcodeJob.count({ where: { status: 'QUEUED' } }),
    prisma.transcodeJob.count({ where: { status: 'RUNNING' } }),
    prisma.transcodeJob.count({
      where: { status: 'FAILED', finishedAt: { gte: new Date(Date.now() - 24 * 60 * 60 * 1000) } },
    }),
    prisma.transcodeJob.findFirst({
      where: { status: { in: ['QUEUED', 'RUNNING'] } },
      orderBy: { createdAt: 'asc' },
      select: { createdAt: true },
    }),
  ]);
  result.queue = {
    queued,
    running,
    failed24h,
    oldestActiveMinutes: oldest ? Math.round((Date.now() - oldest.createdAt.getTime()) / 60000) : 0,
  };
} catch (error) {
  result.postgresError = error instanceof Error ? error.message : String(error);
}

try {
  await redis.connect();
  result.redis = (await redis.ping()) === 'PONG';
} catch (error) {
  result.redisError = error instanceof Error ? error.message : String(error);
} finally {
  redis.disconnect();
  await prisma.$disconnect();
}

console.log(JSON.stringify(result));
