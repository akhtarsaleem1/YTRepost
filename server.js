// server.js — Single Railway deployment: Dashboard + API + Worker + Cron
'use strict';
require('dotenv').config();

const express = require('express');
const cron = require('node-cron');
const path = require('path');
const fs = require('fs-extra');

const { getLatestVideos, getSetupAuthUrl, exchangeCodeForTokens } = require('./lib/youtube');
const { runJob, getAllActiveJobs } = require('./lib/runner');
const db = require('./lib/db');

const app = express();
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

const PORT = process.env.PORT || 3000;
const SOURCE_CH = process.env.SOURCE_CHANNEL_ID || 'UCZkLRWVabarmwiTvAneP_eQ';
const TARGET_CH = process.env.TARGET_CHANNEL_ID || 'UC2HKQFf-HDw8UGGlIyW95kA';

// ══════════════════════════════════════════════════════════════════════════════
//  POLLING LOGIC
// ══════════════════════════════════════════════════════════════════════════════

let isPolling = false;

async function pollAndQueue() {
  if (isPolling) return { newVideos: 0, note: 'already_running' };
  isPolling = true;
  try {
    const videos = await getLatestVideos(8);
    let newCount = 0;
    for (const v of videos) {
      if (!(await db.isProcessed(v.videoId))) {
        const added = await db.enqueue(v);
        if (added) {
          newCount++;
          // Fire and forget — don't await so multiple can queue
          runJob(v).catch((e) => console.error('[Server] Job error:', e.message));
        }
      }
    }
    await db.touchPolled();
    if (newCount) console.log(`[Cron] Queued ${newCount} new video(s)`);
    return { newVideos: newCount, total: videos.length };
  } finally {
    isPolling = false;
  }
}

// ══════════════════════════════════════════════════════════════════════════════
//  CRON — every N minutes
// ══════════════════════════════════════════════════════════════════════════════

const intervalMins = Math.max(1, parseInt(process.env.CHECK_INTERVAL_MINUTES) || 5);
cron.schedule(`*/${intervalMins} * * * *`, () => {
  if (!process.env.TARGET_REFRESH_TOKEN || process.env.TARGET_REFRESH_TOKEN === 'PASTE_REFRESH_TOKEN_AFTER_SETUP') {
    console.log('[Cron] Skipping — TARGET_REFRESH_TOKEN not set');
    return;
  }
  console.log('[Cron] Polling source channel...');
  pollAndQueue().catch((e) => console.error('[Cron]', e.message));
});

// ══════════════════════════════════════════════════════════════════════════════
//  API ROUTES
// ══════════════════════════════════════════════════════════════════════════════

// Status
app.get('/api/status', async (req, res) => {
  const [stats, queue, jobs] = await Promise.all([
    db.getStats(),
    db.getQueue(),
    db.getJobs(20),
  ]);
  res.json({
    ok: true,
    tokenConfigured: !!(process.env.TARGET_REFRESH_TOKEN && process.env.TARGET_REFRESH_TOKEN !== 'PASTE_REFRESH_TOKEN_AFTER_SETUP'),
    sourceChannel: SOURCE_CH,
    targetChannel: TARGET_CH,
    stats,
    queue,
    jobs,
    activeJobs: getAllActiveJobs(),
    config: {
      intervalMins,
      segments: process.env.CLIP_SEGMENTS || 8,
      reverseChance: process.env.REVERSE_CLIP_CHANCE || 0.4,
      pitchShift: process.env.AUDIO_PITCH_SHIFT || 1,
      flip: process.env.ENABLE_HORIZONTAL_FLIP || 'false',
      outputFormat: process.env.OUTPUT_FORMAT || 'mp4',
    },
  });
});

// Manual poll trigger
app.post('/api/poll', async (req, res) => {
  try {
    const result = await pollAndQueue();
    res.json({ ok: true, ...result });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

// Retry a failed job
app.post('/api/retry/:videoId', async (req, res) => {
  const { videoId } = req.params;
  try {
    const queue = await db.getQueue();
    const item = queue.find((v) => v.videoId === videoId);
    if (!item) return res.status(404).json({ ok: false, error: 'Not in queue' });
    await db.updateQueue(videoId, { status: 'pending', error: null });
    runJob(item).catch((e) => console.error('[Retry]', e.message));
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

// Remove from queue
app.delete('/api/queue/:videoId', async (req, res) => {
  await db.dequeue(req.params.videoId);
  res.json({ ok: true });
});

// Live log stream for a job
app.get('/api/log/:videoId', (req, res) => {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');

  const send = () => {
    const active = getAllActiveJobs();
    const job = active[req.params.videoId];
    if (job) res.write(`data: ${JSON.stringify(job)}\n\n`);
  };

  const timer = setInterval(send, 1000);
  req.on('close', () => clearInterval(timer));
});

// ══════════════════════════════════════════════════════════════════════════════
//  OAUTH SETUP ROUTES
// ══════════════════════════════════════════════════════════════════════════════

app.get('/setup', (req, res) => {
  const secret = req.query.s;
  if (secret !== process.env.SETUP_SECRET) {
    return res.send(`
      <html><body style="font:14px monospace;background:#0a0a0a;color:#fff;padding:2rem">
        <h2>🔒 Setup Page</h2>
        <p style="color:#888">Add <code>?s=YOUR_SETUP_SECRET</code> to the URL to access setup.</p>
        <p style="color:#888">Your SETUP_SECRET is set in environment variables.</p>
      </body></html>`);
  }

  const tokenConfigured = !!(process.env.TARGET_REFRESH_TOKEN && 
    process.env.TARGET_REFRESH_TOKEN !== 'PASTE_REFRESH_TOKEN_AFTER_SETUP');
  const clientSecretSet = !!(process.env.YOUTUBE_CLIENT_SECRET && 
    process.env.YOUTUBE_CLIENT_SECRET !== 'YOUR_CLIENT_SECRET_HERE');
  const authUrl = clientSecretSet ? getSetupAuthUrl() : null;

  res.send(`<!DOCTYPE html>
<html><head>
  <title>YT Reposter — Setup</title>
  <link href="https://fonts.googleapis.com/css2?family=Space+Mono:wght@400;700&display=swap" rel="stylesheet">
  <style>
    *{box-sizing:border-box;margin:0;padding:0}
    body{font-family:'Space Mono',monospace;background:#050508;color:#e8e8f0;padding:2rem;min-height:100vh}
    h1{font-size:1.8rem;margin-bottom:0.5rem;color:#fff}
    h2{font-size:1rem;margin:2rem 0 1rem;color:#aaa;letter-spacing:.1em;text-transform:uppercase}
    .card{background:#0d0d14;border:1px solid rgba(80,80,160,.25);border-radius:12px;padding:1.5rem;margin-bottom:1rem}
    .row{display:flex;align-items:center;gap:1rem;margin-bottom:.75rem;flex-wrap:wrap}
    label{font-size:.7rem;color:#888;text-transform:uppercase;letter-spacing:.1em;min-width:180px}
    code{background:#1a1a2e;padding:.2rem .5rem;border-radius:4px;font-size:.8rem;color:#00e5ff;word-break:break-all}
    .tag{padding:.2rem .6rem;border-radius:4px;font-size:.65rem;letter-spacing:.08em;text-transform:uppercase}
    .ok{background:rgba(0,255,136,.1);color:#00ff88;border:1px solid rgba(0,255,136,.3)}
    .warn{background:rgba(255,136,0,.1);color:#ff8800;border:1px solid rgba(255,136,0,.3)}
    .err{background:rgba(255,51,102,.1);color:#ff3366;border:1px solid rgba(255,51,102,.3)}
    .btn{display:inline-block;padding:.7rem 1.5rem;background:#5b3fff;color:#fff;text-decoration:none;border-radius:8px;font-family:'Space Mono',monospace;font-size:.8rem;letter-spacing:.05em;margin-top:.5rem}
    .btn:hover{background:#7055ff}
    p{font-size:.8rem;color:#888;line-height:1.6;margin-top:.5rem}
    ol{margin:.5rem 0 0 1.2rem;font-size:.8rem;color:#888;line-height:2}
  </style>
</head><body>
  <h1>⚙️ YT Reposter Setup</h1>
  <p style="color:#888;font-size:.8rem">Source: @kingslayeroffical → Target: ${TARGET_CH}</p>

  <h2>1. Credentials Check</h2>
  <div class="card">
    <div class="row"><label>YouTube API Key</label><span class="tag ok">✓ Configured</span></div>
    <div class="row"><label>OAuth Client ID</label><span class="tag ok">✓ Configured</span></div>
    <div class="row"><label>OAuth Client Secret</label>
      <span class="tag ${clientSecretSet ? 'ok' : 'err'}">${clientSecretSet ? '✓ Configured' : '✗ MISSING'}</span>
    </div>
    <div class="row"><label>Target Refresh Token</label>
      <span class="tag ${tokenConfigured ? 'ok' : 'warn'}">${tokenConfigured ? '✓ Configured' : '⚠ Not Set'}</span>
    </div>
    ${!clientSecretSet ? `<p style="color:#ff8800;margin-top:.5rem">
      ⚠️ Set YOUTUBE_CLIENT_SECRET in Railway → Variables.<br>
      Get it from <a href="https://console.cloud.google.com/apis/credentials" style="color:#00e5ff">Google Cloud Console</a> → OAuth 2.0 Client IDs → your client → Client Secret.
    </p>` : ''}
  </div>

  <h2>2. Authorize Target Channel</h2>
  <div class="card">
    <p>Click below to authorize your <strong>target channel</strong> (${TARGET_CH}) to receive uploads. 
    Sign in with the Google account that owns the target channel.</p>
    ${authUrl
      ? `<a href="${authUrl}" class="btn">🔑 Authorize Target Channel →</a>`
      : `<p style="color:#ff8800;margin-top:.75rem">Set YOUTUBE_CLIENT_SECRET first, then refresh this page.</p>`
    }
    ${tokenConfigured ? '<p style="color:#00ff88;margin-top:.75rem">✅ Target channel is already authorized.</p>' : ''}
  </div>

  <h2>3. Add OAuth Redirect URI</h2>
  <div class="card">
    <p>In Google Cloud Console → Credentials → your OAuth client, add this Authorized Redirect URI:</p>
    <code>${process.env.APP_URL || 'https://YOUR-APP.railway.app'}/auth/callback</code>
  </div>

  <h2>Config Values</h2>
  <div class="card">
    <div class="row"><label>Source Channel</label><code>${SOURCE_CH}</code></div>
    <div class="row"><label>Target Channel</label><code>${TARGET_CH}</code></div>
    <div class="row"><label>Poll Interval</label><code>every ${intervalMins} minutes</code></div>
    <div class="row"><label>Clip Segments</label><code>${process.env.CLIP_SEGMENTS || 8}</code></div>
    <div class="row"><label>Reverse Chance</label><code>${(parseFloat(process.env.REVERSE_CLIP_CHANCE || 0.4) * 100).toFixed(0)}%</code></div>
    <div class="row"><label>Pitch Shift</label><code>+${process.env.AUDIO_PITCH_SHIFT || 1} semitone(s)</code></div>
    <div class="row"><label>Output Format</label><code>${process.env.OUTPUT_FORMAT || 'mp4'}</code></div>
  </div>

  <p style="margin-top:2rem"><a href="/" style="color:#5b3fff">← Back to Dashboard</a></p>
</body></html>`);
});

app.get('/auth/callback', async (req, res) => {
  const { code } = req.query;
  if (!code) return res.status(400).send('Missing code');
  try {
    const tokens = await exchangeCodeForTokens(code);
    res.send(`<!DOCTYPE html>
<html><head>
  <title>OAuth Success</title>
  <link href="https://fonts.googleapis.com/css2?family=Space+Mono:wght@400;700&display=swap" rel="stylesheet">
  <style>*{box-sizing:border-box}body{font-family:'Space Mono',monospace;background:#050508;color:#e8e8f0;padding:2rem}
  h2{color:#00ff88;font-size:1.5rem;margin-bottom:1rem}
  .box{background:#0d0d14;border:1px solid rgba(0,255,136,.2);border-radius:12px;padding:1.5rem;margin:1rem 0}
  code{display:block;word-break:break-all;color:#00e5ff;font-size:.8rem;margin:.5rem 0;background:#111;padding:1rem;border-radius:8px}
  .warn{background:rgba(255,136,0,.1);border:1px solid rgba(255,136,0,.3);color:#ff8800;padding:1rem;border-radius:8px;font-size:.8rem;margin-top:1rem}
  ol{margin:.5rem 0 0 1.2rem;line-height:2.2;font-size:.85rem;color:#aaa}</style>
</head><body>
  <h2>✅ Authorization Successful!</h2>
  <div class="box">
    <p style="font-size:.8rem;color:#aaa;margin-bottom:.5rem">Your refresh token:</p>
    <code>${tokens.refresh_token || 'N/A — check full tokens below'}</code>
  </div>
  <div class="warn">
    <strong>⚠️ Next step:</strong>
    <ol>
      <li>Copy the refresh token above</li>
      <li>Go to Railway → your project → Variables</li>
      <li>Set <code style="background:#1a1a0a;padding:.1rem .4rem;border-radius:3px">TARGET_REFRESH_TOKEN</code> = the token above</li>
      <li>Railway will auto-redeploy — you're done! 🎉</li>
    </ol>
  </div>
  <details style="margin-top:1.5rem"><summary style="cursor:pointer;color:#888;font-size:.75rem">Full token response</summary>
    <code style="margin-top:.5rem">${JSON.stringify(tokens, null, 2)}</code>
  </details>
  <p style="margin-top:2rem"><a href="/" style="color:#5b3fff">← Dashboard</a></p>
</body></html>`);
  } catch (err) {
    res.status(500).send(`<pre style="color:red;background:#111;padding:1rem">${err.message}</pre>`);
  }
});

// ══════════════════════════════════════════════════════════════════════════════
//  DASHBOARD — Single-page HTML app
// ══════════════════════════════════════════════════════════════════════════════

app.get('/', (req, res) => {
  res.send(`<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>YT Reposter — KingSlayer Dashboard</title>
  <link href="https://fonts.googleapis.com/css2?family=Space+Mono:ital,wght@0,400;0,700;1,400&family=Bebas+Neue&display=swap" rel="stylesheet">
  <style>
    *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
    :root {
      --bg: #050508; --s1: #0d0d14; --s2: #13131e; --s3: #18182a;
      --b: rgba(80,80,160,.22); --b2: rgba(80,80,160,.4);
      --acc: #5b3fff; --acc2: #00e5ff; --acc3: #b44fff;
      --green: #00ff88; --red: #ff3366; --orange: #ff8800; --yellow: #ffe066;
      --txt: #e8e8f0; --muted: rgba(232,232,240,.45);
    }
    html, body { height: 100%; }
    body {
      background: var(--bg); color: var(--txt);
      font-family: 'Space Mono', monospace; font-size: 13px;
      overflow-x: hidden; min-height: 100vh;
    }
    body::before {
      content: ''; position: fixed; inset: 0; pointer-events: none; z-index: 0;
      background:
        radial-gradient(ellipse 70% 45% at 15% -5%, rgba(91,63,255,.13) 0%, transparent 60%),
        radial-gradient(ellipse 50% 35% at 90% 105%, rgba(0,229,255,.07) 0%, transparent 50%),
        radial-gradient(ellipse 40% 30% at 80% 15%, rgba(180,79,255,.06) 0%, transparent 50%);
    }
    .grid-bg {
      position: fixed; inset: 0; z-index: 0; pointer-events: none;
      background-image: linear-gradient(rgba(80,80,160,.055) 1px, transparent 1px),
                        linear-gradient(90deg, rgba(80,80,160,.055) 1px, transparent 1px);
      background-size: 40px 40px;
    }
    .wrap { position: relative; z-index: 1; max-width: 1280px; margin: 0 auto; padding: 1.75rem 1.5rem; }

    /* ── Header ─────────────────────────────────────────────── */
    .hdr { display: flex; align-items: flex-start; justify-content: space-between; gap: 1rem; margin-bottom: 2rem; flex-wrap: wrap; }
    .logo { font-family: 'Bebas Neue', sans-serif; font-size: 3rem; letter-spacing: .07em; line-height: 1;
      background: linear-gradient(130deg, #fff 0%, var(--acc2) 55%, var(--acc) 100%);
      -webkit-background-clip: text; -webkit-text-fill-color: transparent; }
    .tagline { color: var(--muted); font-size: .65rem; letter-spacing: .18em; text-transform: uppercase; margin-top: .2rem; }

    .hdr-right { display: flex; flex-direction: column; align-items: flex-end; gap: .4rem; }
    .pill { display: inline-flex; align-items: center; gap: .4rem; padding: .35rem .85rem; border-radius: 100px;
      font-size: .62rem; letter-spacing: .1em; text-transform: uppercase; border: 1px solid; }
    .pill-green { background: rgba(0,255,136,.07); border-color: rgba(0,255,136,.3); color: var(--green); }
    .pill-red   { background: rgba(255,51,102,.07); border-color: rgba(255,51,102,.3); color: var(--red); }
    .pill-warn  { background: rgba(255,136,0,.07);  border-color: rgba(255,136,0,.3);  color: var(--orange); }
    .dot { width: 6px; height: 6px; border-radius: 50%; background: currentColor; animation: blink 2s ease-in-out infinite; }
    @keyframes blink { 0%,100%{opacity:1;transform:scale(1)} 50%{opacity:.4;transform:scale(.75)} }

    /* ── Channel bar ─────────────────────────────────────────── */
    .ch-bar {
      display: flex; align-items: center; gap: .75rem; flex-wrap: wrap;
      background: var(--s1); border: 1px solid var(--b); border-radius: 10px;
      padding: .7rem 1.1rem; margin-bottom: 1.5rem; font-size: .68rem;
    }
    .ch-tag { display: flex; align-items: center; gap: .4rem; padding: .25rem .65rem; border-radius: 6px; }
    .ch-src { background: rgba(255,0,0,.1); border: 1px solid rgba(255,80,80,.25); color: #ff8888; }
    .ch-tgt { background: rgba(91,63,255,.12); border: 1px solid rgba(91,63,255,.3); color: #aa88ff; }
    .arrow { color: var(--muted); font-size: 1.1rem; }

    /* ── Stats ───────────────────────────────────────────────── */
    .stats { display: grid; grid-template-columns: repeat(auto-fit, minmax(160px, 1fr)); gap: .9rem; margin-bottom: 1.5rem; }
    .stat {
      background: var(--s1); border: 1px solid var(--b); border-radius: 10px;
      padding: 1.1rem 1.1rem .9rem; position: relative; overflow: hidden; transition: border-color .2s;
    }
    .stat::after { content: ''; position: absolute; top: 0; left: 0; right: 0; height: 2px; background: var(--line-color, var(--acc)); }
    .stat:hover { border-color: var(--b2); }
    .stat-lbl { font-size: .58rem; letter-spacing: .18em; text-transform: uppercase; color: var(--muted); margin-bottom: .4rem; }
    .stat-val { font-family: 'Bebas Neue', sans-serif; font-size: 2.6rem; letter-spacing: .04em; line-height: 1; }

    /* ── Controls ────────────────────────────────────────────── */
    .ctrl { display: flex; gap: .6rem; margin-bottom: 1.5rem; flex-wrap: wrap; }
    .btn {
      padding: .55rem 1.1rem; border-radius: 7px; font-family: 'Space Mono', monospace;
      font-size: .68rem; letter-spacing: .07em; text-transform: uppercase;
      cursor: pointer; border: 1px solid; transition: all .18s;
      display: inline-flex; align-items: center; gap: .4rem;
    }
    .btn-pri  { background: var(--acc); border-color: var(--acc); color: #fff; }
    .btn-pri:hover  { background: #7055ff; border-color: #7055ff; }
    .btn-sec  { background: transparent; border-color: var(--b2); color: var(--txt); }
    .btn-sec:hover  { border-color: var(--acc2); color: var(--acc2); }
    .btn-warn { background: transparent; border-color: rgba(255,136,0,.5); color: var(--orange); }
    .btn-warn:hover { background: rgba(255,136,0,.08); }
    .btn:disabled { opacity: .45; cursor: not-allowed; }
    .spin { width: 11px; height: 11px; border: 2px solid transparent; border-top-color: currentColor; border-radius: 50%; animation: spin .65s linear infinite; display: inline-block; }
    @keyframes spin { to { transform: rotate(360deg); } }

    /* ── Main panels ─────────────────────────────────────────── */
    .panels { display: grid; grid-template-columns: 1fr 1.6fr; gap: 1.1rem; margin-bottom: 1.1rem; }
    @media(max-width:800px) { .panels { grid-template-columns: 1fr; } }
    .panel { background: var(--s1); border: 1px solid var(--b); border-radius: 10px; overflow: hidden; }
    .ph { display: flex; align-items: center; justify-content: space-between; padding: .75rem 1.1rem; border-bottom: 1px solid var(--b); }
    .ph-title { font-size: .6rem; letter-spacing: .2em; text-transform: uppercase; color: var(--muted); }
    .badge { background: var(--s2); border: 1px solid var(--b); border-radius: 100px; padding: .1rem .55rem; font-size: .6rem; color: var(--acc2); }
    .pb { padding: .6rem; max-height: 380px; overflow-y: auto; }
    .pb::-webkit-scrollbar { width: 3px; }
    .pb::-webkit-scrollbar-thumb { background: var(--b2); border-radius: 2px; }

    /* ── Queue / Job items ───────────────────────────────────── */
    .item {
      padding: .65rem .75rem; border-radius: 7px; border: 1px solid var(--b);
      margin-bottom: .4rem; background: var(--s2); transition: border-color .18s;
    }
    .item:hover { border-color: var(--b2); }
    .item-title { font-size: .73rem; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; margin-bottom: .28rem; }
    .item-meta { display: flex; align-items: center; gap: .4rem; flex-wrap: wrap; }
    .vid-id { font-size: .58rem; color: var(--muted); }
    .stag { font-size: .56rem; letter-spacing: .08em; text-transform: uppercase; padding: .12rem .45rem; border-radius: 3px; }
    .s-pending    { background: rgba(255,136,0,.12);  color: var(--orange); }
    .s-downloading{ background: rgba(0,229,255,.09);  color: var(--acc2); }
    .s-processing { background: rgba(91,63,255,.13);  color: #aa8fff; }
    .s-uploading  { background: rgba(0,229,255,.09);  color: var(--acc2); }
    .s-completed  { background: rgba(0,255,136,.09);  color: var(--green); }
    .s-failed     { background: rgba(255,51,102,.1);  color: var(--red); }
    .item-log { font-size: .58rem; color: var(--muted); margin-top: .3rem; font-style: italic; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
    .item-err { font-size: .58rem; color: var(--red); margin-top: .25rem; opacity: .85; }
    .pbar { height: 2px; background: var(--s3); border-radius: 2px; margin-top: .4rem; overflow: hidden; }
    .pfill { height: 100%; background: linear-gradient(90deg, var(--acc), var(--acc2)); border-radius: 2px; transition: width .4s; }
    .pfill.anim { animation: pglow 1.2s ease-in-out infinite; }
    @keyframes pglow { 0%,100%{opacity:.6} 50%{opacity:1} }

    /* ── Empty state ─────────────────────────────────────────── */
    .empty { text-align: center; padding: 2.5rem 1rem; color: var(--muted); font-size: .7rem; }
    .empty-ico { font-size: 2rem; margin-bottom: .65rem; opacity: .35; }

    /* ── Config strip ────────────────────────────────────────── */
    .mods {
      background: var(--s1); border: 1px solid var(--b); border-radius: 10px;
      padding: .9rem 1.1rem; margin-bottom: 1.1rem;
    }
    .mods-lbl { font-size: .58rem; letter-spacing: .2em; text-transform: uppercase; color: var(--muted); margin-bottom: .65rem; }
    .mod-tags { display: flex; gap: .4rem; flex-wrap: wrap; }
    .mod-tag { font-size: .62rem; padding: .25rem .6rem; background: rgba(91,63,255,.09); border: 1px solid rgba(91,63,255,.2); border-radius: 5px; color: #aa88ff; }

    /* ── Setup banner ────────────────────────────────────────── */
    .setup-banner {
      display: flex; align-items: center; justify-content: space-between; gap: 1rem;
      background: rgba(255,136,0,.07); border: 1px solid rgba(255,136,0,.3);
      border-radius: 10px; padding: .85rem 1.1rem; margin-bottom: 1.5rem; flex-wrap: wrap;
    }
    .setup-banner p { font-size: .72rem; color: var(--orange); }
    .setup-banner a { font-size: .68rem; padding: .4rem .9rem; border-radius: 6px; background: var(--orange); color: #000; text-decoration: none; font-weight: 700; }

    .footer { text-align: center; margin-top: 1.5rem; font-size: .58rem; color: rgba(232,232,240,.18); letter-spacing: .14em; }

    /* ── Notification toast ──────────────────────────────────── */
    #toast { position: fixed; bottom: 1.5rem; right: 1.5rem; z-index: 100;
      background: var(--s2); border: 1px solid var(--b2); border-radius: 8px;
      padding: .7rem 1rem; font-size: .72rem; transform: translateY(80px) scale(.95);
      opacity: 0; transition: all .25s; pointer-events: none; max-width: 320px; }
    #toast.show { transform: translateY(0) scale(1); opacity: 1; }
  </style>
</head>
<body>
<div class="grid-bg"></div>
<div class="wrap">

  <!-- Header -->
  <div class="hdr">
    <div>
      <div class="logo">YT REPOSTER</div>
      <div class="tagline">@KingSlayer · Auto-Upload · Copyright Bypass</div>
    </div>
    <div class="hdr-right">
      <div id="systemPill" class="pill pill-warn"><div class="dot"></div>Loading...</div>
      <div id="lastPoll" style="font-size:.58rem;color:var(--muted)">—</div>
    </div>
  </div>

  <!-- Setup banner (shown if token not set) -->
  <div id="setupBanner" class="setup-banner" style="display:none">
    <p>⚠️ Target channel not authorized yet — uploads won't work until you complete setup.</p>
    <a href="/setup?s=${process.env.SETUP_SECRET || 'kingslayer_setup_2024'}">Complete Setup →</a>
  </div>

  <!-- Channel bar -->
  <div class="ch-bar">
    <span style="font-size:.58rem;color:var(--muted);letter-spacing:.18em;text-transform:uppercase">Flow</span>
    <div class="ch-tag ch-src">▶ @kingslayeroffical <span style="opacity:.5;margin-left:.3rem">[SOURCE]</span></div>
    <span class="arrow">→ process →</span>
    <div class="ch-tag ch-tgt">▶ ${TARGET_CH} <span style="opacity:.5;margin-left:.3rem">[TARGET]</span></div>
    <span style="margin-left:auto;font-size:.6rem;color:var(--muted)" id="pollInterval">every ${intervalMins}m auto</span>
  </div>

  <!-- Stats -->
  <div class="stats">
    <div class="stat" style="--line-color:var(--acc)">
      <div class="stat-lbl">Total Processed</div>
      <div class="stat-val" id="sTotal" style="color:#fff">0</div>
    </div>
    <div class="stat" style="--line-color:var(--green)">
      <div class="stat-lbl">Uploaded</div>
      <div class="stat-val" id="sUploaded" style="color:var(--green)">0</div>
    </div>
    <div class="stat" style="--line-color:var(--orange)">
      <div class="stat-lbl">In Queue</div>
      <div class="stat-val" id="sQueue" style="color:var(--orange)">0</div>
    </div>
    <div class="stat" style="--line-color:var(--red)">
      <div class="stat-lbl">Failed</div>
      <div class="stat-val" id="sFailed" style="color:var(--red)">0</div>
    </div>
  </div>

  <!-- Controls -->
  <div class="ctrl">
    <button class="btn btn-pri" onclick="pollNow()" id="btnPoll">⟳ Poll Channel Now</button>
    <button class="btn btn-sec" onclick="refreshData()" id="btnRefresh">↻ Refresh</button>
    <a href="/setup?s=${process.env.SETUP_SECRET || 'kingslayer_setup_2024'}" class="btn btn-warn" style="text-decoration:none">⚙ Setup</a>
  </div>

  <!-- Modification config -->
  <div class="mods">
    <div class="mods-lbl">Active Processing Modifications</div>
    <div class="mod-tags" id="modTags">
      <span class="mod-tag">✂ Clip Segmentation</span>
      <span class="mod-tag">🔀 Segment Shuffle</span>
      <span class="mod-tag">⏪ Random Reversal 40%</span>
      <span class="mod-tag">⚡ Speed Variation ±3%</span>
      <span class="mod-tag">🎵 Pitch Shift +1st</span>
      <span class="mod-tag">🎨 Color Correction</span>
      <span class="mod-tag">🔧 Noise Overlay</span>
      <span class="mod-tag">✂ Edge Crop 1%</span>
      <span class="mod-tag">📦 Re-encode H.264</span>
    </div>
  </div>

  <!-- Panels -->
  <div class="panels">
    <!-- Queue -->
    <div class="panel">
      <div class="ph">
        <span class="ph-title">Processing Queue</span>
        <span class="badge" id="qBadge">0</span>
      </div>
      <div class="pb" id="queueList">
        <div class="empty"><div class="empty-ico">📭</div>Queue is empty — poll to detect new videos</div>
      </div>
    </div>

    <!-- History -->
    <div class="panel">
      <div class="ph">
        <span class="ph-title">Job History</span>
        <span class="badge" id="jBadge">0</span>
      </div>
      <div class="pb" id="jobList">
        <div class="empty"><div class="empty-ico">📋</div>No completed jobs yet</div>
      </div>
    </div>
  </div>

  <div class="footer">YT REPOSTER · KINGSLAYER · POLLS EVERY ${intervalMins} MINUTES · RAILWAY DEPLOYMENT</div>
</div>

<div id="toast"></div>

<script>
let refreshTimer;

function toast(msg, color) {
  const el = document.getElementById('toast');
  el.textContent = msg;
  el.style.borderColor = color || 'rgba(80,80,160,.5)';
  el.classList.add('show');
  clearTimeout(el._t);
  el._t = setTimeout(() => el.classList.remove('show'), 3000);
}

function stag(status) {
  return \`<span class="stag s-\${status}">\${status}</span>\`;
}

function pbar(pct, active) {
  return \`<div class="pbar"><div class="pfill \${active ? 'anim' : ''}" style="width:\${pct}%"></div></div>\`;
}

async function refreshData() {
  const btn = document.getElementById('btnRefresh');
  btn.innerHTML = '<span class="spin"></span> Refreshing';
  btn.disabled = true;
  try {
    const res = await fetch('/api/status');
    const d = await res.json();
    render(d);
  } catch(e) {
    toast('Error fetching status: ' + e.message, 'var(--red)');
  } finally {
    btn.textContent = '↻ Refresh';
    btn.disabled = false;
  }
}

function render(d) {
  // System pill
  const pill = document.getElementById('systemPill');
  pill.className = 'pill ' + (d.tokenConfigured ? 'pill-green' : 'pill-warn');
  pill.innerHTML = \`<div class="dot"></div>\${d.tokenConfigured ? 'System Ready' : 'Setup Needed'}\`;

  // Setup banner
  document.getElementById('setupBanner').style.display = d.tokenConfigured ? 'none' : 'flex';

  // Last poll
  if (d.stats?.lastPolled) {
    document.getElementById('lastPoll').textContent = 'Last polled: ' + new Date(d.stats.lastPolled).toLocaleTimeString();
  }

  // Stats
  document.getElementById('sTotal').textContent    = d.stats?.processed ?? 0;
  document.getElementById('sUploaded').textContent = d.stats?.uploaded ?? 0;
  document.getElementById('sQueue').textContent    = d.stats?.queueLen ?? 0;
  document.getElementById('sFailed').textContent   = d.stats?.failed ?? 0;

  // Active jobs overlay onto queue
  const active = d.activeJobs || {};
  const queue = d.queue || [];
  document.getElementById('qBadge').textContent = queue.length;

  const qEl = document.getElementById('queueList');
  if (queue.length === 0) {
    qEl.innerHTML = '<div class="empty"><div class="empty-ico">📭</div>Queue empty — poll to detect new videos</div>';
  } else {
    qEl.innerHTML = queue.map(item => {
      const aj = active[item.videoId];
      const pct = aj?.percent ?? 0;
      const isActive = aj && ['downloading','processing','uploading'].includes(item.status);
      const lastLog = aj?.log?.slice(-1)[0] || '';
      return \`<div class="item">
        <div class="item-title">\${item.title || item.videoId}</div>
        <div class="item-meta">
          <span class="vid-id">\${item.videoId}</span>
          \${stag(item.status)}
        </div>
        \${lastLog ? \`<div class="item-log">\${lastLog}</div>\` : ''}
        \${item.error ? \`<div class="item-err">\${item.error.slice(0,90)}</div>\` : ''}
        \${isActive ? pbar(pct, true) : (item.status === 'completed' ? pbar(100, false) : '')}
      </div>\`;
    }).join('');
  }

  // Jobs history
  const jobs = d.jobs || [];
  document.getElementById('jBadge').textContent = jobs.length;

  const jEl = document.getElementById('jobList');
  if (jobs.length === 0) {
    jEl.innerHTML = '<div class="empty"><div class="empty-ico">📋</div>No completed jobs yet</div>';
  } else {
    jEl.innerHTML = jobs.map(job => \`
      <div class="item">
        <div class="item-title">\${job.title || job.videoId}</div>
        <div class="item-meta">
          <span class="vid-id">src: \${job.videoId}</span>
          \${job.uploadedId ? \`<a href="https://youtu.be/\${job.uploadedId}" target="_blank" style="font-size:.58rem;color:var(--acc2)">→ youtu.be/\${job.uploadedId}</a>\` : ''}
          \${stag(job.status)}
          \${job.elapsed ? \`<span class="vid-id">\${job.elapsed}</span>\` : ''}
        </div>
        \${job.error ? \`<div class="item-err">\${job.error.slice(0,90)}</div>\` : ''}
        \${job.status === 'completed' ? pbar(100, false) : ''}
      </div>\`).join('');
  }

  // Update mod tags from config
  if (d.config) {
    document.getElementById('modTags').innerHTML = [
      \`✂ \${d.config.segments} Segments\`,
      '🔀 Segment Shuffle',
      \`⏪ Reversal \${Math.round(d.config.reverseChance * 100)}%\`,
      '⚡ Speed ±3%',
      \`🎵 Pitch +\${d.config.pitchShift}st\`,
      '🎨 Color Correction',
      '🔧 Noise Overlay',
      '✂ Edge Crop',
      \`📦 Re-encode \${(d.config.outputFormat || 'mp4').toUpperCase()}\`,
      d.config.flip === 'true' ? '↔ Horizontal Flip' : null,
    ].filter(Boolean).map(t => \`<span class="mod-tag">\${t}</span>\`).join('');
  }
}

async function pollNow() {
  const btn = document.getElementById('btnPoll');
  btn.innerHTML = '<span class="spin"></span> Polling...';
  btn.disabled = true;
  try {
    const res = await fetch('/api/poll', { method: 'POST' });
    const d = await res.json();
    toast(d.newVideos > 0 ? \`✅ Found \${d.newVideos} new video(s)!\` : '✓ No new videos', d.newVideos > 0 ? 'var(--green)' : undefined);
    setTimeout(refreshData, 1500);
  } catch(e) {
    toast('Poll error: ' + e.message, 'var(--red)');
  } finally {
    btn.innerHTML = '⟳ Poll Channel Now';
    btn.disabled = false;
  }
}

// Auto-refresh every 12s
async function autoLoop() {
  await refreshData();
  refreshTimer = setTimeout(autoLoop, 12000);
}

autoLoop();
</script>
</body></html>`);
});

// ══════════════════════════════════════════════════════════════════════════════
//  START
// ══════════════════════════════════════════════════════════════════════════════

app.listen(PORT, () => {
  console.log(`
╔══════════════════════════════════════════════════════╗
║         YouTube Auto-Reposter — v2.0                 ║
╠══════════════════════════════════════════════════════╣
║  Dashboard:  http://localhost:${PORT}                    ║
║  Source:     UCZkLRWVabarmwiTvAneP_eQ                ║
║  Target:     UC2HKQFf-HDw8UGGlIyW95kA                ║
║  Poll every: ${intervalMins} minutes                               ║
╚══════════════════════════════════════════════════════╝
  `);
});
