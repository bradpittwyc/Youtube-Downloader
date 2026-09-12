'use strict';
/**
 * Electron 主进程：窗口、IPC、二进制自检、频道枚举、下载队列接线。
 */
const { app, BrowserWindow, ipcMain, dialog, shell, Menu } = require('electron');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const https = require('https');

const paths = require('./paths');
const settingsStore = require('./settings');
const ytdlp = require('./ytdlp');
const channel = require('./channel');
const study = require('./study');
const studyLlm = require('./study/llm');
const secret = require('./study/secret');
const channelsStore = require('./channels-store');
const downloadsIndex = require('./downloads-index');
const queueMod = require('./queue');
const { DownloadQueue } = queueMod;

const queue = new DownloadQueue();

let mainWindow = null;
let activeEnumerate = null; // { child, canceled }

// ---------------------------------------------------------------- 单实例
const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.focus();
    }
  });
}

// ---------------------------------------------------------------- 工具函数

function sendToRenderer(channelName, payload) {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send(channelName, payload);
  }
}

async function binCheck() {
  const settings = settingsStore.load();
  const out = {
    ytdlp: { path: '', ok: false, version: '', error: '', overridden: !!settings.ytDlpPath },
    ffmpeg: { path: '', ok: false, version: '', error: '' },
    binDir: paths.binDir(),
    userData: paths.userDataDir(),
    archive: paths.archiveFile(),
  };

  const yt = paths.ytDlpPath(settings);
  if (!yt) {
    out.ytdlp.error = '内置 yt-dlp.exe 缺失';
  } else {
    out.ytdlp.path = yt;
    try {
      const r = await ytdlp.run(yt, ['--version']);
      if (r.code === 0 && r.stdout.trim()) {
        out.ytdlp.ok = true;
        out.ytdlp.version = r.stdout.trim().split(/\r?\n/)[0];
      } else {
        out.ytdlp.error = ytdlp.extractErrors(r.stderr) || 'yt-dlp 无法运行';
      }
    } catch (err) {
      out.ytdlp.error = err.message;
    }
  }

  const ff = paths.ffmpegPath(settings);
  if (!ff) {
    out.ffmpeg.error = '内置 ffmpeg.exe 缺失';
  } else {
    out.ffmpeg.path = ff;
    try {
      const r = await ytdlp.run(ff, ['-version']);
      if (r.code === 0 && r.stdout.trim()) {
        out.ffmpeg.ok = true;
        out.ffmpeg.version = r.stdout.trim().split(/\r?\n/)[0];
      } else {
        out.ffmpeg.error = 'ffmpeg 无法运行';
      }
    } catch (err) {
      out.ffmpeg.error = err.message;
    }
  }
  return out;
}

/** 下载文件（跟随重定向），带进度回调 */
function downloadFile(url, dest, onProgress, redirects = 0) {
  return new Promise((resolve, reject) => {
    if (redirects > 6) return reject(new Error('重定向次数过多'));
    const req = https.get(
      url,
      { headers: { 'User-Agent': 'youtube-downloader-desktop' }, timeout: 60000 },
      (res) => {
        if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
          res.resume();
          return resolve(downloadFile(res.headers.location, dest, onProgress, redirects + 1));
        }
        if (res.statusCode !== 200) {
          res.resume();
          return reject(new Error(`HTTP ${res.statusCode}`));
        }
        const total = Number(res.headers['content-length'] || 0);
        let received = 0;
        const tmp = dest + '.download';
        const file = fs.createWriteStream(tmp);
        res.on('data', (chunk) => {
          received += chunk.length;
          if (onProgress) onProgress({ received, total, percent: total ? received / total : 0 });
        });
        res.pipe(file);
        file.on('finish', () => {
          file.close(() => {
            try {
              fs.renameSync(tmp, dest);
              resolve({ bytes: received });
            } catch (err) {
              reject(err);
            }
          });
        });
        file.on('error', (err) => {
          try {
            fs.unlinkSync(tmp);
          } catch (_) {}
          reject(err);
        });
      }
    );
    req.on('timeout', () => {
      req.destroy(new Error('下载超时'));
    });
    req.on('error', reject);
  });
}

function channelCacheFile(base) {
  const h = crypto.createHash('sha1').update(base).digest('hex').slice(0, 16);
  return path.join(paths.cacheDir(), `${h}.json`);
}

// ---------------------------------------------------------------- IPC

/**
 * 读取系统已安装的字体族名，供字幕字体选择使用。
 *
 * 用 .NET 的 InstalledFontCollection 而不是读注册表：
 * 注册表里的值名是「Microsoft YaHei & Microsoft YaHei UI (TrueType)」这种合并串，
 * 拆起来容易出错，而且中文系统下部分中文字体根本不在 HKLM 那一项里（实测漏掉微软雅黑、宋体）。
 */
function listSystemFonts() {
  const { execFileSync } = require('child_process');
  const ps = [
    '$ErrorActionPreference="SilentlyContinue"',
    'Add-Type -AssemblyName System.Drawing',
    '(New-Object System.Drawing.Text.InstalledFontCollection).Families | ForEach-Object { $_.Name }',
  ].join('; ');
  let out = '';
  try {
    out = execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', ps], {
      encoding: 'utf8',
      windowsHide: true,
      maxBuffer: 8 * 1024 * 1024,
    });
  } catch (_) {
    return [];
  }
  const set = new Set();
  for (let line of out.split(/\r?\n/)) {
    const name = line.trim();
    if (!name || name.length > 50) continue;
    set.add(name);
  }
  return [...set].sort((a, b) => a.localeCompare(b, 'zh-Hans-CN'));
}

/**
 * 本次运行内已抓取过的频道 / 播放列表（内存缓存，【无过期时间】）。
 * 磁盘缓存有 30 分钟 TTL，超过就重新抓；这里保证「本次打开程序抓过一次，
 * 之后再回来切换就绝不再抓」——多个博主之间来回切换是秒开的。
 * 用户点「重新抓取」时仍然会绕过它。
 */
const sessionCache = new Map();

/** 会话缓存键：与磁盘缓存用同一套来源，保证一致 */
function sessionKeyOf(target, input) {
  return String(target.url || target.channelBase || input || '')
    .trim()
    .replace(/\/+$/, '')
    .toLowerCase();
}

function registerIpc() {
  ipcMain.handle('app:info', async () => ({
    version: app.getVersion(),
    electron: process.versions.electron,
    node: process.versions.node,
    platform: process.platform,
    isPackaged: app.isPackaged,
  }));

  ipcMain.handle('bin:check', () => binCheck());

  ipcMain.handle('bin:reset-override', () => {
    settingsStore.save({ ytDlpPath: '' });
    return binCheck();
  });

  ipcMain.handle('bin:update', async () => {
    const dir = paths.ensureDir(path.join(paths.userDataDir(), 'bin'));
    const dest = path.join(dir, 'yt-dlp.exe');
    sendToRenderer('bin:update:log', '正在从 GitHub 下载最新版 yt-dlp…');
    try {
      const url = 'https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp.exe';
      await downloadFile(url, dest, (p) => {
        sendToRenderer('bin:update:log', `下载中 ${(p.percent * 100).toFixed(1)}%（${(p.received / 1048576).toFixed(1)} MB）`);
      });
      // 校验能运行
      const r = await ytdlp.run(dest, ['--version']);
      if (r.code !== 0) throw new Error(ytdlp.extractErrors(r.stderr) || '下载的 yt-dlp 无法运行');
      settingsStore.save({ ytDlpPath: dest });
      sendToRenderer('bin:update:log', `更新成功：${r.stdout.trim()}`);
      return { ok: true, path: dest, version: r.stdout.trim() };
    } catch (err) {
      sendToRenderer('bin:update:log', `更新失败：${err.message}`);
      return { ok: false, error: err.message };
    }
  });

  ipcMain.handle('settings:get', () => {
    const s = settingsStore.load();
    // API Key 绝不明文回传给渲染进程，只回传「是否已设置」和打码串
    const plain = secret.open(s.studyApiKey);
    return Object.assign({}, s, {
      studyApiKey: '',
      studyApiKeySet: !!plain,
      studyApiKeyMask: secret.mask(plain),
      studyKeyEncrypted: secret.isSealed(s.studyApiKey),
      studyCanEncrypt: secret.canEncrypt(),
    });
  });

  ipcMain.handle('settings:set', (_e, patch) => {
    const p = Object.assign({}, patch || {});
    // 渲染层传上来的是明文 Key，这里加密后再落盘
    if (typeof p.studyApiKey === 'string') {
      if (!p.studyApiKey) {
        delete p.studyApiKey; // 空串表示「不改动」
      } else {
        p.studyApiKey = secret.seal(p.studyApiKey);
      }
    }
    if (p.studyApiKeyClear) {
      p.studyApiKey = '';
      delete p.studyApiKeyClear;
    }
    const s = settingsStore.save(p);
    queue.pump();
    return s;
  });

  // ---- 学习文档（大模型） ----
  ipcMain.handle('study:test-connection', async (_e, override) => {
    const base = settingsStore.load();
    const merged = Object.assign({}, base, override || {});
    const cfg = study.llmConfigFrom(merged);
    if (!cfg.baseURL || !cfg.model) return { ok: false, error: '请先填写 Base URL 与模型名' };
    if (!cfg.apiKey) return { ok: false, error: '请先填写 API Key' };
    try {
      const r = await studyLlm.testConnection(cfg);
      return r;
    } catch (err) {
      return { ok: false, error: String((err && err.message) || err).slice(0, 300) };
    }
  });

  ipcMain.handle('study:estimate', async (_e, { srtPath, durationMs }) => {
    try {
      if (!srtPath || !fs.existsSync(srtPath)) return { ok: false, error: '字幕文件不存在' };
      const s = settingsStore.load();
      return { ok: true, estimate: study.estimateFor(srtPath, s, durationMs || 0) };
    } catch (err) {
      return { ok: false, error: String((err && err.message) || err).slice(0, 200) };
    }
  });

  ipcMain.handle('study:generate', async (_e, { key, force }) => {
    const item = queue.items.get(key);
    if (!item) return { ok: false, error: '任务不存在' };
    if (item.studying) return { ok: false, error: '该任务正在生成中' };
    // 手动触发时忽略护栏，并且可以强制重新翻译
    // 先重新扫一遍磁盘：老任务可能因为文件名截断漏记了字幕，
    // 但字幕其实就在视频旁边，重扫即可直接生成，不必重新下载
    const srt = queueMod.refreshSubPaths(item).find((p) => /\.srt$/i.test(p)) || '';
    if (!srt || !fs.existsSync(srt)) return { ok: false, error: '该任务没有英文字幕，无法生成' };
    if (item.filePath && !fs.existsSync(item.filePath)) {
      // 视频被删了也不影响，字幕还在就能生成
    }
    item.studying = true;
    item.studyError = '';
    item.stage = '已完成 · 生成学习文档…';
    queue.changed(true);
    try {
      const settings = settingsStore.load();
      const res = await study.generateForVideo({
        srtPath: srt,
        videoPath: item.filePath,
        videoId: item.id,
        force: !!force,
        width: item.width,
        height: item.height,
        meta: {
          title: item.title,
          channel: item.channel,
          durationMs: (Number(item.duration) || 0) * 1000,
          uploadDate: queueMod.fmtUploadDate(item.uploadDate) || queueMod.uploadDateFromPath(item.filePath),
          url: item.url,
        },
        settings,
        onProgress: (p) => {
          item.studyStage =
            p.phase === 'translate' ? `翻译 ${p.done}/${p.total} 段` : p.label || p.phase;
          item.stage = `已完成 · ${item.studyStage}`;
          queue.changed();
        },
      });
      item.studyDocPath = res.paths.docx || '';
      item.biSrtPath = res.paths.bilingualSrt || '';
      item.assPath = res.paths.ass || '';
      item.studyFromCache = !!res.fromCache;
      item.studySummary = res.summary;
      item.studyCost = 0;
      if (force) study.clearCache(item.id, srt);
      return { ok: true, paths: res.paths, summary: res.summary, fromCache: res.fromCache };
    } catch (err) {
      item.studyError = String((err && err.message) || err).slice(0, 300);
      return { ok: false, error: item.studyError };
    } finally {
      item.studying = false;
      item.stage = queue._finalStage(item);
      queue.changed(true);
    }
  });

  ipcMain.handle('study:key-info', () => {
    const s = settingsStore.load();
    const plain = secret.open(s.studyApiKey);
    return {
      set: !!plain,
      mask: secret.mask(plain),
      encrypted: secret.isSealed(s.studyApiKey),
      canEncrypt: secret.canEncrypt(),
    };
  });

  ipcMain.handle('dialog:pickFolder', async (_e, current) => {
    const r = await dialog.showOpenDialog(mainWindow, {
      title: '选择保存目录',
      defaultPath: current || settingsStore.load().outputDir,
      properties: ['openDirectory', 'createDirectory'],
    });
    if (r.canceled || !r.filePaths.length) return null;
    return r.filePaths[0];
  });

  ipcMain.handle('dialog:pickFile', async () => {
    const r = await dialog.showOpenDialog(mainWindow, {
      title: '选择 cookies.txt',
      properties: ['openFile'],
      filters: [{ name: 'Cookies', extensions: ['txt'] }],
    });
    if (r.canceled || !r.filePaths.length) return null;
    return r.filePaths[0];
  });

  /** 原生确认框（用于批量删除这类不可逆操作） */
  ipcMain.handle('dialog:confirm', async (_e, opts) => {
    const o = opts || {};
    const r = await dialog.showMessageBox(mainWindow, {
      type: o.type || 'warning',
      buttons: [o.confirmLabel || '确定', '取消'],
      defaultId: 1, // 默认停在「取消」上，避免误按回车
      cancelId: 1,
      title: o.title || '确认',
      message: o.message || '',
      detail: o.detail || '',
      noLink: true,
    });
    return r.response === 0;
  });

  // ---- 频道识别 ----
  ipcMain.handle('channel:enumerate', async (_e, { input, force }) => {
    const settings = settingsStore.load();
    const bin = paths.ytDlpPath(settings);
    if (!bin) return { ok: false, error: '未找到 yt-dlp.exe，无法识别频道' };

    const target = channel.parseTarget(input);
    if (target.kind === 'unknown') return { ok: false, error: target.error };

    if (activeEnumerate) return { ok: false, error: '已有识别任务在进行中' };

    const send = (payload) => sendToRenderer('channel:progress', payload);

    try {
      if (target.kind === 'video') {
        send({ phase: 'probe', label: '读取视频信息…' });
        const res = await channel.probeVideo(bin, target.url, {
          onChild: (c) => {
            activeEnumerate = { child: c, canceled: false };
          },
        });
        if (!res.ok) return { ok: false, error: res.error };
        const item = Object.assign({}, res.item, { section: 'single', sections: ['single'] });
        return {
          ok: true,
          data: {
            channel: { url: target.url, title: '单个视频', id: '', handle: '', followerCount: null, avatar: '' },
            sections: { single: [item] },
            items: [item],
            warnings: [],
            tabStatus: {},
            targetKind: 'video',
          },
        };
      }

      // 本次运行内抓过的直接复用，不再发任何请求
      const skey = sessionKeyOf(target, input);
      if (!force && skey && sessionCache.has(skey)) {
        const hit = sessionCache.get(skey);
        send({ phase: 'cache', label: '本次已抓取过，直接复用' });
        return {
          ok: true,
          data: hit.data,
          cached: true,
          sessionCached: true,
          cacheAgeSec: Math.round((Date.now() - hit.ts) / 1000),
        };
      }

      const cacheFile = channelCacheFile(target.url || target.channelBase || input);
      if (!force && fs.existsSync(cacheFile)) {
        try {
          const cached = JSON.parse(fs.readFileSync(cacheFile, 'utf8'));
          const age = Date.now() - (cached.ts || 0);
          if (cached.data && age < 30 * 60 * 1000) {
            // 磁盘缓存命中也必须写进会话缓存，否则主页的「本次已抓取」里看不到它，
            // 用户就没法从主页快速切回来（实测踩过：两个频道都命中磁盘缓存时面板是空的）。
            if (skey) sessionCache.set(skey, { ts: Date.now(), data: cached.data });
            send({ phase: 'cache', label: '使用 30 分钟内的缓存列表' });
            return { ok: true, data: cached.data, cached: true, cacheAgeSec: Math.round(age / 1000) };
          }
        } catch (_) {}
      }

      const enumerator =
        target.kind === 'playlist' ? channel.enumeratePlaylist : channel.enumerateChannel;
      const baseUrl = target.kind === 'playlist' ? target.url : target.channelBase;

      const out = await enumerator(bin, baseUrl, {
        maxItems: Number(settings.maxItemsPerChannel) || 0,
        readPlaylists: settings.readPlaylists !== false,
        onProgress: (p) => send(p),
        onChild: (c) => {
          if (activeEnumerate && activeEnumerate.canceled) {
            ytdlp.killTree(c);
          }
          activeEnumerate = { child: c, canceled: activeEnumerate ? activeEnumerate.canceled : false };
        },
      });

      if (activeEnumerate && activeEnumerate.canceled) {
        return { ok: false, canceled: true, error: '已取消识别' };
      }
      if (!out.ok) return { ok: false, error: out.error || '识别失败' };

      const data = Object.assign({}, out.result, { targetKind: target.kind });
      if (skey) sessionCache.set(skey, { ts: Date.now(), data });
      try {
        fs.writeFileSync(cacheFile, JSON.stringify({ ts: Date.now(), data }), 'utf8');
      } catch (_) {}
      return { ok: true, data };
    } catch (err) {
      return { ok: false, error: err.message };
    } finally {
      activeEnumerate = null;
    }
  });

  ipcMain.handle('channel:playlist-items', async (_e, { url, title }) => {
    const bin = paths.ytDlpPath(settingsStore.load());
    if (!bin) return { ok: false, error: '未找到 yt-dlp.exe' };
    if (!url) return { ok: false, error: '缺少播放列表地址' };
    try {
      const res = await channel.playlistItems(bin, url, title || '');
      if (!res.ok) return { ok: false, error: res.error };
      return { ok: true, items: res.items, title: res.title };
    } catch (err) {
      return { ok: false, error: String((err && err.message) || err).slice(0, 300) };
    }
  });

  /** 本次运行内已抓取过的列表（用于主页的快速切换） */
  ipcMain.handle('channel:session-list', () => {
    const list = [];
    for (const [url, v] of sessionCache.entries()) {
      const ch = (v.data && v.data.channel) || {};
      list.push({
        url,
        title: ch.title || url,
        avatar: ch.avatar || '',
        handle: ch.handle || '',
        targetKind: (v.data && v.data.targetKind) || 'channel',
        items: ((v.data && v.data.items) || []).length,
        ts: v.ts,
      });
    }
    list.sort((a, b) => b.ts - a.ts);
    return { ok: true, list };
  });

  /** 清掉会话缓存里的一条（主页上右键移除用） */
  ipcMain.handle('channel:session-forget', (_e, url) => {
    const k = String(url || '').trim().replace(/\/+$/, '').toLowerCase();
    sessionCache.delete(k);
    return { ok: true };
  });

  ipcMain.handle('channel:cancel', async () => {
    if (!activeEnumerate) return false;
    activeEnumerate.canceled = true;
    await ytdlp.killTree(activeEnumerate.child);
    return true;
  });

  ipcMain.handle('channel:clear-cache', async (_e, input) => {
    const settings = settingsStore.load();
    const bin = paths.ytDlpPath(settings);
    const target = channel.parseTarget(input);
    const key = target.url || target.channelBase || input;
    const file = channelCacheFile(key);
    try {
      if (fs.existsSync(file)) fs.unlinkSync(file);
    } catch (_) {}
    return true;
  });

  /** 系统已安装的字体族名（用于字幕字体选择） */
  ipcMain.handle('fonts:list', () => {
    try {
      return { ok: true, list: listSystemFonts() };
    } catch (err) {
      return { ok: false, error: String((err && err.message) || err), list: [] };
    }
  });

  // ---- 已下载索引（按视频 ID 识别本地文件）----
  /**
   * 返回本地已下载的作品 { id: {title, videoPath, ...} }。
   * 完全以磁盘上的边车文件为准 —— 队列被清空、换机器、重装都不影响识别。
   */
  ipcMain.handle('downloads:index', (_e, opts) => {
    try {
      const settings = settingsStore.load();
      const map = downloadsIndex.lookupAll((opts && opts.dir) || settings.outputDir, {
        ttl: opts && opts.fresh ? 0 : undefined,
      });
      const list = [];
      for (const [id, rec] of map) {
        list.push({
          id,
          title: rec.title || '',
          videoPath: rec.videoPath,
          uploadDate: rec.uploadDate || '',
          viewCount: rec.viewCount == null ? null : rec.viewCount,
          duration: rec.duration == null ? null : rec.duration,
        });
      }
      return { ok: true, list, dir: (opts && opts.dir) || settings.outputDir };
    } catch (err) {
      return { ok: false, error: String((err && err.message) || err), list: [] };
    }
  });

  /** 单个视频的本地边车信息（有则秒出，用于详情预览先渲染一部分） */
  ipcMain.handle('downloads:local', (_e, { id }) => {
    try {
      const settings = settingsStore.load();
      const map = downloadsIndex.lookupAll(settings.outputDir);
      const rec = map.get(String(id || ''));
      return rec ? { ok: true, rec } : { ok: false };
    } catch (_) {
      return { ok: false };
    }
  });

  /** 按需拉取作品详情（列表用的 flat 数据不含文案，只能点开时再拉） */
  ipcMain.handle('video:details', async (_e, { url }) => {
    const settings = settingsStore.load();
    const bin = paths.ytDlpPath(settings);
    if (!bin) return { ok: false, error: '未找到 yt-dlp.exe' };
    if (!url) return { ok: false, error: '缺少视频地址' };
    try {
      const r = await channel.videoDetails(bin, url);
      return r;
    } catch (err) {
      return { ok: false, error: String((err && err.message) || err).slice(0, 300) };
    }
  });

  // ---- 最近下载的博主（首页快捷入口）----
  ipcMain.handle('channels:top', (_e, limit) => {
    try {
      return { ok: true, list: channelsStore.top(Number(limit) || 12) };
    } catch (err) {
      return { ok: false, error: String((err && err.message) || err), list: [] };
    }
  });
  ipcMain.handle('channels:remove', (_e, url) => {
    channelsStore.remove(url);
    return { ok: true, list: channelsStore.top(12) };
  });

  // ---- 下载队列 ----
  ipcMain.handle('queue:add', (_e, { items, options }) => queue.add(items || [], options || {}));
  ipcMain.handle('queue:list', () => ({ items: queue.snapshot(), stats: queue.stats() }));
  ipcMain.handle('queue:action', async (_e, { key, action }) => {
    switch (action) {
      case 'pause':
        await queue.pause(key);
        break;
      case 'resume':
        queue.resume(key);
        break;
      case 'retry':
        queue.retry(key);
        break;
      case 'remove':
        await queue.remove(key);
        break;
      default:
        return { ok: false, error: '未知操作' };
    }
    return { ok: true, items: queue.snapshot(), stats: queue.stats() };
  });
  ipcMain.handle('queue:clear', (_e, filter) => {
    queue.clear(filter || 'done');
    return { ok: true, items: queue.snapshot(), stats: queue.stats() };
  });
  ipcMain.handle('queue:cancel-all', async () => {
    const removed = await queue.cancelAll();
    return { ok: true, removed, items: queue.snapshot(), stats: queue.stats() };
  });
  ipcMain.handle('queue:pause-all', async () => {
    await queue.pauseAll();
    return { ok: true, items: queue.snapshot(), stats: queue.stats() };
  });
  ipcMain.handle('queue:resume-all', () => {
    queue.resumeAll();
    return { ok: true, items: queue.snapshot(), stats: queue.stats() };
  });

  // ---- 系统 ----
  ipcMain.handle('shell:open-path', async (_e, p) => {
    if (!p) return false;
    const dir = fs.existsSync(p) && fs.statSync(p).isDirectory() ? p : path.dirname(p);
    if (!fs.existsSync(dir)) return false;
    await shell.openPath(dir);
    return true;
  });
  ipcMain.handle('shell:show-item', (_e, p) => {
    if (p && fs.existsSync(p)) shell.showItemInFolder(p);
    return true;
  });
  /** 用系统默认浏览器打开外链（渲染进程里直接点 <a> 会把应用窗口导航走） */
  ipcMain.handle('shell:open-external', (_e, url) => {
    const u = String(url || '');
    if (!/^https?:\/\//i.test(u)) return false;
    shell.openExternal(u);
    return true;
  });
}

/**
 * 一次性回填「最近下载的博主」。
 * 新版本会在下载成功时直接记录博主信息，但老版本下载的任务只有频道【名字】没有 URL，
 * 因此这里借频道缓存（里面存着每个频道的完整识别结果，含 title 和 url）建立 名字→URL 映射，
 * 把历史下载补进统计。用设置里的标记保证只跑一次，避免每次启动重复累加。
 */
function backfillChannelHistory() {
  try {
    const settings = settingsStore.load();
    if (settings.channelsBackfilled) return;
    settingsStore.save({ channelsBackfilled: true });

    const dir = paths.cacheDir();
    const byTitle = new Map();
    for (const f of fs.readdirSync(dir)) {
      if (!f.endsWith('.json')) continue;
      try {
        const j = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8'));
        const ch = j && j.data && j.data.channel;
        if (ch && ch.title && ch.url) byTitle.set(ch.title, { url: ch.url, avatar: ch.avatar || '' });
      } catch (_) {}
    }
    if (!byTitle.size) return;

    const counts = new Map();
    for (const it of queue.items.values()) {
      if (it.status !== 'done' && it.status !== 'skipped') continue;
      if (it.channelRef && it.channelRef.url) continue; // 新任务已经记过了
      if (!it.channel) continue;
      counts.set(it.channel, (counts.get(it.channel) || 0) + 1);
    }
    let n = 0;
    for (const [name, cnt] of counts) {
      const ref = byTitle.get(name);
      if (!ref) continue;
      channelsStore.bump({ url: ref.url, title: name, avatar: ref.avatar }, cnt);
      n += cnt;
    }
    if (n) console.log(`[channels] 已从历史下载回填 ${n} 条记录，覆盖 ${counts.size} 个频道`);
  } catch (err) {
    console.error('[channels] backfill failed:', err && err.message);
  }
}

// ---------------------------------------------------------------- 窗口

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1320,
    height: 880,
    minWidth: 1000,
    minHeight: 640,
    title: 'YouTube 下载器',
    backgroundColor: '#0f1116',
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, '..', 'preload', 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
      spellcheck: false,
    },
  });

  mainWindow.loadFile(path.join(__dirname, '..', 'renderer', 'index.html'));

  // 开发期把渲染进程的 console / 加载失败转发到主进程，便于排查白屏问题
  mainWindow.webContents.on('console-message', (...args) => {
    const d = args[0];
    if (d && typeof d === 'object' && 'message' in d) {
      console.log(`[renderer:${d.level}] ${d.message} (${d.sourceId || ''}:${d.lineNumber || 0})`);
    } else {
      console.log(`[renderer:${args[1]}] ${args[2]} (${args[4] || ''}:${args[3] || 0})`);
    }
  });
  mainWindow.webContents.on('did-fail-load', (_e, code, desc, url) => {
    console.error(`[renderer] did-fail-load ${code} ${desc} ${url}`);
  });
  mainWindow.webContents.on('render-process-gone', (_e, details) => {
    console.error('[renderer] render-process-gone', JSON.stringify(details));
  });
  mainWindow.webContents.on('did-finish-load', () => {
    console.log('[renderer] did-finish-load');
  });

  // 开发辅助（打包后默认失效，除非显式设置环境变量 YTDL_DEV_EXEC=1，用于发布前验证）：
  //   electron . --exec=<js文件>          在渲染进程里执行脚本（真实驱动 UI），输出结果但不退出
  //   electron . --capture=<png路径>      截图后退出
  if (!app.isPackaged || process.env.YTDL_DEV_EXEC === '1') {
    const capArg = process.argv.find((a) => a.startsWith('--capture='));
    const execArg = process.argv.find((a) => a.startsWith('--exec='));
    if (capArg || execArg) {
      mainWindow.webContents.once('did-finish-load', async () => {
        await new Promise((r) => setTimeout(r, 1500));
        if (execArg) {
          const jsFile = execArg.slice('--exec='.length);
          try {
            const code = fs.readFileSync(jsFile, 'utf8');
            const result = await mainWindow.webContents.executeJavaScript(code, true);
            console.log('[exec] result: ' + JSON.stringify(result));
          } catch (err) {
            console.error('[exec] failed: ' + err.message);
          }
        }
        if (capArg) {
          const out = capArg.slice('--capture='.length);
          try {
            const img = await mainWindow.webContents.capturePage();
            fs.writeFileSync(out, img.toPNG());
            console.log('[capture] saved ' + out);
          } catch (err) {
            console.error('[capture] failed: ' + err.message);
          }
          app.exit(0);
        }
      });
    }
  }

  mainWindow.webContents.on('before-input-event', (_e, input) => {
    if (input.key === 'F12' && input.type === 'keyDown') {
      mainWindow.webContents.toggleDevTools();
    }
    if (input.key === 'F5' && input.type === 'keyDown') {
      mainWindow.webContents.reload();
    }
  });

  mainWindow.on('closed', () => {
    mainWindow = null;
  });
}

// ---------------------------------------------------------------- 生命周期

let quitting = false;

app.whenReady().then(() => {
  Menu.setApplicationMenu(null);
  queue.load();
  queue.on('changed', () => {
    sendToRenderer('queue:changed', { items: queue.snapshot(), stats: queue.stats() });
  });
  registerIpc();
  createWindow();
  backfillChannelHistory();
  // 启动后自动继续上次未完成的任务（断点续传）
  setTimeout(() => queue.pump(), 1500);
});

app.on('window-all-closed', () => {
  app.quit();
});

app.on('before-quit', (e) => {
  if (quitting) return;
  quitting = true;
  e.preventDefault();
  Promise.resolve()
    .then(() => queue.shutdown())
    .catch(() => {})
    .finally(() => app.exit(0));
});

process.on('uncaughtException', (err) => {
  console.error('[main] uncaught:', err);
});
