'use strict';
/**
 * 最小验证：字幕清洗 → 大模型分段 → 逐段翻译
 *
 * 这一步【只验证译文与分段质量】，不生成 Word、不接 UI。
 * 用法：
 *   node tools/translate-probe.js --srt .probe/xxx.en.srt --dry-run          # 只看清洗结果（不花钱）
 *   node tools/translate-probe.js --srt .probe/xxx.en.srt --max-cues 400     # 限制条数快速试
 *   node tools/translate-probe.js --srt .probe/xxx.en.srt --out report.md
 *
 * API 配置优先级：命令行 --config 文件 > 环境变量 > tools/probe.config.json
 *   环境变量：PROBE_BASE_URL / PROBE_API_KEY / PROBE_MODEL
 */
const fs = require('fs');
const path = require('path');

// ---------------------------------------------------------------- 参数

function parseArgs(argv) {
  const a = { concurrency: 2, maxCues: 0, dryRun: false, out: '', maxSegCues: 45 };
  for (let i = 2; i < argv.length; i++) {
    const k = argv[i];
    if (k === '--srt') a.srt = argv[++i];
    else if (k === '--out') a.out = argv[++i];
    else if (k === '--config') a.config = argv[++i];
    else if (k === '--max-cues') a.maxCues = parseInt(argv[++i], 10) || 0;
    else if (k === '--max-seg-cues') a.maxSegCues = parseInt(argv[++i], 10) || 45;
    else if (k === '--concurrency') a.concurrency = parseInt(argv[++i], 10) || 2;
    else if (k === '--dry-run') a.dryRun = true;
    else if (k === '--ping') a.ping = true;
  }
  return a;
}

function loadConfig(args) {
  const file = args.config || path.join(__dirname, 'probe.config.json');
  let cfg = {};
  if (fs.existsSync(file)) {
    try {
      cfg = JSON.parse(fs.readFileSync(file, 'utf8'));
    } catch (err) {
      console.error(`配置文件解析失败: ${file} — ${err.message}`);
    }
  }
  return {
    baseURL: process.env.PROBE_BASE_URL || cfg.baseURL || '',
    apiKey: process.env.PROBE_API_KEY || cfg.apiKey || '',
    model: process.env.PROBE_MODEL || cfg.model || '',
    temperature: cfg.temperature != null ? cfg.temperature : 0.2,
    configFile: file,
  };
}

// ---------------------------------------------------------------- SRT 解析与清洗

const TIME_RE = /(\d{2}):(\d{2}):(\d{2})[,.](\d{3})\s*-->\s*(\d{2}):(\d{2}):(\d{2})[,.](\d{3})/;

function toMs(h, m, s, ms) {
  return ((+h * 60 + +m) * 60 + +s) * 1000 + +ms;
}

/** 解析 SRT → [{start, end, lines[]}] */
function parseSrt(text) {
  const blocks = text.replace(/\r/g, '').split(/\n{2,}/);
  const cues = [];
  for (const block of blocks) {
    const lines = block.split('\n').filter((l) => l.trim() !== '');
    if (!lines.length) continue;
    const ti = lines.findIndex((l) => TIME_RE.test(l));
    if (ti < 0) continue;
    const m = lines[ti].match(TIME_RE);
    const body = lines.slice(ti + 1);
    if (!body.length) continue;
    cues.push({
      start: toMs(m[1], m[2], m[3], m[4]),
      end: toMs(m[5], m[6], m[7], m[8]),
      lines: body,
    });
  }
  cues.sort((a, b) => a.start - b.start || a.end - b.end);
  return cues;
}

/** 去掉内联标签与音效标记 */
function cleanLine(s) {
  return s
    .replace(/<[^>]*>/g, '') // <i> <font> <c> 等
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&#39;/gi, "'")
    .replace(/&quot;/gi, '"')
    .replace(/\[(music|applause|laughter|sighs|inaudible|noise|sound|silence)\]/gi, ' ')
    // YouTube 用 >> 标记换说话人，对翻译是噪声（后续可作为"说话人切换"信号单独利用）
    .replace(/>>+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * 折叠「滚动累加」式自动字幕。
 *
 * YouTube 自动字幕每条会把上一条的内容再重复一遍，还夹着 10 毫秒的过渡条目。
 * 例如：
 *   1  00:00:00,240 --> 00:00:01,954  Welcome to Huberman Lab Essentials,
 *   2  00:00:01,954 --> 00:00:01,964  Welcome to Huberman Lab Essentials,     ← 重复
 *   3  00:00:01,964 --> 00:00:04,309  Welcome to Huberman Lab Essentials,
 *                                     [music] where we revisit past episodes
 * 直接送进大模型会白烧 2~3 倍 token，还会把同一句翻译多遍。
 *
 * 做法：对每条，去掉开头与「上一条的行序列」尾部重叠的部分，只保留新增内容。
 */
function collapseRolling(cues) {
  const out = [];
  let prevLines = [];
  let dropped = 0;
  let dupChars = 0;

  for (const c of cues) {
    const curLines = c.lines.map(cleanLine).filter(Boolean);
    if (!curLines.length) {
      prevLines = c.lines.map(cleanLine).filter(Boolean);
      dropped++;
      continue;
    }
    let newLines = curLines;
    const maxK = Math.min(prevLines.length, curLines.length);
    for (let k = maxK; k > 0; k--) {
      const a = curLines.slice(0, k).join('\n');
      const b = prevLines.slice(prevLines.length - k).join('\n');
      if (a === b) {
        newLines = curLines.slice(k);
        break;
      }
    }
    if (!newLines.length) {
      dupChars += curLines.join(' ').length;
      dropped++;
      prevLines = curLines;
      continue;
    }
    const text = newLines.join(' ').replace(/\s+/g, ' ').trim();
    if (text) {
      out.push({ start: c.start, end: c.end, text });
    } else {
      dropped++;
    }
    prevLines = curLines;
  }

  // 合并零时长的过渡条目到前一条
  const merged = [];
  for (const c of out) {
    const prev = merged[merged.length - 1];
    if (prev && (c.end - c.start < 100 || prev.end - prev.start < 100)) {
      prev.text = (prev.text + ' ' + c.text).replace(/\s+/g, ' ').trim();
      prev.end = Math.max(prev.end, c.end);
    } else {
      merged.push(Object.assign({}, c));
    }
  }
  return { cues: merged, dropped, dupChars };
}

function fmtTime(ms) {
  const s = Math.floor(ms / 1000);
  const h = String(Math.floor(s / 3600)).padStart(2, '0');
  const m = String(Math.floor((s % 3600) / 60)).padStart(2, '0');
  const ss = String(s % 60).padStart(2, '0');
  return `${h}:${m}:${ss}`;
}

/** 把碎片拼成较长的行（带序号区间），用于第一遍结构分析，省 token */
function buildStructureLines(cues, wordsPerLine = 18) {
  const lines = [];
  let buf = [];
  let words = 0;
  let from = null;
  let to = null;
  const flush = () => {
    if (!buf.length) return;
    lines.push(`${from}-${to}: ${buf.join(' ')}`);
    buf = [];
    words = 0;
    from = null;
  };
  cues.forEach((c, idx) => {
    const i = idx + 1;
    if (from === null) from = i;
    to = i;
    buf.push(c.text);
    words += c.text.split(/\s+/).length;
    if (words >= wordsPerLine) flush();
  });
  flush();
  return lines;
}

/**
 * 在句子边界处切分 cue。
 *
 * 为什么必须做：自动字幕的 cue 是按显示宽度切的，一个 cue 里常常装着
 * 「上一句的结尾 + 下一句的开头」，例如 "conversation. I know that many people"。
 * 这样分段边界无论放在 cue 前还是 cue 后都会切断句子，翻译出来就会出现
 * 「第 2 段以『对话。』这个孤零零的残句开头」这种问题。
 * 先按句子把 cue 切开，后面的分段才能真正对齐到句子。
 *
 * 注意排除 Dr. / Mr. / etc. 这类缩写，否则 "Dr. Gina Poe" 会被切成两句。
 */
const ABBR_RE = /(?:^|\s)(?:Dr|Mr|Mrs|Ms|Prof|St|vs|etc|Inc|Ltd|Jr|Sr|Fig|No|approx|dept|est|al|i\.e|e\.g)\.$/i;

function splitCuesAtSentences(cues) {
  const out = [];
  for (const c of cues) {
    let parts = c.text.split(/(?<=[.!?]["'”’)\]]?)\s+(?=[A-Z"“'])/);
    if (parts.length > 1) {
      const merged = [parts[0]];
      for (let i = 1; i < parts.length; i++) {
        if (ABBR_RE.test(merged[merged.length - 1])) merged[merged.length - 1] += ' ' + parts[i];
        else merged.push(parts[i]);
      }
      parts = merged;
    }
    if (parts.length <= 1) {
      out.push(c);
      continue;
    }
    const total = c.text.length || 1;
    const dur = Math.max(0, c.end - c.start);
    let consumed = 0;
    for (let i = 0; i < parts.length; i++) {
      const start = c.start + Math.round((consumed / total) * dur);
      consumed += parts[i].length + 1;
      const end = i === parts.length - 1 ? c.end : c.start + Math.round((consumed / total) * dur);
      const text = parts[i].trim();
      if (text) out.push({ start, end: Math.max(end, start), text });
    }
  }
  return out;
}

/** 该条是否以句子结束符收尾 */
function endsSentence(text) {
  return /[.!?]["'”’)\]]?$/.test(String(text).trim());
}

/**
 * 把分段边界吸附到最近的句末条目上，避免切断句子。
 * 只在 ±4 条范围内挪动，并保证每段至少保留 MIN_SEG 条，挪不动就保持原样。
 */
function snapPlanToSentences(plan, cues) {
  const MIN_SEG = 4;
  const flags = cues.map((c) => endsSentence(c.text));
  const adj = plan.map((p) => Object.assign({}, p));
  let moved = 0;
  for (let k = 0; k < adj.length - 1; k++) {
    const cur = adj[k];
    const nxt = adj[k + 1];
    if (flags[cur.to - 1]) continue; // 已经落在句末
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

/** 吸附后重新校验：必须仍然连续、无重叠、无遗漏 */
function planStillValid(plan, total) {
  return validatePlan(plan, total).length === 0;
}

/**
 * 主动把过大的段拆小（在句末处切）。
 *
 * 为什么不等失败再拆：实测大段（50+ 条）会让模型漏掉部分条目，
 * 触发「补漏重试」——而补漏要把整段重新发一遍，token 翻倍。
 * 提前切小既省钱又快，翻译上下文更聚焦、质量也更好。
 */
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
            if (cand > from + 3 && cand < seg.to && endsSentence(cues[cand - 1].text)) {
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

// ---------------------------------------------------------------- 大模型调用

async function callLLM(cfg, messages, maxTokens = 8192) {
  const url = cfg.baseURL.replace(/\/+$/, '') + '/chat/completions';
  const body = {
    model: cfg.model,
    messages,
    temperature: cfg.temperature,
    max_tokens: maxTokens,
    stream: false,
  };
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 300000);
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${cfg.apiKey}`,
      },
      body: JSON.stringify(body),
      signal: ctrl.signal,
    });
    const text = await res.text();
    if (!res.ok) {
      throw new Error(`HTTP ${res.status}: ${text.slice(0, 300)}`);
    }
    const json = JSON.parse(text);
    const content = json.choices && json.choices[0] && json.choices[0].message.content;
    if (!content) throw new Error('响应里没有 content: ' + text.slice(0, 200));
    return {
      content,
      usage: json.usage || {},
    };
  } finally {
    clearTimeout(timer);
  }
}

/** 剥掉模型可能加的 ```json 围栏，再解析 */
function parseJsonLoose(s) {
  let t = String(s).trim();
  const fence = t.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (fence) t = fence[1].trim();
  const firstArr = t.search(/[[{]/);
  if (firstArr > 0) t = t.slice(firstArr);
  const lastObj = Math.max(t.lastIndexOf('}'), t.lastIndexOf(']'));
  if (lastObj >= 0) t = t.slice(0, lastObj + 1);
  return JSON.parse(t);
}

const STRUCT_SYSTEM = `你是专业的字幕结构化编辑。用户会给你一份 YouTube 自动生成字幕的清洗稿，每行格式为「起始序号-结束序号: 文本」。

这些文本是从自动字幕切分出来的碎片，缺少标点、大小写和完整句子结构。你只做结构分析，不要翻译、不要改写。

任务：把整篇内容按语义和主题划分成若干段落，每段在内容上自成一体。

硬性要求：
1. 段落边界必须落在给定的序号边界上（不能出现 1-45 这种跨越了未给出边界的区间）；
2. **段落边界必须尽量落在句子结束的位置**：也就是文本以 . ? ! 收尾、且下一条以大写字母开头的地方。绝不要把一句话从中间切开——这一点非常重要，切开的句子会导致翻译出现残句；
3. 各段区间必须严格首尾相接、不重叠、不遗漏：第一段从第 1 条开始，最后一段到最后一条结束，前一段的 to + 1 必须等于后一段的 from；
4. 段落数量按内容自然划分，视频越长段数越多，通常 6~25 段，避免过碎或过长；
5. 每段给一个简短的中文主题小标题，不超过 15 个字。

只输出 JSON 数组，不要任何解释、不要 Markdown 代码块。格式：
[{"from":1,"to":45,"topic":"开场与本期主题"}]`;

const TRANSLATE_SYSTEM = `你是资深英中翻译与英语教学编辑。用户会给你一段 YouTube 视频的自动字幕碎片（带序号），以及上一段的结尾作为上下文。

自动字幕的特点：碎片化、无标点、无大小写、专有名词可能有识别错误。

请输出严格的 JSON 对象，包含三个字段：

1. "en"：把碎片重排成通顺的英文段落。补全标点与大小写、合并被切断的句子、去掉 [music] 之类的音效标记。必须忠实原文，不要改写成你自己的话，不要漏掉任何信息，也不要添加原文没有的内容。

2. "zh"：把 "en" 翻译成自然流畅的简体中文。忠实准确，不要意译扩写。专业术语保留英文原词并在括号内给中文，例如 REM sleep（快速眼动睡眠）。

3. "cues"：逐条中文。这是一个**字符串**，每行一条，格式固定为「序号|中文」，行数必须与输入的条数完全相等、序号一一对应。

   这一项极其重要：
   - 必须严格一条输入对应一行输出，**绝对不允许把几条合并成一条**，也不允许跳过任何一条；
   - 不要把同一句话的碎片合并——哪怕这几条连起来才是一个完整句子，也要按条分别给出中文；
   - 行数必须与输入条数完全相等，序号必须与输入完全一致。

   正确示例（输入 3 条）：
   "cues": "12|我一直很期待\n13|这次对话\n14|我知道很多人会很想了解"

   错误示例（把 12-13 合并了，缺少 13）：
   "cues": "12|我一直很期待这次对话\n14|我知道很多人会很想了解"

只输出 JSON 对象，不要任何解释、不要 Markdown 代码块。`;

// ---------------------------------------------------------------- 校验

/** 校验分段计划：连续、覆盖、边界合理 */
function validatePlan(plan, total) {
  const errs = [];
  if (!Array.isArray(plan) || !plan.length) return ['分段计划不是非空数组'];
  let expect = 1;
  plan.forEach((p, i) => {
    if (typeof p.from !== 'number' || typeof p.to !== 'number') errs.push(`第 ${i + 1} 段缺少 from/to`);
    else {
      if (p.from !== expect) errs.push(`第 ${i + 1} 段 from=${p.from}，期望 ${expect}`);
      if (p.to < p.from) errs.push(`第 ${i + 1} 段 to < from`);
      expect = p.to + 1;
    }
    if (!p.topic) errs.push(`第 ${i + 1} 段缺少 topic`);
  });
  if (expect !== total + 1) errs.push(`最后一段到 ${expect - 1}，但总条数是 ${total}`);
  return errs;
}

/** 解析 cues 字段：兼容「每行 序号|中文」字符串与 [{i,zh}] 数组两种形态 */
function parseCuesField(raw) {
  if (Array.isArray(raw)) return raw;
  if (typeof raw !== 'string') return null;
  const out = [];
  for (const line of raw.split(/\r?\n/)) {
    const m = line.trim().match(/^(\d+)\s*[|｜:：]\s*(.*)$/);
    if (m) out.push({ i: parseInt(m[1], 10), zh: m[2].trim() });
  }
  return out;
}

/** 校验逐条中文是否与输入序号完全一致 */
function validateCues(seg, expectedIdx) {
  const parsed = parseCuesField(seg && seg.cues);
  if (!parsed) return { ok: false, missing: expectedIdx, extra: [], parsed: [] };
  const got = new Set(parsed.map((c) => c.i));
  const missing = expectedIdx.filter((i) => !got.has(i));
  const extra = [...got].filter((i) => !expectedIdx.includes(i));
  return { ok: missing.length === 0 && extra.length === 0, missing, extra, parsed };
}

// ---------------------------------------------------------------- 主流程

async function main() {
  const args = parseArgs(process.argv);
  const cfg = loadConfig(args);

  // --ping 不需要字幕文件，先处理
  if (args.ping) {
    if (!cfg.baseURL || !cfg.apiKey || !cfg.model) {
      console.error('缺少 API 配置（--config 文件 / PROBE_* 环境变量）');
      process.exit(2);
    }
    console.log(`连通性测试 → ${cfg.baseURL}  模型 ${cfg.model}`);
    const t0 = Date.now();
    try {
      const r = await callLLM(
        cfg,
        [
          { role: 'system', content: '你是一个测试助手，只回答用户要求的内容。' },
          { role: 'user', content: '请只回复两个字：正常' },
        ],
        32
      );
      console.log(`  ✅ 成功（${Date.now() - t0}ms）  回复: ${JSON.stringify(r.content.trim())}`);
      console.log(`  token: 输入 ${r.usage.prompt_tokens || '?'} / 输出 ${r.usage.completion_tokens || '?'}`);
    } catch (err) {
      console.error(`  ❌ 失败：${err.message}`);
      process.exit(1);
    }
    return;
  }

  if (!args.srt || !fs.existsSync(args.srt)) {
    console.error('用法: node tools/translate-probe.js --srt <字幕文件> [--dry-run] [--max-cues N] [--out report.md]');
    process.exit(1);
  }

  console.log('='.repeat(70));
  console.log('文件:', path.basename(args.srt));
  const raw = fs.readFileSync(args.srt, 'utf8');
  const parsed = parseSrt(raw);
  const { cues: collapsed, dropped, dupChars } = collapseRolling(parsed);
  const sentenceSplit = splitCuesAtSentences(collapsed);
  const cues = sentenceSplit;

  console.log(`原始条目      : ${parsed.length}`);
  console.log(`丢弃重复/空条 : ${dropped}   （重复正文约 ${dupChars} 字符）`);
  console.log(`清洗后条目    : ${collapsed.length}`);
  console.log(`句末切分后    : ${cues.length}   （多出的 ${cues.length - collapsed.length} 条来自"一个 cue 装着两句"）`);
  const totalChars = cues.reduce((s, c) => s + c.text.length, 0);
  const totalWords = cues.reduce((s, c) => s + c.text.split(/\s+/).length, 0);
  console.log(`正文规模      : ${totalWords} 词 / ${totalChars} 字符`);

  let work = cues;
  if (args.maxCues > 0 && cues.length > args.maxCues) {
    work = cues.slice(0, args.maxCues);
    console.log(`已截取前 ${args.maxCues} 条用于快速验证`);
  }

  if (args.dryRun) {
    console.log('\n--- 清洗后前 30 条（这就是要送进大模型的内容）---');
    work.slice(0, 30).forEach((c, i) => {
      console.log(`  ${String(i + 1).padStart(4)} [${fmtTime(c.start)}] ${c.text}`);
    });
    const sl = buildStructureLines(work);
    console.log(`\n--- 第一遍「结构分析」的输入（${sl.length} 行，约 ${sl.join('\n').length} 字符）---`);
    sl.slice(0, 6).forEach((l) => console.log('  ' + l.slice(0, 150)));
    if (sl.length > 6) console.log(`  … 共 ${sl.length} 行`);
    console.log('\n（--dry-run 不调用 API，不产生费用）');
    return;
  }

  if (!cfg.baseURL || !cfg.apiKey || !cfg.model) {
    console.error(`
缺少 API 配置。请任选一种方式：
  1) 编辑 ${cfg.configFile}
     { "baseURL": "https://api.deepseek.com/v1", "apiKey": "sk-...", "model": "deepseek-chat" }
  2) 设置环境变量 PROBE_BASE_URL / PROBE_API_KEY / PROBE_MODEL
`);
    process.exit(2);
  }

  console.log(`\n模型: ${cfg.model}   baseURL: ${cfg.baseURL}`);
  const usage = { prompt: 0, completion: 0, calls: 0 };
  const t0 = Date.now();

  // ---------- 第一遍：结构分析 ----------
  const structLines = buildStructureLines(work);
  console.log(`\n[1/2] 结构分析：输入 ${structLines.length} 行…`);
  let plan = null;
  let planRaw = '';
  for (let attempt = 1; attempt <= 2; attempt++) {
    const messages = [
      { role: 'system', content: STRUCT_SYSTEM },
      { role: 'user', content: structLines.join('\n') },
    ];
    const r = await callLLM(cfg, messages, 4096);
    usage.prompt += r.usage.prompt_tokens || 0;
    usage.completion += r.usage.completion_tokens || 0;
    usage.calls++;
    planRaw = r.content;
    try {
      plan = parseJsonLoose(r.content);
      const errs = validatePlan(plan, work.length);
      if (!errs.length) {
        console.log(`      分片成功：${plan.length} 段`);
        break;
      }
      console.log(`      校验未通过（第 ${attempt} 次）：${errs.slice(0, 3).join('; ')}`);
      plan = null;
    } catch (err) {
      console.log(`      JSON 解析失败（第 ${attempt} 次）：${err.message}`);
      plan = null;
    }
  }
  if (!plan) {
    console.error('结构分析两次都失败，原始输出前 500 字：\n' + planRaw.slice(0, 500));
    process.exit(3);
  }

  // 边界吸附：把分段点挪到最近的句末，避免切断句子
  const snapped = snapPlanToSentences(plan, work);
  if (snapped.moved > 0 && planStillValid(snapped.plan, work.length)) {
    console.log(`      边界吸附：修正了 ${snapped.moved} 处切断句子的分段点`);
    plan = snapped.plan;
  } else if (snapped.moved > 0) {
    console.log('      边界吸附后校验不通过，保持原计划');
  }
  const cutAfter = plan.filter((p, i) => i < plan.length - 1 && !endsSentence(work[p.to - 1].text)).length;
  console.log(`      仍有 ${cutAfter}/${plan.length - 1} 处边界未落在句末（±4 条内找不到句末，属正常）`);

  // 主动把过大的段切小（在句末处切）
  const sized = splitOversizedSegments(plan, work, args.maxSegCues);
  if (sized.splitCount > 0 && planStillValid(sized.plan, work.length)) {
    console.log(`      大段切分：拆出 ${sized.splitCount} 处，${plan.length} 段 → ${sized.plan.length} 段（上限 ${args.maxSegCues} 条/段）`);
    plan = sized.plan;
  }

  // ---------- 第二遍：逐段翻译 ----------
  console.log(`\n[2/2] 逐段翻译：${plan.length} 段，并发 ${args.concurrency}`);
  const results = new Array(plan.length).fill(null);
  let cursor = 0;
  let done = 0;
  let splits = 0;
  let repairs = 0;

  /**
   * 翻译一段。失败时两级兜底：
   *  1) 带上「你漏了这些序号」的提示重试一次（模型漏条目是最常见的失败）
   *  2) 仍失败就把这一段拆成两半递归处理 —— 大段既容易漏条目，翻译质量也偏差
   */
  async function translateSeg(seg, contextText, depth = 0) {
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
        repairs++;
        userMsg +=
          `\n\n【重要】上一次你的输出漏掉了这些序号：${lastMissing.slice(0, 40).join(', ')}` +
          `${lastMissing.length > 40 ? ` 等 ${lastMissing.length} 条` : ''}。` +
          `本次必须输出与输入完全一致的 ${expected.length} 条 cues，一条不能少、也不能多。`;
      }
      try {
        const r = await callLLM(
          cfg,
          [
            { role: 'system', content: TRANSLATE_SYSTEM },
            { role: 'user', content: userMsg },
          ],
          8192
        );
        usage.prompt += r.usage.prompt_tokens || 0;
        usage.completion += r.usage.completion_tokens || 0;
        usage.calls++;
        const out = parseJsonLoose(r.content);
        const v = validateCues(out, expected);
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
        lastErr = `逐条覆盖不符：缺 ${v.missing.length} 条（${v.missing.slice(0, 6).join(',')}…）多 ${v.extra.length} 条`;
      } catch (err) {
        lastErr = err.message;
      }
    }

    if (depth < 3 && expected.length >= 12) {
      splits++;
      const mid = Math.floor((seg.from + seg.to) / 2);
      const a = await translateSeg({ from: seg.from, to: mid, topic: seg.topic }, contextText, depth + 1);
      const ctxB = a.ok ? a.data.en.split(/(?<=[.!?])\s+/).slice(-2).join(' ') : contextText;
      const b = await translateSeg({ from: mid + 1, to: seg.to, topic: seg.topic }, ctxB, depth + 1);
      if (a.ok && b.ok) {
        return {
          ok: true,
          data: {
            en: (a.data.en + ' ' + b.data.en).replace(/\s+/g, ' ').trim(),
            zh: (a.data.zh + b.data.zh).replace(/\s+/g, ''),
            cues: [].concat(a.data.cues || [], b.data.cues || []),
            _seg: seg,
            _cues: [].concat(a.data._cues, b.data._cues),
            _expected: [].concat(a.data._expected, b.data._expected),
            _split: true,
          },
        };
      }
      return { ok: false, error: lastErr, seg, splitFailed: true };
    }
    return { ok: false, error: lastErr, seg };
  }

  /** 并发时「上一段」可能还没跑完，等一小会儿以拿到真正的上下文 */
  async function contextFor(idx) {
    if (idx === 0) return '（这是全文第一段）';
    for (let i = 0; i < 120; i++) {
      const prev = results[idx - 1];
      if (prev) {
        if (prev._failed) return '（上一段处理失败，无上下文）';
        return prev.en.split(/(?<=[.!?])\s+/).slice(-2).join(' ') || '（无上下文）';
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
      process.stdout.write(`\r      进度 ${done}/${plan.length} 段（最近：${seg.topic}）                    `);
    }
  }
  await Promise.all(Array.from({ length: Math.max(1, args.concurrency) }, worker));
  console.log('');
  if (repairs) console.log(`      补漏重试 ${repairs} 次`);
  if (splits) console.log(`      自动拆半 ${splits} 次`);

  const secs = ((Date.now() - t0) / 1000).toFixed(1);
  const failed = results.filter((r) => r && r._failed).length;

  // ---------- 报告 ----------
  const lines = [];
  lines.push(`# 字幕分段与翻译验证报告\n`);
  lines.push(`- 字幕文件：\`${path.basename(args.srt)}\``);
  lines.push(`- 模型：\`${cfg.model}\``);
  lines.push(`- 原始条目 ${parsed.length} → 清洗后 ${work.length}（丢弃重复 ${dropped} 条，重复正文约 ${dupChars} 字符）`);
  lines.push(`- 正文规模：${work.reduce((s, c) => s + c.text.split(/\s+/).length, 0)} 词`);
  lines.push(`- 分段：${plan.length} 段，失败 ${failed} 段`);
  lines.push(`- 耗时：${secs}s，API 调用 ${usage.calls} 次`);
  lines.push(`- Token：输入约 ${usage.prompt}，输出约 ${usage.completion}`);
  lines.push('');
  lines.push('---\n');

  results.forEach((r, i) => {
    const seg = r._seg;
    lines.push(`## 第 ${i + 1} 段 · ${seg.topic}`);
    lines.push(`> 时间码 ${fmtTime(work[seg.from - 1].start)} · 序号 ${seg.from}-${seg.to}`);
    lines.push('');
    if (r._failed) {
      lines.push(`**本段失败**：${r._failed}\n`);
      return;
    }
    lines.push(`**EN**  \n${r.en}\n`);
    lines.push(`**ZH**  \n${r.zh}\n`);
    const missing = (r.cues || []).length;
    lines.push(`<sub>逐条中文 ${missing} 条（用于双语字幕）</sub>\n`);
    lines.push('---\n');
  });

  const outPath = args.out || path.join(path.dirname(args.srt), 'probe-report.md');
  fs.writeFileSync(outPath, lines.join('\n'), 'utf8');

  console.log(`耗时 ${secs}s   调用 ${usage.calls} 次   token 输入 ${usage.prompt} / 输出 ${usage.completion}`);
  console.log(`报告已写入: ${outPath}`);
  console.log('\n=== 前两段预览 ===\n');
  results.slice(0, 2).forEach((r, i) => {
    console.log(`【第 ${i + 1} 段】${r._seg.topic}`);
    if (r._failed) return console.log('  (失败) ' + r._failed);
    console.log('EN: ' + r.en.slice(0, 260) + (r.en.length > 260 ? '…' : ''));
    console.log('ZH: ' + r.zh.slice(0, 200) + (r.zh.length > 200 ? '…' : ''));
    console.log('');
  });
}

main().catch((err) => {
  console.error('运行失败:', err && err.stack ? err.stack : err);
  process.exit(1);
});
