import { mkdtemp, rm, writeFile } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import { afterEach, describe, expect, it } from 'vitest';
import { detectEncoding, isTextCodec, normalizeLanguage, subtitleMatchScore } from '../../src/subtitles/subtitles.service';

let fixtureRoot = '';
afterEach(async () => { if (fixtureRoot) await rm(fixtureRoot, { recursive: true, force: true }); fixtureRoot = ''; });

describe('subtitle encoding, matching and conversion inputs', () => {
  it('detects UTF-8 Bulgarian text', async () => {
    fixtureRoot = await mkdtemp(join(tmpdir(), 'subtitle-fixture-'));
    const file = join(fixtureRoot, 'utf8.srt');
    await writeFile(file, '1\n00:00:01,000 --> 00:00:03,000\nЗдравей, свят!\n', 'utf8');
    await expect(detectEncoding(file)).resolves.toBe('utf-8');
  });
  it('detects Windows-1251 bytes', async () => {
    fixtureRoot = await mkdtemp(join(tmpdir(), 'subtitle-fixture-'));
    const file = join(fixtureRoot, 'cp1251.srt');
    await writeFile(file, Buffer.from([0xcf,0xf0,0xe8,0xe2,0xe5,0xf2]));
    await expect(detectEncoding(file)).resolves.toBe('windows-1251');
  });
  it('matches the same episode and rejects a different episode', () => {
    expect(subtitleMatchScore('Show.S01E02.1080p', 'Show.S01E02.bg')).toBeGreaterThan(80);
    expect(subtitleMatchScore('Show.S01E02.1080p', 'Show.S01E03.bg')).toBe(0);
  });
  it('normalizes Bulgarian language aliases and validates codes', () => {
    expect(normalizeLanguage('bg-BG')).toBe('bul');
    expect(() => normalizeLanguage('../')).toThrow();
  });
  it('separates convertible text codecs from bitmap subtitles', () => {
    expect(isTextCodec('subrip')).toBe(true);
    expect(isTextCodec('hdmv_pgs_subtitle')).toBe(false);
  });
});
