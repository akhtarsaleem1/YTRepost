// lib/processor.js — FFmpeg copyright-bypass pipeline
'use strict';
require('dotenv').config();
const ffmpeg = require('fluent-ffmpeg');
const path = require('path');
const fs = require('fs-extra');
const { v4: uuidv4 } = require('uuid');

const TEMP_DIR = process.env.PROCESSING_TEMP_DIR || '/tmp/yt-reposter';

// ═══════════════════════════════════════════════════════════════
//  MAIN PIPELINE
// ═══════════════════════════════════════════════════════════════

async function processVideo(inputPath, onProgress) {
  const jobId = uuidv4().slice(0, 8);
  const workDir = path.join(TEMP_DIR, `job_${jobId}`);
  await fs.ensureDir(workDir);

  const cfg = {
    segments: parseInt(process.env.CLIP_SEGMENTS) || 8,
    reverseChance: parseFloat(process.env.REVERSE_CLIP_CHANCE) || 0.4,
    speedMin: parseFloat(process.env.SPEED_MIN) || 0.97,
    speedMax: parseFloat(process.env.SPEED_MAX) || 1.03,
    pitchShift: parseInt(process.env.AUDIO_PITCH_SHIFT) || 1,
    enableFlip: process.env.ENABLE_HORIZONTAL_FLIP === 'true',
    enableColor: process.env.ENABLE_COLOR_CORRECTION !== 'false',
    outputFormat: process.env.OUTPUT_FORMAT || 'mp4',
  };

  const log = (msg) => { console.log(`[Processor:${jobId}] ${msg}`); onProgress?.(msg); };

  try {
    // Step 1 — probe
    log('Probing video...');
    const meta = await probe(inputPath);
    log(`Duration: ${meta.duration.toFixed(1)}s  |  ${meta.width}×${meta.height}`);

    // Step 2 — split
    log(`Splitting into ${cfg.segments} segments...`);
    const segPaths = await splitSegments(inputPath, workDir, cfg.segments, meta.duration, log);

    // Step 3 — modify each segment
    log('Modifying segments (reverse / speed)...');
    const modPaths = [];
    for (let i = 0; i < segPaths.length; i++) {
      log(`  Segment ${i + 1}/${segPaths.length}`);
      modPaths.push(await modifySegment(segPaths[i], workDir, i, cfg));
    }

    // Step 4 — shuffle
    const shuffled = fisherYates(modPaths);
    log('Shuffled segment order');

    // Step 5 — concat
    log('Concatenating segments...');
    const concatPath = path.join(workDir, `concat.mp4`);
    await concatenate(shuffled, concatPath);

    // Step 6 — final pass
    log('Applying final pass (pitch, color, noise, crop)...');
    const finalPath = path.join(TEMP_DIR, `final_${jobId}.${cfg.outputFormat}`);
    await finalPass(concatPath, finalPath, cfg, (pct) => onProgress?.(`Final pass: ${pct}%`));

    log(`✅ Complete → ${finalPath}`);
    await fs.remove(workDir);
    return finalPath;

  } catch (err) {
    await fs.remove(workDir).catch(() => {});
    throw err;
  }
}

// ═══════════════════════════════════════════════════════════════
//  STEP 1 — PROBE
// ═══════════════════════════════════════════════════════════════

function probe(filePath) {
  return new Promise((resolve, reject) => {
    ffmpeg.ffprobe(filePath, (err, meta) => {
      if (err) return reject(err);
      const v = meta.streams.find((s) => s.codec_type === 'video') || {};
      const fps = v.r_frame_rate
        ? v.r_frame_rate.split('/').reduce((a, b) => a / b)
        : 30;
      resolve({
        duration: parseFloat(meta.format.duration),
        width: v.width || 1920,
        height: v.height || 1080,
        fps,
      });
    });
  });
}

// ═══════════════════════════════════════════════════════════════
//  STEP 2 — SPLIT INTO SEGMENTS
// ═══════════════════════════════════════════════════════════════

async function splitSegments(input, workDir, n, duration, log) {
  const segDur = duration / n;
  const paths = [];
  for (let i = 0; i < n; i++) {
    const outPath = path.join(workDir, `seg_${String(i).padStart(3, '0')}.mp4`);
    await new Promise((resolve, reject) => {
      ffmpeg(input)
        .setStartTime(i * segDur)
        .setDuration(segDur)
        .outputOptions(['-c:v libx264', '-c:a aac', '-avoid_negative_ts make_zero', '-reset_timestamps 1'])
        .output(outPath)
        .on('end', resolve)
        .on('error', reject)
        .run();
    });
    paths.push(outPath);
  }
  return paths;
}

// ═══════════════════════════════════════════════════════════════
//  STEP 3 — MODIFY EACH SEGMENT
// ═══════════════════════════════════════════════════════════════

async function modifySegment(segPath, workDir, idx, cfg) {
  const outPath = path.join(workDir, `mod_${String(idx).padStart(3, '0')}.mp4`);
  const doReverse = Math.random() < cfg.reverseChance;
  const speed = cfg.speedMin + Math.random() * (cfg.speedMax - cfg.speedMin);
  const atempo = clampAtempo(1 / speed);

  const vFilter = [`setpts=${(1 / speed).toFixed(4)}*PTS`];
  const aFilter = [`atempo=${atempo.toFixed(4)}`];

  if (doReverse) {
    vFilter.unshift('vreverse');
    aFilter.unshift('areverse');
  }

  await new Promise((resolve, reject) => {
    ffmpeg(segPath)
      .videoFilters(vFilter)
      .audioFilters(aFilter)
      .outputOptions(['-c:v libx264', '-c:a aac', '-preset fast'])
      .output(outPath)
      .on('end', resolve)
      .on('error', reject)
      .run();
  });

  return outPath;
}

// ═══════════════════════════════════════════════════════════════
//  STEP 5 — CONCATENATE
// ═══════════════════════════════════════════════════════════════

async function concatenate(paths, outputPath) {
  const listFile = outputPath + '.txt';
  await fs.writeFile(listFile, paths.map((p) => `file '${p}'`).join('\n'));
  await new Promise((resolve, reject) => {
    ffmpeg()
      .input(listFile)
      .inputOptions(['-f concat', '-safe 0'])
      .outputOptions(['-c:v libx264', '-c:a aac', '-movflags +faststart'])
      .output(outputPath)
      .on('end', resolve)
      .on('error', reject)
      .run();
  });
  await fs.remove(listFile);
}

// ═══════════════════════════════════════════════════════════════
//  STEP 6 — FINAL PASS
// ═══════════════════════════════════════════════════════════════

async function finalPass(input, output, cfg, onPct) {
  const vFilters = [];
  const aFilters = [];

  if (cfg.enableFlip) vFilters.push('hflip');
  if (cfg.enableColor) vFilters.push('eq=brightness=0.02:contrast=1.03:saturation=1.05');

  // Slight crop to change spatial fingerprint
  vFilters.push('crop=iw*0.99:ih*0.99');
  vFilters.push('scale=iw:ih:flags=lanczos');

  // Subtle noise overlay
  vFilters.push('noise=alls=3:allf=t');

  // Pitch shift via asetrate
  if (cfg.pitchShift !== 0) {
    const factor = Math.pow(2, cfg.pitchShift / 12);
    aFilters.push(`asetrate=44100*${factor.toFixed(5)}`);
    aFilters.push(`atempo=${clampAtempo(1 / factor).toFixed(5)}`);
    aFilters.push('aresample=44100');
  }

  await new Promise((resolve, reject) => {
    const cmd = ffmpeg(input);
    if (vFilters.length) cmd.videoFilters(vFilters);
    if (aFilters.length) cmd.audioFilters(aFilters);
    cmd
      .outputOptions([
        '-c:v libx264', '-crf 23', '-preset medium',
        '-c:a aac', '-b:a 192k', '-movflags +faststart',
        '-x264-params keyint=48:min-keyint=48',
      ])
      .output(output)
      .on('progress', (p) => { if (p.percent) onPct?.(Math.round(p.percent)); })
      .on('end', resolve)
      .on('error', reject)
      .run();
  });
}

// ═══════════════════════════════════════════════════════════════
//  DOWNLOAD
// ═══════════════════════════════════════════════════════════════

async function downloadVideo(videoId, onProgress) {
  const ytdl = require('@distube/ytdl-core');
  const downloadDir = path.join(TEMP_DIR, 'downloads');
  await fs.ensureDir(downloadDir);
  const outPath = path.join(downloadDir, `${videoId}_${Date.now()}.mp4`);

  return new Promise((resolve, reject) => {
    let downloaded = 0;
    let total = 0;

    const stream = ytdl(`https://www.youtube.com/watch?v=${videoId}`, {
      quality: 'highestvideo',
      filter: 'audioandvideo',
    });

    stream.on('response', (res) => {
      total = parseInt(res.headers['content-length'] || '0');
    });

    stream.on('data', (chunk) => {
      downloaded += chunk.length;
      if (total > 0) onProgress?.(`Downloading: ${Math.round((downloaded / total) * 100)}%`);
    });

    stream.pipe(fs.createWriteStream(outPath));
    stream.on('end', () => resolve(outPath));
    stream.on('error', reject);
  });
}

// ═══════════════════════════════════════════════════════════════
//  HELPERS
// ═══════════════════════════════════════════════════════════════

function clampAtempo(v) { return Math.max(0.5, Math.min(2.0, v)); }

function fisherYates(arr) {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

module.exports = { processVideo, downloadVideo };
