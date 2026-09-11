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
const sub = require('./subtitle');
const llm = require('./llm');
const secret = require('./secret');
const { runStudyPipeline, estimateTokens, summarize } = require('./pipeline');
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

/** 从视频路径推导产物路径 */function derivePaths(videoPath, srtPath) {
  const base = videoPath ? videoPath.replace(/\.[^.\\/]+$/, '') : String(srtPath).replace(/\.en\.srt$/i, '');
  return {
    bilingualSrt: `${base}.zh-en.srt`,
    docx: `${base}.学习文档.docx`,
  };
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

function readCache(videoId, srtPath, model) {
  try {
    const f = cacheKey(videoId, srtPath);
    if (!fs.existsSync(f)) return null;
    const j = JSON.parse(fs.readFileSync(f, 'utf8'));
    if (j.model !== model || j.promptVersion !== llm.PROMPT_VERSION) return null;
    if (!j.segments || !j.segments.length) return null;
    return j;
  } catch (_) {
    return null;
  }
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

  if (!o.force) {
    const cached = readCache(o.videoId, o.srtPath, cfg.model);
    if (cached) {
      res = cached;
      fromCache = true;
      onProgress({ phase: 'cache', done: 0, total: 1, label: '命中翻译缓存，不再调用大模型' });
    }
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
    writeCache(o.videoId, o.srtPath, {
      ts: Date.now(),
      model: cfg.model,
      promptVersion: llm.PROMPT_VERSION,
      segments: res.segments,
      vocab: res.vocab,
      cueZh: res.cueZh,
      cues: res.cues.map((c) => ({ start: c.start, end: c.end, text: c.text })),
      stats: res.stats,
      usage: res.usage,
    });
  }

  const paths = derivePaths(o.videoPath, o.srtPath);
  const wrote = { bilingualSrt: '', docx: '' };

  // 双语 SRT
  if (settings.studyBilingualSrt !== false) {
    onProgress({ phase: 'write', done: 0, total: 2, label: '生成双语字幕' });
    const srtText = sub.buildBilingualSrt(res.cues, res.cueZh);
    if (srtText.trim()) {
      writeFileSafe(paths.bilingualSrt, srtText);
      wrote.bilingualSrt = paths.bilingualSrt;
    }
  }

  // Word
  if (res.segments && res.segments.length) {
    onProgress({ phase: 'write', done: 1, total: 2, label: '排版 Word 文档' });
    const buf = await buildStudyDocx({
      meta: Object.assign({}, o.meta, { model: cfg.model }),
      segments: res.segments,
      vocab: res.vocab || [],
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

module.exports = {
  generateForVideo,
  estimateFor,
  derivePaths,
  llmConfigFrom,
  isConfigured,
  clearCache,
  writeFileSafe,
};
