'use strict';
/**
 * 学习文档流水线：字幕 → 清洗 → 结构分段 → 逐段翻译/精讲/词汇 → 汇总。
 *
 * 两遍法：
 *   第一遍只看结构，产出分段计划（输出很小，成本低）
 *   第二遍按段精加工，每段独立可缓存、可重试、可并行
 *
 * 实测的取舍（详见项目 README 踩坑记录）：
 *   · 未做边界吸附时 17/24 段会出现残句 → 现在吸附到句末，0 残句
 *   · 大段（50+ 条）模型容易漏条目，触发整段重发 → 主动切到 45 条以内
 *   · 逐条中文用 JSON 数组会被模型合并 → 改行分隔格式
 */
const path = require('path');
const fs = require('fs');
const sub = require('./subtitle');
const llm = require('./llm');

const DEFAULT_MAX_SEG_CUES = 45;
const DEFAULT_CONCURRENCY = 3;

/** 把分段边界吸附到最近的句末条目上，避免切断句子 */
function snapPlanToSentences(plan, cues) {
  const MIN_SEG = 4;
  const flags = cues.map((c) => sub.endsSentence(c.text));
  const adj = plan.map((p) => Object.assign({}, p));
  let moved = 0;
  for (let k = 0; k < adj.length - 1; k++) {
    const cur = adj[k];
    const nxt = adj[k + 1];
    if (flags[cur.to - 1]) continue;
    let best = null;
    for (let d = 1; d <= 4 && best === null; d++) {
      const back = cur.to - d;
      const fwd = cur.to + d;
      if (back >= cur.from + MIN_SEG - 1 && flags[back - 1]) best = back;
      else if (fwd <= nxt.to - MIN_SEG + 1 && flags[fwd - 1]) best = fwd;
    }
    if (best == null) continue;
    cur.to = best;
    nxt.from = best + 1;
    moved++;
  }
  return { plan: adj, moved };
}

/** 主动把过大的段拆小（在句末处切），避免模型漏条目导致昂贵的重发 */
function splitOversizedSegments(plan, cues, maxCues) {
  if (!maxCues || maxCues < 8) return { plan, splitCount: 0 };
  const out = [];
  let splitCount = 0;
  for (const seg of plan) {
    const n = seg.to - seg.from + 1;
    if (n <= maxCues) {
      out.push(seg);
      continue;
    }
    const parts = Math.ceil(n / maxCues);
    const target = Math.ceil(n / parts);
    let from = seg.from;
    for (let p = 0; p < parts; p++) {
      let to = p === parts - 1 ? seg.to : Math.min(seg.to - 1, from + target - 1);
      if (p < parts - 1) {
        let best = null;
        for (let d = 0; d <= 6 && best === null; d++) {
          for (const cand of [to + d, to - d]) {
            if (cand > from + 3 && cand < seg.to && sub.endsSentence(cues[cand - 1].text)) {
              best = cand;
              break;
            }
          }
        }
        if (best != null) to = best;
      }
      out.push({ from, to, topic: p === 0 ? seg.topic : `${seg.topic}（续${p}）` });
      if (p < parts - 1) splitCount++;
      from = to + 1;
    }
  }
  return { plan: out, splitCount };
}

/** 粗略估算 token（中英混排按 3 字符/token 估），用于生成前给出费用预估 */
function estimateTokens(cues) {
  const chars = cues.reduce((s, c) => s + c.text.length, 0);
  const input = Math.round(chars / 3.2) + 900; // 结构分析的输入
  const inputTranslate = Math.round(chars / 3.2) * 2.1; // 翻译段（原文 + 逐段提示开销）
  const output = Math.round(chars / 3.0) * 2.2; // 英文重排 + 中文 + 逐条中文 + 精讲词汇
  return { input: Math.round(input + inputTranslate), output: Math.round(output) };
}

/**
 * 执行完整流水线。
 * @param {object} o
 * @param {string} o.srtPath      英文字幕路径
 * @param {object} o.cfg          { baseURL, apiKey, model, temperature }
 * @param {object} [o.meta]       视频元信息（标题/频道/时长/链接等），仅用于日志
 * @param {function} [o.onProgress] ({phase, done, total, label})
 * @param {number} [o.concurrency]
 * @param {number} [o.maxSegCues]
 * @param {number} [o.maxCues]    只处理前 N 条（调试用）
 */
async function runStudyPipeline(o) {
  const cfg = o.cfg;
  const onProgress = o.onProgress || (() => {});
  const concurrency = Math.max(1, Math.min(6, o.concurrency || DEFAULT_CONCURRENCY));
  const maxSegCues = o.maxSegCues || DEFAULT_MAX_SEG_CUES;
  const usage = { prompt: 0, completion: 0, calls: 0, repairs: 0, splits: 0 };
  const t0 = Date.now();

  const loaded = sub.loadCues(o.srtPath);
  let work = loaded.cues;
  if (o.maxCues > 0 && work.length > o.maxCues) work = work.slice(0, o.maxCues);
  if (!work.length) throw new Error('字幕清洗后没有任何内容');

  // ---------- 第一遍：结构分析 ----------
  onProgress({ phase: 'structure', done: 0, total: 1, label: '分析内容结构' });
  const structLines = sub.buildStructureLines(work);
  let plan = null;
  for (let attempt = 1; attempt <= 2 && !plan; attempt++) {
    const r = await llm.callLLM(
      cfg,
      [
        { role: 'system', content: llm.STRUCT_SYSTEM },
        { role: 'user', content: structLines.join('\n') },
      ],
      4096
    );
    usage.prompt += r.usage.prompt_tokens || 0;
    usage.completion += r.usage.completion_tokens || 0;
    usage.calls++;
    try {
      const candidate = llm.parseJsonLoose(r.content);
      if (llm.validatePlan(candidate, work.length).length === 0) plan = candidate;
    } catch (_) {
      /* 重试 */
    }
  }
  if (!plan) throw new Error('结构分析失败（模型两次都没给出合法分段计划）');

  // 边界吸附
  const snapped = snapPlanToSentences(plan, work);
  if (snapped.moved > 0 && llm.validatePlan(snapped.plan, work.length).length === 0) {
    plan = snapped.plan;
  }
  // 大段切分
  const sized = splitOversizedSegments(plan, work, maxSegCues);
  if (sized.splitCount > 0 && llm.validatePlan(sized.plan, work.length).length === 0) {
    plan = sized.plan;
  }

  // ---------- 第二遍：逐段精加工 ----------
  const results = new Array(plan.length).fill(null);
  let cursor = 0;
  let done = 0;

  async function translateSeg(seg, contextText, depth) {
    const segCues = work.slice(seg.from - 1, seg.to);
    const expected = segCues.map((_, i) => seg.from + i);
    const baseMsg =
      `【上下文：上一段结尾，仅供理解，不要翻译】\n${contextText}\n\n` +
      `【本段字幕碎片（序号|文本）】\n` +
      segCues.map((c, i) => `${expected[i]}|${c.text}`).join('\n');

    let lastErr = '';
    let lastMissing = [];
    for (let attempt = 1; attempt <= 2; attempt++) {
      let userMsg = baseMsg;
      if (attempt === 2 && lastMissing.length) {
        usage.repairs++;
        userMsg +=
          `\n\n【重要】上一次你的输出漏掉了这些序号：${lastMissing.slice(0, 40).join(', ')}` +
          `${lastMissing.length > 40 ? ` 等 ${lastMissing.length} 条` : ''}。` +
          `本次必须输出与输入完全一致的 ${expected.length} 条 cues，一条不能少、也不能多。`;
      }
      try {
        const r = await llm.callLLM(
          cfg,
          [
            { role: 'system', content: llm.TRANSLATE_SYSTEM },
            { role: 'user', content: userMsg },
          ],
          8192
        );
        usage.prompt += r.usage.prompt_tokens || 0;
        usage.completion += r.usage.completion_tokens || 0;
        usage.calls++;
        const out = llm.parseJsonLoose(r.content);
        const v = llm.validateCues(out, expected);
        if (v.ok) {
          return {
            ok: true,
            data: Object.assign({}, out, {
              cues: v.parsed,
              _seg: seg,
              _cues: segCues,
              _expected: expected,
            }),
          };
        }
        lastMissing = v.missing;
        lastErr = `逐条覆盖不符：缺 ${v.missing.length} 条、多 ${v.extra.length} 条`;
      } catch (err) {
        lastErr = err.message;
      }
    }

    // 仍失败 → 拆半递归
    if (depth < 3 && expected.length >= 12) {
      usage.splits++;
      const mid = Math.floor((seg.from + seg.to) / 2);
      const a = await translateSeg({ from: seg.from, to: mid, topic: seg.topic }, contextText, depth + 1);
      const ctxB = a.ok ? String(a.data.en).split(/(?<=[.!?])\s+/).slice(-2).join(' ') : contextText;
      const b = await translateSeg({ from: mid + 1, to: seg.to, topic: seg.topic }, ctxB, depth + 1);
      if (a.ok && b.ok) {
        return {
          ok: true,
          data: {
            en: (String(a.data.en) + ' ' + String(b.data.en)).replace(/\s+/g, ' ').trim(),
            zh: (String(a.data.zh || '') + String(b.data.zh || '')).replace(/\s+/g, ''),
            notes: [].concat(a.data.notes || [], b.data.notes || []),
            vocab: [].concat(a.data.vocab || [], b.data.vocab || []),
            cues: [].concat(a.data.cues, b.data.cues),
            _seg: seg,
            _cues: [].concat(a.data._cues, b.data._cues),
            _expected: [].concat(a.data._expected, b.data._expected),
          },
        };
      }
      return { ok: false, error: lastErr, seg };
    }
    return { ok: false, error: lastErr, seg };
  }

  async function contextFor(idx) {
    if (idx === 0) return '（这是全文第一段）';
    for (let i = 0; i < 240; i++) {
      const prev = results[idx - 1];
      if (prev) {
        if (prev._failed) return '（上一段处理失败，无上下文）';
        return String(prev.en).split(/(?<=[.!?])\s+/).slice(-2).join(' ') || '（无上下文）';
      }
      await new Promise((r) => setTimeout(r, 250));
    }
    return '（上一段超时未完成，无上下文）';
  }

  async function worker() {
    while (true) {
      const idx = cursor++;
      if (idx >= plan.length) return;
      const seg = plan[idx];
      const ctx = await contextFor(idx);
      const r = await translateSeg(seg, ctx, 0);
      results[idx] = r.ok ? r.data : { _failed: r.error, _seg: seg };
      done++;
      onProgress({ phase: 'translate', done, total: plan.length, label: seg.topic });
    }
  }
  onProgress({ phase: 'translate', done: 0, total: plan.length, label: '开始翻译' });
  await Promise.all(Array.from({ length: concurrency }, worker));

  // ---------- 汇总 ----------
  const segments = [];
  const cueZh = {};
  const failed = [];
  results.forEach((r, i) => {
    const seg = r._seg || plan[i];
    if (r._failed) {
      failed.push({ topic: seg.topic, error: r._failed });
      return;
    }
    for (const c of r.cues || []) cueZh[c.i] = c.zh;
    segments.push({
      index: segments.length + 1,
      topic: seg.topic,
      from: seg.from,
      to: seg.to,
      startMs: work[seg.from - 1].start,
      en: String(r.en || '').trim(),
      zh: String(r.zh || '').trim(),
      notes: (r.notes || []).filter((n) => n && n.sentence && n.explain),
      vocab: (r.vocab || []).filter((v) => v && v.word),
    });
  });

  // 词汇全局聚合：按词形归并、按出现次数排序
  const vocabMap = new Map();
  for (const s of segments) {
    for (const v of s.vocab) {
      const key = String(v.word).toLowerCase().trim();
      if (!key) continue;
      const cur = vocabMap.get(key);
      if (cur) {
        cur.count++;
      } else {
        vocabMap.set(key, {
          word: v.word,
          phonetic: v.phonetic || '',
          pos: v.pos || '',
          def: v.def || '',
          count: 1,
        });
      }
    }
  }
  const vocabAgg = [...vocabMap.values()].sort((a, b) => b.count - a.count || a.word.localeCompare(b.word));

  return {
    segments,
    cueZh,
    cues: work,
    vocab: vocabAgg,
    failed,
    stats: Object.assign({}, loaded.stats, {
      usedCues: work.length,
      segments: segments.length,
      failedSegments: failed.length,
      elapsedMs: Date.now() - t0,
      planMoved: snapped.moved,
      planSplit: sized.splitCount,
    }),
    usage,
  };
}

/** 汇总报告用的简要统计行 */
function summarize(res, cfg) {
  const s = res.stats;
  return [
    `模型 ${cfg.model}`,
    `字幕 ${s.raw} 条 → 清洗 ${s.final} 条（丢重复 ${s.dropped}）`,
    `分段 ${s.segments} 段${s.failedSegments ? `（失败 ${s.failedSegments}）` : ''}`,
    `调用 ${res.usage.calls} 次（补漏 ${res.usage.repairs}、拆半 ${res.usage.splits}）`,
    `token 输入 ${res.usage.prompt} / 输出 ${res.usage.completion}`,
    `耗时 ${(s.elapsedMs / 1000).toFixed(1)}s`,
  ].join(' · ');
}

module.exports = {
  runStudyPipeline,
  snapPlanToSentences,
  splitOversizedSegments,
  estimateTokens,
  summarize,
  DEFAULT_MAX_SEG_CUES,
  DEFAULT_CONCURRENCY,
};
