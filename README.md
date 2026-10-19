# YouTube Reposter

A Node.js server with a private dashboard, scheduled polling, FFmpeg processing, and YouTube uploads. Use only videos you own or have permission to process and upload.

## Configure and run

Install Node.js 22 or later and FFmpeg, including `ffprobe`. Install locked dependencies:

```sh
npm ci
```

Copy `.env.example` to `.env` and fill in your own configuration. `.env` is ignored by Git. In production, set values in your hosting provider's private environment-variable settings instead of uploading an environment file.

| Variable | Purpose |
| --- | --- |
| `YOUTUBE_API_KEY` | Server-side YouTube Data API key |
| `YOUTUBE_CLIENT_ID` | Your Google OAuth web client ID |
| `YOUTUBE_CLIENT_SECRET` | Your Google OAuth client secret |
| `SOURCE_CHANNEL_ID` | Channel to poll |
| `TARGET_CHANNEL_ID` | Channel whose account will authorize uploads |
| `ADMIN_PASSWORD` | Unique password, at least 32 characters; login username is `admin` |
| `APP_URL` | Exact HTTPS origin of the deployment, e.g. `https://your-app.example.com` |
| `TARGET_REFRESH_TOKEN` | Leave empty until setup; then save privately in the environment |
| `UPLOAD_PRIVACY` | `private` by default; may also be `unlisted` or `public` |

Generate an admin password locally:

```sh
node -e "console.log(require('node:crypto').randomBytes(32).toString('hex'))"
```

Never paste the output into source code, an issue, a commit, or a screenshot. The app refuses to start without the required configuration. HTTP is accepted only for localhost development; use HTTPS in production because the dashboard uses HTTP Basic authentication. The former `SETUP_SECRET` and `?s=` setup links are no longer used.

```sh
npm start
```

Open `APP_URL`, then sign in as `admin` with `ADMIN_PASSWORD`. The dashboard, status API, controls, setup, and OAuth callback require authentication. `/healthz` is the only unauthenticated endpoint and returns only a health flag. API writes require the `X-Requested-With: YTReposter` header; browser requests must also come from `APP_URL`.

## Authorize uploads

1. Enable YouTube Data API v3 in your Google Cloud project and configure its OAuth consent screen and a web application OAuth client.
2. Register the exact redirect URI `https://your-app.example.com/auth/callback` (or `http://localhost:3000/auth/callback` locally).
3. Sign in to the dashboard and open `/setup`. Click **Authorize Target Channel**.
4. Authorize with the account for `TARGET_CHANNEL_ID`. Setup requests upload and channel-read scopes and verifies that the returned account owns the configured target channel.
5. The authenticated callback displays the refresh token once. Copy it into your hosting environment as `TARGET_REFRESH_TOKEN`, then restart or redeploy. Do not commit it. No refresh token is written to source files or logs.

Authorization uses a random, ten-minute, single-use state value, an HttpOnly browser-binding cookie, and PKCE. Complete setup in the same browser against the same server instance. An app restart invalidates pending setup; begin again if it expires. This application uses a local JSON database and in-memory OAuth state and login throttling; run one instance.

## Railway deployment

Deploy from GitHub, set the private environment variables above, and set `APP_URL` to the assigned HTTPS origin. `Nixpacks.toml` installs FFmpeg and Node.js and uses the lockfile for installation. Use `/healthz` for the service health check. Mount private persistent storage for `DB_PATH` if job history must survive deployments. The dashboard is access controlled even when the source repository is public.

## Processing options

`CHECK_INTERVAL_MINUTES` defaults to 5. The example file lists segment, reversal, speed, pitch, flip, and encoding settings. Configure processing through the environment. Uploads default to private; set `UPLOAD_PRIVACY=public` only when intended.

## Security and verification

Credentials previously committed to this repository must be revoked or rotated before making it public. Deleting `.env` in a new commit does not remove older versions. Follow [SECURITY.md](SECURITY.md) before changing visibility.

```sh
npm test
npm run check:secrets
npm audit --omit=dev
```

The secret check examines the Git index, so stage intended changes first; it rejects environment files, common credential files, and recognizable tokens without printing their contents. CI repeats the tests, secret checks, and dependency audit. Pattern scanning cannot prove that every possible secret is absent.
