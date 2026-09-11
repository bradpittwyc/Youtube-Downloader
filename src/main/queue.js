'use strict';
/**
 * 下载队列：
 *  - 并发调度、进度解析、暂停/恢复/重试
 *  - 队列状态落盘（userData/queue.json），关掉软件再打开继续下载（断点续传）
 *  - yt-dlp 的 --continue 负责字节级续传，这里负责「任务级」续传
 */
const fs = require('fs');
const path = require('path');
const { EventEmitter } = require('events');
const ytdlp = require('./ytdlp');
const paths = require('./paths');
const settingsStore = require('./settings');

/**
 * 分辨率上限（只限制高度，具体编码由编码策略决定）
 */
const QUALITY_LIMIT = {
  best: '',
  2160: 'height<=2160',
  1440: 'height<=1440',
  1080: 'height<=1080',
  720: 'height<=720',
  480: 'height<=480',
  360: 'height<=360',
};

/**
 * 构造 -f 格式串。
 *
 * ⚠️ 这里是「视频没声音」那个 bug 的修复点：
 * 最佳画质下 YouTube 给的是 AV1/VP9 视频 + **Opus** 音频，
 * 如果直接 `bv*+ba` 再 `--merge-output-format mp4`，就会得到 Opus-in-MP4，
 * 这是非标准组合，绝大多数播放器/剪辑软件解不出音频 → 表现为「有画面没声音」。
 * 因此无论哪种策略，音频都强制优先取 m4a(AAC)，只有在确实没有 m4a 时才退回任意音频。
 */
function buildFormat(opts) {
  const lim = QUALITY_LIMIT[opts.quality] != null ? QUALITY_LIMIT[opts.quality] : '';
  const h = lim ? `[${lim}]` : '';
  const aac = `ba[ext=m4a]`;
  if (opts.videoCodec === 'compat') {
    // 兼容优先：H.264 + AAC，剪辑软件与老设备通吃
    return `bv*${h}[vcodec^=avc1]+${aac}/bv*${h}+${aac}/bv*${h}+ba/b${h}`;
  }
  // 画质优先（默认）：保留最佳视频编码，但音频仍是 AAC
  return `bv*${h}+${aac}/bv*${h}+ba/b${h}`;
}

const POSTPROCESS_LABEL = {
  Merger: '合并音视频',
  ExtractAudio: '提取音频',
  EmbedThumbnail: '嵌入封面',
  Metadata: '写入元数据',
  MoveFiles: '整理文件',
  FFmpegVideoConvertor: '转换格式',
  FixupM3u8: '修复直播流',
  SponsorBlock: '处理章节',
};

const TERMINAL = new Set(['done', 'error', 'canceled', 'skipped']);

function nowIso() {
  return new Date().toISOString();
}

/**
 * 收集与视频同名的字幕文件（如 `标题 [2026-08-23].zh-Hans.srt`）。
 * 字幕由 yt-dlp 直接落盘，路径不经过 --print，因此这里用同名前缀扫目录。
 */
const SUB_EXT = /\.(srt|vtt|ass|ssa|ttml|srv[123]|json3)$/i;
function collectSubtitleFiles(videoPath) {
  if (!videoPath) return [];
  try {
    const dir = path.dirname(videoPath);
    const base = path.basename(videoPath, path.extname(videoPath));
    return fs
      .readdirSync(dir)
      .filter((f) => f.startsWith(base + '.') && SUB_EXT.test(f))
      .map((f) => path.join(dir, f))
      .sort();
  } catch (_) {
    return [];
  }
}

function num(v) {
  if (v == null) return null;
  const s = String(v).trim();
  if (!s || s === 'NA' || s === 'None' || s === 'none') return null;
  const n = Number(s);
  return Number.isFinite(n) ? n : null;
}

class DownloadQueue extends EventEmitter {
  constructor() {
    super();
    /** @type {Map<string, object>} */
    this.items = new Map();
    /** @type {Map<string, {child:any, canceled:boolean, pause:boolean, remove:boolean}>} */
    this.active = new Map();
    this._persistTimer = null;
    this._emitTimer = null;
  }

  // ---------- 持久化 ----------

  load() {
    try {
      const file = paths.queueFile();
      if (!fs.existsSync(file)) return;
      const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
      const list = Array.isArray(raw) ? raw : raw.items || [];
      for (const it of list) {
        if (!it || !it.key) continue;
        const item = Object.assign({}, it);
        // 上次退出时正在下载 → 重新排队，交由 yt-dlp --continue 续传
        if (item.status === 'downloading') {
          item.status = 'queued';
          item.interrupted = true;
          item.stage = '等待续传';
        }
        this.items.set(item.key, item);
      }
      console.log(`[queue] restored ${this.items.size} item(s)`);
    } catch (err) {
      console.error('[queue] load failed:', err.message);
    }
  }

  persist() {
    if (this._persistTimer) return;
    this._persistTimer = setTimeout(() => {
      this._persistTimer = null;
      try {
        const list = Array.from(this.items.values()).map((it) => {
          const c = Object.assign({}, it);
          delete c._pause;
          delete c._remove;
          return c;
        });
        fs.writeFileSync(paths.queueFile(), JSON.stringify(list, null, 2), 'utf8');
      } catch (err) {
        console.error('[queue] persist failed:', err.message);
      }
    }, 400);
  }

  changed(immediate) {
    this.persist();
    if (immediate) {
      if (this._emitTimer) {
        clearTimeout(this._emitTimer);
        this._emitTimer = null;
      }
      this.emit('changed');
      return;
    }
    if (this._emitTimer) return;
    this._emitTimer = setTimeout(() => {
      this._emitTimer = null;
      this.emit('changed');
    }, 300);
  }

  // ---------- 查询 ----------

  snapshot() {
    const order = { downloading: 0, queued: 1, paused: 2, error: 3, canceled: 4, done: 5, skipped: 5 };
    return Array.from(this.items.values())
      .sort((a, b) => {
        const oa = order[a.status] == null ? 9 : order[a.status];
        const ob = order[b.status] == null ? 9 : order[b.status];
        if (oa !== ob) return oa - ob;
        return (a.addedAt || '').localeCompare(b.addedAt || '');
      })
      .map((it) => ({
        key: it.key,
        id: it.id,
        title: it.title,
        channel: it.channel,
        section: it.section,
        liveStatus: it.liveStatus,
        thumbnail: it.thumbnail,
        duration: it.duration,
        status: it.status,
        progress: it.progress || 0,
        downloadedBytes: it.downloadedBytes || 0,
        totalBytes: it.totalBytes || 0,
        speed: it.speed || 0,
        eta: it.eta == null ? null : it.eta,
        stage: it.stage || '',
        filePath: it.filePath || '',
        audioPath: it.audioPath || '',
        audioError: it.audioError || '',
        extractingAudio: !!it.extractingAudio,
        subPaths: it.subPaths || [],
        subCount: (it.subPaths || []).length,
        subError: it.subError || '',
        fetchingSubs: !!it.fetchingSubs,
        error: it.error || '',
        attempts: it.attempts || 0,
        interrupted: !!it.interrupted,
        audioOnly: !!it.opts.audioOnly,
        quality: it.opts.quality,
        outputDir: it.opts.outputDir,
        addedAt: it.addedAt,
        finishedAt: it.finishedAt || '',
      }));
  }

  stats() {
    const s = { total: this.items.size, queued: 0, downloading: 0, paused: 0, done: 0, error: 0, canceled: 0, skipped: 0 };
    for (const it of this.items.values()) {
      if (s[it.status] != null) s[it.status]++;
    }
    s.active = this.active.size;
    s.concurrency = settingsStore.load().concurrency;
    return s;
  }

  // ---------- 入队 ----------

  /**
   * @param {Array} items 视频条目
   * @param {object} batchOpts { quality, audioOnly, outputDir }
   */
  add(items, batchOpts = {}) {
    const settings = settingsStore.load();
    const opts = {
      quality: batchOpts.quality || settings.quality || 'best',
      videoCodec: batchOpts.videoCodec || settings.videoCodec || 'quality',
      audioOnly: batchOpts.audioOnly != null ? !!batchOpts.audioOnly : !!settings.audioOnly,
      audioFormat: batchOpts.audioFormat || settings.audioFormat || 'mp3',
      alsoAudio:
        batchOpts.alsoAudio != null ? !!batchOpts.alsoAudio : settings.alsoAudio !== false,
      writeSubs:
        batchOpts.writeSubs != null ? !!batchOpts.writeSubs : settings.writeSubs !== false,
      writeAutoSubs: settings.writeAutoSubs !== false,
      subLangs: batchOpts.subLangs || settings.subLangs || 'en',
      subFormat: settings.subFormat || 'srt',
      embedSubs: !!settings.embedSubs,
      outputDir: batchOpts.outputDir || settings.outputDir,
      filenameTemplate: settings.filenameTemplate,
      skipDownloaded: settings.skipDownloaded !== false,
      rateLimit: settings.rateLimit || '',
      proxy: settings.proxy || '',
      cookieFile: settings.cookieFile || '',
      liveFromStart: !!settings.liveFromStart,
      embedMetadata: settings.embedMetadata !== false,
      embedThumbnail: settings.embedThumbnail !== false,
    };
    paths.ensureDir(opts.outputDir);

    let added = 0;
    let skipped = 0;
    for (const it of items) {
      if (!it || !it.id) continue;
      const key = it.id;
      const existing = this.items.get(key);
      if (existing && !TERMINAL.has(existing.status)) {
        skipped++;
        continue;
      }
      // 重新下载同一视频时，只有在「输出目录没变 且 旧文件仍在」的情况下才沿用旧路径。
      // 否则会继承一个已经不存在的/别的目录的路径，导致「打开文件夹」指错地方，
      // 也会让后续的音频导出从错误的源文件里抽轨（踩坑：测试间互相污染就是这个问题）。
      const canInherit =
        existing &&
        existing.opts &&
        existing.opts.outputDir === opts.outputDir &&
        existing.filePath &&
        fs.existsSync(existing.filePath)
          ? existing.filePath
          : '';
      const item = {
        key,
        id: it.id,
        title: it.title,
        channel: it.channel || '',
        section: it.section || 'videos',
        liveStatus: it.liveStatus || null,
        thumbnail: it.thumbnail || '',
        duration: it.duration || null,
        url: it.url || `https://www.youtube.com/watch?v=${it.id}`,
        opts: Object.assign({}, opts),
        status: 'queued',
        progress: 0,
        downloadedBytes: 0,
        totalBytes: 0,
        speed: 0,
        eta: null,
        stage: '排队中',
        filePath: canInherit,
        audioPath: '',
        audioError: '',
        subPaths: [],
        subError: '',
        error: '',
        attempts: 0,
        addedAt: nowIso(),
        finishedAt: '',
        _files: {},
      };
      this.items.set(key, item);
      added++;
    }
    this.changed(true);
    this.pump();
    return { added, skipped };
  }

  // ---------- 调度 ----------

  pump() {
    const settings = settingsStore.load();
    const limit = Math.max(1, Math.min(6, Number(settings.concurrency) || 2));
    if (this.active.size >= limit) return;
    const pending = Array.from(this.items.values()).filter((it) => it.status === 'queued');
    for (const item of pending) {
      if (this.active.size >= limit) break;
      this._start(item);
    }
  }

  _start(item) {
    const settings = settingsStore.load();
    const bin = paths.ytDlpPath(settings);
    if (!bin) {
      item.status = 'error';
      item.error = '未找到 yt-dlp.exe（内置文件缺失）';
      this.changed(true);
      return;
    }
    const ffDir = paths.ffmpegDir(settings);
    if (!ffDir) {
      item.status = 'error';
      item.error = '未找到 ffmpeg.exe（内置文件缺失）';
      this.changed(true);
      return;
    }

    if (item.liveStatus === 'is_upcoming') {
      item.status = 'error';
      item.error = '该直播尚未开播，开播后再下载';
      this.changed(true);
      return;
    }

    const args = this._buildArgs(item, settings, bin, ffDir);
    item.status = 'downloading';
    item.error = '';
    item.stage = '开始下载';
    item._files = {};
    this.changed(true);

    const handle = { child: null, canceled: false, pause: false, remove: false };
    const ctx = ytdlp.spawnLines(bin, args, {
      onStdoutLine: (line) => this._onLine(item, line),
      onStderrLine: (line) => this._onErrLine(item, line),
    });
    handle.child = ctx.child;
    this.active.set(item.key, handle);

    ctx.done
      .then(({ code, stderr }) => this._onExit(item, handle, code, stderr))
      .catch((err) => {
        this.active.delete(item.key);
        item.status = 'error';
        item.error = `启动失败：${err.message}`;
        this.changed(true);
        this.pump();
      });
  }

  _buildArgs(item, settings, bin, ffDir) {
    const o = item.opts;
    const a = [
      // BASE_FLAGS 里已包含 --encoding utf-8（否则中文/特殊字符文件名会变乱码）
      ...ytdlp.BASE_FLAGS,
      '--newline',
      '--no-quiet',
      '--no-simulate',
      '--progress',
      // 机器可读的进度（含总字节/速度/ETA）
      '--progress-template',
      'download:DL|%(progress.status)s|%(progress.downloaded_bytes)s|%(progress.total_bytes)s|%(progress.total_bytes_estimate)s|%(progress.speed)s|%(progress.eta)s|%(progress.filename)s',
      '--progress-template',
      'postprocess:PP|%(progress.status)s|%(progress.postprocessor)s',
      // 下载完成后的真实落盘路径
      '--print',
      'after_move:FINAL|%(filepath)s',
      '--ffmpeg-location',
      ffDir,
      '--retries',
      '10',
      '--fragment-retries',
      '10',
      '--socket-timeout',
      '20',
      '--concurrent-fragments',
      '4',
      '--continue',
      '--no-overwrites',
      '--windows-filenames',
      '--trim-filenames',
      '180',
      '-P',
      o.outputDir,
      '-o',
      o.filenameTemplate || '%(title)s [%(id)s].%(ext)s',
    ];

    if (o.skipDownloaded) a.push('--download-archive', paths.archiveFile());
    if (o.rateLimit) a.push('--limit-rate', o.rateLimit);
    if (o.proxy) a.push('--proxy', o.proxy);
    if (o.cookieFile) a.push('--cookies', o.cookieFile);

    if (o.audioOnly) {
      a.push('-x', '--audio-format', o.audioFormat || 'mp3', '--audio-quality', '0');
      if (o.embedMetadata) a.push('--embed-metadata');
      if (o.embedThumbnail) a.push('--embed-thumbnail');
    } else {
      a.push('-f', buildFormat(o));
      a.push('--merge-output-format', 'mp4');
      if (o.embedMetadata) a.push('--embed-metadata');
    }

    if (item.liveStatus === 'is_live' && o.liveFromStart) a.push('--live-from-start');

    // 注意：字幕【不】在这里下载。
    // 曾经把 --write-subs 放在这条命令里，结果字幕请求被 YouTube 限流（HTTP 429）时
    // 整个 yt-dlp 退出码非 0，视频明明已经下好却被标记为「失败」。
    // 现在字幕改为视频落地后的独立步骤（_fetchSubtitles），失败只记录 subError，不影响成品。

    // 每个队列项都是单个视频：绝不要把整个播放列表一起拖下来。
    // 注意：这里刻意不使用 --no-part，即使直播也不使用——--no-part 会直接写目标文件，
    // 从而彻底破坏断点续传能力。
    a.push('--no-playlist');
    a.push(item.url);
    return a;
  }

  _onLine(item, line) {
    if (line.startsWith('DL|')) {
      const p = line.split('|');
      // DL|status|downloaded|total|total_est|speed|eta|filename
      const status = p[1];
      let downloaded = num(p[2]) || 0;
      const total = num(p[3]) || num(p[4]) || 0;
      const speed = num(p[5]) || 0;
      const eta = num(p[6]);
      const filename = p.slice(7).join('|');
      if (!item._files) item._files = {};
      // 某一路（如视频流）先前已下完时，yt-dlp 会直接报 finished 但 downloaded_bytes=0。
      // 这一路其实已经完整存在于磁盘上，必须按 total 计入进度，否则总进度会凭空虚低。
      if (status === 'finished' && downloaded === 0 && total > 0) downloaded = total;
      if (filename) item._files[filename] = { downloaded, total, done: status === 'finished' };
      const files = Object.values(item._files);
      const sumTotal = files.reduce((s, f) => s + (f.total || 0), 0);
      const sumDone = files.reduce((s, f) => s + (f.downloaded || 0), 0);
      item.downloadedBytes = sumDone;
      item.totalBytes = sumTotal;
      item.progress = sumTotal > 0 ? Math.max(0, Math.min(1, sumDone / sumTotal)) : item.progress || 0;
      item.speed = speed;
      item.eta = eta;
      item.stage = status === 'finished' ? '下载完成' : '下载中';
      item.interrupted = false;
      this.changed();
      return;
    }
    if (line.startsWith('PP|')) {
      const p = line.split('|');
      const status = p[1];
      const pp = (p[2] || '').split('+')[0];
      const label = POSTPROCESS_LABEL[pp] || pp || '后处理';
      item.stage = status === 'finished' ? `${label} 完成` : `${label}…`;
      item.speed = 0;
      item.eta = null;
      this.changed();
      return;
    }
    if (line.startsWith('FINAL|')) {
      item.filePath = line.slice(6).trim();
      this.changed();
      return;
    }
    const dest = line.match(/^\[download\] Destination: (.+)$/);
    if (dest) {
      item.filePath = dest[1].trim();
      this.changed();
      return;
    }
    const merge = line.match(/^\[Merger\] Merging formats into "(.+)"$/);
    if (merge) {
      item.filePath = merge[1].trim();
      item.stage = '合并音视频…';
      this.changed();
      return;
    }
    if (/has already been downloaded/i.test(line)) {
      item.alreadyDownloaded = true;
      item.stage = '已存在，跳过';
      this.changed();
      return;
    }
  }

  _onErrLine(item, line) {
    const m = line.match(/^ERROR:\s*(.*)$/i);
    if (m) item.error = m[1].slice(0, 500);
  }

  async _onExit(item, handle, code, stderr) {
    this.active.delete(item.key);
    item.speed = 0;
    item.eta = null;

    if (handle.remove) {
      this.items.delete(item.key);
      this.changed(true);
      this.pump();
      return;
    }
    if (handle.pause) {
      item.status = 'paused';
      item.stage = '已暂停（可继续，支持断点续传）';
      this.changed(true);
      this.pump();
      return;
    }

    if (code === 0) {
      // 「已存在，跳过」必须满足：本任务这一轮一个字节都没下。
      // 断点续传时 yt-dlp 会为已完成的那一路打印 "has already been downloaded"，
      // 若据此就判定整单跳过，会把「实际下载了几十 MB 并成功产出成品」误报成跳过。
      const downloadedAny = Object.values(item._files || {}).some((f) => (f.downloaded || 0) > 0) || (item.downloadedBytes || 0) > 0;
      const isSkip = !!item.alreadyDownloaded && !downloadedAny;
      item.status = isSkip ? 'skipped' : 'done';
      item.progress = 1;
      item.stage = isSkip ? '已存在，跳过' : '已完成';
      item.error = '';
      item.finishedAt = nowIso();
      item.subPaths = collectSubtitleFiles(item.filePath);
      this.changed(true);
      this.pump();

      // 视频落地后的两个「附加件」，都走本地/独立请求，失败一律不影响视频本身：
      //   1) 用内置 ffmpeg 从成品抽音轨成同名音频
      //   2) 单独拉一次字幕（避免字幕限流把整个任务拖失败）
      (async () => {
        try {
          const wantAudio =
            item.opts.alsoAudio != null ? item.opts.alsoAudio : settingsStore.load().alsoAudio !== false;
          if (wantAudio && !item.opts.audioOnly && item.filePath) await this._exportAudio(item);
        } catch (err) {
          console.error('[queue] export audio unexpected:', err && err.message);
        }
        try {
          await this._fetchSubtitles(item);
        } catch (err) {
          console.error('[queue] fetch subtitles unexpected:', err && err.message);
        }
      })();
      return;
    }

    const errText = item.error || ytdlp.extractErrors(stderr) || `yt-dlp 退出码 ${code}`;
    item.error = errText;

    const settings = settingsStore.load();
    const maxRetry = Math.max(0, Math.min(10, Number(settings.autoRetry) || 0));
    if (item.attempts < maxRetry) {
      item.attempts += 1;
      item.status = 'queued';
      item.stage = `失败，第 ${item.attempts} 次自动重试（断点续传）`;
      this.changed(true);
    } else {
      item.status = 'error';
      item.stage = '失败';
      this.changed(true);
    }
    this.pump();
  }

  /**
   * 从已下载的视频文件里抽出音轨，导出为同目录同名的 MP3。
   * 用本地 ffmpeg 转码，不再走网络，几秒钟完成；失败不影响视频本身（只记录 audioError）。
   */
  async _exportAudio(item) {
    const settings = settingsStore.load();
    const ff = paths.ffmpegPath(settings);
    const src = item.filePath;

    if (!ff) {
      item.audioError = '未找到 ffmpeg.exe，无法导出音频';
      this.changed(true);
      return;
    }
    if (!src || !fs.existsSync(src)) {
      item.audioError = '视频文件不存在，跳过音频导出';
      this.changed(true);
      return;
    }

    const fmt = (item.opts.audioFormat || 'mp3').toLowerCase() === 'm4a' ? 'm4a' : 'mp3';
    const out = src.replace(/\.[^.\\/]+$/, '.' + fmt);
    item.audioPath = out;
    item.extractingAudio = true;
    item.stage = '已完成 · 正在导出音频…';
    this.changed(true);

    try {
      if (fs.existsSync(out) && fs.statSync(out).size > 0) {
        item.audioError = '';
        item.stage = this._finalStage(item);
        return;
      }
      const codecArgs =
        fmt === 'm4a'
          ? ['-c:a', 'aac', '-b:a', '192k']
          : ['-c:a', 'libmp3lame', '-q:a', '0', '-id3v2_version', '3'];
      const args = [
        '-hide_banner',
        '-nostdin',
        '-loglevel',
        'error',
        '-nostats',
        '-y',
        '-i',
        src,
        '-vn',
        '-map_metadata',
        '0',
        ...codecArgs,
        out,
      ];
      const res = await ytdlp.run(ff, args);
      if (res.code !== 0 || !fs.existsSync(out) || fs.statSync(out).size === 0) {
        const tail = (res.stderr || '')
          .split(/\r?\n/)
          .map((l) => l.trim())
          .filter(Boolean)
          .slice(-2)
          .join(' ');
        throw new Error(tail || `ffmpeg 退出码 ${res.code}`);
      }
      item.audioError = '';
      item.stage = this._finalStage(item);
    } catch (err) {
      item.audioError = String((err && err.message) || err).slice(0, 300);
      item.stage = '已完成（音频导出失败）';
      console.error('[queue] export audio failed:', item.audioError);
    } finally {
      item.extractingAudio = false;
      this.changed(true);
    }
  }

  /**
   * 单独一次请求只抓字幕（--skip-download，不下媒体）。
   *
   * 两个已实测的坑：
   *  1. 字幕接口若与视频下载放在同一条命令里，字幕一失败（HTTP 429）整个任务就被判为失败，
   *     视频明明已经下好却显示「失败」→ 所以拆成独立步骤，失败只记 subError。
   *  2. YouTube 对「机器自动翻译」的字幕轨（英文视频请求 zh-Hans 这类）限流极严，
   *     经常稳定 429；而原生字幕轨（视频本身的语言）正常。
   *     因此「拿到了部分语言」必须算成功，不能报错，也不要为翻译轨反复重试浪费用户时间。
   */
  async _fetchSubtitles(item) {
    const settings = settingsStore.load();
    const bin = paths.ytDlpPath(settings);
    const want =
      item.opts.writeSubs != null ? item.opts.writeSubs : settings.writeSubs !== false;
    if (!want || !bin) return;
    if (!item.filePath) return; // 视频都没落地就没必要抓字幕

    const ffDir = paths.ffmpegDir(settings);
    const args = ytdlp.BASE_FLAGS.concat([
      '--skip-download',
      '--write-subs',
      '--no-overwrites',
      '--sub-langs',
      item.opts.subLangs || 'en',
      '--convert-subs',
      item.opts.subFormat || 'srt',
      '-P',
      item.opts.outputDir,
      '-o',
      item.opts.filenameTemplate || '%(title)s [%(upload_date>%Y-%m-%d)s].%(ext)s',
    ]);
    // YouTube 绝大多数视频只有「自动生成字幕」，不开这个会出现「明明有字幕却一个都没下」
    if (item.opts.writeAutoSubs !== false) args.push('--write-auto-subs');
    if (ffDir) args.push('--ffmpeg-location', ffDir);
    args.push('--no-playlist', item.url);

    item.fetchingSubs = true;
    item.stage = '已完成 · 正在抓取字幕…';
    this.changed(true);

    let lastErr = '';
    try {
      for (let attempt = 0; attempt < 2; attempt++) {
        const res = await ytdlp.run(bin, args);
        const got = collectSubtitleFiles(item.filePath);
        if (res.code === 0) {
          lastErr = '';
          break;
        }
        lastErr = ytdlp.extractErrors(res.stderr) || `yt-dlp 退出码 ${res.code}`;
        // 已经拿到部分语言就算成功（通常是翻译轨被限流），不再重试
        if (got.length > 0) break;
        // 只有限流/超时才退避重试一次，其它错误直接放弃
        if (!/429|Too Many Requests|timed out|Timeout/i.test(lastErr)) break;
        await new Promise((r) => setTimeout(r, 3000));
      }
      item.subPaths = collectSubtitleFiles(item.filePath);
      // --convert-subs 属于后处理阶段：只要有一个语言失败（如翻译轨 429）导致 yt-dlp 中途退出，
      // 后处理就被跳过，只会留下 .vtt。这里用内置 ffmpeg 本地兜底转成 .srt，保证格式一致。
      await this._normalizeSubtitles(item);
      item.subPaths = collectSubtitleFiles(item.filePath);
      // 一个字幕都没拿到才算失败；拿到一部分说明只是某些语言（多为翻译轨）不可用
      item.subError = item.subPaths.length === 0 && lastErr ? lastErr.slice(0, 200) : '';
      if (item.subPaths.length > 0 && lastErr) {
        console.log(
          `[queue] 部分字幕语言未能获取（通常是 YouTube 对自动翻译轨限流）：${lastErr.slice(0, 120)}`
        );
      }
    } finally {
      item.fetchingSubs = false;
      item.stage = this._finalStage(item);
      this.changed(true);
    }
  }

  /** 把非 .srt 的字幕本地转成 .srt（兜底，见 _fetchSubtitles 里的说明） */
  async _normalizeSubtitles(item) {
    const fmt = String(item.opts.subFormat || 'srt').toLowerCase();
    if (fmt !== 'srt') return;
    const ff = paths.ffmpegPath(settingsStore.load());
    if (!ff) return;
    for (const f of collectSubtitleFiles(item.filePath)) {
      if (/\.srt$/i.test(f)) continue;
      const out = f.replace(/\.[^.\\/]+$/, '.srt');
      try {
        if (fs.existsSync(out) && fs.statSync(out).size > 0) {
          fs.unlinkSync(f);
          continue;
        }
        const res = await ytdlp.run(ff, [
          '-hide_banner',
          '-nostdin',
          '-loglevel',
          'error',
          '-nostats',
          '-y',
          '-i',
          f,
          out,
        ]);
        if (res.code === 0 && fs.existsSync(out) && fs.statSync(out).size > 0) {
          fs.unlinkSync(f);
        } else {
          console.error('[queue] 字幕转 srt 失败:', path.basename(f));
        }
      } catch (err) {
        console.error('[queue] 字幕转 srt 异常:', err && err.message);
      }
    }
  }

  /** 根据实际产出决定「已完成」的措辞 */
  _finalStage(item) {
    const bits = [];
    if (item.filePath) bits.push('视频');
    if (item.audioPath) bits.push('音频');
    if ((item.subPaths || []).length) bits.push(`${item.subPaths.length} 个字幕`);
    return bits.length > 1 ? `已完成（${bits.join(' + ')}）` : '已完成';
  }

  // ---------- 用户操作 ----------

  async pause(key) {
    const item = this.items.get(key);
    if (!item) return false;
    if (item.status === 'queued') {
      item.status = 'paused';
      item.stage = '已暂停';
      this.changed(true);
      return true;
    }
    if (item.status !== 'downloading') return false;
    const h = this.active.get(key);
    if (h) {
      h.pause = true;
      h.canceled = true;
      await ytdlp.killTree(h.child);
    }
    return true;
  }

  resume(key) {
    const item = this.items.get(key);
    if (!item) return false;
    if (item.status !== 'paused' && item.status !== 'error' && item.status !== 'canceled') return false;
    item.status = 'queued';
    item.error = '';
    item.stage = item.interrupted ? '继续下载（断点续传）' : '重新排队';
    this.changed(true);
    this.pump();
    return true;
  }

  retry(key) {
    const item = this.items.get(key);
    if (!item) return false;
    item.attempts = 0;
    item.status = 'queued';
    item.error = '';
    item.stage = '重试中';
    this.changed(true);
    this.pump();
    return true;
  }

  async remove(key) {
    const h = this.active.get(key);
    if (h) {
      h.remove = true;
      h.canceled = true;
      await ytdlp.killTree(h.child);
      return true;
    }
    this.items.delete(key);
    this.changed(true);
    return true;
  }

  /** 清空：done / error / canceled / all */
  clear(filter) {
    let removed = 0;
    for (const [key, it] of Array.from(this.items.entries())) {
      if (this.active.has(key)) continue;
      const match =
        filter === 'all'
          ? true
          : filter === 'done'
          ? it.status === 'done' || it.status === 'skipped'
          : filter === 'error'
          ? it.status === 'error' || it.status === 'canceled'
          : false;
      if (match) {
        this.items.delete(key);
        removed++;
      }
    }
    this.changed(true);
    return removed;
  }

  pauseAll() {
    return Promise.all(
      Array.from(this.items.values())
        .filter((it) => it.status === 'downloading' || it.status === 'queued')
        .map((it) => this.pause(it.key))
    );
  }

  resumeAll() {
    for (const it of this.items.values()) {
      if (it.status === 'paused' || it.status === 'error' || it.status === 'canceled') {
        it.status = 'queued';
        it.error = '';
        it.stage = '继续下载（断点续传）';
      }
    }
    this.changed(true);
    this.pump();
  }

  /** 退出前把正在下载的任务落盘为可续传状态 */
  async shutdown() {
    const tasks = [];
    for (const [key, h] of this.active.entries()) {
      const item = this.items.get(key);
      if (item) {
        item.status = 'queued';
        item.interrupted = true;
        item.stage = '已中断，下次启动继续（断点续传）';
      }
      h.canceled = true;
      tasks.push(ytdlp.killTree(h.child));
    }
    await Promise.all(tasks);
    this.active.clear();
    try {
      const list = Array.from(this.items.values());
      fs.writeFileSync(paths.queueFile(), JSON.stringify(list, null, 2), 'utf8');
    } catch (_) {}
  }
}

module.exports = { DownloadQueue, QUALITY_LIMIT, buildFormat, POSTPROCESS_LABEL };
