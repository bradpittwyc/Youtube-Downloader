'use strict';
/**
 * Electron 主进程：窗口、IPC、二进制自检、频道枚举、下载队列接线。
 */
const { app, BrowserWindow, ipcMain, dialog, shell, Menu } = require('electron');
const path = require('path');
const fs = require('fs');
const os = require('os');
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
const categories = require('./categories');
const netdiag = require('./netdiag');
const power = require('./power');
const updater = require('./updater');
const downloadsIndex = require('./downloads-index');
const { authArgs, detectBrowsers, authSummary, explainCookieError } = require('./ytdlp-auth');
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

/**
 * 频道列表的有效期：**一天内抓过就绝不再抓**。
 *
 * 为什么是一天而不是几分钟：频道的视频列表不会几分钟就变，
 * 而重新枚举一个频道要十几秒、几十个请求，还可能撞上 YouTube 风控。
 * 需要立刻拿最新列表时，用户点「重新抓取」即可（那条路会绕过这里）。
 */
const CHANNEL_CACHE_TTL_MS = 24 * 60 * 60 * 1000;

function saveChannelCache(file, data) {
  try {
    fs.writeFileSync(file, JSON.stringify({ ts: Date.now(), data }), 'utf8');
  } catch (_) {}
}

/** 抓完之后的收尾：按标题分类 + 写会话缓存 */
function finishChannelData(data, target, skey) {
  // 顺便按视频标题给这个频道分类（书签分组用）。
  // 分类只需要粗粒度，关键词打分就够，**不花钱也不联网**；
  // 而且此刻手上正好有几百条标题，是最准的时机。
  try {
    if (target.kind === 'channel' && (data.items || []).length) {
      const cls = categories.classifyTitles((data.items || []).map((x) => x.title));
      data.category = { id: cls.id, name: cls.name, icon: cls.icon };
      channelsStore.setCategory(
        {
          url: target.channelBase || target.url,
          title: (data.channel && data.channel.title) || '',
          avatar: (data.channel && data.channel.avatar) || '',
        },
        cls.id,
        cls.name
      );
    }
  } catch (err) {
    console.error('[main] 频道分类失败:', err && err.message);
  }
  if (skey) sessionCache.set(skey, { ts: Date.now(), data });
}

/**
 * 后台静默刷新（stale-while-revalidate 的 revalidate 那一半）。
 *
 * 为什么需要：缓存过期时如果直接重新联网抓，用户每次点回主页的频道都要干等，
 * 而绝大多数时候列表根本没变。改成先把旧列表秒给用户，再悄悄抓一遍最新的，抓完推给界面替换。
 *
 * 注意生效时机：只有缓存超过 CHANNEL_CACHE_TTL_MS（一天）才会走到这里 ——
 * 一天内点进来是纯读缓存，连后台请求都不发。
 */
let bgRefresh = null; // { key, canceled }

function startBackgroundRefresh({ target, input, skey, cacheFile, bin, settings }) {
  const key = skey || target.url || input;
  if (bgRefresh) return; // 同一时间只跑一个，避免给 YouTube 添压
  const state = { key, canceled: false };
  bgRefresh = state;

  (async () => {
    try {
      const enumerator =
        target.kind === 'playlist' ? channel.enumeratePlaylist : channel.enumerateChannel;
      const baseUrl = target.kind === 'playlist' ? target.url : target.channelBase;
      console.log('[channel] 后台刷新开始：' + (target.url || input));
      const out = await enumerator(bin, baseUrl, {
        maxItems: Number(settings.maxItemsPerChannel) || 0,
        playlistEnd: Number(settings.maxItemsPerChannel) || 0,
        maxContainers: Number(settings.maxContainersPerTab) || 0,
        readPlaylists: settings.readPlaylists !== false,
        auth: authArgs(settings),
        onChild: (c) => {
          if (state.canceled) ytdlp.killTree(c);
        },
      });
      if (state.canceled) return;
      if (!out.ok) {
        console.log('[channel] 后台刷新失败（保留旧列表）：' + (out.error || ''));
        return;
      }
      const data = Object.assign({}, out.result, { targetKind: target.kind });
      finishChannelData(data, target, skey);
      saveChannelCache(cacheFile, data);
      sendToRenderer('channel:refreshed', {
        key,
        items: (data.items || []).length,
        data,
      });
      console.log(`[channel] 后台刷新完成：${(data.items || []).length} 个内容`);
    } catch (err) {
      console.log('[channel] 后台刷新出错（保留旧列表）：' + (err && err.message));
    } finally {
      if (bgRefresh === state) bgRefresh = null;
    }
  })();
}

/** 用户主动发起识别时，把后台刷新让开（避免两个 yt-dlp 同时打 YouTube） */
function cancelBackgroundRefresh() {
  if (bgRefresh) {
    bgRefresh.canceled = true;
    bgRefresh = null;
  }
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
 * 磁盘缓存有 CHANNEL_CACHE_TTL_MS（一天）的有效期；这里保证「本次打开程序抓过一次，
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

  // 拉取该端点支持的模型列表（GET /models，免费不消耗 token）。
  // 界面据此把「模型名」从纯手填变成下拉选项；拿不到就退化成手填，不阻塞。
  ipcMain.handle('study:list-models', async (_e, override) => {
    const base = settingsStore.load();
    const merged = Object.assign({}, base, override || {});
    const cfg = study.llmConfigFrom(merged);
    if (!cfg.baseURL) return { ok: false, error: '请先填写 API 地址', models: [], profiles: {} };
    if (!cfg.apiKey) return { ok: false, error: '请先填写 API Key', models: [], profiles: {} };
    const r = await studyLlm.listModels(cfg);
    // 顺手带上每个模型的档案（是不是推理模型、单价、界面显示名）
    r.profiles = {};
    for (const m of r.models) r.profiles[m] = studyLlm.modelProfile(m);
    return r;
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

  // 金句卡片已改为「生成文档」时自动产出（见 study/index.js 的 generateForVideo），
  // 原来的 study:quote-cards IPC 与界面按钮一并移除。

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
          auth: authArgs(settings),
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
          if (cached.data) {
            // 【关键】不用有效期卡住返回值 —— 多旧都先给出去，让用户秒开。
            // 旧的只是「可能过期」，补齐就行，不该让用户干等。
            if (skey) sessionCache.set(skey, { ts: Date.now(), data: cached.data });
            // 一天内抓过就纯读缓存，连后台请求都不发；超过一天才顺手补一次
            const stale = age >= CHANNEL_CACHE_TTL_MS;
            if (stale) {
              send({ phase: 'cache', label: '先用上次的列表，正在后台更新…' });
              startBackgroundRefresh({ target, input, skey, cacheFile, bin, settings });
            } else {
              send({ phase: 'cache', label: '使用缓存列表' });
            }
            return {
              ok: true,
              data: cached.data,
              cached: true,
              cacheAgeSec: Math.round(age / 1000),
              refreshing: stale,
            };
          }
        } catch (_) {}
      }

      // 用户主动抓取：把后台刷新让开，避免两个 yt-dlp 同时打 YouTube
      cancelBackgroundRefresh();

      const enumerator =
        target.kind === 'playlist' ? channel.enumeratePlaylist : channel.enumerateChannel;
      const baseUrl = target.kind === 'playlist' ? target.url : target.channelBase;
      const out = await enumerator(bin, baseUrl, {
        maxItems: Number(settings.maxItemsPerChannel) || 0,
        // 【关键】把上限真正传给 yt-dlp（--playlist-end / 容器展开数）。
        // 以前只传 maxItems，而它仅在拿到全部数据后做过滤 ——
        // 大频道照样把整页翻完再丢掉，实测 @marvel 一万多条白等了 3 分 13 秒。
        playlistEnd: Number(settings.maxItemsPerChannel) || 0,
        maxContainers: Number(settings.maxContainersPerTab) || 0,
        readPlaylists: settings.readPlaylists !== false,
        auth: authArgs(settings),
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
      finishChannelData(data, target, skey);
      saveChannelCache(cacheFile, data);
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
      const res = await channel.playlistItems(bin, url, title || '', { auth: authArgs(settingsStore.load()) });
      if (!res.ok) return { ok: false, error: res.error };
      return { ok: true, items: res.items, title: res.title };
    } catch (err) {
      return { ok: false, error: String((err && err.message) || err).slice(0, 300) };
    }
  });

  // ---- 频道分类（书签分组）----
  /** 书签栏要显示的分类清单 */
  ipcMain.handle('categories:list', () => {
    try {
      return { ok: true, list: categories.allCategories() };
    } catch (err) {
      return { ok: false, error: String((err && err.message) || err), list: [] };
    }
  });

  /** 本次运行内已抓取过的列表（用于主页的快速切换） */
  ipcMain.handle('channel:session-list', () => {
    const list = [];
    for (const [url, v] of sessionCache.entries()) {
      const ch = (v.data && v.data.channel) || {};
      const cat = (v.data && v.data.category) || null;
      list.push({
        url,
        title: ch.title || url,
        avatar: ch.avatar || '',
        handle: ch.handle || '',
        targetKind: (v.data && v.data.targetKind) || 'channel',
        cat: cat ? cat.id : '',
        catName: cat ? cat.name : '',
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

  // ---- Cookies（YouTube 风控）----
  /** 本机装了哪些浏览器 + 当前生效的配置 */
  ipcMain.handle('cookies:detect', () => {
    try {
      const s = settingsStore.load();
      return { ok: true, browsers: detectBrowsers(), summary: authSummary(s), browser: s.cookieBrowser || '' };
    } catch (err) {
      return { ok: false, error: String((err && err.message) || err), browsers: [] };
    }
  });

  /**
   * 实测一次：用当前 Cookies 配置去请求一个真实视频。
   * 只配了不算数 —— 能不能过风控要试了才知道。
   * patch 优先：用户刚在下拉框里选完就点测试时还没保存，
   * 只读设置文件会得到旧值（实测踩过：选了 Edge 却提示"尚未配置"）。
   */
  ipcMain.handle('cookies:test', async (_e, patch) => {
    const saved = settingsStore.load();
    const s = Object.assign({}, saved, patch || {});
    const bin = paths.ytDlpPath(saved);
    if (!bin) return { ok: false, error: '未找到 yt-dlp.exe' };
    const auth = authArgs(s);
    if (!auth.length) {
      return { ok: false, error: '尚未配置 Cookies：既没选浏览器，也没填 cookies.txt 文件' };
    }
    // 固定用一个长期存在的视频做探针（YouTube 第一个视频）
    const probe = 'https://www.youtube.com/watch?v=jNQXAC9IVRw';
    const args = ytdlp.BASE_FLAGS.concat([
      '--no-playlist',
      '--skip-download',
      '--print',
      '%(title)s',
      ...auth,
      probe,
    ]);
    try {
      const r = await ytdlp.run(bin, args);
      if (r.code === 0 && r.stdout.trim()) {
        return { ok: true, title: r.stdout.trim().split(/\r?\n/)[0], used: authSummary(s) };
      }
      const raw = ytdlp.extractErrors(r.stderr) || 'yt-dlp 退出码 ' + r.code;
      return { ok: false, error: explainCookieError(raw), raw: String(raw).slice(0, 400) };
    } catch (err) {
      return { ok: false, error: String((err && err.message) || err) };
    }
  });

  // ---- 自动关机 ----
  /** 当前关机状态（是否已排定、还剩几秒） */
  ipcMain.handle('power:state', () => ({ ok: true, state: power.state() }));
  /** 取消已排定的关机 */
  ipcMain.handle('power:cancel', () => {
    const was = power.cancel();
    return { ok: true, canceled: was, state: power.state() };
  });
  /** 用户在设置里关掉开关时清干净 */
  ipcMain.handle('power:reset', () => {
    power.reset();
    return { ok: true, state: power.state() };
  });

  // ---- 网络诊断 ----
  /**
   * 把「为什么下不动」变成一句人话。
   * 尤其要能识别「出口是机房 IP」——那是 YouTube 风控最常见的原因，
   * 但用户从一屏英文报错里根本看不出来。
   */
  ipcMain.handle('net:diagnose', async () => {
    const settings = settingsStore.load();
    const bin = paths.ytDlpPath(settings);
    try {
      return {
        ok: true,
        report: await netdiag.diagnose({
          bin,
          run: (b, args) => ytdlp.run(b, args),
          settings,
          probeUrl: 'https://www.youtube.com/watch?v=jNQXAC9IVRw',
        }),
      };
    } catch (err) {
      return { ok: false, error: String((err && err.message) || err) };
    }
  });

  /** 系统已安装的字体族名（用于字幕字体选择） */  ipcMain.handle('fonts:list', () => {
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
          // 下面几个是给「下载历史」用的 —— 边车文件里本来就有，之前没透出来。
          // 历史列表要显示频道名与下载时间，否则一屏都是标题、分不清是谁的。
          channel: rec.channel || '',
          url: rec.url || '',
          at: rec.at || '',
          file: rec.file || '',
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
      const r = await channel.videoDetails(bin, url, { auth: authArgs(settings) });
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
      case 'retryNow':
        queue.retryNow(key);
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

  // ---- 自动升级 ----
  //
  // 安装包来自本仓库的 GitHub Releases（仓库必须是公开的，私有仓库匿名读不到 → 404）。
  // 实测：Setup 安装包支持 `/S` 静默原地升级，但 `/S` 不触发 runAfterFinish，
  // 所以装完由 updater 用一段临时 .cmd 负责把 App 重新拉起来。
  ipcMain.handle('update:check', async () => updater.checkForUpdate(app.getVersion()));

  ipcMain.handle('update:download', async (_e, asset) => {
    if (!asset || !asset.url) return { ok: false, error: '没有可下载的安装包' };
    const dest = path.join(os.tmpdir(), asset.name || 'ytdl-update.exe');
    try {
      const r = await updater.downloadUpdate(asset, dest, (p) => {
        sendToRenderer('update:progress', p);
      });
      return { ok: true, path: r.path, bytes: r.bytes, verified: r.verified };
    } catch (err) {
      return { ok: false, error: String((err && err.message) || err) };
    }
  });

  ipcMain.handle('update:apply', (_e, installerPath) => {
    if (!installerPath || !fs.existsSync(installerPath)) {
      return { ok: false, error: '安装包不存在，请重新下载' };
    }
    // 重启的是「当前正在运行的这个 exe」—— 安装是原地升级，路径不变
    updater.applyUpdateAndRestart(installerPath, process.execPath);
    // 给一点时间让上面的批处理落盘，然后退出；批处理会等 2 秒再开始装
    setTimeout(() => app.quit(), 400);
    return { ok: true };
  });

  ipcMain.handle('update:open-page', () => {
    shell.openExternal(updater.RELEASES_PAGE);
    return true;
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
 * 回填频道分类（书签分组用）。
 *
 * 分类需要视频标题，而只有识别时才拿得到；老记录（分类功能上线前建的书签）没有。
 * 好在频道缓存里就存着标题，直接拿来补，不用重新联网识别。
 * 每次启动都跑：只处理「还没分类」的，成本是读几个 JSON。
 */
function backfillCategories() {
  try {
    const list = channelsStore.load();
    const pending = list.filter((x) => x && x.url && !x.cat);
    if (!pending.length) return;
    let n = 0;
    for (const item of pending) {
      const f = channelCacheFile(item.url);
      if (!fs.existsSync(f)) continue;
      try {
        const j = JSON.parse(fs.readFileSync(f, 'utf8'));
        const items = (j && j.data && j.data.items) || [];
        if (!items.length) continue;
        const cls = categories.classifyTitles(items.map((x) => x.title));
        channelsStore.setCategory(
          { url: item.url, title: item.title, avatar: item.avatar },
          cls.id,
          cls.name
        );
        n++;
      } catch (_) {}
    }
    if (n) console.log(`[channels] 已按视频标题回填 ${n} 个频道的分类`);
  } catch (err) {
    console.error('[channels] 分类回填失败:', err && err.message);
  }
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

  // 启动后静默检查一次更新。
  // 延迟 8 秒：不跟启动时的频道索引、字体枚举抢网络和 CPU；
  // 检查失败（断网、被墙、接口抽风）只写日志，绝不打扰用户 ——
  // 用户还能在设置里手动点「检查更新」。
  mainWindow.webContents.once('did-finish-load', () => {
    setTimeout(async () => {
      try {
        const r = await updater.checkForUpdate(app.getVersion());
        if (r.ok && r.hasUpdate) {
          console.log(`[update] 发现新版本 ${r.latest}（当前 ${r.current}）`);
          sendToRenderer('update:available', r);
        } else if (r.ok) {
          console.log(`[update] 已是最新版本 ${r.current}`);
        } else {
          console.log('[update] 检查失败：' + r.error);
        }
      } catch (e) {
        console.log('[update] 检查异常：' + e.message);
      }
    }, 8000);
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
    // 自动关机：每轮队列变化都判断一次「是不是全部干完了」
    try {
      const all = Array.from(queue.items.values());
      const busy = all.filter((i) => power.BUSY.has(i.status)).length;
      const failed = all.filter((i) => i.status === 'error').length;
      power.onQueueChange(busy, settingsStore.load(), failed);
    } catch (err) {
      console.error('[power] 自动关机判断失败:', err && err.message);
    }
  });
  // 关机状态变化（排定 / 取消）推给界面，好让用户能一键取消
  power.setListener((st) => sendToRenderer('power:state', st));
  registerIpc();
  createWindow();
  backfillChannelHistory();
  backfillCategories();
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
