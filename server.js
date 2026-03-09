'use strict';
require('dotenv').config();

const express = require('express');
const cron = require('node-cron');

// Flat imports — all files at root level
const { getLatestVideos, getSetupAuthUrl, exchangeCode } = require('./youtube');
const { runJob, getActive } = require('./runner');
const db = require('./db');

const app = express();
app.set('strict routing', false);
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
// Redirect trailing slashes so /setup/ works same as /setup
app.use((req, res, next) => {
  if (req.path !== '/' && req.path.endsWith('/')) {
    const query = req.url.slice(req.path.length);
    return res.redirect(301, req.path.slice(0, -1) + query);
  }
  next();
});

const PORT = process.env.PORT || 3000;
const SOURCE_CH = process.env.SOURCE_CHANNEL_ID || 'REMOVED_CREDENTIAL';
const TARGET_CH = process.env.TARGET_CHANNEL_ID || 'REMOVED_CREDENTIAL';
const SETUP_SECRET = process.env.SETUP_SECRET || 'REMOVED_CREDENTIAL';
const INTERVAL = Math.max(1, parseInt(process.env.CHECK_INTERVAL_MINUTES) || 5);

// ── Polling ───────────────────────────────────────────────────────────────────

let polling = false;

async function pollAndQueue() {
  if (polling) return { newVideos: 0, note: 'busy' };
  polling = true;
  try {
    const videos = await getLatestVideos(8);
    let added = 0;
    for (const v of videos) {
      if (!(await db.isProcessed(v.videoId))) {
        const ok = await db.enqueue(v);
        if (ok) { added++; runJob(v).catch((e) => console.error('[Poll]', e.message)); }
      }
    }
    await db.touchPolled();
    return { newVideos: added, total: videos.length };
  } finally { polling = false; }
}

// ── Cron ──────────────────────────────────────────────────────────────────────

cron.schedule(`*/${INTERVAL} * * * *`, () => {
  const tokenOk = process.env.TARGET_REFRESH_TOKEN && process.env.TARGET_REFRESH_TOKEN !== 'PASTE_REFRESH_TOKEN_AFTER_SETUP';
  if (!tokenOk) { console.log('[Cron] Skipping — token not set'); return; }
  console.log('[Cron] Polling...');
  pollAndQueue().catch((e) => console.error('[Cron]', e.message));
});

// ── API ───────────────────────────────────────────────────────────────────────

app.get('/api/status', async (req, res) => {
  const [stats, queue, jobs] = await Promise.all([db.getStats(), db.getQueue(), db.getJobs(20)]);
  const tokenOk = !!(process.env.TARGET_REFRESH_TOKEN && process.env.TARGET_REFRESH_TOKEN !== 'PASTE_REFRESH_TOKEN_AFTER_SETUP');
  res.json({ ok: true, tokenConfigured: tokenOk, sourceChannel: SOURCE_CH, targetChannel: TARGET_CH, stats, queue, jobs, activeJobs: getActive(), config: { intervalMins: INTERVAL, segments: process.env.CLIP_SEGMENTS || 8, reverseChance: process.env.REVERSE_CLIP_CHANCE || 0.4, pitchShift: process.env.AUDIO_PITCH_SHIFT || 1, flip: process.env.ENABLE_HORIZONTAL_FLIP || 'false', outputFormat: process.env.OUTPUT_FORMAT || 'mp4' } });
});

app.post('/api/poll', async (req, res) => {
  try { res.json({ ok: true, ...(await pollAndQueue()) }); }
  catch (e) { res.status(500).json({ ok: false, error: e.message }); }
});

app.delete('/api/queue/:id', async (req, res) => { await db.dequeue(req.params.id); res.json({ ok: true }); });

// ── OAuth ─────────────────────────────────────────────────────────────────────

app.get('/setup', (req, res) => {
  if (req.query.s !== SETUP_SECRET) return res.send('<body style="font:14px monospace;background:#111;color:#fff;padding:2rem"><h2>🔒 Add ?s=YOUR_SETUP_SECRET to the URL</h2></body>');
  const tokenOk = !!(process.env.TARGET_REFRESH_TOKEN && process.env.TARGET_REFRESH_TOKEN !== 'PASTE_REFRESH_TOKEN_AFTER_SETUP');
  const secretOk = !!(process.env.YOUTUBE_CLIENT_SECRET && process.env.YOUTUBE_CLIENT_SECRET !== 'YOUR_CLIENT_SECRET_HERE');
  const authUrl = secretOk ? getSetupAuthUrl() : null;
  res.send(`<!DOCTYPE html><html><head><title>Setup</title>
<link href="https://fonts.googleapis.com/css2?family=Space+Mono:wght@400;700&display=swap" rel="stylesheet">
<style>*{box-sizing:border-box;margin:0;padding:0}body{font-family:'Space Mono',monospace;background:#050508;color:#e8e8f0;padding:2rem}
h1{font-size:1.8rem;color:#fff;margin-bottom:.3rem}h2{font-size:.9rem;margin:2rem 0 .75rem;color:#aaa;text-transform:uppercase;letter-spacing:.12em}
.card{background:#0d0d14;border:1px solid rgba(80,80,160,.25);border-radius:10px;padding:1.25rem;margin-bottom:.75rem}
.row{display:flex;align-items:center;gap:.75rem;margin-bottom:.6rem;flex-wrap:wrap;font-size:.78rem}
label{min-width:200px;color:#888;font-size:.68rem;text-transform:uppercase;letter-spacing:.1em}
code{background:#1a1a2e;padding:.2rem .5rem;border-radius:4px;font-size:.75rem;color:#00e5ff;word-break:break-all}
.ok{background:rgba(0,255,136,.1);border:1px solid rgba(0,255,136,.3);color:#00ff88;padding:.2rem .6rem;border-radius:4px;font-size:.65rem}
.err{background:rgba(255,51,102,.1);border:1px solid rgba(255,51,102,.3);color:#ff3366;padding:.2rem .6rem;border-radius:4px;font-size:.65rem}
.warn{background:rgba(255,136,0,.1);border:1px solid rgba(255,136,0,.3);color:#ff8800;padding:.2rem .6rem;border-radius:4px;font-size:.65rem}
.btn{display:inline-block;padding:.7rem 1.4rem;background:#5b3fff;color:#fff;text-decoration:none;border-radius:7px;font-family:'Space Mono',monospace;font-size:.78rem;margin-top:.5rem}
p{font-size:.78rem;color:#888;line-height:1.7;margin-top:.5rem}
ol{margin:.5rem 0 0 1.2rem;font-size:.78rem;color:#888;line-height:2.2}
a{color:#00e5ff}</style></head><body>
<h1>⚙️ YT Reposter Setup</h1>
<p style="color:#888;font-size:.75rem;margin-top:.25rem">Source: ${SOURCE_CH} → Target: ${TARGET_CH}</p>

<h2>1. Credential Status</h2>
<div class="card">
  <div class="row"><label>YouTube API Key</label><span class="ok">✓ Set</span></div>
  <div class="row"><label>OAuth Client ID</label><span class="ok">✓ Set</span></div>
  <div class="row"><label>OAuth Client Secret</label><span class="${secretOk ? 'ok' : 'err'}">${secretOk ? '✓ Set' : '✗ MISSING'}</span></div>
  <div class="row"><label>Target Refresh Token</label><span class="${tokenOk ? 'ok' : 'warn'}">${tokenOk ? '✓ Set' : '⚠ Not set yet'}</span></div>
  ${!secretOk ? '<p style="color:#ff8800">Set <code>YOUTUBE_CLIENT_SECRET</code> in Railway → Variables, then redeploy.</p>' : ''}
</div>

<h2>2. Add Redirect URI in Google Cloud</h2>
<div class="card">
  <p>Go to <a href="https://console.cloud.google.com/apis/credentials" target="_blank">Google Cloud Console</a> → OAuth 2.0 Client IDs → your client → add Authorized Redirect URI:</p>
  <code style="display:block;margin-top:.5rem;padding:.75rem">${process.env.APP_URL || 'https://YOUR-APP.railway.app'}/auth/callback</code>
</div>

<h2>3. Authorize Target Channel</h2>
<div class="card">
  <p>Click below and sign in with the Google account that owns channel <code>${TARGET_CH}</code>.</p>
  ${authUrl ? `<a href="${authUrl}" class="btn">🔑 Authorize Target Channel →</a>` : '<p style="color:#ff8800">Set YOUTUBE_CLIENT_SECRET first.</p>'}
  ${tokenOk ? '<p style="color:#00ff88;margin-top:.75rem">✅ Already authorized!</p>' : ''}
</div>

<p style="margin-top:2rem"><a href="/" style="color:#5b3fff">← Dashboard</a></p>
</body></html>`);
});

app.get('/auth/callback', async (req, res) => {
  if (!req.query.code) return res.status(400).send('Missing code');
  try {
    const tokens = await exchangeCode(req.query.code);
    res.send(`<!DOCTYPE html><html><head><title>Success</title>
<link href="https://fonts.googleapis.com/css2?family=Space+Mono:wght@400;700&display=swap" rel="stylesheet">
<style>*{box-sizing:border-box;margin:0;padding:0}body{font-family:'Space Mono',monospace;background:#050508;color:#e8e8f0;padding:2rem}
h2{color:#00ff88;margin-bottom:1rem}code{display:block;word-break:break-all;background:#111;padding:1rem;border-radius:8px;color:#00e5ff;font-size:.8rem;margin:.5rem 0}
.warn{background:rgba(255,136,0,.08);border:1px solid rgba(255,136,0,.3);color:#ff8800;padding:1rem;border-radius:8px;font-size:.82rem;margin-top:1rem}
ol{margin:.75rem 0 0 1.2rem;line-height:2.4}a{color:#5b3fff}</style></head><body>
<h2>✅ Authorized Successfully!</h2>
<p style="color:#888;font-size:.82rem;margin-bottom:.5rem">Your refresh token (copy this):</p>
<code>${tokens.refresh_token || 'No refresh token — re-authorize with prompt=consent'}</code>
<div class="warn"><strong>Next steps:</strong><ol>
<li>Copy the token above</li>
<li>Railway → your project → Variables</li>
<li>Set <code style="background:#1a1a0a;padding:.1rem .4rem;border-radius:3px;display:inline">TARGET_REFRESH_TOKEN</code> = token above</li>
<li>Railway redeploys automatically — you're live! 🎉</li>
</ol></div>
<p style="margin-top:1.5rem"><a href="/">← Dashboard</a></p>
</body></html>`);
  } catch (e) { res.status(500).send(`<pre style="color:red;padding:2rem">${e.message}</pre>`); }
});

// ── Dashboard ─────────────────────────────────────────────────────────────────

app.get('/', (req, res) => {
  res.send(`<!DOCTYPE html>
<html lang="en"><head>
<meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>YT Reposter — KingSlayer</title>
<link href="https://fonts.googleapis.com/css2?family=Space+Mono:wght@400;700&family=Bebas+Neue&display=swap" rel="stylesheet">
<style>
*,*::before,*::after{box-sizing:border-box;margin:0;padding:0}
:root{--bg:#050508;--s1:#0d0d14;--s2:#13131e;--b:rgba(80,80,160,.2);--b2:rgba(80,80,160,.4);
--acc:#5b3fff;--acc2:#00e5ff;--green:#00ff88;--red:#ff3366;--orange:#ff8800;
--txt:#e8e8f0;--muted:rgba(232,232,240,.45)}
html,body{height:100%}
body{background:var(--bg);color:var(--txt);font-family:'Space Mono',monospace;font-size:13px;overflow-x:hidden;min-height:100vh}
body::before{content:'';position:fixed;inset:0;pointer-events:none;z-index:0;
background:radial-gradient(ellipse 70% 45% at 15% -5%,rgba(91,63,255,.13) 0%,transparent 60%),
radial-gradient(ellipse 50% 35% at 90% 105%,rgba(0,229,255,.07) 0%,transparent 50%)}
.gbg{position:fixed;inset:0;z-index:0;pointer-events:none;
background-image:linear-gradient(rgba(80,80,160,.055) 1px,transparent 1px),linear-gradient(90deg,rgba(80,80,160,.055) 1px,transparent 1px);
background-size:40px 40px}
.wrap{position:relative;z-index:1;max-width:1280px;margin:0 auto;padding:1.75rem 1.5rem}
.hdr{display:flex;align-items:flex-start;justify-content:space-between;gap:1rem;margin-bottom:2rem;flex-wrap:wrap}
.logo{font-family:'Bebas Neue',sans-serif;font-size:3rem;letter-spacing:.07em;line-height:1;
background:linear-gradient(130deg,#fff 0%,var(--acc2) 55%,var(--acc) 100%);
-webkit-background-clip:text;-webkit-text-fill-color:transparent}
.tagline{color:var(--muted);font-size:.63rem;letter-spacing:.18em;text-transform:uppercase;margin-top:.2rem}
.hdr-r{display:flex;flex-direction:column;align-items:flex-end;gap:.4rem}
.pill{display:inline-flex;align-items:center;gap:.4rem;padding:.35rem .85rem;border-radius:100px;
font-size:.6rem;letter-spacing:.1em;text-transform:uppercase;border:1px solid}
.p-green{background:rgba(0,255,136,.07);border-color:rgba(0,255,136,.3);color:var(--green)}
.p-warn{background:rgba(255,136,0,.07);border-color:rgba(255,136,0,.3);color:var(--orange)}
.p-red{background:rgba(255,51,102,.07);border-color:rgba(255,51,102,.3);color:var(--red)}
.dot{width:6px;height:6px;border-radius:50%;background:currentColor;animation:blink 2s ease-in-out infinite}
@keyframes blink{0%,100%{opacity:1;transform:scale(1)}50%{opacity:.4;transform:scale(.7)}}
.chbar{display:flex;align-items:center;gap:.75rem;flex-wrap:wrap;background:var(--s1);
border:1px solid var(--b);border-radius:10px;padding:.65rem 1rem;margin-bottom:1.4rem;font-size:.68rem}
.chtag{display:flex;align-items:center;gap:.4rem;padding:.22rem .6rem;border-radius:5px}
.chsrc{background:rgba(255,0,0,.1);border:1px solid rgba(255,80,80,.25);color:#ff8888}
.chtgt{background:rgba(91,63,255,.12);border:1px solid rgba(91,63,255,.3);color:#aa88ff}
.arrow{color:var(--muted);font-size:1.1rem}
.stats{display:grid;grid-template-columns:repeat(auto-fit,minmax(155px,1fr));gap:.85rem;margin-bottom:1.4rem}
.stat{background:var(--s1);border:1px solid var(--b);border-radius:10px;padding:1rem 1rem .8rem;
position:relative;overflow:hidden;transition:border-color .2s}
.stat::after{content:'';position:absolute;top:0;left:0;right:0;height:2px;background:var(--lc,var(--acc))}
.stat:hover{border-color:var(--b2)}
.slbl{font-size:.57rem;letter-spacing:.18em;text-transform:uppercase;color:var(--muted);margin-bottom:.35rem}
.sval{font-family:'Bebas Neue',sans-serif;font-size:2.5rem;letter-spacing:.04em;line-height:1}
.ctrl{display:flex;gap:.55rem;margin-bottom:1.4rem;flex-wrap:wrap}
.btn{padding:.52rem 1rem;border-radius:7px;font-family:'Space Mono',monospace;font-size:.67rem;
letter-spacing:.07em;text-transform:uppercase;cursor:pointer;border:1px solid;transition:all .18s;
display:inline-flex;align-items:center;gap:.4rem;text-decoration:none}
.bpri{background:var(--acc);border-color:var(--acc);color:#fff}
.bpri:hover{background:#7055ff;border-color:#7055ff}
.bsec{background:transparent;border-color:var(--b2);color:var(--txt)}
.bsec:hover{border-color:var(--acc2);color:var(--acc2)}
.bwarn{background:transparent;border-color:rgba(255,136,0,.5);color:var(--orange)}
.bwarn:hover{background:rgba(255,136,0,.07)}
.btn:disabled{opacity:.4;cursor:not-allowed}
.spin{width:11px;height:11px;border:2px solid transparent;border-top-color:currentColor;
border-radius:50%;animation:spin .65s linear infinite;display:inline-block}
@keyframes spin{to{transform:rotate(360deg)}}
.panels{display:grid;grid-template-columns:1fr 1.6fr;gap:1rem;margin-bottom:1rem}
@media(max-width:800px){.panels{grid-template-columns:1fr}}
.panel{background:var(--s1);border:1px solid var(--b);border-radius:10px;overflow:hidden}
.ph{display:flex;align-items:center;justify-content:space-between;padding:.7rem 1rem;border-bottom:1px solid var(--b)}
.phtitle{font-size:.58rem;letter-spacing:.2em;text-transform:uppercase;color:var(--muted)}
.badge{background:var(--s2);border:1px solid var(--b);border-radius:100px;padding:.1rem .5rem;font-size:.58rem;color:var(--acc2)}
.pb{padding:.55rem;max-height:370px;overflow-y:auto}
.pb::-webkit-scrollbar{width:3px}
.pb::-webkit-scrollbar-thumb{background:var(--b2);border-radius:2px}
.item{padding:.6rem .7rem;border-radius:7px;border:1px solid var(--b);margin-bottom:.38rem;
background:var(--s2);transition:border-color .18s}
.item:hover{border-color:var(--b2)}
.ititle{font-size:.72rem;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;margin-bottom:.25rem}
.imeta{display:flex;align-items:center;gap:.4rem;flex-wrap:wrap}
.vid{font-size:.57rem;color:var(--muted)}
.stag{font-size:.55rem;letter-spacing:.08em;text-transform:uppercase;padding:.1rem .42rem;border-radius:3px}
.s-pending{background:rgba(255,136,0,.12);color:var(--orange)}
.s-downloading{background:rgba(0,229,255,.09);color:var(--acc2)}
.s-processing{background:rgba(91,63,255,.13);color:#aa8fff}
.s-uploading{background:rgba(0,229,255,.09);color:var(--acc2)}
.s-completed{background:rgba(0,255,136,.09);color:var(--green)}
.s-failed{background:rgba(255,51,102,.1);color:var(--red)}
.ilog{font-size:.57rem;color:var(--muted);margin-top:.28rem;font-style:italic;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.ierr{font-size:.57rem;color:var(--red);margin-top:.22rem;opacity:.85}
.pbar{height:2px;background:var(--s1);border-radius:2px;margin-top:.38rem;overflow:hidden}
.pfill{height:100%;background:linear-gradient(90deg,var(--acc),var(--acc2));border-radius:2px;transition:width .4s}
.pfill.live{animation:pglow 1.2s ease-in-out infinite}
@keyframes pglow{0%,100%{opacity:.6}50%{opacity:1}}
.empty{text-align:center;padding:2.5rem 1rem;color:var(--muted);font-size:.7rem}
.eico{font-size:2rem;margin-bottom:.6rem;opacity:.3}
.mods{background:var(--s1);border:1px solid var(--b);border-radius:10px;padding:.85rem 1rem;margin-bottom:1rem}
.mlbl{font-size:.57rem;letter-spacing:.2em;text-transform:uppercase;color:var(--muted);margin-bottom:.6rem}
.mtags{display:flex;gap:.35rem;flex-wrap:wrap}
.mtag{font-size:.6rem;padding:.22rem .55rem;background:rgba(91,63,255,.09);border:1px solid rgba(91,63,255,.2);border-radius:5px;color:#aa88ff}
.banner{display:flex;align-items:center;justify-content:space-between;gap:1rem;
background:rgba(255,136,0,.07);border:1px solid rgba(255,136,0,.3);border-radius:10px;
padding:.8rem 1rem;margin-bottom:1.4rem;flex-wrap:wrap}
.banner p{font-size:.72rem;color:var(--orange)}
.banner a{font-size:.67rem;padding:.38rem .85rem;border-radius:6px;background:var(--orange);color:#000;text-decoration:none;font-weight:700;white-space:nowrap}
#toast{position:fixed;bottom:1.5rem;right:1.5rem;z-index:100;background:var(--s2);
border:1px solid var(--b2);border-radius:8px;padding:.7rem 1rem;font-size:.72rem;
transform:translateY(80px) scale(.95);opacity:0;transition:all .25s;pointer-events:none;max-width:300px}
#toast.show{transform:translateY(0) scale(1);opacity:1}
.footer{text-align:center;margin-top:1.5rem;font-size:.57rem;color:rgba(232,232,240,.18);letter-spacing:.14em}
</style></head>
<body>
<div class="gbg"></div>
<div class="wrap">

<div class="hdr">
  <div>
    <div class="logo">YT REPOSTER</div>
    <div class="tagline">@KingSlayer · Auto-Upload · Copyright Bypass</div>
  </div>
  <div class="hdr-r">
    <div id="sysPill" class="pill p-warn"><div class="dot"></div>Loading...</div>
    <div id="lastPoll" style="font-size:.57rem;color:var(--muted)">—</div>
  </div>
</div>

<div id="setupBanner" class="banner" style="display:none">
  <p>⚠️ Target channel not authorized — uploads paused. Complete setup first.</p>
  <a href="/setup?s=${SETUP_SECRET}">Complete Setup →</a>
</div>

<div class="chbar">
  <span style="font-size:.57rem;color:var(--muted);text-transform:uppercase;letter-spacing:.18em">Flow</span>
  <div class="chtag chsrc">▶ @kingslayeroffical <span style="opacity:.45;margin-left:.3rem">[SOURCE]</span></div>
  <span class="arrow">→ process →</span>
  <div class="chtag chtgt">▶ ${TARGET_CH} <span style="opacity:.45;margin-left:.3rem">[TARGET]</span></div>
  <span style="margin-left:auto;font-size:.6rem;color:var(--muted)">auto-poll every ${INTERVAL}m</span>
</div>

<div class="stats">
  <div class="stat" style="--lc:var(--acc)"><div class="slbl">Processed</div><div class="sval" id="sProc" style="color:#fff">0</div></div>
  <div class="stat" style="--lc:var(--green)"><div class="slbl">Uploaded</div><div class="sval" id="sUp" style="color:var(--green)">0</div></div>
  <div class="stat" style="--lc:var(--orange)"><div class="slbl">In Queue</div><div class="sval" id="sQ" style="color:var(--orange)">0</div></div>
  <div class="stat" style="--lc:var(--red)"><div class="slbl">Failed</div><div class="sval" id="sFail" style="color:var(--red)">0</div></div>
</div>

<div class="ctrl">
  <button class="btn bpri" onclick="pollNow()" id="btnPoll">⟳ Poll Channel Now</button>
  <button class="btn bsec" onclick="load()" id="btnRefresh">↻ Refresh</button>
  <a href="/setup?s=${SETUP_SECRET}" class="btn bwarn">⚙ Setup</a>
</div>

<div class="mods">
  <div class="mlbl">Active Modifications</div>
  <div class="mtags" id="modTags">
    <span class="mtag">✂ 8 Segments</span><span class="mtag">🔀 Shuffle</span>
    <span class="mtag">⏪ Reversal 40%</span><span class="mtag">⚡ Speed ±3%</span>
    <span class="mtag">🎵 Pitch +1st</span><span class="mtag">🎨 Color</span>
    <span class="mtag">🔧 Noise</span><span class="mtag">✂ Crop</span><span class="mtag">📦 H.264</span>
  </div>
</div>

<div class="panels">
  <div class="panel">
    <div class="ph"><span class="phtitle">Processing Queue</span><span class="badge" id="qBadge">0</span></div>
    <div class="pb" id="qList"><div class="empty"><div class="eico">📭</div>Queue empty</div></div>
  </div>
  <div class="panel">
    <div class="ph"><span class="phtitle">Job History</span><span class="badge" id="jBadge">0</span></div>
    <div class="pb" id="jList"><div class="empty"><div class="eico">📋</div>No jobs yet</div></div>
  </div>
</div>

<div class="footer">YT REPOSTER · RAILWAY · POLLS EVERY ${INTERVAL} MINUTES</div>
</div>
<div id="toast"></div>

<script>
function toast(msg,col){const e=document.getElementById('toast');e.textContent=msg;e.style.borderColor=col||'rgba(80,80,160,.5)';e.classList.add('show');clearTimeout(e._t);e._t=setTimeout(()=>e.classList.remove('show'),3000)}
function stag(s){return \`<span class="stag s-\${s}">\${s}</span>\`}
function pbar(pct,live){return \`<div class="pbar"><div class="pfill \${live?'live':''}" style="width:\${pct}%"></div></div>\`}

async function load(){
  const btn=document.getElementById('btnRefresh');
  btn.innerHTML='<span class="spin"></span>';btn.disabled=true;
  try{
    const d=await(await fetch('/api/status')).json();
    render(d);
  }catch(e){toast('Error: '+e.message,'var(--red)');
  }finally{btn.textContent='↻ Refresh';btn.disabled=false}
}

function render(d){
  const pill=document.getElementById('sysPill');
  pill.className='pill '+(d.tokenConfigured?'p-green':'p-warn');
  pill.innerHTML='<div class="dot"></div>'+(d.tokenConfigured?'System Ready':'Setup Needed');
  document.getElementById('setupBanner').style.display=d.tokenConfigured?'none':'flex';
  if(d.stats?.lastPolled) document.getElementById('lastPoll').textContent='Last poll: '+new Date(d.stats.lastPolled).toLocaleTimeString();
  document.getElementById('sProc').textContent=d.stats?.processed??0;
  document.getElementById('sUp').textContent=d.stats?.uploaded??0;
  document.getElementById('sQ').textContent=d.stats?.queueLen??0;
  document.getElementById('sFail').textContent=d.stats?.failed??0;

  const act=d.activeJobs||{};
  const q=d.queue||[];
  document.getElementById('qBadge').textContent=q.length;
  const qEl=document.getElementById('qList');
  if(!q.length){qEl.innerHTML='<div class="empty"><div class="eico">📭</div>Queue empty — poll to check</div>';}
  else qEl.innerHTML=q.map(v=>{
    const aj=act[v.videoId];const pct=aj?.percent??0;
    const live=['downloading','processing','uploading'].includes(v.status)&&aj;
    const log=aj?.log?.slice(-1)[0]||'';
    return \`<div class="item">
      <div class="ititle">\${v.title||v.videoId}</div>
      <div class="imeta"><span class="vid">\${v.videoId}</span>\${stag(v.status)}</div>
      \${log?'<div class="ilog">'+log+'</div>':''}
      \${v.error?'<div class="ierr">'+v.error.slice(0,80)+'</div>':''}
      \${live?pbar(pct,true):v.status==='completed'?pbar(100,false):''}
    </div>\`;
  }).join('');

  const jobs=d.jobs||[];
  document.getElementById('jBadge').textContent=jobs.length;
  const jEl=document.getElementById('jList');
  if(!jobs.length){jEl.innerHTML='<div class="empty"><div class="eico">📋</div>No jobs yet</div>';}
  else jEl.innerHTML=jobs.map(j=>\`<div class="item">
    <div class="ititle">\${j.title||j.videoId}</div>
    <div class="imeta">
      <span class="vid">\${j.videoId}</span>
      \${j.uploadedId?'<a href="https://youtu.be/'+j.uploadedId+'" target="_blank" style="font-size:.57rem;color:var(--acc2)">→ youtu.be/'+j.uploadedId+'</a>':''}
      \${stag(j.status)}
    </div>
    \${j.error?'<div class="ierr">'+j.error.slice(0,80)+'</div>':''}
    \${j.status==='completed'?pbar(100,false):''}
  </div>\`).join('');

  if(d.config){document.getElementById('modTags').innerHTML=
    ['✂ '+d.config.segments+' Segments','🔀 Shuffle','⏪ Reversal '+(d.config.reverseChance*100).toFixed(0)+'%','⚡ Speed ±3%',
     '🎵 Pitch +'+d.config.pitchShift+'st','🎨 Color','🔧 Noise','✂ Crop','📦 '+String(d.config.outputFormat||'mp4').toUpperCase(),
     d.config.flip==='true'?'↔ Flip':null].filter(Boolean).map(t=>'<span class="mtag">'+t+'</span>').join('')}
}

async function pollNow(){
  const btn=document.getElementById('btnPoll');
  btn.innerHTML='<span class="spin"></span> Polling...';btn.disabled=true;
  try{
    const d=await(await fetch('/api/poll',{method:'POST'})).json();
    toast(d.newVideos>0?'✅ '+d.newVideos+' new video(s) queued!':'✓ No new videos',d.newVideos>0?'var(--green)':undefined);
    setTimeout(load,1500);
  }catch(e){toast('Error: '+e.message,'var(--red)');
  }finally{btn.innerHTML='⟳ Poll Channel Now';btn.disabled=false}
}

load();
setInterval(load,12000);
</script>
</body></html>`);
});

// ── Start ─────────────────────────────────────────────────────────────────────

app.listen(PORT, () => {
  console.log(`
╔══════════════════════════════════════════════════╗
║     YouTube Auto-Reposter v2.1 — Railway         ║
╠══════════════════════════════════════════════════╣
║  URL:     http://localhost:${PORT}                   ║
║  Source:  REMOVED_CREDENTIAL               ║
║  Target:  REMOVED_CREDENTIAL               ║
║  Poll:    every ${INTERVAL} minutes                        ║
╚══════════════════════════════════════════════════╝
  `);
});
