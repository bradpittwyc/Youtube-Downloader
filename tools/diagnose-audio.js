'use strict';
/**
 * 诊断：不同格式选择策略下，成品文件里的音频编码是什么、能不能被常规播放器解码。
 * 背景：YouTube 在 1080p 以上常给 AV1/VP9 视频 + Opus 音频，
 *       若强行 merge 成 mp4，Opus-in-MP4 很多播放器（含剪映/WMP）解不出来 → 表现为「没有声音」。
 */
const { spawnSync } = require('child_process');
const path = require('path');
const fs = require('fs');
const os = require('os');

const BIN = path.join(__dirname, '..', 'resources', 'bin', 'yt-dlp.exe');
const FF = path.join(__dirname, '..', 'resources', 'bin', 'ffmpeg.exe');
const BASE = path.join(os.tmpdir(), 'ytdl-audio');
const URL = 'https://www.youtube.com/watch?v=5mU6SRS2Bxo'; // 36 秒短片，1080p 可用

fs.rmSync(BASE, { recursive: true, force: true });

function probe(file) {
  const r = spawnSync(FF, ['-hide_banner', '-i', file], { encoding: 'utf8', windowsHide: true });
  const text = (r.stderr || '') + (r.stdout || '');
  const streams = text
    .split(/\r?\n/)
    .filter((l) => /Stream #\d+:\d+/.test(l))
    .map((l) => l.trim().replace(/^Stream #\d+:\d+(\[[^\]]*\])?:\s*/, '').slice(0, 90));
  const hasAudio = streams.some((s) => /^Audio:/.test(s));
  const audioCodec = (streams.find((s) => /^Audio:/.test(s)) || '').match(/^Audio:\s*([a-zA-Z0-9_]+)/)?.[1] || null;
  const videoCodec = (streams.find((s) => /^Video:/.test(s)) || '').match(/^Video:\s*([a-zA-Z0-9_]+)/)?.[1] || null;
  return { hasAudio, audioCodec, videoCodec, streams, size: fs.existsSync(file) ? fs.statSync(file).size : 0 };
}

/** 真正尝试解码音频流，模拟播放器行为 */
function decodeAudio(file) {
  const r = spawnSync(FF, ['-hide_banner', '-v', 'error', '-i', file, '-vn', '-f', 'null', '-'], {
    encoding: 'utf8',
    windowsHide: true,
  });
  const err = ((r.stderr || '') + (r.stdout || '')).trim();
  return { ok: r.status === 0 && !err, err: err.slice(0, 200) };
}

function attempt(label, fmt, mergeFmt, extra = []) {
  const dir = path.join(BASE, label);
  fs.mkdirSync(dir, { recursive: true });
  const args = [
    '--ignore-config',
    '--no-warnings',
    '--no-cache-dir',
    '--encoding',
    'utf-8',
    '--newline',
    '--no-quiet',
    '--no-simulate',
    '-f',
    fmt,
    '--merge-output-format',
    mergeFmt,
    '--windows-filenames',
    '-P',
    dir,
    '-o',
    '%(title)s [%(id)s].%(ext)s',
    ...extra,
    '--no-playlist',
    URL,
  ];
  const r = spawnSync(BIN, args, { encoding: 'utf8', windowsHide: true, maxBuffer: 64 * 1024 * 1024 });
  const out = (r.stdout || '') + (r.stderr || '');
  const files = fs.readdirSync(dir).filter((f) => !f.endsWith('.part'));
  const fmtLine = out.split(/\r?\n/).find((l) => /^\[info\] .*\+.*: Downloading/.test(l)) || '';
  console.log(`\n=== ${label} ===`);
  console.log(`  选择: -f "${fmt}"  merge=${mergeFmt} ${extra.join(' ')}`);
  console.log(`  exit=${r.status}`);
  const w = out.split(/\r?\n/).find((l) => /WARNING|ERROR/.test(l));
  if (w) console.log('  yt-dlp 警告: ' + w.slice(0, 160));
  if (fmtLine) console.log('  ' + fmtLine.trim().slice(0, 160));
  for (const f of files) {
    const p = path.join(dir, f);
    const info = probe(p);
    const dec = decodeAudio(p);
    console.log(`  文件: ${f}  (${(info.size / 1048576).toFixed(2)} MB)`);
    console.log(`    视频编码: ${info.videoCodec}   音频编码: ${info.audioCodec || '(无音频流!)'}`);
    console.log(`    音频可解码: ${dec.ok ? '✅ 正常' : '❌ 失败 ' + dec.err}`);
    info.streams.forEach((s) => console.log('      · ' + s));
  }
  return files.length ? probe(path.join(dir, files[0])) : null;
}

console.log('测试视频: ' + URL);

attempt('A-当前实现(best+mp4)', 'bv*+ba/b', 'mp4');
attempt('B-仅改音频为m4a(+mp4)', 'bv*+ba[ext=m4a]/bv*+ba/b', 'mp4');
attempt('C-兼容优先(h264+aac+mp4)', 'bv*[vcodec^=avc1]+ba[ext=m4a]/bv*+ba[ext=m4a]/bv*+ba/b', 'mp4');
attempt('D-当前实现但容器mkv', 'bv*+ba/b', 'mkv');

console.log('\n提示：B/C 若音频可解码而 A 不行，即确认是 Opus-in-MP4 问题。');
