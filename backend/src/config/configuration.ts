export default () => ({
  port: parseInt(process.env.PORT ?? '3000', 10),

  database: {
    url: process.env.DATABASE_URL,
  },

  redis: {
    url: process.env.REDIS_URL,
  },

  media: {
    root: process.env.MEDIA_ROOT ?? 'D:/media',
  },

  tmdb: {
    // "API Read Access Token" from TMDB settings (a long JWT), not the short
    // api_key. Absent means metadata enrichment is simply disabled.
    accessToken: process.env.TMDB_ACCESS_TOKEN,
    language: process.env.TMDB_LANGUAGE ?? 'bg-BG',
    // Which country's certification to store in Title.rating. TMDB rarely has
    // Bulgarian certifications, so US is the practical default -- and the
    // rating ladders in catalog/ratings.ts are the US ones.
    certificationCountry: process.env.TMDB_CERTIFICATION_COUNTRY ?? 'US',
    // Posters are downloaded here and served by the API, so client devices
    // never need to reach image.tmdb.org themselves.
    posterRoot: process.env.POSTER_ROOT ?? 'D:/media-posters',
  },

  auth: {
    // No safe default on purpose — a hardcoded fallback secret would be a
    // real vulnerability if someone forgets to set this. Fails loudly at
    // startup instead (see AuthModule) if JWT_SECRET is missing.
    jwtSecret: process.env.JWT_SECRET,
    jwtExpiresIn: process.env.JWT_EXPIRES_IN ?? '7d',
  },

  transcode: {
    // HLS output root. Kept separate from MEDIA_ROOT (source library) so
    // transcoded renditions never mix with originals on disk.
    outputRoot: process.env.TRANSCODE_OUTPUT_ROOT ?? 'D:/media-transcoded',

    // Validated on the server's RX 7900 XTX (see scripts/gpu-test/gpu-test-results.csv
    // and docs/ARCHITECTURE.md): all sessions stayed OK-realtime up to 6
    // concurrent for both encoders. 6 is the tested ceiling, not a proven
    // hard max — bump the env var and retest if you need more headroom.
    maxConcurrentH264Amf: parseInt(
      process.env.TRANSCODE_MAX_CONCURRENT_H264_AMF ?? '6',
      10,
    ),
    maxConcurrentHevcAmf: parseInt(
      process.env.TRANSCODE_MAX_CONCURRENT_HEVC_AMF ?? '6',
      10,
    ),
  },
});
