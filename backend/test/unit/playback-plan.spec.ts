import { describe, expect, it, vi } from 'vitest';
import { directPlayBlockers } from '../../src/common/playability';
import { StreamService } from '../../src/stream/stream.service';

describe('playback compatibility and plans', () => {
  it('direct-plays MP4 H264 AAC', () => expect(directPlayBlockers({ container: 'mp4', videoCodec: 'h264', audioTracks: [{ codec: 'aac' }] })).toEqual([]));
  it('requires transcode for MKV HEVC DTS', () => expect(directPlayBlockers({ container: 'mkv', videoCodec: 'hevc', audioTracks: [{ codec: 'dts' }] })).toEqual(['container mkv', 'video hevc', 'audio dts']));
  it('returns direct plan when codecs are compatible', async () => {
    const prisma = { mediaFile: { findUnique: vi.fn().mockResolvedValue({ container: 'mp4', videoCodec: 'h264', audioTracks: [{ codec: 'aac' }] }) } } as any;
    const service = new StreamService(prisma, {} as any);
    await expect(service.getPlaybackPlan('media-1')).resolves.toMatchObject({ mode: 'direct', url: '/stream/media-1/direct' });
  });
  it('chooses adaptive HLS for multiple renditions', async () => {
    const prisma = { mediaFile: { findUnique: vi.fn().mockResolvedValue({ container: 'mkv', videoCodec: 'hevc', audioTracks: [] }) } } as any;
    const service = new StreamService(prisma, {} as any);
    vi.spyOn(service, 'listRenditions').mockResolvedValue([{ height: 480, playlistUrl: '/480' }, { height: 720, playlistUrl: '/720' }]);
    await expect(service.getPlaybackPlan('media-2')).resolves.toMatchObject({ mode: 'hls', url: '/stream/media-2/adaptive/master.m3u8' });
  });
  it('reports unavailable when no direct or HLS path exists', async () => {
    const prisma = { mediaFile: { findUnique: vi.fn().mockResolvedValue({ container: 'mkv', videoCodec: 'hevc', audioTracks: [] }) } } as any;
    const service = new StreamService(prisma, {} as any);
    vi.spyOn(service, 'listRenditions').mockResolvedValue([]);
    await expect(service.getPlaybackPlan('media-3')).resolves.toMatchObject({ mode: 'unavailable', url: null });
  });
});
