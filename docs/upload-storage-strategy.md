# Upload Storage Strategy (Production)

## Current strategy (confirmed)
- **Primary storage**: MongoDB GridFS (`uploads` bucket)
- Upload metadata is stored in MongoDB and files are streamed from the backend.

## Why this is acceptable now
- Single backend + Mongo deployment
- No additional object storage service required
- Existing app logic already supports this flow

## Production requirements
- MongoDB storage sizing + monitoring
- Backups include GridFS collections (`uploads.files`, `uploads.chunks`)
- Rate limits and file size limits remain enabled

## Future scale upgrade path (optional)
Move uploads to S3-compatible storage if any of these become issues:
- DB storage cost grows too fast
- large media traffic load
- need CDN for global delivery

## Decision for current deployment
- Keep GridFS for first production release
- Revisit S3 migration after usage/traffic data
