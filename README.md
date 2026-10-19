# YouTube Reposter

A Node.js server with a private dashboard, scheduled polling, FFmpeg processing, and YouTube uploads. Use only videos you own or have permission to process and upload.

**Set your own values in `.env` locally or your hosting service's private Variables settings. You do not need to replace credentials inside `server.js`, `processor.js`, or this README.** Every person deploying a copy should use their own Google Cloud project and credentials.

## 1. What you need and which API to enable

| Item | What it does | Setup link |
| --- | --- | --- |
| Google Cloud project | Holds your API configuration and OAuth credentials | [Google Cloud Console](https://console.cloud.google.com/) |
| **YouTube Data API v3** | Reads the source channel's public uploads and uploads videos to the authorized target channel | [Enable YouTube Data API v3](https://console.cloud.google.com/apis/library/youtube.googleapis.com) · [Official overview](https://developers.google.com/youtube/v3/getting-started) |
| API key | Identifies the project when reading the source channel | [APIs & Services → Credentials](https://console.cloud.google.com/apis/credentials) |
| OAuth web application client | Lets the target channel's Google account authorize uploads | [Google Auth platform](https://console.cloud.google.com/auth/overview) |
| Node.js 22 or later | Runs the server; npm is included | [Node.js downloads](https://nodejs.org/en/download) |
| FFmpeg and ffprobe | Process and inspect video files | [FFmpeg downloads](https://ffmpeg.org/download.html) |

The Google API key and OAuth client secret are different credentials. The API key alone cannot authorize uploads. FFmpeg runs on your server; it has no API key to configure. Railway is an optional hosting provider.

## 2. Create your Google credentials

### A. Create a project and enable the API

1. Open [Google Cloud Console](https://console.cloud.google.com/) and create or select your project in the project selector.
2. In that project, open the [YouTube Data API v3 library page](https://console.cloud.google.com/apis/library/youtube.googleapis.com) and click **Enable**.
3. Keep that same project selected while creating both credentials below.

### B. Create the API key → `YOUTUBE_API_KEY`

1. Open [APIs & Services → Credentials](https://console.cloud.google.com/apis/credentials).
2. Choose **Create credentials → API key** and copy the new key into your private `YOUTUBE_API_KEY` environment variable.
3. Edit the key's **API restrictions** to allow **YouTube Data API v3**. For application restrictions, use the server's fixed outbound IP address if your host provides one. This server makes the API requests; website-referrer restrictions are intended for browser requests.

Follow [Google's API-key guidance](https://cloud.google.com/docs/authentication/api-keys-best-practices). Never put a real key in the README, a GitHub issue, or a committed file.

### C. Configure OAuth consent

Open [Google Auth platform](https://console.cloud.google.com/auth/overview). If prompted, choose **Get Started** and enter the app name, support email, audience, and contact email.

- In **Audience**, choose the audience appropriate for your Google account. For an external app in **Testing**, add the Google account that owns your target YouTube channel under **Test users**.
- In **Data Access**, configure the two scopes the software requests:

| Scope | Why this software requests it |
| --- | --- |
| `https://www.googleapis.com/auth/youtube.upload` | Upload processed videos |
| `https://www.googleapis.com/auth/youtube.readonly` | Check that the authorized account owns `TARGET_CHANNEL_ID` |

See [Google's consent setup guide](https://developers.google.com/workspace/guides/configure-oauth-consent). Making this GitHub repository public does not publish or verify your Google OAuth app. External apps in Testing receive refresh tokens that expire after seven days for these scopes; review [Google's token-expiration guidance](https://developers.google.com/identity/protocols/oauth2#expiration) and [production-readiness requirements](https://developers.google.com/identity/protocols/oauth2/production-readiness/overview) for ongoing use.

### D. Create the web client → `YOUTUBE_CLIENT_ID` and `YOUTUBE_CLIENT_SECRET`

1. In Google Cloud Console, open **Google Auth platform → Clients → Create client**.
2. Select **Web application** as the application type and give it a name.
3. Under **Authorized redirect URIs**, add the exact callback for the environment you will run:

| Where you run it | `APP_URL` | Authorized redirect URI |
| --- | --- | --- |
| Your computer, default port | `http://localhost:3000` | `http://localhost:3000/auth/callback` |
| Railway, example domain | `https://your-app.up.railway.app` | `https://your-app.up.railway.app/auth/callback` |
| Your own HTTPS domain | `https://your-app.example.com` | `https://your-app.example.com/auth/callback` |

Replace each example domain with your actual deployment domain. Keep `APP_URL` as the origin only, without a path; append `/auth/callback` only in Google's redirect-URI field. The scheme, hostname, port, and callback path must match exactly. If your domain or local port changes, update both settings.

4. Create the client. Save its **Client ID** as `YOUTUBE_CLIENT_ID` and its **Client secret** as `YOUTUBE_CLIENT_SECRET` in your private environment settings. Keep the secret available securely when Google displays it.

The app performs the redirect on the server. Configure the callback under **Authorized redirect URIs**, rather than putting it in **Authorized JavaScript origins**. See [Google's web-client creation instructions](https://developers.google.com/workspace/guides/create-credentials).

## 3. Find your source and target channel IDs

- **Source** means the channel whose public uploads the app checks. Set its channel ID in `SOURCE_CHANNEL_ID`.
- **Target** means the channel that will receive uploads. Set its channel ID in `TARGET_CHANNEL_ID`; authorize with that channel's Google account later.

Use the channel ID beginning with `UC`, rather than an `@handle`, email address, video ID, or full channel URL. If the URL is `https://www.youtube.com/channel/UC...`, copy just the `UC...` part.

For a channel you own, switch to that channel on YouTube, open [Advanced account settings](https://www.youtube.com/account_advanced), and copy **Channel ID**. See [YouTube's official instructions](https://support.google.com/youtube/answer/3250431).

If you only know the source channel's handle, use the official [`channels.list` API Explorer](https://developers.google.com/youtube/v3/docs/channels/list): set `part` to `id`, set `forHandle` to the handle, execute the request, and copy `items[0].id` from the response. See the same reference for authorization requirements.

## 4. Fill in your environment variables

| Variable | What you put here | Required when |
| --- | --- | --- |
| `YOUTUBE_API_KEY` | Your API key from step 2B | Before startup |
| `YOUTUBE_CLIENT_ID` | Your web application's Client ID from step 2D | Before startup |
| `YOUTUBE_CLIENT_SECRET` | The same web client's Client secret | Before startup |
| `SOURCE_CHANNEL_ID` | Source channel's `UC...` ID from step 3 | Before startup |
| `TARGET_CHANNEL_ID` | Target channel's `UC...` ID from step 3 | Before startup |
| `ADMIN_PASSWORD` | A newly generated password of at least 32 characters | Before startup; dashboard username is `admin` |
| `APP_URL` | Your exact deployment origin, or `http://localhost:3000` locally | Set before authorization; localhost is the development default |
| `TARGET_REFRESH_TOKEN` | Leave empty initially; then copy the token produced in step 6 | Before polling and uploads |

Generate your own admin password:

```sh
node -e "console.log(require('node:crypto').randomBytes(32).toString('hex'))"
```

Copy that generated value into `ADMIN_PASSWORD` privately. The former `SETUP_SECRET` and `?s=` setup links are no longer used. Restart or redeploy after changing environment variables.

## 5. Install and run locally

Install Node.js and FFmpeg from the links in step 1. Ensure both `ffmpeg` and `ffprobe` are on your `PATH`, then check:

```sh
node --version
ffmpeg -version
ffprobe -version
git clone https://github.com/akhtarsaleem1/YTRepost.git
cd YTRepost
npm ci
```

Copy the blank example file to `.env`:

```powershell
# Windows PowerShell
Copy-Item .env.example .env
```

```sh
# macOS / Linux
cp .env.example .env
```

Open `.env` in your editor. Replace the `YOUR_...` / `REPLACE_...` placeholders below with your own values; leave `TARGET_REFRESH_TOKEN` empty until step 6. This is a template, not working credentials:

```dotenv
YOUTUBE_API_KEY=YOUR_YOUTUBE_DATA_API_KEY
YOUTUBE_CLIENT_ID=YOUR_OAUTH_WEB_CLIENT_ID
YOUTUBE_CLIENT_SECRET=YOUR_OAUTH_WEB_CLIENT_SECRET
SOURCE_CHANNEL_ID=YOUR_SOURCE_CHANNEL_ID
TARGET_CHANNEL_ID=YOUR_TARGET_CHANNEL_ID
ADMIN_PASSWORD=REPLACE_WITH_YOUR_GENERATED_ADMIN_PASSWORD
TARGET_REFRESH_TOKEN=
APP_URL=http://localhost:3000
PORT=3000
CHECK_INTERVAL_MINUTES=5
UPLOAD_PRIVACY=private
```

`.env` is ignored by Git. Keep real values there, rather than filling them into the tracked `.env.example`. Required empty or placeholder credentials prevent startup. Run:

```sh
npm start
```

Open [the local dashboard](http://localhost:3000). Sign in with username **`admin`** and the `ADMIN_PASSWORD` you generated. For a hosted deployment, open your own `APP_URL` instead. The setup page should show that upload authorization is still needed.

## 6. Authorize the target channel and get your refresh token

1. Check that the redirect URI from step 2D matches the `APP_URL` of the instance you are using.
2. Sign in to your dashboard and open `/setup` on that same site; locally this is [http://localhost:3000/setup](http://localhost:3000/setup).
3. Click **Authorize Target Channel**. Sign in with the Google account for your target channel and choose the correct channel if Google offers a channel selector. Grant both requested permissions.
4. The software checks the account's channel against `TARGET_CHANNEL_ID`. After successful authorization, the authenticated callback displays a refresh token.
5. Copy that token into `TARGET_REFRESH_TOKEN` in your private `.env` or hosting Variables settings. Do not paste it into source code or GitHub. Restart or redeploy the app, then return to the dashboard.

Keep `UPLOAD_PRIVACY=private` for initial verification. Once a refresh token is configured, the scheduler can download, process, and upload recent unprocessed source videos; the first poll can queue up to eight. **Poll Channel Now** also starts this work. Check the results in [YouTube Studio](https://studio.youtube.com/) before intentionally selecting public uploads.

Authorization uses a random, ten-minute, single-use state value, an HttpOnly browser-binding cookie, and PKCE. Complete it in the same browser against the same running server instance. Restarting the app during authorization invalidates pending setup; begin again if it expires. No refresh token is written to source files or logs. Run one instance because the app uses a local JSON database and in-memory OAuth state and login throttling.

## Deploy on Railway instead of running locally

1. Open [Railway](https://railway.com/) and deploy this GitHub repository, using branch **`master`** for the current application.
2. Open your service's **Variables** tab and add the values from step 4 privately. Leave `TARGET_REFRESH_TOKEN` empty until you complete authorization. See [Railway's Variables guide](https://docs.railway.com/variables).
3. Under the service's **Settings → Networking → Public Networking**, choose **Generate Domain**, or configure your own domain. See [Railway's domain guide](https://docs.railway.com/networking/domains/working-with-domains).
4. Set `APP_URL` to the exact `https://` origin Railway gives you. Let Railway supply its service `PORT`; the local port `3000` does not need to be copied into hosting settings.
5. Add that origin plus `/auth/callback` to your Google web client's Authorized redirect URIs. Apply the variables and deploy. `Nixpacks.toml` defines Node.js, FFmpeg, lockfile installation, and the start command.
6. Open the hosted dashboard, log in as `admin`, and complete step 6 above. Save the resulting refresh token in Railway Variables and redeploy.

Use `/healthz` as the service health-check path. For persistent job history, mount a private volume and point `DB_PATH` to a file within it; for example, if mounted at `/data`, use `/data/state.json`. Do not commit runtime data. The dashboard remains password protected when the source repository is public. Use HTTPS in production because the dashboard uses HTTP Basic authentication; plain HTTP is allowed only on localhost.

## Optional settings

| Variable | Default | What to configure |
| --- | --- | --- |
| `UPLOAD_PRIVACY` | `private` | Choose `private`, `unlisted`, or `public` |
| `CHECK_INTERVAL_MINUTES` | `5` | Cron minute step; use a whole number from 1 to 59 |
| `CLIP_SEGMENTS` | `8` | Positive number of segments per video |
| `REVERSE_CLIP_CHANCE` | `0.4` | Chance of reversing each segment |
| `SPEED_MIN` / `SPEED_MAX` | `0.97` / `1.03` | Per-segment speed range |
| `AUDIO_PITCH_SHIFT` | `1` | Pitch shift in semitones |
| `ENABLE_HORIZONTAL_FLIP` | `false` | Set to `true` to mirror the video |
| `PROCESSING_TEMP_DIR` | OS temporary directory plus `ytr` | Writable private scratch directory |
| `DB_PATH` | `data/state.json` in the project | Writable private state file; use persistent storage on hosting |

The current `server.js` pipeline outputs MP4 and always applies its color correction. `OUTPUT_FORMAT` and `ENABLE_COLOR_CORRECTION` are listed in the example for the separate `processor.js` module; they do not change those behaviors in the running server.

The dashboard, status API, controls, setup, and OAuth callback require authentication. `/healthz` is the only unauthenticated endpoint and returns only a health flag. API writes require the `X-Requested-With: YTReposter` header; browser requests must also come from `APP_URL`.

## Setup troubleshooting

| Problem | What to check |
| --- | --- |
| App exits with a required-variable or password error | Fill every required variable from step 4, replace placeholders, and use an admin password of at least 32 characters. Restart after editing. |
| `redirect_uri_mismatch` during Google login | Match Google's Authorized redirect URI exactly to `APP_URL` plus `/auth/callback`, including the scheme and port. |
| Google blocks a test account | Add the target channel's Google account to your OAuth app's Test users, and check Audience/Data Access settings. |
| Authorization fails after Google consent | Check the client ID and secret belong to the same web client, grant both scopes, and choose the account/channel matching `TARGET_CHANNEL_ID`. |
| Invalid or expired authorization | Start again from `/setup` in the same browser within ten minutes; do not restart the app mid-flow. |
| Authorization stops working after several days | Check Google's seven-day refresh-token rule for external apps in Testing; review the linked production guidance and reauthorize as needed. |
| API reads or uploads fail | Check YouTube Data API v3 is enabled, key restrictions, your [API usage and quotas](https://console.cloud.google.com/apis/dashboard), and the target account's authorization. |
| Uploads stay private despite your setting | YouTube restricts uploads from certain unverified API projects to private until an API compliance audit; see the [official upload reference](https://developers.google.com/youtube/v3/docs/videos/insert). |
| Video processing fails locally | Confirm `ffmpeg` and `ffprobe` are on `PATH`, source videos are accessible, and temporary storage is writable. |

If changing `TARGET_CHANNEL_ID` or OAuth clients, clear the old `TARGET_REFRESH_TOKEN` and authorize the new target through `/setup` again. Upload authorization belongs to the account that granted the token.

## Security and verification

Credentials previously committed to this repository must be revoked or rotated before making it public. Deleting `.env` in a new commit does not remove older versions. Follow [SECURITY.md](SECURITY.md) before changing visibility.

```sh
npm test
npm run check:secrets
npm audit --omit=dev
```

The secret check examines the Git index, so stage intended changes first; it rejects environment files, common credential files, and recognizable tokens without printing their contents. CI repeats the tests, secret checks, and dependency audit. Pattern scanning cannot prove that every possible secret is absent.
