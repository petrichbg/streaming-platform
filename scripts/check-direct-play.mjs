#!/usr/bin/env node
/**
 * Exercises the HTTP Range behaviour of GET /stream/:id/direct against a
 * running backend, and checks that the bytes it returns are the bytes the
 * file actually holds.
 *
 * There is no test framework in this project, and the range code is easy to
 * break in ways that do not throw -- a wrong slice still comes back as a
 * cheerful 206. So this exists as a script that can be re-run after any edit
 * to stream.controller.ts.
 *
 *   node scripts/check-direct-play.mjs <mediaFileId> [--url http://localhost:3000] [--token <jwt>]
 *
 * The token may also come from the DIRECT_PLAY_TOKEN environment variable.
 * Pick a SMALL media file: the script downloads it once to compare slices.
 */

const args = process.argv.slice(2);
const mediaFileId = args.find((a) => !a.startsWith('--'));
const flag = (name, fallback) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : fallback;
};

const baseUrl = flag('url', 'http://localhost:3000').replace(/\/$/, '');
const token = flag('token', process.env.DIRECT_PLAY_TOKEN);

if (!mediaFileId || !token) {
  console.error('usage: node scripts/check-direct-play.mjs <mediaFileId> [--url URL] [--token JWT]');
  console.error('       (or set DIRECT_PLAY_TOKEN)');
  process.exit(2);
}

const target = `${baseUrl}/stream/${mediaFileId}/direct`;

async function get(range) {
  const headers = { Authorization: `Bearer ${token}` };
  if (range) headers.Range = range;
  const response = await fetch(target, { headers });
  return {
    status: response.status,
    contentRange: response.headers.get('content-range'),
    acceptRanges: response.headers.get('accept-ranges'),
    contentType: response.headers.get('content-type'),
    body: Buffer.from(await response.arrayBuffer()),
  };
}

const failures = [];
function check(label, condition, detail) {
  const ok = Boolean(condition);
  if (!ok) failures.push(`${label}: ${detail}`);
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${label}${ok ? '' : `  -- ${detail}`}`);
}

const whole = await get(null);
if (whole.status !== 200) {
  console.error(`Cannot fetch the file: HTTP ${whole.status}. Check the id and the token.`);
  process.exit(1);
}
const size = whole.body.length;
console.log(`\n${target}\nfile size: ${size} bytes, content-type: ${whole.contentType}\n`);

console.log('Headers on a plain request');
check('status is 200', whole.status === 200, `got ${whole.status}`);
check('advertises Accept-Ranges: bytes', whole.acceptRanges === 'bytes', `got ${whole.acceptRanges}`);

console.log('\nSatisfiable ranges return 206 with the right slice');
for (const [label, header, start, end] of [
  ['first kilobyte', 'bytes=0-1023', 0, 1023],
  ['middle slice', 'bytes=1000-2000', 1000, 2000],
  ['open ended', 'bytes=0-', 0, size - 1],
  ['tail via start', `bytes=${size - 10}-`, size - 10, size - 1],
  // A last-byte-pos past EOF is clamped rather than refused (RFC 9110 14.1.2);
  // clients really do open with "bytes=0-<something enormous>".
  ['end past EOF is clamped', 'bytes=0-99999999999', 0, size - 1],
  // "bytes=-N" is the LAST n bytes. Reading it as 0-N is the classic bug: it
  // returns a valid-looking 206 full of the wrong data.
  ['suffix range is the tail', 'bytes=-1024', size - 1024, size - 1],
  ['oversized suffix is whole file', 'bytes=-99999999', 0, size - 1],
]) {
  const r = await get(header);
  const expected = whole.body.subarray(start, end + 1);
  check(
    `${label} (${header})`,
    r.status === 206 && r.contentRange === `bytes ${start}-${end}/${size}` && r.body.equals(expected),
    `status ${r.status}, content-range ${r.contentRange}, ${r.body.equals(expected) ? 'bytes match' : 'BYTES DIFFER'}`,
  );
}

console.log('\nUnsatisfiable ranges return 416');
for (const [label, header] of [
  ['start at EOF', `bytes=${size}-`],
  ['start past EOF', `bytes=${size + 5000}-`],
  ['zero-length suffix', 'bytes=-0'],
  ['inverted range', 'bytes=5000-1000'],
]) {
  const r = await get(header);
  check(
    `${label} (${header})`,
    r.status === 416 && r.contentRange === `bytes */${size}`,
    `status ${r.status}, content-range ${r.contentRange}`,
  );
}

console.log('\nUnparsable ranges are ignored, not rejected');
for (const [label, header] of [
  ['malformed', 'bytes=abc'],
  ['multi-range (we serve single only)', 'bytes=0-99,200-299'],
  ['unknown unit', 'frames=0-10'],
]) {
  const r = await get(header);
  check(
    `${label} (${header})`,
    r.status === 200 && r.body.length === size,
    `status ${r.status}, ${r.body.length} bytes`,
  );
}

console.log('\nAuth');
const noToken = await fetch(target, { headers: { Range: 'bytes=0-99' } });
check('rejects a request with no token', noToken.status === 401, `got ${noToken.status}`);
const viaQuery = await fetch(`${target}?token=${encodeURIComponent(token)}`, {
  headers: { Range: 'bytes=0-99' },
});
check('accepts ?token= (a <video src> cannot send a header)', viaQuery.status === 206, `got ${viaQuery.status}`);

console.log(
  failures.length === 0
    ? '\nAll checks passed.\n'
    : `\n${failures.length} check(s) failed:\n${failures.map((f) => `  - ${f}`).join('\n')}\n`,
);
process.exit(failures.length === 0 ? 0 : 1);
