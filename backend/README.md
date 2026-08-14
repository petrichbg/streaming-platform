# backend

NestJS API for the streaming platform. Phase 1 status: media ingestion
(file scanner + ffprobe), the transcode queue (BullMQ worker driving
native FFmpeg AMF), read-only catalog/browse endpoints, and JWT auth
(register/login) are wired up. Playback session and profile endpoints are
not built yet.

## Prerequisites

- Node.js 20+
- The root Docker Compose stack running (`docker compose up -d` from the
  repo root) so Postgres and Redis are reachable.

## Setup

```powershell
cd backend
npm install
copy .env.example .env
notepad .env   # match DATABASE_URL / REDIS_URL to your root ../.env credentials, set MEDIA_ROOT
npm run prisma:migrate
npm run start:dev
```

If you already ran `npm install`/`prisma:migrate` before the ingestion and
transcode code was added, re-run both — `package.json` gained BullMQ/Redis
client deps and `schema.prisma` gained a unique constraint on `Title`.

Server listens on `PORT` from `.env` (default 3000).

## What's here

- `src/main.ts` — app bootstrap
- `src/app.module.ts` — root module, loads config, registers BullMQ + feature modules
- `src/config/configuration.ts` — env-driven config, including the
  transcode concurrency values (see comments — these come from the GPU
  capacity test, not guessed)
- `prisma/schema.prisma` — core domain: users/profiles, titles/episodes,
  media files, transcode jobs, watch progress, watchlist
- `src/media/` — `MediaScannerService` walks `MEDIA_ROOT`, probes each new
  file with ffprobe, and imports it as a `Title`/`Episode`/`MediaFile`.
  Basic filename heuristics (`filename-parser.ts`) split movies vs
  `SxxEyy` episodes — expect to replace with real metadata matching later.
  Trigger a scan: `POST /media/scan`.
- `src/transcode/` — BullMQ queue + worker (`TranscodeProcessor`) that
  shells out to native `ffmpeg` with the AMF encoder, applying the
  `format=nv12` fix for 10-bit sources on `h264_amf` (see
  `docs/ARCHITECTURE.md`). Worker concurrency is set from the tested GPU
  limits, using the combined cap since both encoder types share one AMF
  block. Enqueue a job: `POST /transcode` with
  `{ "mediaFileId": "...", "encoder": "h264_amf", "targetHeight": 1080 }`.
- `src/catalog/` — read-only browse API over the imported library.
  `GET /titles` lists titles (optional `?search=` name filter, `?type=MOVIE|SERIES`
  filter), returning id/name/type/year/genres/poster plus episode and media
  file counts. `GET /titles/:id` returns full detail — media files for
  movies, episodes (each with their own media files) for series — 404 if
  the id doesn't exist.
- `src/auth/` — JWT-based auth. `POST /auth/register` (first account
  created becomes admin, rest register as regular users) and
  `POST /auth/login` both return `{ accessToken, user }`. `JwtAuthGuard`
  reads `Authorization: Bearer <token>`, verifies it, and attaches the
  decoded payload to `request.user` — import `AuthModule` and
  `@UseGuards(JwtAuthGuard)` to protect a route. `GET /auth/me` is a
  reference example. Requires `JWT_SECRET` in `.env` — the app refuses to
  start without it (see `.env.example`).

- `src/profiles/` — multi-profile support per account, all guarded and
  scoped to the authenticated user. `POST /profiles` (name, optional
  `isKid`/`maxRating`), `GET /profiles`, `GET /profiles/:id`,
  `DELETE /profiles/:id`. Requesting another account's profile returns 404
  rather than 403, so profile existence isn't leaked across accounts.
- `src/playback/` — per-profile watch state, all nested under
  `/profiles/:profileId` and verified to belong to the caller.
  `PUT .../progress` saves a resume position (`titleId` or `episodeId`,
  plus `positionSec`), `GET .../continue-watching` returns the 20 most
  recent, `POST/GET/DELETE .../watchlist` manage the watchlist. Note:
  progress uses find-then-write rather than `upsert`, because the
  `@@unique([profileId, titleId, episodeId])` index does not dedupe rows
  where `episodeId` is NULL (movies) — Postgres treats NULLs as distinct.

## Not yet built

Subtitles delivery and parental controls enforcement — next steps in
Phase 1+ per `../docs/ARCHITECTURE.md`.
