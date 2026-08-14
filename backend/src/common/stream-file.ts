import { Logger, StreamableFile } from '@nestjs/common';
import { createReadStream } from 'fs';

const logger = new Logger('StreamFile');

/**
 * Wraps a file in a StreamableFile that does not shout about client aborts.
 *
 * hls.js cancels in-flight segment requests on every seek, and browsers drop
 * connections when a tab closes. Node reports that as
 * ERR_STREAM_PREMATURE_CLOSE, which Nest logs at ERROR level by default --
 * routine playback then buries the errors that actually matter. Those aborts
 * are demoted to debug here; everything else still logs as an error.
 */
export function streamFile(filePath: string): StreamableFile {
  return new StreamableFile(createReadStream(filePath)).setErrorLogger((err: Error) => {
    if ((err as NodeJS.ErrnoException).code === 'ERR_STREAM_PREMATURE_CLOSE') {
      logger.debug(`Client aborted transfer of ${filePath}`);
      return;
    }
    logger.error(`Failed streaming ${filePath}: ${err.message}`);
  });
}
