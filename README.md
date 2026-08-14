# streaming-platform

Custom, self-hosted streaming platform (HBO Max-style) for a locked local
network, ~10-50 users.

Start here:

- [`docs/STATUS.md`](docs/STATUS.md) — what currently works, what is shipped
  but unverified, open questions, and known traps. Read this first.
- [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) — requirements, server
  spec, tech stack, phased roadmap, risks. Source of truth for decisions.
- [`docs/SETUP.md`](docs/SETUP.md) — Phase 0 setup steps for this
  Windows 11 Pro server (Docker stack, local CA, GPU capacity test).

## Current phase

**End of Phase 3.** Phases 0-2 are done and Phase 3 is all but finished:
the backend serves a real library (164 files, 67 titles) and the web client
plays it end-to-end in a browser — catalog with TMDB posters, direct play
with HTTP range seeking, HLS for what the browser cannot decode natively,
resume, subtitles and parental control.

Remaining before Phase 3 can be called closed:

- **Search is API-only** — `GET /titles?search=` works; the catalog page has
  no search field.
- **No profile picker** — the player always uses the first profile, which
  leaves parental control unreachable from the UI.
- **Multi-audio is not delivered** — the transcoder maps only the first
  audio track (`-map 0:a:0?`). 20 files in the library carry more than one.
- **Storage** — ~460 GB free is not enough for the library; this is a
  hardware decision, not a code task.

`docs/STATUS.md` is the detailed and current picture; prefer it over this
summary.

## Layout

```
docker-compose.yml       Postgres + Redis + Traefik (no GPU services — see ARCHITECTURE.md)
.env.example              Copy to .env before first run
traefik/                  Reverse proxy config + local TLS certs (not committed)
scripts/gpu-test/         AMD AMF hardware-encode capacity test
scripts/check-direct-play.mjs  HTTP range regression checks for direct play
backend/                  NestJS API: ingestion, transcode, catalog, auth, playback, streaming
web/                      Next.js client: login, catalog, player (hls.js + direct play)
docs/                     Architecture reference + setup guide
```

## Legacy application

The unrelated history previously stored on the remote default branch is
preserved under `legacy/live-streaming-v1/`. It is an older Django, React and
RTMP streaming application kept for historical reference; it is not part of
the current build or deployment.
