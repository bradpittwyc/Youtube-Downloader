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
  /**
   * 每个视频单独建一个文件夹（文件夹名 = 命名模板渲染结果），
   * 该视频的视频/音频/字幕/ASS/学习文档全部放进去，避免下载目录被大量文件铺满。
   */
  organizeInFolder: true,
  /**
   * 博主母文件夹的命名方式（以博主主页抓取的内容才会套这层母文件夹）：
   *   handle → @lexfridman（易读，默认）
   *   id     → UCSHZKyawb77ixDdsGog4iWA（YouTube 内部频道 ID，最稳定）
   *   title  → Lex Fridman（频道显示名，可能含空格/特殊字符）
   */
  channelFolderName: 'handle',
  skipDownloaded: true,
  rateLimit: '', // 例如 '2M'，空 = 不限速
  proxy: '',
  /**
   * cookies.txt 文件路径。与 cookieBrowser 二选一，**文件优先**（明确指定，更好排错）。
   * 两者都会作用于【所有】yt-dlp 调用：下载、抓字幕、频道识别、视频探测。
   */
  cookieFile: '',
  /**
   * 从浏览器直接读 Cookies（yt-dlp --cookies-from-browser）。
   * 用于绕过 YouTube 的「Sign in to confirm you're not a bot」风控，
   * 比手动导出 cookies.txt 省事得多。取值如 edge / chrome / firefox。
   */
  cookieBrowser: '',
  liveFromStart: false, // 直播：从开头录制（需要该直播支持 DVR）
  embedMetadata: true,
  embedThumbnail: true, // 仅音频生效；视频嵌入封面需转码，默认不启用
  ytDlpPath: '',
  ffmpegPath: '',
  autoRetry: 3,
  /**
   * 全部任务跑完后自动关机。
   * 睡前挂一批下载、下完自动关机是常见用法。
   * 默认关闭 —— 这是会关掉整台机器的操作，必须用户明确打开。
   */
  shutdownAfterDone: false,
  /** 关机前的等待秒数，这段时间内可以取消 */
  shutdownDelaySec: 60,
  /** 有失败任务时是否也关机（默认也关：重试已经用完了，留着也没意义） */
  shutdownEvenIfFailed: true,
  // 每个标签页最多识别多少个内容（0 = 不限制）。
  //
  // 【为什么默认不是 0】实测 @marvel 有一万多个内容，全部翻完要 3 分 13 秒，
  // 而界面一次只显示 80 条 —— 那一万条对用户毫无用处，纯属白等。
  // 这个上限会**真正传给 yt-dlp**（--playlist-end），让它翻够就停，
  // 而不是把全部数据拉回来再丢掉（那样网络开销一分没省）。
  maxItemsPerChannel: 300,
  // 每个标签页最多展开多少个「容器」（podcasts / 播放列表这类需要二级抓取的）。
  // 每个容器是一次独立的 yt-dlp 调用 —— Huberman 那种有 428 个容器，
  // 全展开是几百次请求，比标签页本身慢得多。
  maxContainersPerTab: 40,
  /**
   * 读取频道的「播放列表」标签页。
   * 该标签页返回的是播放列表容器，需要逐个二级展开才能拿到视频，
   * 请求量可能很大（实测 @OpenAI 有 58 个播放列表），卡顿时可关闭。
   */
  readPlaylists: true,

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
  /**
   * 中英双语字幕的产出形式。
   * ASS 是唯一支持「逐行独立颜色/描边」的字幕格式（SRT 零样式、mov_text 支持极差），
   * 因此要做「中英不同色 + 黑边」必须用 ASS。
   * .srt 兼容性更好但与 .ass 并存时播放器加载哪个不一定，默认不再生成。
   */
  studyAss: true,
  /**
   * 是否同时输出双语 SRT。
   *
   * 【为什么默认是 true】ASS 有颜色/描边/精确定位，但**需要支持 ASS 的播放器**；
   * Windows 11 自带的 Media Player 根本不支持 ASS，只认 SRT。
   * 只给 ASS 的话，用默认播放器的用户会「一个字幕都看不到」。
   * 两个都输出最稳妥：播放器支持 ASS 就选 ASS 轨（有颜色），不支持就选 SRT 轨。
   * 单文件里可以手动切轨，不存在"选错就没了"的问题。
   */
  studyBilingualSrt: true,
  assColorEn: '#FFFFFF', // 英文字色（白）
  assColorZh: '#FFD700', // 中文字色（琥珀）
  assOutlineColor: '#000000', // 黑描边
  // 描边粗细（相对 1080 高度，会按视频分辨率等比缩放）。
  // 作者对比过 0~5 各档，认为 1 最好：细描边更利落，不会把衬线体的笔画糊住。
  // 换算：2160p → 2.0，1080p → 1.0，360p → 0.3，相对字号一律是 2%，各分辨率视觉一致。
  assOutlineWidth: 1,
  assBorderStyle: 1, // 1=描边  3=背景框
  assShadow: 0,
  assFontScale: 1, // 整体字号缩放
  /** 字幕字体：英文用衬线体更适合阅读，中文用雅黑保证字形完整 */
  assFontEn: 'Times New Roman',
  assFontZh: '微软雅黑',
  /**
   * 中英之间的额外行距，单位是英文字号的倍数。
   * 0 = libass 自然排版（间距恒等于英文下伸部空间，偏大）；负值把英文往下拉。
   */
  assLineGap: -0.2,
  /**
   * 折行上限。0 = 自动：不设人为上限，一行尽量铺满可用宽度，真装不下才折行。
   * 作者明确要求「不需要换行，尽量展开」，实测放开后中文 0 条要折行、
   * 英文只剩 0.05%。填具体数值可以更早折行（控制每行阅读长度）。
   */
  assWrapEnChars: 0,
  assWrapZhChars: 0,
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
  // 识别上限迁移：旧默认是 0（不限），实测大频道要翻 2 分 45 秒才回来，
  // 而界面上一次只显示 80 条 —— 那几万条纯属白等。老设置里的 0 一律升到新默认。
  // （想要"不限"的用户可以在设置里显式改回 0，那之后不会再被迁移覆盖。）
  if (s.maxItemsPerChannel === 0 && !s.maxItemsMigrated) {
    s.maxItemsPerChannel = DEFAULTS.maxItemsPerChannel;
    s.maxItemsMigrated = true;
  }
  return s;
}

function load() {
  if (cache) return cache;
  const file = settingsFile();
  let disk = {};
  let migrated = false;
  try {
    if (fs.existsSync(file)) {
      // 同样容忍 UTF-8 BOM（外部工具用 PowerShell 改过就会带上）
      disk = JSON.parse(fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, '')) || {};
    }
  } catch (_) {
    disk = {};
  }
  // 【已撤销的一次性迁移】早期版本在这里把 studyBilingualSrt 自动关掉，
  // 理由是「.srt 与 .ass 并存时播放器可能挑 srt，导致看不到颜色」。
  //
  // 这个假设是错的，而且代价很大：**Windows 自带的 Media Player（Win11 默认）
  // 根本不支持 ASS**，只认 SRT。于是「关掉双语 SRT」= 一个字幕都看不到
  // （作者实测：默认播放器打开视频画面里没有任何字幕）。
  //
  // 正确做法是两个都生成：播放器支持 ASS 就选 ASS（有颜色），
  // 不支持就选 SRT（没颜色但能看中文）。让用户按自己的播放器选轨，
  // 而不是替他假定一个播放器。
  //
  // 下面这条反向迁移把「被自动关掉」的配置重新打开。
  // 用 bilingualSrtFixed 做标记，之后用户若真的想关，手动关掉不会再被覆盖。
  if (disk.bilingualSrtFixed !== true) {
    // 【注意】必须判断 !== true，不能只判断 === false。
    // 老配置里往往【根本没有这个字段】，此时内层条件不成立、
    // 标记却被打上，于是永远不再修正
    // （实测踩过：改完之后仍然是只有 ASS、没有 SRT）。
    if (disk.studyBilingualSrt !== true) {
      disk.studyBilingualSrt = true;
      migrated = true;
      console.log('[settings] 已恢复双语 SRT 输出（ASS 需要支持的播放器，Windows 自带的读不了）');
    }
    disk.bilingualSrtFixed = true;
    migrated = true;
  }
  // 识别上限迁移（值本身在 normalize 里改，这里只负责把它落到磁盘上）
  if (disk.maxItemsPerChannel === 0 && !disk.maxItemsMigrated) {
    migrated = true;
  }
  // 折行上限迁移：默认从「英文 44 字符 / 中文 22 字宽」改成 0 =【自动铺满可用宽度】。
  // 老配置里存着 44 / 22（那正是当时的默认值），不迁移的话改动对他们完全无效。
  // 只认这两个「旧默认值」，用户若填过别的数值（真的是自己想要的）不动。
  // 用 wrapAutoFixed 做标记，之后想手动设回来不会再被覆盖。
  if (disk.wrapAutoFixed !== true) {
    let changed = false;
    if (disk.assWrapEnChars === 44) {
      disk.assWrapEnChars = 0;
      changed = true;
    }
    if (disk.assWrapZhChars === 22) {
      disk.assWrapZhChars = 0;
      changed = true;
    }
    disk.wrapAutoFixed = true;
    migrated = true;
    if (changed) {
      console.log('[settings] 字幕折行改为「自动铺满可用宽度」（原来限制在 44 / 22，会提前折行）');
    }
  }
  // 模型名迁移：deepseek-chat / deepseek-reasoner 是旧名字，
  // 服务端虽然还在静默转发（响应里 model 已经是 deepseek-flash），
  // 但 /v1/models 里已经不再列出它们，随时可能彻底停用。
  //
  // 【为什么敢改】缓存键是 videoId + srtPath，模型名只是另外比对的；
  // 而且 llm.canonicalModel() 会把新旧名字归一化成同一个身份，
  // 所以改名字**不会让已有的翻译缓存失效**，不用重新花钱。
  // 只迁移「恰好等于旧默认名」的情况，用户自己填的其它模型一律不动。
  if (disk.modelNameFixed !== true) {
    const OLD_TO_NEW = { 'deepseek-chat': 'deepseek-flash', 'deepseek-reasoner': 'deepseek-v4-pro' };
    const cur = String(disk.studyModel || '').trim();
    if (OLD_TO_NEW[cur]) {
      disk.studyModel = OLD_TO_NEW[cur];
      console.log(`[settings] 模型名 ${cur} → ${disk.studyModel}（旧名已被服务端转发，改成正式名字；缓存不受影响）`);
    }
    disk.modelNameFixed = true;
    migrated = true;
  }
  cache = normalize(Object.assign({}, DEFAULTS, disk));
  if (migrated) {
    try {
      fs.writeFileSync(file, JSON.stringify(cache, null, 2), 'utf8');
      console.log('[settings] 已迁移设置（含频道识别上限）');
    } catch (_) {}
  }
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

