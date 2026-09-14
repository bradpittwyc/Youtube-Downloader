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
const quoteCard = require('./quote-card');

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
    // 用【归一化后的模型名】比对：deepseek-chat 与 deepseek-flash 其实是同一个后端，
    // 不做归一化的话，把配置里的旧名改成新名会让所有已付费的缓存瞬间失效。
    if (llm.canonicalModel(j.model) !== llm.canonicalModel(model)) return null;
    // allowStale：提示词升级后仍允许取回旧翻译（只补跑结构分析，不重译全文）
    if (j.promptVersion !== llm.PROMPT_VERSION && !(opts && opts.allowStale)) return null;
    // summaryDone：确认这份缓存里已经包含 Takeaways / 金句。
    // 没有这个标记的（早期版本写的，或补总结时失败留下的）一律当作不完整，
    // 走「复用翻译 + 只补总结」的轻量路径，而不是直接拿来用导致文档缺内容。
    if (j.summaryDone !== true && !(opts && opts.allowStale)) return null;
    // 【自愈】summaryDone 说「总结已完成」，但要点与金句都是空的 —— 这份缓存是坏的。
    //
    // 实测成因：结构分析那一步开着「思考」，思考量把 max_tokens 撑爆 → 三次尝试全部
    // 截断 → 退化成均分兜底，此时 takeaways 与 quotes 全空，可 summaryDone 照样被写上。
    // 结果是文档没有要点/金句、也不出金句图，而缓存却判定「命中、无需重跑」。
    // 这里把它当成不完整，让它走轻量路径只补一次结构分析（1 次调用，很便宜）。
    if (
      j.summaryDone === true &&
      !(opts && opts.allowStale) &&
      !(j.takeaways || []).length &&
      !(j.quotes || []).length
    ) {
      console.warn('[study] 缓存里要点与金句都是空的，按不完整处理（只补跑一次结构分析）');
      return null;
    }
    if (!j.segments || !j.segments.length) return null;
    return j;
  } catch (_) {
    return null;
  }
}

// ---------------------------------------------------------------- 中间结果（断点续跑）
//
// 逐段翻译是整个流水线里最贵的一步（一个 93 段的视频约 ¥0.68、十几分钟）。
// 以前只在全部跑完之后才写缓存，所以进程中途被杀（关 App、打包、系统更新）
// 就把已经翻好的段落全丢了，下次从 0 重来、重新花钱。
//
// 这里把中间结果单独落一份文件：每翻完一段就更新，跑完后再删掉。
// 它记录的是【最终形态】的分段计划（已过句末吸附与大段拆分），
// 续跑时直接复用这份计划 + 已完成的段落，于是只翻剩下的。

function partialKey(videoId, srtPath) {
  return cacheKey(videoId, srtPath).replace(/\.json$/, '.partial.json');
}

function readPartial(videoId, srtPath, model) {
  try {
    const f = partialKey(videoId, srtPath);
    if (!fs.existsSync(f)) return null;
    const j = JSON.parse(fs.readFileSync(f, 'utf8'));
    // 同 readCache：模型名归一化后再比，改名不会丢掉断点续跑的中间结果
    if (llm.canonicalModel(j.model) !== llm.canonicalModel(model)) return null;
    if (j.promptVersion !== llm.PROMPT_VERSION) return null;
    if (!Array.isArray(j.plan) || !j.plan.length) return null;
    if (!j.segments || !Object.keys(j.segments).length) return null;
    return j;
  } catch (_) {
    return null;
  }
}

function writePartial(videoId, srtPath, cfg, state) {
  try {
    fs.writeFileSync(
      partialKey(videoId, srtPath),
      JSON.stringify({
        ts: Date.now(),
        model: cfg.model,
        promptVersion: llm.PROMPT_VERSION,
        cuesFp: state.cuesFp,
        plan: state.plan,
        struct: state.struct,
        segments: state.segments,
        planMoved: state.planMoved,
        planSplit: state.planSplit,
        done: state.done,
        total: state.total,
      })
    );
  } catch (err) {
    console.error('[study] 写中间结果失败:', err && err.message);
  }
}

function deletePartial(videoId, srtPath) {
  try {
    const f = partialKey(videoId, srtPath);
    if (fs.existsSync(f)) fs.unlinkSync(f);
  } catch (_) {}
}

/** 统一构造缓存内容，避免两处写入字段不一致 */function cachePayload(cfg, res) {
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
    // 断点续跑：上次没跑完就接着跑，只翻缺的那些段，不重复花钱。
    // force 时忽略中间结果（用户明确要求重来）。
    const partial = o.force ? null : readPartial(o.videoId, o.srtPath, cfg.model);
    if (partial) {
      const n = Object.keys(partial.segments || {}).length;
      console.log(`[study] 发现上次的中间结果：已完成 ${n}/${partial.plan.length} 段，继续`);
    }
    // 进度写盘做节流：每段都写会产生很多次磁盘 IO（文件最终几百 KB），
    // 但最后一段必须写进去，否则「就差最后一段」时被杀会白翻。
    let lastWrite = 0;
    let pending = null;
    res = await runStudyPipeline({
      srtPath: o.srtPath,
      cfg,
      onProgress,
      concurrency: Number(settings.studyConcurrency) || 3,
      maxSegCues: Number(settings.studyMaxSegCues) || 45,
      resume: partial,
      onPartial: (st) => {
        pending = st;
        const now = Date.now();
        const isLast = st.done >= st.total;
        if (!isLast && now - lastWrite < 1500) return;
        lastWrite = now;
        pending = null;
        writePartial(o.videoId, o.srtPath, cfg, st);
      },
    });
    if (pending) writePartial(o.videoId, o.srtPath, cfg, pending);
    writeCache(o.videoId, o.srtPath, cachePayload(cfg, res));
    // 全文跑完了，中间结果没用了（留着只会让下次误判成「还没跑完」）
    deletePartial(o.videoId, o.srtPath);
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
    wrote.docx = paths.docx;
  }

  // ---- 金句卡片 ----
  // 以前要在队列里点「金句图」按钮才生成，作者要求改成自动产出：
  // 文档里既然已经有金句，顺手渲染成图片就行，不用再按一次。
  // 单独 try/catch —— 渲染卡片依赖 Electron 窗口，万一失败也绝不能连累文档。
  const quotes = res.quotes || [];
  if (quotes.length) {
    onProgress({ phase: 'write', done: 3, total: 4, label: '渲染金句卡片' });
    try {
      const base = o.videoPath
        ? String(o.videoPath).replace(/\.[^.\\/]+$/, '')
        : path.join(settings.outputDir || '', String(o.videoId || '').replace(/[\\/:*?"<>|]/g, '_'));
      const outDir = `${base}.金句卡片`;
      const r = await quoteCard.renderQuoteCards({
        quotes,
        meta: { title: (o.meta && o.meta.title) || '', channel: (o.meta && o.meta.channel) || '', url: (o.meta && o.meta.url) || '' },
        outDir,
        accent: settings.assColorZh || '#FFD166',
      });
      if (r.ok) {
        wrote.quoteCards = r.dir;
        wrote.quoteCardCount = r.files.length;
      } else {
        console.warn('[study] 金句卡片未生成:', r.error);
      }
    } catch (err) {
      console.error('[study] 金句卡片渲染失败:', err && err.message);
    }
  }

  return {
    paths: wrote,
    fromCache,
    segments: res.segments,
    vocab: res.vocab || [],
    quotes,
    failed: res.failed || [],
    stats: res.stats,
    usage: res.usage,
    // 结构分析退化成均分兜底时，takeaways 与 quotes 都是空的。
    // 界面要据此提示「本次没有要点与金句」，别让用户只看到「没有金句图」却查不出原因。
    fallbackPlan: !!(res.usage && res.usage.fallbackPlan),
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
  probeVideoSize,
};
