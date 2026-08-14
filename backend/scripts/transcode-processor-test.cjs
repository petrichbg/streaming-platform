const assert = require('node:assert/strict');
const { TranscodeProcessor } = require('../dist/transcode/transcode.processor');

const updates = [];
const prisma = {
  transcodeJob: {
    update: async (input) => { updates.push(input.data); return input.data; },
    findUnique: async () => ({ status: 'RUNNING' }),
  },
};
const cleanup = { discardWork: async () => undefined };
const processor = new TranscodeProcessor(prisma, {}, { get: () => 1 }, cleanup);
const encoders = [];
processor.runFfmpeg = async (_jobId, _mediaFileId, encoder) => {
  encoders.push(encoder);
  if (encoder === 'h264_amf') throw new Error('AMF initialization failed: no capable devices');
  return 'D:\\media-transcoded\\test\\360p\\master.m3u8';
};

processor.process({
  data: {
    transcodeJobId: 'job-test',
    mediaFileId: '00000000-0000-0000-0000-000000000001',
    encoder: 'h264_amf',
    targetHeight: 360,
    attempt: 1,
  },
}).then(() => {
  assert.deepEqual(encoders, ['h264_amf', 'libx264']);
  assert.ok(updates.some((update) => update.encoder === 'libx264' && update.fallbackFrom === 'h264_amf'));
  assert.ok(updates.some((update) => update.status === 'DONE'));
  console.log(JSON.stringify({ result: 'PASS', transition: encoders.join(' -> '), finalStatus: 'DONE' }));
}).catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
