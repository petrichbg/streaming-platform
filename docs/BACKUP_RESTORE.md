# Backup and restore

## Schedule and storage

`StreamingPlatformDailyBackup` runs every day at 03:00 and writes encrypted
archives to `G:\My Drive\StreamingPlatformBackups`. The task runs as the
interactive Windows user because Google Drive is not mounted in the SYSTEM
session. `StartWhenAvailable` runs a missed backup after the next login.

Check the task and newest archive:

```powershell
.\scripts\backup-status.ps1
```

Run an additional backup manually:

```powershell
.\scripts\backup.ps1
```

## Contents and encryption

Each `streaming-backup-*.7z` archive uses AES-256 encrypted 7z headers and
payload. It contains:

- PostgreSQL custom-format dump;
- root, backend and web production environment files;
- `ruvector.db` metadata;
- downloaded posters;
- Traefik certificates, including the local leaf private key;
- the Cloudflare Tunnel credential;
- a manifest with the size and SHA-256 of every backed-up file.

The recovery key is stored locally at
`var\backup-recovery.key`, is excluded from Git, and has a restricted Windows
ACL. Keep an offline copy in a password manager or encrypted removable drive.
Do not place the recovery key next to the Google Drive archives.

## Retention

The default policy keeps:

- the newest 14 daily backups;
- one newest backup from each of the newest 8 weeks;
- one newest backup from each of the newest 12 months.

An archive selected by more than one tier is kept only once. Pruning happens
only after a new archive has been created and successfully tested by 7-Zip.

## Restore verification

The restore drill decrypts the newest archive, validates every manifest hash,
starts an isolated temporary PostgreSQL 16 container, restores the database,
checks the schema, then deletes the test container and temporary files:

```powershell
.\scripts\restore-test.ps1
```

It never connects to or modifies the production database.

## Disaster recovery order

1. Install Docker, Node.js and `cloudflared` on the replacement host.
2. Clone the repository and copy the offline recovery key to
   `var\backup-recovery.key`.
3. Run `restore-test.ps1` against the selected archive before touching a
   production database.
4. Extract the verified archive with the pinned `var\tools\7zr.exe` binary.
5. Restore `config`, posters, Traefik certificates and the Cloudflare
   credential to their documented paths.
6. Restore `database\streaming.dump` with `pg_restore` into a fresh PostgreSQL
   database.
7. Run the production builds, start the supervisor and verify health, login,
   Range seek, HLS and subtitles.
