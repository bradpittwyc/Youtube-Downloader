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

/** 主动把过大的段拆小（在句末处切），避免模型漏条目导致昂贵的重发 */function splitOversizedSegments(plan, cues, maxCues) {
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

/**
 * 兜底分段：模型没给出可用计划时，按条数均分，尽量切在句末。
 * 用途只有一个 —— 别让整份文档因为分段这一步生不出来。
 */
function fallbackPlan(cues, targetCues) {
  const total = cues.length;
  const per = Math.max(20, Math.min(Number(targetCues) || DEFAULT_MAX_SEG_CUES, total));
  const parts = Math.max(1, Math.ceil(total / per));
  const out = [];
  let from = 1;
  for (let p = 0; p < parts && from <= total; p++) {
    let to = p === parts - 1 ? total : Math.min(total, from + per - 1);
    if (p < parts - 1) {
      // 往后找最近的句末，避免把句子劈开
      for (let d = 0; d <= 8; d++) {
        const cand = to + d;
        if (cand < total && sub.endsSentence(cues[cand - 1].text)) {
          to = cand;
          break;
        }
      }
    }
    out.push({ from, to, topic: `第 ${p + 1} 部分` });
    from = to + 1;
  }
  return out;
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
 * 字幕指纹：条数 + 首尾文本。
 * 断点续跑时用它确认「还是同一份字幕」—— 字幕变了就不能复用上次的分段计划，
 * 否则段落区间会和实际内容对不上。
 */
function cuesFingerprint(cues) {
  if (!cues || !cues.length) return '0';
  const a = String(cues[0].text || '').slice(0, 40);
  const b = String(cues[cues.length - 1].text || '').slice(0, 40);
  return `${cues.length}|${a}|${b}`;
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
 * @param {object} [o.resume]     上次中断时的中间结果（见 partialState）
 * @param {function} [o.onPartial] 每翻完一段回调一次，调用方负责落盘
 */
async function runStudyPipeline(o) {
  const cfg = o.cfg;
  const onProgress = o.onProgress || (() => {});
  const onPartial = o.onPartial || null;
  const concurrency = Math.max(1, Math.min(6, o.concurrency || DEFAULT_CONCURRENCY));
  const maxSegCues = o.maxSegCues || DEFAULT_MAX_SEG_CUES;
  const usage = { prompt: 0, completion: 0, calls: 0, repairs: 0, splits: 0 };
  const t0 = Date.now();

  const loaded = sub.loadCues(o.srtPath);
  let work = loaded.cues;
  if (o.maxCues > 0 && work.length > o.maxCues) work = work.slice(0, o.maxCues);
  if (!work.length) throw new Error('字幕清洗后没有任何内容');

  const cuesFp = cuesFingerprint(work);

  // ---------- 第一遍：结构分析 ----------
  onProgress({ phase: 'structure', done: 0, total: 1, label: '分析内容结构' });
  // 【关键】把「总条数」明确告诉模型。
  // 以前只让模型自己从最后一行去数，长字幕下它几乎必然算错结尾 ——
  // 实测 2758 条的视频喂 639 行，要精确对齐到第 2758 条基本靠碰运气。
  const structInput = buildStructMessage(work);

  let plan = null;
  let struct = { takeaways: [], quotes: [] };
  let lastErrs = null;
  /** 续跑复用：plan 下标 → 已完成的结果 */
  const resumed = new Map();
  let planMoved = 0;
  let planSplit = 0;
  /** 计划是否已经是「最终形态」（续跑时是，重新生成时还要经过吸附与拆分） */
  let planIsFinal = false;

  // 断点续跑：上次的中间结果如果对得上（同一份字幕、同一份计划），直接接着跑。
  // 这里复用的是【最终形态】的计划（已经过句末吸附与大段拆分），
  // 所以下面必须跳过那两个变换 —— 再变换一次会得到完全不同的段落划分，
  // 已翻好的段落就对不上了。
  if (o.resume && o.resume.cuesFp === cuesFp && Array.isArray(o.resume.plan) && o.resume.plan.length) {
    const rp = o.resume;
    if (llm.validatePlan(rp.plan, work.length).length === 0) {
      plan = rp.plan.map((p) => Object.assign({}, p));
      planIsFinal = true;
      planMoved = Number(rp.planMoved) || 0;
      planSplit = Number(rp.planSplit) || 0;
      if (rp.struct && ((rp.struct.takeaways || []).length || (rp.struct.quotes || []).length)) {
        struct = { takeaways: rp.struct.takeaways || [], quotes: rp.struct.quotes || [] };
      }
      for (const [k, v] of Object.entries(rp.segments || {})) {
        const i = Number(k);
        if (Number.isInteger(i) && i >= 0 && i < plan.length && v) resumed.set(i, v);
      }
      usage.resumed = resumed.size;
      console.log(`[study] 断点续跑：复用上次的分段计划，已完成 ${resumed.size}/${plan.length} 段`);
    } else {
      console.log('[study] 上次的中间结果与当前字幕对不上，重新开始');
    }
  }

  // 续跑时 plan 已经就位（且已是最终形态），整段跳过结构分析 —— 省一次调用
  for (let attempt = 1; !plan && attempt <= 3; attempt++) {
    // 重试时把「上一次哪里不合格」告诉模型，否则同样的输入只会得到同样的错
    const userContent = lastErrs
      ? `${structInput}\n\n【上一次的输出不合格】\n${lastErrs.slice(0, 6).join('\n')}\n请针对以上问题修正后，重新输出完整 JSON。`
      : structInput;
    try {
      const r = await llm.callLLM(
        cfg,
        [
          { role: 'system', content: llm.STRUCT_SYSTEM },
          { role: 'user', content: userContent },
        ],
        8192,
        // 【必须关思考】这一步要输出「完整分段计划 + 要点 + 金句」，而模型一思考就是
        // 4000~8700 个 token，且思考也算进 max_tokens。实测同一份 2046 条字幕：
        //   4096 开思考  → 截断
        //   8192 开思考  → 照样截断（思考吃了 8193）
        //   16384 开思考 → 能成，但要 41 秒、烧 8649 个思考 token
        //   4096 关思考  → 6 秒成功，plan 24 段 / takeaways 5 / quotes 6
        // 更阴的是它**间歇性**：三次尝试都截断就静默退化成兜底均分，
        // takeaways 与 quotes 全空 —— 用户只会看到「没有金句图」，查不出原因。
        { reasoning: 'off' }
      );
      usage.prompt += r.usage.prompt_tokens || 0;
      usage.completion += r.usage.completion_tokens || 0;
      usage.calls++;

      // 【曾经的 bug】这里直接把解析出来的对象丢给 validatePlan，
      // 而 validatePlan 期望数组 —— 于是永远判定「不是非空数组」，
      // 两次重试必然失败，任何没有翻译缓存的新视频都生不出文档。
      // 必须用 extractStruct 先拆出 plan。
      const st = llm.extractStruct(llm.parseJsonLoose(r.content));
      if (st.takeaways.length || st.quotes.length) {
        struct = { takeaways: st.takeaways, quotes: st.quotes };
      }
      const errs = llm.validatePlan(st.plan, work.length);
      if (!errs.length) {
        plan = st.plan;
        break;
      }
      const repaired = llm.repairPlan(st.plan, work.length);
      if (repaired) {
        console.log(`[study] 分段计划有 ${errs.length} 处偏差，已自动修复`);
        plan = repaired;
        break;
      }
      lastErrs = errs;
    } catch (err) {
      lastErrs = [String((err && err.message) || err).slice(0, 200)];
    }
  }
  if (!plan) {
    // 兜底：模型完全没给出可用计划时按条数均分（切在句末）。
    // 分段粗糙总比整份文档生不出来好。
    plan = fallbackPlan(work, maxSegCues);
    usage.fallbackPlan = 1;
    console.warn('[study] 模型未给出可用分段计划，改用均分兜底');
  }

  // 边界吸附 + 大段切分。
  // 【续跑时必须跳过】——上次存的计划已经是这一步之后的最终形态，
  // 再变换一次会得到完全不同的段落划分，已翻好的段落就对不上了。
  let snappedMoved = planMoved;
  let splitCount = planSplit;
  if (!planIsFinal) {
    const snapped = snapPlanToSentences(plan, work);
    if (snapped.moved > 0 && llm.validatePlan(snapped.plan, work.length).length === 0) {
      plan = snapped.plan;
      snappedMoved = snapped.moved;
    }
    const sized = splitOversizedSegments(plan, work, maxSegCues);
    if (sized.splitCount > 0 && llm.validatePlan(sized.plan, work.length).length === 0) {
      plan = sized.plan;
      splitCount = sized.splitCount;
    }
  }

  // ---------- 第二遍：逐段精加工 ----------
  const results = new Array(plan.length).fill(null);
  let cursor = 0;

  // 续跑：把上次翻好的段落填回去（只存了必要字段，_seg/_cues/_expected 在此重建，
  // 这样中间文件小得多，也不会因为字幕内容被写两遍而膨胀）
  for (const [i, v] of resumed) {
    const seg = plan[i];
    if (!seg) continue;
    results[i] = Object.assign({}, v, {
      _seg: seg,
      _cues: work.slice(seg.from - 1, seg.to),
      _expected: Array.from({ length: seg.to - seg.from + 1 }, (_, k) => seg.from + k),
    });
  }
  let done = resumed.size;

  /** 把当前进度交给调用方落盘（只带必要字段） */
  function emitPartial() {
    if (!onPartial) return;
    const segs = {};
    results.forEach((r, i) => {
      if (!r || r._failed) return;
      segs[i] = {
        en: r.en,
        zh: r.zh,
        notes: r.notes || [],
        vocab: r.vocab || [],
        cues: r.cues || [],
      };
    });
    try {
      onPartial({
        cuesFp,
        plan,
        struct,
        segments: segs,
        planMoved: snappedMoved,
        planSplit: splitCount,
        done: Object.keys(segs).length,
        total: plan.length,
      });
    } catch (err) {
      console.error('[study] 写中间结果失败:', err && err.message);
    }
  }

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
          8192,
          // 翻译是「照本宣科」的活，不需要推理。实测对推理模型关掉思考后
          // 同一段 45 条字幕：10.5s → 6.3s、2959 → 2149 token，产出质量没差别。
          // 也能避免思考把 max_tokens 吃光导致返回空 content。
          { reasoning: 'off' }
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
      // 续跑：这一段上次已经翻好了，直接跳过（不调用模型、不花钱）。
      // 【不要 done++】—— done 已经初始化成 resumed.size，再自增就会重复计数，
      // 界面上会看到「15/14」「20/14」这种超出总数的进度（实测踩过）。
      if (results[idx]) {
        continue;
      }
      const seg = plan[idx];
      const ctx = await contextFor(idx);
      const r = await translateSeg(seg, ctx, 0);
      results[idx] = r.ok ? r.data : { _failed: r.error, _seg: seg };
      done++;
      onProgress({ phase: 'translate', done, total: plan.length, label: seg.topic });
      // 每翻完一段就把进度交给调用方落盘 —— 中途被杀掉也不至于全部重来
      emitPartial();
    }
  }
  // 续跑时进度从 resumed.size 起算，这里要把「已经翻好的」也算进去
  onProgress({ phase: 'translate', done: resumed.size, total: plan.length, label: resumed.size ? '继续上次的进度' : '开始翻译' });
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
    takeaways: struct.takeaways,
    quotes: resolveQuoteTimes(struct.quotes, work),
    failed,
    stats: Object.assign({}, loaded.stats, {
      usedCues: work.length,
      segments: segments.length,
      failedSegments: failed.length,
      elapsedMs: Date.now() - t0,
      planMoved: snappedMoved,
      planSplit: splitCount,
      /** 断点续跑复用了多少段（0 表示这次是全新的） */
      resumedSegments: resumed.size,
    }),
    usage,
  };
}

/** 汇总报告用的简要统计行 */
function summarize(res, cfg) {
  const s = res.stats;
  const parts = [
    `模型 ${cfg.model}`,
    `字幕 ${s.raw} 条 → 清洗 ${s.final} 条（丢重复 ${s.dropped}）`,
    `分段 ${s.segments} 段${s.failedSegments ? `（失败 ${s.failedSegments}）` : ''}`,
    `调用 ${res.usage.calls} 次（补漏 ${res.usage.repairs}、拆半 ${res.usage.splits}）`,
    `token 输入 ${res.usage.prompt} / 输出 ${res.usage.completion}`,
    `耗时 ${(s.elapsedMs / 1000).toFixed(1)}s`,
  ];
  // 【必须显式说出来】结构分析失败时会退化成均分兜底，同时 takeaways 与 quotes 全空 ——
  // 表现为「文档里没有要点和金句、也不生成金句图」。
  // 以前这条路径完全静默，用户只能看到结果不对、查不出原因（v1.29.2 实测踩过）。
  if (res.usage && res.usage.fallbackPlan) {
    parts.push('⚠ 结构分析失败，已用均分兜底：本次没有「要点」与「金句」（可点「重做」重试）');
  }
  return parts.join(' · ');
}

/** 毫秒 → h:mm:ss（金句旁边标时间码，方便回看原片） */
function fmtClock(ms) {
  const total = Math.max(0, Math.round((ms || 0) / 1000));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  return h > 0
    ? `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`
    : `${m}:${String(s).padStart(2, '0')}`;
}

/** 把金句的 cue 序号换算成时间码 */
function resolveQuoteTimes(quotes, cues) {
  return (quotes || []).map((q) => {
    const n = Math.max(1, Math.min(cues.length, Number(q.cue) || 1));
    const c = cues[n - 1] || {};
    return { en: q.en, zh: q.zh, startMs: c.start || 0, timeText: fmtClock(c.start || 0) };
  });
}

/**
 * 构造「结构分析」的用户消息。
 *
 * 【关键】必须把总条数明确写出来。以前只让模型自己从最后一行去数，
 * 长字幕下它几乎必然算错结尾 —— 实测 2758 条的视频要喂 639 行，
 * 让模型精确对齐到第 2758 条基本靠碰运气。
 *
 * 还要说清「序号」指的是每行开头的字幕编号，不是行号 —— 两者在长输入里很容易混。
 */
function buildStructMessage(work) {
  return [
    `【总条数】${work.length} 条`,
    '【输入格式】每行「起始序号-结束序号: 文本」，序号是字幕条目编号（不是行号）',
    '',
    sub.buildStructureLines(work).join('\n'),
    '',
    `【硬性要求】plan 必须从第 1 条开始、到第 ${work.length} 条结束，各段首尾相接、不重叠、不遗漏。`,
  ].join('\n');
}

/**
 * 只跑「结构分析」这一遍，拿 takeaways / quotes。
 *
 * 用途：给【已经缓存过全文翻译】的旧文档补上总结。
 * 结构分析是一次调用，而逐段翻译是几十次调用——这样补总结只花一次调用的钱，
 * 不必为了让新字段生效就把整篇重译一遍。
 */
async function runSummaryOnly(o) {
  const cfg = o.cfg;
  const work = o.cues && o.cues.length ? o.cues : sub.loadCues(o.srtPath).cues;
  const usage = { prompt: 0, completion: 0, calls: 0, repairs: 0, splits: 0 };
  if (!work.length) return { takeaways: [], quotes: [], usage };
  const structInput = buildStructMessage(work);
  let lastErrs = null;
  for (let attempt = 1; attempt <= 3; attempt++) {
    const userContent = lastErrs
      ? `${structInput}\n\n【上一次的输出不合格】\n${lastErrs.slice(0, 6).join('\n')}\n请针对以上问题修正后，重新输出完整 JSON。`
      : structInput;
    try {
      const r = await llm.callLLM(
        cfg,
        [
          { role: 'system', content: llm.STRUCT_SYSTEM },
          { role: 'user', content: userContent },
        ],
        8192,
        // 同 runStudyPipeline：结构分析必须关思考，否则会被自己的思考撑爆 max_tokens
        { reasoning: 'off' }
      );
      usage.prompt += r.usage.prompt_tokens || 0;
      usage.completion += r.usage.completion_tokens || 0;
      usage.calls++;
      const st = llm.extractStruct(llm.parseJsonLoose(r.content));
      if (st.takeaways.length || st.quotes.length) {
        return { takeaways: st.takeaways, quotes: resolveQuoteTimes(st.quotes, work), usage };
      }
      lastErrs = llm.validatePlan(st.plan, work.length);
    } catch (err) {
      lastErrs = [String((err && err.message) || err).slice(0, 200)];
    }
  }
  return { takeaways: [], quotes: [], usage };
}

module.exports = {
  runStudyPipeline,
  runSummaryOnly,
  resolveQuoteTimes,
  fmtClock,
  snapPlanToSentences,
  splitOversizedSegments,
  estimateTokens,
  summarize,
  cuesFingerprint,
  DEFAULT_MAX_SEG_CUES,
  DEFAULT_CONCURRENCY,
};
