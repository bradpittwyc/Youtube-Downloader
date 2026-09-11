'use strict';
/**
 * 设置持久化（userData/settings.json）
 */
const fs = require('fs');
const path = require('path');
const { settingsFile, userDataDir } = require('./paths');

const OUTPUT_FOLDER_NAME = 'YouTube下载';

/** 旧版默认文件名模板，用于自动迁移到新模板（标题 + 上传日期） */
const LEGACY_FILENAME_TEMPLATE = '%(title)s [%(id)s].%(ext)s';
/** 新默认：标题 + 上传日期，简洁明了 */
const DEFAULT_FILENAME_TEMPLATE = '%(title)s [%(upload_date>%Y-%m-%d)s].%(ext)s';

/**
 * 挑选默认下载目录。
 * 默认优先放在 F 盘（用户要求：不要占 C 盘），F 盘不存在时依次尝试其他非 C 盘数据盘，
 * 全都不可用才退回系统「视频」目录。只选真实可写、且有足够空间的盘，避免换台机器就崩。
 */
function pickDefaultOutputDir() {
  const PREFERRED = ['F', 'D', 'E', 'G', 'H', 'I', 'J', 'K', 'L', 'M', 'N'];
  for (const letter of PREFERRED) {
    const root = `${letter}:\\`;
    try {
      if (!fs.existsSync(root)) continue;
      fs.accessSync(root, fs.constants.W_OK);
      const st = fs.statfsSync ? fs.statfsSync(root) : null;
      // 至少留 2GB 余量，避免选到快满的盘
      if (st && st.bavail * st.bsize < 2 * 1024 * 1024 * 1024) continue;
      return path.join(root, OUTPUT_FOLDER_NAME);
    } catch (_) {
      /* 试下一个盘 */
    }
  }
  try {
    return path.join(require('electron').app.getPath('videos'), OUTPUT_FOLDER_NAME);
  } catch (_) {
    return path.join(userDataDir(), OUTPUT_FOLDER_NAME);
  }
}

/** 旧版本的默认下载目录（在 C 盘 userData 下），用于迁移 */
function legacyDefaultOutputDir() {
  return path.join(userDataDir(), 'downloads');
}

const DEFAULTS = {
  outputDir: pickDefaultOutputDir(),
  concurrency: 2,
  quality: 'best', // best | 2160 | 1440 | 1080 | 720 | 480 | 360
  /**
   * 视频编码策略（关键：决定成品有没有声音）
   *  'quality' 画质优先：最佳视频编码（AV1/VP9）+ 强制 AAC 音频（MP4）
   *  'compat'  兼容优先：H.264 + AAC（MP4），剪辑软件/老设备通吃，但分辨率上限 1080p
   * 两者都保证音频是 AAC —— 绝不能把 Opus 塞进 MP4，否则大多数播放器「有画面没声音」。
   */
  videoCodec: 'quality',
  audioOnly: false,
  audioFormat: 'mp3',
  /** 下载视频时，额外在同目录导出一份同名音频文件 */
  alsoAudio: true,
  /** 下载字幕（YouTube 多数视频只有自动生成字幕，因此默认连自动字幕一起抓） */
  writeSubs: true,
  writeAutoSubs: true,
  /**
   * 只要原生英文字幕。刻意不请求 zh-Hans 这类「自动翻译轨」：
   * 实测 YouTube 对翻译轨（timedtext 的 tlang 请求）限流极狠，几乎稳定返回 HTTP 429，
   * 而原生语言字幕轨完全正常。取不到的翻译轨只会徒增失败与等待。
   */
  subLangs: 'en',
  subFormat: 'srt',
  embedSubs: false,
  filenameTemplate: DEFAULT_FILENAME_TEMPLATE,
  skipDownloaded: true,
  rateLimit: '', // 例如 '2M'，空 = 不限速
  proxy: '',
  cookieFile: '',
  liveFromStart: false, // 直播：从开头录制（需要该直播支持 DVR）
  embedMetadata: true,
  embedThumbnail: true, // 仅音频生效；视频嵌入封面需转码，默认不启用
  ytDlpPath: '',
  ffmpegPath: '',
  autoRetry: 3,
  maxItemsPerChannel: 0, // 0 = 不限制

  // ---------------- 学习文档（调用大模型） ----------------
  /** 字幕下载完成后自动生成中英对照学习文档 */
  studyDoc: true,
  studyBaseURL: 'https://api.deepseek.com/v1',
  /** 用 safeStorage 加密后的 Key（enc:v1: 前缀）；历史数据可能是明文 */
  studyApiKey: '',
  studyModel: 'deepseek-chat',
  studyTemperature: 0.2,
  studyConcurrency: 3,
  studyMaxSegCues: 45,
  studyIncludePureEnglish: true,
  studyIncludeVocab: true,
  studyTimecode: true,
  /** 生成双语 SRT（中英双行） */
  studyBilingualSrt: true,
  /** 价格（元 / 百万 token），仅用于费用预估显示 */
  studyPriceIn: 2,
  studyPriceOut: 8,
  /** 护栏：默认全部不启用（用户要求下完就自动生成） */
  studyMinDurationSec: 0, // 0 = 不限制
  studyMaxCostPerVideo: 0, // 0 = 不限制
  studyMaxCostPerBatch: 0, // 0 = 不限制
};

let cache = null;

/**
 * 归一化：空值 / 旧版默认目录（C 盘 userData\downloads）→ 换成新默认目录；
 * 盘符已不存在（例如拔了移动硬盘）→ 回退到默认目录，避免下载全部失败。
 * load 与 save 都会调用，保证磁盘上永远不会留下不可用的路径。
 */
function normalize(s) {
  const cur = s.outputDir;
  if (!cur || cur === legacyDefaultOutputDir()) {
    s.outputDir = DEFAULTS.outputDir;
  } else {
    try {
      const root = path.parse(cur).root;
      if (!root || !fs.existsSync(root)) s.outputDir = DEFAULTS.outputDir;
    } catch (_) {
      s.outputDir = DEFAULTS.outputDir;
    }
  }
  // 文件名模板迁移：旧默认模板（标题+视频ID）自动换成新默认（标题+上传日期）
  if (!s.filenameTemplate || s.filenameTemplate === LEGACY_FILENAME_TEMPLATE) {
    s.filenameTemplate = DEFAULT_FILENAME_TEMPLATE;
  }
  // 字幕语言迁移：早期的默认值含 zh-Hans（对英文视频属自动翻译轨，必被 429），改成只取原生英文
  if (!s.subLangs || s.subLangs === 'zh-Hans,en') {
    s.subLangs = DEFAULTS.subLangs;
  }
  return s;
}

function load() {
  if (cache) return cache;
  const file = settingsFile();
  let disk = {};
  try {
    if (fs.existsSync(file)) disk = JSON.parse(fs.readFileSync(file, 'utf8')) || {};
  } catch (_) {
    disk = {};
  }
  cache = normalize(Object.assign({}, DEFAULTS, disk));
  return cache;
}

function save(patch) {
  const cur = normalize(Object.assign(load(), patch || {}));
  try {
    fs.mkdirSync(path.dirname(settingsFile()), { recursive: true });
    fs.writeFileSync(settingsFile(), JSON.stringify(cur, null, 2), 'utf8');
  } catch (err) {
    console.error('[settings] save failed:', err.message);
  }
  return cur;
}

function reset() {
  cache = Object.assign({}, DEFAULTS);
  return save({});
}

module.exports = {
  DEFAULTS,
  load,
  save,
  reset,
  normalize,
  pickDefaultOutputDir,
  OUTPUT_FOLDER_NAME,
  DEFAULT_FILENAME_TEMPLATE,
  LEGACY_FILENAME_TEMPLATE,
};

