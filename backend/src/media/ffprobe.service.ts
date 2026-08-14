import { Injectable } from '@nestjs/common';
import { execFile } from 'child_process';
import { promisify } from 'util';

const execFileAsync = promisify(execFile);

export interface FfprobeStream {
  index: number;
  codec_type: 'video' | 'audio' | 'subtitle' | 'data';
  codec_name?: string;
  pix_fmt?: string;
  /** Frame rate as the fraction ffprobe reports it, e.g. "24000/1001". */
  r_frame_rate?: string;
  /** Channel count on an audio stream; drives its bitrate budget. */
  channels?: number;
  /** Pixel dimensions of a video stream; the source height caps renditions. */
  width?: number;
  height?: number;
  tags?: Record<string, string>;
  disposition?: Record<string, number>;
}

export interface FfprobeResult {
  format: {
    duration?: string;
    format_name?: string;
  };
  streams: FfprobeStream[];
}

@Injectable()
export class FfprobeService {
  async probe(filePath: string): Promise<FfprobeResult> {
    const { stdout } = await execFileAsync(
      'ffprobe',
      ['-v', 'quiet', '-print_format', 'json', '-show_format', '-show_streams', filePath],
      { maxBuffer: 10 * 1024 * 1024 },
    );

    return JSON.parse(stdout) as FfprobeResult;
  }

  /** True if the video stream uses a 10-bit (or higher) pixel format. */
  isHighBitDepth(stream: FfprobeStream): boolean {
    return !!stream.pix_fmt && /10le|10be|12le|12be/.test(stream.pix_fmt);
  }
}
