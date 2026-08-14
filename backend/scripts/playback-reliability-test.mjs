import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';

const require = createRequire(import.meta.url);
const scriptDir = dirname(fileURLToPath(import.meta.url));
require('dotenv').config({ path: join(scriptDir, '..', '.env') });
const { PrismaClient } = require('@prisma/client');
const jwt = require('jsonwebtoken');

const baseUrl = process.argv[2] ?? 'https://api.petrich.live';
const concurrency = Number(process.argv[3] ?? 24);
const prisma = new PrismaClient();

const job = await prisma.transcodeJob.findFirst({
  where: { status: 'DONE' },
  orderBy: { finishedAt: 'desc' },
  include: { mediaFile: true },
});
const user = await prisma.user.findFirst({ orderBy: { createdAt: 'asc' } });
if (!job || !user) throw new Error('A completed rendition and a user are required for the reliability test');

function token() {
  return jwt.sign(
    { sub: user.id, email: user.email, isAdmin: user.isAdmin, scope: 'playback', mediaFileId: job.mediaFileId, sv: user.sessionVersion, jti: randomUUID() },
    process.env.JWT_SECRET,
    { expiresIn: '5m' },
  );
}

async function authenticated(path, init = {}, accessToken = token()) {
  return fetch(`${baseUrl}${path}`, {
    ...init,
    headers: { ...init.headers, Authorization: `Bearer ${accessToken}` },
  });
}

const entryResponse = await authenticated(`/stream/${job.mediaFileId}/${job.targetHeight}/index.m3u8`);
if (!entryResponse.ok) throw new Error(`HLS entry failed: ${entryResponse.status}`);
const entry = await entryResponse.text();
const variantName = mediaLines(entry).find((line) => line.endsWith('.m3u8'));
if (!variantName) throw new Error('HLS entry has no variant playlist');
const variantResponse = await authenticated(`/stream/${job.mediaFileId}/${job.targetHeight}/${variantName}`);
const variant = await variantResponse.text();
const segmentName = mediaLines(variant).find((line) => line.endsWith('.ts'));
if (!segmentName) throw new Error('HLS variant has no segment');

let interrupted = 0;
for (let index = 0; index < 12; index++) {
  const controller = new AbortController();
  const response = await authenticated(
    `/stream/${job.mediaFileId}/${job.targetHeight}/${segmentName}`,
    { signal: controller.signal },
  );
  const reader = response.body?.getReader();
  if (!reader) throw new Error('Segment response has no readable body');
  await reader.read();
  controller.abort();
  interrupted++;
}

const started = Date.now();
const latencies = [];
const requests = Array.from({ length: concurrency }, async (_, index) => {
  const accessToken = token();
  const requestStarted = Date.now();
  const response = index % 2 === 0
    ? await authenticated(
        `/stream/${job.mediaFileId}/direct`,
        { headers: { Range: `bytes=${index * 262144}-${index * 262144 + 262143}` } },
        accessToken,
      )
    : await authenticated(
        `/stream/${job.mediaFileId}/${job.targetHeight}/${segmentName}`,
        {},
        accessToken,
      );
  const body = await response.arrayBuffer();
  const expected = index % 2 === 0 ? 206 : 200;
  if (response.status !== expected || body.byteLength === 0) {
    throw new Error(`Concurrent request ${index} failed: HTTP ${response.status}, ${body.byteLength} bytes`);
  }
  latencies.push(Date.now() - requestStarted);
});
await Promise.all(requests);

const health = await fetch(`${baseUrl}/health`);
if (!health.ok) throw new Error(`API unhealthy after interrupted streams: ${health.status}`);
latencies.sort((a, b) => a - b);
const p95 = latencies[Math.min(latencies.length - 1, Math.ceil(latencies.length * 0.95) - 1)];
console.log(JSON.stringify({
  result: 'PASS',
  mediaFileId: job.mediaFileId,
  height: job.targetHeight,
  interruptedRequests: interrupted,
  concurrentUsers: concurrency,
  totalMs: Date.now() - started,
  p95Ms: p95,
  healthStatus: health.status,
}));

await prisma.$disconnect();

function mediaLines(value) {
  return value.split(/\r?\n/).map((line) => line.trim()).filter((line) => line && !line.startsWith('#'));
}
