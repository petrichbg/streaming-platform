# Phase 0 setup — Windows 11 Pro

Follow in order. Each step has a way to verify it worked before moving on.

## 0. Storage — do this first

Only ~460 GB is free on this machine today. That is not enough for a real
media library. Attach/mount additional storage (external drive, NAS share,
or a second internal disk) before you start importing content in Phase 1.
Decide the mount point now (e.g. `D:\media`) so later config can reference
it consistently.

## 1. Install Docker Desktop

Install Docker Desktop for Windows with the WSL2 backend (default option).
This repo's Docker services (Postgres, Redis, Traefik) don't need GPU
access, so the known AMD GPU-passthrough limitations in WSL2 don't apply
to them — transcoding stays outside Docker entirely (see step 4).

Verify:
```powershell
docker compose version
```

## 2. Generate a local CA + certificate with mkcert

Install mkcert (via `choco install mkcert` or from
https://github.com/FiloSottile/mkcert/releases), then:

```powershell
mkcert -install
mkdir traefik\certs
mkcert -cert-file traefik\certs\streaming.local.pem -key-file traefik\certs\streaming.local-key.pem streaming.local "*.streaming.local"
```

`mkcert -install` adds the local CA to this machine's trust store. Every
other client device (phones, TVs, other laptops) that will hit this server
over HTTPS needs the same CA trusted — mkcert prints the CA file location;
copy `rootCA.pem` to each device and trust it there. Skip this step only if
you're fine with client devices showing a certificate warning.

## 3. Configure and start the base stack

```powershell
copy .env.example .env
notepad .env   # fill in real passwords, confirm DOMAIN matches the mkcert cert
docker compose up -d
docker compose ps
```

Verify: `docker compose ps` shows `postgres`, `redis`, and `traefik` as
healthy/running. Traefik dashboard should be reachable at
`http://localhost:8080` (insecure dashboard, Phase 0 only — see
`traefik/traefik.yml` comment).

## 4. Install FFmpeg with AMF support (native, not in Docker)

Download the "full" build from https://www.gyan.dev/ffmpeg/builds/, unzip,
add the `bin` folder to your system PATH. Confirm:

```powershell
ffmpeg -hide_banner -encoders | Select-String amf
```

You should see `h264_amf` and `hevc_amf` at minimum.

## 5. Run the GPU capacity test

See `scripts/gpu-test/README.md` for full instructions. Short version:

```powershell
cd scripts\gpu-test
.\test-amf-capacity.ps1 -SourceFile "D:\media\<a real sample file>.mkv" -MaxConcurrent 6 -Encoder h264_amf
```

Review `gpu-test-results.csv`. This number (safe concurrent transcode
ceiling) is a real input to Phase 1's design, not a formality — don't skip
it.

## 6. Reaching the server from other devices

Wired on 14 август 2026. Traefik carries both host-side services, so every
client — phone, TV, another PC — uses one pair of names instead of an IP and
a port that change with DHCP:

| Name | Serves |
|---|---|
| `https://streaming.local` | the web client (host port 3001) |
| `https://api.streaming.local` | the API (host port 3000) |

The routes live in `traefik/dynamic/routes.yml`. Both services run natively on
the host rather than in Docker (the transcoder needs the GPU), so Traefik
reaches them back through `host.docker.internal`.

Verified through the proxy: the web client, the API with and without a token
(401 preserved), a `Range` request answered **206** with an intact
`Content-Range` — direct play survives the proxy — and a 2 MB HLS segment.

**Each device needs two one-off steps:**

1. **Name resolution.** `streaming.local` and `api.streaming.local` must
   resolve to this host's LAN address. Best done once on the router's DNS;
   otherwise per device via its hosts file. Nothing resolves them by default,
   including this machine.
2. **Trust the mkcert root CA** (from step 2 above). Without it the
   certificate is rejected and nothing loads. On Android this means importing
   the CA and, from Android 7 onwards, an app that opts into user CAs.

The firewall already allows inbound 80 and 443. It does **not** allow 3000 or
3001, which is deliberate — the dev servers stay off the network and Traefik
is the only way in.

> **Trap:** Traefik's `watch: true` does not see edits to files on a Windows
> bind mount — inotify events do not cross from the host filesystem into the
> container. A new or edited file under `traefik/dynamic/` is picked up only
> after `docker restart streaming-traefik`. The routes above sat unread for
> exactly this reason.

## 7. Windows reliability tweaks (consumer OS running as a server)

Windows 11 Pro will happily run this, but a couple of defaults fight
against always-on server use:

- Power settings → set "Sleep" to Never for this machine.
- Windows Update → set active hours to cover when the service needs to stay
  up, or schedule restarts for a known-low-usage window; Windows will
  otherwise restart the box for updates on its own schedule.
- Consider Docker Desktop's "start on login + auto-start containers"
  setting so the stack comes back up after any restart without manual
  intervention.

## Done when

- `docker compose ps` shows all three services healthy
- A test client device trusts the mkcert CA and can reach
  `https://traefik.streaming.local:8080` without a certificate warning
- `gpu-test-results.csv` shows a known safe concurrent-transcode ceiling
  for both `h264_amf` and `hevc_amf`
- Additional storage is mounted and its path decided

Once all four are true, Phase 0 is complete — move to Phase 1
(backend ingestion + transcode pipeline) per `docs/ARCHITECTURE.md`.
