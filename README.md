# 🎬 YouTube Auto-Reposter — Railway Deployment

Single-server deployment. Everything runs on Railway: dashboard, cron polling, FFmpeg processing, and YouTube upload.

---

## 🔑 Your Pre-Configured Credentials

| Key | Value |
|-----|-------|
| YouTube API Key | `REMOVED_CREDENTIAL` |
| OAuth Client ID | `REMOVED_CREDENTIAL` |
| Source Channel | `REMOVED_CREDENTIAL` (@kingslayeroffical) |
| Target Channel | `REMOVED_CREDENTIAL` |

---

## 🚀 Deploy in 5 Steps

### Step 1 — Push to GitHub
```bash
git init
git add .
git commit -m "initial"
git remote add origin https://github.com/YOUR_USERNAME/yt-reposter.git
git push -u origin main
```

### Step 2 — Deploy on Railway
1. Go to [railway.app](https://railway.app) → **New Project** → **Deploy from GitHub**
2. Select your repo
3. Railway auto-detects `nixpacks.toml` and installs FFmpeg ✅

### Step 3 — Add Environment Variables
In Railway → your project → **Variables**, add:

```
YOUTUBE_API_KEY         = REMOVED_CREDENTIAL
YOUTUBE_CLIENT_ID       = REMOVED_CREDENTIAL
YOUTUBE_CLIENT_SECRET   = [GET FROM GOOGLE CLOUD - see Step 4]
SOURCE_CHANNEL_ID       = REMOVED_CREDENTIAL
TARGET_CHANNEL_ID       = REMOVED_CREDENTIAL
TARGET_REFRESH_TOKEN    = [GET FROM SETUP PAGE - see Step 5]
APP_URL                 = https://YOUR-APP.railway.app
SETUP_SECRET            = REMOVED_CREDENTIAL
CHECK_INTERVAL_MINUTES  = 5
UPLOAD_PRIVACY          = public
```

### Step 4 — Get OAuth Client Secret
1. Go to [console.cloud.google.com](https://console.cloud.google.com)
2. APIs & Services → **Credentials**
3. Find your OAuth 2.0 Client → click it → copy **Client Secret**
4. Add to Railway as `YOUTUBE_CLIENT_SECRET`
5. Also add `https://YOUR-APP.railway.app/auth/callback` to **Authorized Redirect URIs**

### Step 5 — Authorize Target Channel
1. Visit `https://YOUR-APP.railway.app/setup?s=REMOVED_CREDENTIAL`
2. Click **"Authorize Target Channel"**
3. Sign in with the Google account that owns channel `REMOVED_CREDENTIAL`
4. Copy the `refresh_token` shown
5. Add it to Railway as `TARGET_REFRESH_TOKEN`
6. Railway auto-redeploys — **you're live!** 🎉

---

## 🎬 How It Works

```
Every 5 minutes:
  ↓ Poll @kingslayeroffical for new videos
  ↓ If new video found → add to queue
  ↓ Download video
  ↓ Split into 8 segments
  ↓ Shuffle segment order
  ↓ Randomly reverse 40% of clips
  ↓ Apply ±3% speed variation per clip
  ↓ Concatenate segments
  ↓ Apply pitch shift (+1 semitone)
  ↓ Apply color correction + noise overlay
  ↓ Re-encode H.264 with new parameters
  ↓ Upload to REMOVED_CREDENTIAL
```

---

## 📊 Dashboard
Visit your Railway URL to see real-time queue, job history, and controls.

---

## ⚙️ Customise Processing

Edit Railway Variables:

| Variable | Default | Effect |
|----------|---------|--------|
| `CLIP_SEGMENTS` | `8` | More = more scrambled |
| `REVERSE_CLIP_CHANCE` | `0.4` | 0–1, % clips reversed |
| `SPEED_MIN` / `SPEED_MAX` | `0.97` / `1.03` | Speed variation range |
| `AUDIO_PITCH_SHIFT` | `1` | Semitones to shift pitch |
| `ENABLE_HORIZONTAL_FLIP` | `false` | Mirror video |
| `UPLOAD_PRIVACY` | `public` | `public`/`unlisted`/`private` |
