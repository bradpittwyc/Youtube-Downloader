'use strict';
/**
 * 学习文档功能的对外入口。
 * 输入：视频的英文字幕 + 视频元信息 + 设置
 * 输出：中英双语 SRT + Word 学习文档
 *
 * 带结果缓存：翻译一次后落盘，重新生成文档（例如改了排版选项）不再产生 API 费用。
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { spawnSync } = require('child_process');
const sub = require('./subtitle');
const assMod = require('./ass');
const llm = require('./llm');
const secret = require('./secret');
const { runStudyPipeline, runSummaryOnly, estimateTokens, summarize } = require('./pipeline');
const { buildStudyDocx } = require('./word');

/**
 * 写文件，并把人话讲清楚被占用的错误。
 * 最常见的场景：用户正开着这份 Word 文档或播放器占着字幕，此时 Windows 会返回 EBUSY。
 */
function writeFileSafe(p, data) {
  try {
    fs.writeFileSync(p, data);
  } catch (err) {
    const code = err && err.code;
    if (code === 'EBUSY' || code === 'EPERM' || code === 'EACCES') {
      throw new Error(
        `文件被占用，写不进去：${path.basename(p)}。如果它正在 Word 或播放器里打开，请先关闭再重试。`
      );
    }
    if (code === 'ENOSPC') {
      throw new Error(`磁盘空间不足，无法写入：${path.basename(p)}`);
    }
    throw err;
  }
}

/** 从视频路径推导产物路径 */
function derivePaths(videoPath, srtPath) {
  const base = videoPath ? videoPath.replace(/\.[^.\\/]+$/, '') : String(srtPath).replace(/\.en\.srt$/i, '');
  return {
    bilingualSrt: `${base}.zh-en.srt`,
    ass: `${base}.zh-en.ass`,
    docx: `${base}.学习文档.docx`,
  };
}

/**
 * 用 ffmpeg 探测视频分辨率。
 * ASS 的 PlayResX/PlayResY 必须与真实分辨率一致，否则字号和定位会整体错乱；
 * 下载时抓到的宽高优先，这里是老任务/异常情况的兜底。
 */
function probeVideoSize(ffmpegExe, file) {
  if (!ffmpegExe || !file || !fs.existsSync(file)) return null;
  try {
    const r = spawnSync(ffmpegExe, ['-hide_banner', '-i', file], {
      encoding: 'utf8',
      windowsHide: true,
    });
    const text = (r.stderr || '') + (r.stdout || '');
    const m = text.match(/Video:[\s\S]*?,\s*(\d{2,5})x(\d{2,5})/);
    if (m) {
      const width = parseInt(m[1], 10);
      const height = parseInt(m[2], 10);
      if (width > 0 && height > 0) return { width, height };
    }
  } catch (_) {
    /* 探测失败就退回默认值 */
  }
  return null;
}

/** 把设置里的 LLM 配置取出来（API Key 在此解密） */
function llmConfigFrom(settings) {
  return {
    baseURL: String(settings.studyBaseURL || '').trim(),
    apiKey: secret.open(settings.studyApiKey),
    model: String(settings.studyModel || '').trim(),
    temperature: settings.studyTemperature != null ? Number(settings.studyTemperature) : 0.2,
    hasKey: !!secret.open(settings.studyApiKey),
  };
}

function isConfigured(cfg) {
  return !!(cfg.baseURL && cfg.apiKey && cfg.model);
}

/** 生成前预估 token 与费用（人民币），用于界面提示 */
function estimateFor(srtPath, settings, durationMs) {
  const { cues, stats } = sub.loadCues(srtPath);
  const est = estimateTokens(cues);
  const inPrice = Number(settings.studyPriceIn) || 0;
  const outPrice = Number(settings.studyPriceOut) || 0;
  const cost = (est.input / 1e6) * inPrice + (est.output / 1e6) * outPrice;
  return {
    stats,
    durationMs: durationMs || stats.durationMs,
    inputTokens: est.input,
    outputTokens: est.output,
    costCny: cost,
    hasPrice: inPrice > 0 || outPrice > 0,
  };
}

// ---------------------------------------------------------------- 结果缓存

function cacheDir() {
  const dir = path.join(require('../paths').userDataDir(), 'study-cache');
  try {
    fs.mkdirSync(dir, { recursive: true });
  } catch (_) {}
  return dir;
}

function cacheKey(videoId, srtPath) {
  const h = crypto.createHash('sha1').update(String(videoId || srtPath)).digest('hex').slice(0, 16);
  return path.join(cacheDir(), `${h}.json`);
}

function readCache(videoId, srtPath, model, opts) {
  try {
    const f = cacheKey(videoId, srtPath);
    if (!fs.existsSync(f)) return null;
    const j = JSON.parse(fs.readFileSync(f, 'utf8'));
    if (j.model !== model) return null;
    // allowStale：提示词升级后仍允许取回旧翻译（只补跑结构分析，不重译全文）
    if (j.promptVersion !== llm.PROMPT_VERSION && !(opts && opts.allowStale)) return null;
    // summaryDone：确认这份缓存里已经包含 Takeaways / 金句。
    // 没有这个标记的（早期版本写的，或补总结时失败留下的）一律当作不完整，
    // 走「复用翻译 + 只补总结」的轻量路径，而不是直接拿来用导致文档缺内容。
    if (j.summaryDone !== true && !(opts && opts.allowStale)) return null;
    if (!j.segments || !j.segments.length) return null;
    return j;
  } catch (_) {
    return null;
  }
}

/** 统一构造缓存内容，避免两处写入字段不一致 */
function cachePayload(cfg, res) {
  return {
    ts: Date.now(),
    model: cfg.model,
    promptVersion: llm.PROMPT_VERSION,
    segments: res.segments,
    vocab: res.vocab,
    cueZh: res.cueZh,
    takeaways: res.takeaways || [],
    quotes: res.quotes || [],
    /** 标记：这份缓存已经包含 Takeaways / 金句，可以放心直接用 */
    summaryDone: true,
    cues: (res.cues || []).map((c) => ({ start: c.start, end: c.end, text: c.text })),
    stats: res.stats,
    usage: res.usage,
  };
}

function writeCache(videoId, srtPath, payload) {
  try {
    fs.writeFileSync(cacheKey(videoId, srtPath), JSON.stringify(payload), 'utf8');
  } catch (err) {
    console.error('[study] 写缓存失败:', err && err.message);
  }
}

// ---------------------------------------------------------------- 主流程

/**
 * 执行完整流程并落盘。
 * @param {object} o
 * @param {string} o.srtPath   英文字幕路径（必需）
 * @param {string} o.videoPath 视频路径（用于推导产物名）
 * @param {string} [o.videoId] 视频 ID（缓存键）
 * @param {object} o.meta      { title, channel, durationMs, uploadDate, url }
 * @param {object} o.settings  应用设置
 * @param {function} [o.onProgress]
 * @param {boolean} [o.force]  忽略缓存，强制重新调用大模型
 */
async function generateForVideo(o) {
  const cfg = llmConfigFrom(o.settings);
  const settings = o.settings;
  const onProgress = o.onProgress || (() => {});

  if (!o.srtPath || !fs.existsSync(o.srtPath)) {
    throw new Error('找不到英文字幕文件，无法生成学习文档');
  }

  let res = null;
  let fromCache = false;
  let staleDoc = null; // 旧版本缓存的全文翻译（缺 takeaways / quotes），可复用

  if (!o.force) {
    const cached = readCache(o.videoId, o.srtPath, cfg.model);
    if (cached) {
      res = cached;
      fromCache = true;
      onProgress({ phase: 'cache', done: 0, total: 1, label: '命中翻译缓存，不再调用大模型' });
    } else {
      // 提示词升级后（例如新增了 Takeaways / 金句）旧缓存会失效。
      // 但逐段翻译很贵，而缺的只是「结构分析」那一次调用的产物，
      // 所以这里把旧翻译捡回来，只补跑结构分析，不重译全文。
      const loose = readCache(o.videoId, o.srtPath, cfg.model, { allowStale: true });
      if (loose && (loose.segments || []).length) staleDoc = loose;
    }
  }

  if (!res && staleDoc) {
    if (!isConfigured(cfg)) {
      throw new Error('尚未配置大模型 API（请在设置里填写 Base URL、API Key 与模型名）');
    }
    onProgress({ phase: 'summary', done: 0, total: 1, label: '复用已有翻译，补生成 Takeaways 与金句' });
    const sum = await runSummaryOnly({ srtPath: o.srtPath, cfg, cues: staleDoc.cues });
    res = Object.assign({}, staleDoc, {
      takeaways: sum.takeaways || [],
      quotes: sum.quotes || [],
      usage: Object.assign({}, staleDoc.usage || {}, {
        prompt: ((staleDoc.usage || {}).prompt || 0) + (sum.usage.prompt || 0),
        completion: ((staleDoc.usage || {}).completion || 0) + (sum.usage.completion || 0),
        calls: ((staleDoc.usage || {}).calls || 0) + (sum.usage.calls || 0),
        summaryOnly: true,
      }),
    });
    fromCache = true;
    writeCache(o.videoId, o.srtPath, cachePayload(cfg, res));
  }

  if (!res) {
    if (!isConfigured(cfg)) {
      throw new Error('尚未配置大模型 API（请在设置里填写 Base URL、API Key 与模型名）');
    }
    res = await runStudyPipeline({
      srtPath: o.srtPath,
      cfg,
      onProgress,
      concurrency: Number(settings.studyConcurrency) || 3,
      maxSegCues: Number(settings.studyMaxSegCues) || 45,
    });
    writeCache(o.videoId, o.srtPath, cachePayload(cfg, res));
  }

  const paths = derivePaths(o.videoPath, o.srtPath);
  const wrote = { bilingualSrt: '', ass: '', docx: '' };

  // 分辨率：优先用下载时抓到的，其次 ffmpeg 探测，最后退回 1920x1080
  let size = null;
  if (Number(o.width) > 0 && Number(o.height) > 0) {
    size = { width: Number(o.width), height: Number(o.height) };
  } else {
    size = probeVideoSize(require('../paths').ffmpegPath(settings), o.videoPath);
  }
  const vw = (size && size.width) || 1920;
  const vh = (size && size.height) || 1080;

  // ---- 中英双语 ASS（可分别设色 + 黑描边）----
  if (settings.studyAss !== false) {
    onProgress({ phase: 'write', done: 0, total: 3, label: '生成双语 ASS 字幕' });
    const assText = assMod.buildAss({
      cues: res.cues,
      cueZh: res.cueZh,
      title: (o.meta && o.meta.title) || '',
      width: vw,
      height: vh,
      options: {
        colorEn: settings.assColorEn,
        colorZh: settings.assColorZh,
        outlineColor: settings.assOutlineColor,
        outlineWidth: settings.assOutlineWidth,
        borderStyle: settings.assBorderStyle,
        shadow: settings.assShadow,
        fontScale: settings.assFontScale,
        fontEn: settings.assFontEn,
        fontZh: settings.assFontZh,
        lineGap: settings.assLineGap,
        wrapEnChars: settings.assWrapEnChars,
        wrapZhChars: settings.assWrapZhChars,
      },
    });
    if (assText.trim()) {
      writeFileSafe(paths.ass, assText);
      wrote.ass = paths.ass;
      // 同一个视频旁边若还留着旧的 .zh-en.srt，播放器可能挑它加载，结果"看不到颜色"。
      // 关闭 srt 输出时顺手清掉——这是本工具自己生成的产物，且随时可从缓存免费重建。
      if (settings.studyBilingualSrt === false && fs.existsSync(paths.bilingualSrt)) {
        try {
          fs.unlinkSync(paths.bilingualSrt);
          console.log('[study] 已清理旧的 .zh-en.srt（避免播放器加载它而看不到 ASS 颜色）');
        } catch (_) {}
      }
    }
  }

  // ---- 双语 SRT（可选，兼容性更好）----
  if (settings.studyBilingualSrt !== false) {
    onProgress({ phase: 'write', done: 1, total: 3, label: '生成双语字幕' });
    const srtText = sub.buildBilingualSrt(res.cues, res.cueZh);
    if (srtText.trim()) {
      // 带 BOM 的 UTF-8。SRT 没有声明编码的地方，而 Windows 自带播放器
      // （Media Player / Windows Media Player）遇到无 BOM 的 UTF-8 常按 ANSI 解析，
      // 中文会整片乱码。加 BOM 后 VLC / PotPlayer / MPC / ffmpeg 也都正常。
      writeFileSafe(paths.bilingualSrt, '\uFEFF' + srtText);
      wrote.bilingualSrt = paths.bilingualSrt;
    }
  }

  // ---- Word ----
  if (res.segments && res.segments.length) {
    onProgress({ phase: 'write', done: 2, total: 3, label: '排版 Word 文档' });
    const buf = await buildStudyDocx({
      meta: Object.assign({}, o.meta, { model: cfg.model }),
      segments: res.segments,
      vocab: res.vocab || [],
      takeaways: res.takeaways || [],
      quotes: res.quotes || [],
      options: {
        includePureEnglish: settings.studyIncludePureEnglish !== false,
        includeVocabTable: settings.studyIncludeVocab !== false,
        segmentTimecode: settings.studyTimecode !== false,
      },
    });
    writeFileSafe(paths.docx, buf);
    wrote.docx = paths.docx;  }

  return {
    paths: wrote,
    fromCache,
    segments: res.segments,
    vocab: res.vocab || [],
    failed: res.failed || [],
    stats: res.stats,
    usage: res.usage,
    summary: fromCache ? '使用翻译缓存重新排版' : summarize(res, cfg),
  };
}

function clearCache(videoId, srtPath) {
  try {
    const f = cacheKey(videoId, srtPath);
    if (fs.existsSync(f)) fs.unlinkSync(f);
  } catch (_) {}
}

/**
 * 取出某个视频已生成的金句（做金句卡片用）。
 * 金句只存在学习缓存里，不需要重新调用大模型。
 * allowStale：即使提示词版本升级过，旧缓存里的金句照样能用。
 */
function readQuotesFor(videoId, srtPath, model) {
  const j = readCache(videoId, srtPath, model, { allowStale: true });
  return (j && Array.isArray(j.quotes) ? j.quotes : []).filter((q) => q && (q.en || q.zh));
}

module.exports = {
  generateForVideo,
  estimateFor,
  derivePaths,
  llmConfigFrom,
  isConfigured,
  clearCache,
  writeFileSafe,
  probeVideoSize,
  readQuotesFor,
};
