# Rollback Plan (Backend + Frontend)

This file closes the `Rollback plan documented` checklist item.

## Trigger conditions

Start rollback when any of these occurs after deploy:

- health endpoint failing for > 3 minutes
- chat send/receive broken
- socket connect failures for majority of users
- AI route failures spike (`5xx`, provider auth failures)

## Backend rollback

1. Re-deploy previous known-good commit from host history.
2. Keep current DB, unless deployment included irreversible schema/data changes.
3. Re-apply previous env snapshot (host env history/export).
4. Verify:
   - `/api/health`
   - smoke script:
     - `node backend/scripts/smoke-production.mjs --base=https://<backend-domain>`

## Frontend rollback (Vercel)

1. In Vercel deployment history, promote previous stable deployment.
2. Confirm frontend env values match backend URLs.
3. Verify login/chat/AI/search flows from browser.

## Database rollback

Only if required:

1. Use latest backup archive.
2. Restore into isolated DB first and validate.
3. Promote restore with planned maintenance window.

Backup tools:

- `node backend/scripts/mongo-backup.mjs`
- `node backend/scripts/mongo-restore.mjs`
- `node backend/scripts/verify-backup-restore.mjs`

## Incident logging

Capture:

- rollback start/end time
- deployment ids reverted
- root cause summary
- follow-up actions

