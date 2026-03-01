# MongoDB Backup & Restore Plan

## Goal
Create a repeatable backup process and a safe restore validation process before production launch.

## Scripts
- `node backend/scripts/mongo-backup.mjs --dry-run`
- `node backend/scripts/mongo-backup.mjs`
- `node backend/scripts/mongo-restore.mjs --archive=<file> --db=<targetDb> --dry-run`
- `node backend/scripts/mongo-restore.mjs --archive=<file> --db=<targetDb> --drop`
- `node backend/scripts/verify-backup-restore.mjs` (dry-run verification)

## Production backup plan
1. Run backups on a schedule (at least daily) using `mongodump` archive + gzip.
2. Store archives outside the app host (S3 / object storage / secure backup disk).
3. Keep retention (example): 7 daily, 4 weekly, 3 monthly.
4. Encrypt backup storage and restrict access.
5. Log backup job status and alert on failures.

## Restore test process (safe)
1. Pick latest backup archive.
2. Restore into a separate DB (example: `lovechatty_restore_test`).
3. Verify key collections exist (`users`, `messages`, `groups`, `chatsettings`).
4. Verify random sample counts / recent records.
5. Delete test DB after verification.

## Notes
- The included `verify-backup-restore.mjs` runs a dry-run validation of generated commands.
- Real restore execution still requires `mongodump` / `mongorestore` binaries and a Mongo target.
