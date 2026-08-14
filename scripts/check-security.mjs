const baseUrl = process.env.SECURITY_TEST_BASE_URL ?? 'http://127.0.0.1:3000';
const checks = [
  ['health is public', '/health', 200],
  ['account requires auth', '/auth/me', 401],
  ['library scan requires admin auth', '/media/scan', 401, { method: 'POST' }],
  ['transcode status requires admin auth', '/transcode/status', 401],
  ['transcode cancel requires admin auth', '/transcode/jobs/00000000-0000-0000-0000-000000000000/cancel', 401, { method: 'POST' }],
  ['transcode retry requires admin auth', '/transcode/jobs/00000000-0000-0000-0000-000000000000/retry', 401, { method: 'POST' }],
  ['transcode requeue requires admin auth', '/transcode/jobs/00000000-0000-0000-0000-000000000000/requeue', 401, { method: 'POST' }],
  ['invalid playback token is rejected', '/stream/00000000-0000-0000-0000-000000000000/direct?token=invalid', 401],
];
let failed = 0;
for (const [name, path, expected, init] of checks) {
  try {
    const response = await fetch(`${baseUrl}${path}`, init);
    const ok = response.status === expected;
    console.log(`${ok ? 'PASS' : 'FAIL'} ${name}: ${response.status}`);
    if (!ok) failed++;
  } catch (error) {
    console.log(`FAIL ${name}: ${error.message}`);
    failed++;
  }
}
if (failed) process.exitCode = 1;
