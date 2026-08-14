const assert = require('node:assert/strict');
const { TranscodeQueueService } = require('../dist/transcode/transcode-queue.service');

function baseJob(status) {
  return {
    id: `job-${status.toLowerCase()}`,
    mediaFileId: '00000000-0000-0000-0000-000000000001',
    status,
    encoder: 'h264_amf',
    fallbackFrom: null,
    attempt: 1,
    targetHeight: 360,
    mediaFile: { sourcePath: 'test.mp4' },
  };
}

async function testCancel() {
  const job = baseJob('QUEUED');
  let removed = false;
  const prisma = {
    transcodeJob: {
      findUnique: async () => job,
      update: async ({ data }) => Object.assign(job, data),
    },
  };
  const queue = { getJob: async () => ({ getState: async () => 'waiting', remove: async () => { removed = true; } }) };
  const service = new TranscodeQueueService(queue, prisma, {}, {}, { cancelJob: async () => false }, { discardWork: async () => undefined });
  const result = await service.cancel(job.id);
  assert.equal(result.status, 'CANCELLED');
  assert.equal(removed, true);
}

async function testRetry() {
  const oldJob = baseJob('FAILED');
  const newJob = { ...baseJob('QUEUED'), id: 'job-retry-new', attempt: 2 };
  let owner = null;
  let oldRemoved = false;
  const oldQueueJob = { getState: async () => 'failed', remove: async () => { oldRemoved = true; } };
  const queue = {
    getJob: async () => owner ?? oldQueueJob,
    add: async (_name, data) => { owner = { data }; },
  };
  const prisma = {
    transcodeJob: {
      findUnique: async ({ where }) => where.id === oldJob.id ? oldJob : newJob,
      findFirst: async () => null,
      create: async ({ data }) => Object.assign(newJob, data),
      delete: async () => undefined,
    },
  };
  const service = new TranscodeQueueService(queue, prisma, {}, {}, {}, {});
  const result = await service.retry(oldJob.id);
  assert.equal(oldRemoved, true);
  assert.equal(result.attempt, 2);
  assert.equal(result.encoder, 'h264_amf');
}

async function testRequeue() {
  const job = baseJob('DONE');
  const newJob = { ...baseJob('QUEUED'), id: 'job-requeue-new', attempt: 2 };
  let renditionRemoved = false;
  let owner = null;
  const queue = { getJob: async () => owner, add: async (_name, data) => { owner = { data }; } };
  const prisma = {
    transcodeJob: {
      findUnique: async ({ where }) => where.id === job.id ? job : newJob,
      findFirst: async () => null,
      create: async ({ data }) => Object.assign(newJob, data),
      delete: async () => undefined,
    },
  };
  const cleanup = { removeRendition: async () => { renditionRemoved = true; } };
  const service = new TranscodeQueueService(queue, prisma, {}, {}, {}, cleanup);
  const result = await service.requeue(job.id);
  assert.equal(renditionRemoved, true);
  assert.equal(result.attempt, 2);
}

Promise.all([testCancel(), testRetry(), testRequeue()]).then(() => {
  console.log(JSON.stringify({ result: 'PASS', actions: ['cancel', 'retry', 'requeue'] }));
}).catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
