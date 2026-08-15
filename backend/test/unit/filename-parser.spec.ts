import { describe, expect, it } from 'vitest';
import { isSamplePath, parseFilename, parseMediaPath } from '../../src/media/filename-parser';

describe('media filename parser', () => {
  it.each([
    ['Movie.Title.2024.1080p.mkv', { type: 'movie', title: 'Movie Title', year: 2024 }],
    ['Show.Name.S02E07.720p.mkv', { type: 'episode', title: 'Show Name', season: 2, episode: 7 }],
    ['[Group] Zootopia.2.2025.WEB.mkv', { type: 'movie', title: 'Zootopia 2', year: 2025 }],
  ])('parses %s', (input, expected) => expect(parseFilename(input)).toEqual(expected));

  it('prefers the informative directory over a release-group filename', () => {
    expect(parseMediaPath('Captain.America.2016.1080p/rflx-cacw-bg.mkv')).toMatchObject({ title: 'Captain America', year: 2016 });
  });

  it.each(['Movie/sample.mkv', 'Movie/Sample/clip.mkv', 'Movie.Title.sample.avi'])('rejects sample path %s', (input) => expect(isSamplePath(input)).toBe(true));
  it('does not reject words containing sample', () => expect(isSamplePath('The.Sampler.2020.mkv')).toBe(false));
});
