# Production Environment Profiles

Backend profile loading order (later files override earlier files):
1. `.env`
2. `.env.local`
3. `.env.<APP_ENV|NODE_ENV>`
4. `.env.<APP_ENV|NODE_ENV>.local`

Recommended values:
- local dev: `APP_ENV=development`, `NODE_ENV=development`
- staging: `APP_ENV=staging`, `NODE_ENV=production`
- production: `APP_ENV=production`, `NODE_ENV=production`

Frontend (Vite) profile files are mode-based:
- `.env.development`
- `.env.staging`
- `.env.production`

Use the provided `*.example` files as templates and set secrets in your host dashboard (Render/Vercel) instead of committing real values.
