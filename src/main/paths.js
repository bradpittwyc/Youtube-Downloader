'use strict';
/**
 * 路径解析：区分「开发运行」与「打包后运行」两种环境下的内置二进制位置。
 */
const path = require('path');
const fs = require('fs');
const { app } = require('electron');

let cachedBinDir = null;

/** 内置二进制目录（yt-dlp.exe / ffmpeg.exe 所在目录） */
function binDir() {
  if (cachedBinDir) return cachedBinDir;
  const candidates = [];
  if (app.isPackaged) {
    // extraResources -> resources/bin
    candidates.push(path.join(process.resourcesPath, 'bin'));
    candidates.push(path.join(path.dirname(process.execPath), 'resources', 'bin'));
  } else {
    candidates.push(path.join(app.getAppPath(), 'resources', 'bin'));
  }
  for (const c of candidates) {
    if (fs.existsSync(c)) {
      cachedBinDir = c;
      return cachedBinDir;
    }
  }
  cachedBinDir = candidates[0];
  return cachedBinDir;
}

/** 解析某个内置可执行文件；带 overridePath 时优先使用用户自定义路径 */
function resolveBin(filename, overridePath) {
  if (overridePath && String(overridePath).trim()) {
    const p = String(overridePath).trim();
    if (fs.existsSync(p)) return p;
  }
  const p = path.join(binDir(), filename);
  return fs.existsSync(p) ? p : null;
}

function ytDlpPath(settings) {
  return resolveBin('yt-dlp.exe', settings && settings.ytDlpPath);
}

function ffmpegPath(settings) {
  return resolveBin('ffmpeg.exe', settings && settings.ffmpegPath);
}

/** ffmpeg 所在目录（yt-dlp 用 --ffmpeg-location 接收目录或文件路径） */
function ffmpegDir(settings) {
  const p = ffmpegPath(settings);
  return p ? path.dirname(p) : null;
}

function userDataDir() {
  return app.getPath('userData');
}

function ensureDir(dir) {
  try {
    fs.mkdirSync(dir, { recursive: true });
  } catch (_) {
    /* ignore */
  }
  return dir;
}

/** 已下载记录文件（yt-dlp --download-archive），用于跨会话跳过重复下载 */
function archiveFile() {
  return path.join(ensureDir(userDataDir()), 'download-archive.txt');
}

function queueFile() {
  return path.join(ensureDir(userDataDir()), 'queue.json');
}

function settingsFile() {
  return path.join(ensureDir(userDataDir()), 'settings.json');
}

function cacheDir() {
  return ensureDir(path.join(userDataDir(), 'channel-cache'));
}

module.exports = {
  binDir,
  resolveBin,
  ytDlpPath,
  ffmpegPath,
  ffmpegDir,
  userDataDir,
  ensureDir,
  archiveFile,
  queueFile,
  settingsFile,
  cacheDir,
};
