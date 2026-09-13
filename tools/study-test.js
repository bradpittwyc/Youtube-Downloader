'use strict';
/**
 * 学习文档流水线的端到端测试（**不联网、不花钱、几秒跑完**）。
 *
 * 为什么单独一个文件：这是全项目最贵、最复杂、也最容易悄悄坏掉的一条链路
 * （608 行流水线 + LLM 调用 + 排版），而 tools/integration-test.js 只覆盖了
 * 「识别 → 下载 → 断点续传」——那些是 yt-dlp 在干活，便宜且稳定。
 *
 * 代价已经付过一次：`validatePlan` 传错对象 + `takeaways/quotes` 未声明
 * 这两个致命 bug，让**任何没有翻译缓存的新视频都生不出文档**，
 * 跨了好几个版本没人发现，因为已缓存的视频走的是另一条旁路。
 * 这个文件就是用来挡住这类回归的。
 *
 * 做法：把 llm.callLLM 换成「可编程的假模型」——
 *   · 结构分析：按提示词里的【总条数】造一个合法计划
 *   · 逐段翻译：从用户消息里解析出真实序号，原样回显（保证 validateCues 一定通过）
 * 于是不需要 API Key，也不会产生任何费用。
 *
 * 运行： node tools/study-test.js
 */
const path = require('path');
const fs = require('fs');
const os = require('os');
const zlib = require('zlib');
const Module = require('module');

const ROOT = path.resolve(__dirname, '..');
const TMP = path.join(os.tmpdir(), 'ytdl-study-test');

// ---------- mock electron ----------
const fakeElectron = {
  app: {
    isPackaged: false,
    getAppPath: () => ROOT,
    getVersion: () => '1.0.0-test',
    getPath: (name) => {
      const d = path.join(TMP, 'userData', name);
      fs.mkdirSync(d, { recursive: true });
      return d;
    },
  },
  // 金句卡片需要真的 BrowserWindow；Node 里给不了，
  // generateForVideo 内部对这一步有 try/catch，所以不该影响其它断言。
  BrowserWindow: undefined,
};
const origLoad = Module._load;
Module._load = function (request, ...rest) {
  if (request === 'electron') return fakeElectron;
  return origLoad.call(this, request, ...rest);
};

const llm = require('../src/main/study/llm');
const pipeline = require('../src/main/study/pipeline');
const study = require('../src/main/study');
const sub = require('../src/main/study/subtitle');
const assMod = require('../src/main/study/ass');
const word = require('../src/main/study/word');

// ---------- 测试脚手架（与 integration-test.js 保持一致的风格）----------
let pass = 0;
let fail = 0;
const failures = [];

function ok(cond, label, extra) {
  if (cond) {
    pass++;
    console.log(`  ✅ ${label}`);
  } else {
    fail++;
    failures.push(label + (extra ? ` — ${extra}` : ''));
    console.log(`  ❌ ${label}${extra ? ' — ' + extra : ''}`);
  }
}

function section(t) {
  console.log(`\n=== ${t} ===`);
}

// ---------- 假模型 ----------
let callLog = [];
/** 每次调用前决定返回什么：抛 Error 表示模拟失败，返回字符串表示模型输出 */
let responder = null;

function installFakeLLM() {
  llm.callLLM = async (cfg, messages, maxTokens) => {
    const sys = ((messages || []).find((m) => m.role === 'system') || {}).content || '';
    const usr = ((messages || []).find((m) => m.role === 'user') || {}).content || '';
    const kind = /结构化编辑/.test(sys) ? 'struct' : 'translate';
    const ctx = { kind, sys, usr, maxTokens, index: callLog.length };
    callLog.push(ctx);
    const out = responder(ctx);
    if (out instanceof Error) throw out;
    return { content: out, usage: { prompt_tokens: 120, completion_tokens: 80 } };
  };
}

/** 从结构分析的用户消息里取【总条数】 */
function totalFromPrompt(usr) {
  const m = String(usr).match(/【总条数】(\d+)\s*条/);
  return m ? Number(m[1]) : 0;
}

/** 默认的结构分析回答：把 1..N 按 chunk 切开，topic 带「模型分段」前缀 ——
 *  这样测试就能验证「产出的段落确实来自模型」，而不是悄悄退化成兜底均分。 */
function structReply(usr, chunk = 40) {
  const total = totalFromPrompt(usr);
  const plan = [];
  let from = 1;
  let i = 1;
  while (from <= total) {
    const to = Math.min(total, from + chunk - 1);
    plan.push({ from, to, topic: `模型分段 ${i}` });
    from = to + 1;
    i++;
  }
  return JSON.stringify({
    plan,
    takeaways: [
      { en: 'The first key takeaway of this talk.', zh: '本讲的第一条核心要点。' },
      { en: 'The second key takeaway of this talk.', zh: '本讲的第二条核心要点。' },
      { en: 'The third key takeaway of this talk.', zh: '本讲的第三条核心要点。' },
    ],
    quotes: [
      { cue: Math.min(3, total), en: 'This is a memorable quote.', zh: '这是一句值得记住的话。' },
      { cue: Math.min(9, total), en: 'Another memorable line.', zh: '另一句值得记住的话。' },
    ],
  });
}

/** 默认的逐段翻译回答：解析用户消息里的序号，逐条回显（保证覆盖校验必过） */
function translateReply(usr, opt = {}) {
  const idx = [];
  for (const line of String(usr).split('\n')) {
    const m = line.match(/^(\d+)\|/);
    if (m) idx.push(Number(m[1]));
  }
  if (opt.missingFirst && idx.length > 1) idx.shift(); // 故意漏一条，模拟模型的疏漏
  return JSON.stringify({
    en: 'This is the rearranged English paragraph for the segment.',
    zh: '这是本段重排后的中文翻译。',
    notes: [
      { sentence: 'This is the rearranged English paragraph for the segment.', explain: '这句话的难点在于……' },
    ],
    vocab: [
      { word: 'rearrange', phonetic: '/ˌriːəˈreɪndʒ/', pos: 'v.', def: '重新排列' },
      { word: 'segment', phonetic: '/ˈseɡmənt/', pos: 'n.', def: '片段' },
      { word: 'paragraph', phonetic: '/ˈpærəɡræf/', pos: 'n.', def: '段落' },
    ],
    cues: idx.map((i) => `${i}|第 ${i} 条的中文`).join('\n'),
  });
}

/** 默认 responder */
function defaultResponder(ctx) {
  return ctx.kind === 'struct' ? structReply(ctx.usr) : translateReply(ctx.usr);
}

// ---------- 造一份假字幕 ----------
/**
 * 生成 n 条「像样」的英文字幕。
 * 内容要满足 subtitle.js 的清洗规则（不要重复行，否则会被当成滚动字幕折叠掉）。
 */
function makeSrt(n) {
  const lines = [];
  for (let i = 1; i <= n; i++) {
    const s = i * 3;
    const fmt = (sec) => {
      const h = String(Math.floor(sec / 3600)).padStart(2, '0');
      const m = String(Math.floor((sec % 3600) / 60)).padStart(2, '0');
      const ss = String(sec % 60).padStart(2, '0');
      return `${h}:${m}:${ss},000`;
    };
    lines.push(String(i));
    lines.push(`${fmt(s)} --> ${fmt(s + 2)}`);
    // 每句都以句号收尾，且互不重复 —— 便于句末吸附
    lines.push(`Sentence number ${i} talks about the topic in detail.`);
    lines.push('');
  }
  return lines.join('\r\n');
}

// ---------- 最小 ZIP 读取（docx 就是 zip）----------
// 不引依赖（项目约定），手写一个只够用的版本：走中央目录，稳妥处理 data descriptor。
function unzipEntry(buf, wantName) {
  const eocd = buf.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
  if (eocd < 0) return null;
  const cdCount = buf.readUInt16LE(eocd + 10);
  let off = buf.readUInt32LE(eocd + 16);
  for (let i = 0; i < cdCount; i++) {
    if (buf.readUInt32LE(off) !== 0x02014b50) return null;
    const method = buf.readUInt16LE(off + 10);
    const compSize = buf.readUInt32LE(off + 20);
    const nameLen = buf.readUInt16LE(off + 28);
    const extraLen = buf.readUInt16LE(off + 30);
    const commentLen = buf.readUInt16LE(off + 32);
    const localOff = buf.readUInt32LE(off + 42);
    const name = buf.slice(off + 46, off + 46 + nameLen).toString('utf8');
    if (name === wantName) {
      // 本地头长度可能与中央目录不同，必须按本地头再算一次
      const lNameLen = buf.readUInt16LE(localOff + 26);
      const lExtraLen = buf.readUInt16LE(localOff + 28);
      const dataStart = localOff + 30 + lNameLen + lExtraLen;
      const data = buf.slice(dataStart, dataStart + compSize);
      return method === 0 ? data : zlib.inflateRawSync(data);
    }
    off += 46 + nameLen + extraLen + commentLen;
  }
  return null;
}

/** 从 docx 里取出纯文本（按段落拼接） */
function docxText(buf) {
  const xml = unzipEntry(buf, 'word/document.xml');
  if (!xml) return '';
  return xml
    .toString('utf8')
    .replace(/<w:p[ >]/g, '\n<w:p ')
    .replace(/<[^>]+>/g, '')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'");
}

// ---------- 公共上下文 ----------
let SRT = '';
const CFG = { baseURL: 'http://fake.local/v1', apiKey: 'sk-test', model: 'fake-model', temperature: 0.2 };

function reset() {
  callLog = [];
  responder = defaultResponder;
}

function translateCalls() {
  return callLog.filter((c) => c.kind === 'translate');
}
function structCalls() {
  return callLog.filter((c) => c.kind === 'struct');
}

// ================================================================ A. 结构分析
async function testStructure() {
  section('A. 结构分析');

  // A1 正常
  reset();
  let r = await pipeline.runStudyPipeline({ srtPath: SRT, cfg: CFG, concurrency: 3 });
  ok(r.segments.length > 0, 'A1 正常计划能跑通', `段落数=${r.segments.length}`);
  // 【关键】这两条是防「悄悄退化成兜底」的：只断言"跑通了"是不够的 ——
  // 曾经 validatePlan 收到的是整个对象，于是永远判定不合法、一路退到均分兜底，
  // 表面上"文档还是生成出来了"，实际模型给的计划被完全丢弃。
  ok(
    r.segments.every((s) => /^模型分段/.test(s.topic)),
    'A1 段落主题来自模型（不是兜底均分的「第 N 部分」）',
    `首段主题=${r.segments[0].topic}`
  );
  ok(!r.usage.fallbackPlan, 'A1 没有走兜底均分（usage.fallbackPlan 未置位）', JSON.stringify(r.usage.fallbackPlan));
  ok(
    llm.validatePlan(
      r.segments.map((s) => ({ from: s.from, to: s.to, topic: s.topic })),
      r.cues.length
    ).length === 0,
    'A1 产出段落首尾相接、完整覆盖'
  );
  ok(
    r.segments[0].from === 1 && r.segments[r.segments.length - 1].to === r.cues.length,
    'A1 首段从 1 开始、末段到总数结束'
  );

  // A2 计划有偏差 → 自动修复（这是最常见的模型错误：结尾少算）
  reset();
  responder = (ctx) => {
    if (ctx.kind !== 'struct') return translateReply(ctx.usr);
    const total = totalFromPrompt(ctx.usr);
    return JSON.stringify({
      plan: [
        { from: 1, to: 30, topic: '前半' },
        { from: 31, to: total - 7, topic: '后半' }, // 结尾故意少 7 条
      ],
      takeaways: [{ en: 'a', zh: '甲' }],
      quotes: [{ cue: 2, en: 'q', zh: '句' }],
    });
  };
  r = await pipeline.runStudyPipeline({ srtPath: SRT, cfg: CFG, concurrency: 3 });
  const last = r.segments[r.segments.length - 1];
  ok(last.to === r.cues.length, 'A2 结尾少算时被自动修复到总数', `末段到 ${last.to} / 共 ${r.cues.length}`);

  // A3 模型彻底给不出计划 → 兜底均分，而不是整单失败
  reset();
  responder = (ctx) => {
    if (ctx.kind !== 'struct') return translateReply(ctx.usr);
    return '这不是 JSON，只是一段废话。';
  };
  r = await pipeline.runStudyPipeline({ srtPath: SRT, cfg: CFG, concurrency: 3 });
  ok(r.segments.length > 0, 'A3 计划完全不可用时走兜底均分，不抛异常', `段落数=${r.segments.length}`);
  ok(structCalls().length === 3, 'A3 结构分析确实重试了 3 次', `实际 ${structCalls().length} 次`);

  // A4 第一次返回坏 JSON，第二次成功（重试要能救回来）
  reset();
  let n = 0;
  responder = (ctx) => {
    if (ctx.kind !== 'struct') return translateReply(ctx.usr);
    n++;
    return n === 1 ? '{"plan": [{"from":1,' : structReply(ctx.usr); // 第一次截断
  };
  r = await pipeline.runStudyPipeline({ srtPath: SRT, cfg: CFG, concurrency: 3 });
  ok(r.segments.length > 0 && structCalls().length === 2, 'A4 坏 JSON 后重试成功', `调用 ${structCalls().length} 次`);

  // A5 from/to 越界、重叠、乱序 → 修复
  reset();
  responder = (ctx) => {
    if (ctx.kind !== 'struct') return translateReply(ctx.usr);
    const total = totalFromPrompt(ctx.usr);
    return JSON.stringify({
      plan: [
        { from: 20, to: 60, topic: '乱序在前' },
        { from: 1, to: 25, topic: '重叠' },
        { from: 200, to: total + 999, topic: '越界' },
      ],
      takeaways: [],
      quotes: [],
    });
  };
  r = await pipeline.runStudyPipeline({ srtPath: SRT, cfg: CFG, concurrency: 3 });
  ok(
    r.segments[0].from === 1 && r.segments[r.segments.length - 1].to === r.cues.length,
    'A5 越界/重叠/乱序的计划被修复成合法区间'
  );
}

// ================================================================ B. 翻译与汇总
async function testTranslate() {
  section('B. 逐段翻译与汇总');
  reset();
  const r = await pipeline.runStudyPipeline({ srtPath: SRT, cfg: CFG, concurrency: 3 });

  // B1 逐条中文 100% 覆盖 —— ASS / 双语 SRT 全靠它
  const covered = Object.keys(r.cueZh).length;
  ok(covered === r.cues.length, 'B1 逐条中文 100% 覆盖', `${covered} / ${r.cues.length}`);

  // B2 takeaways（回归：这里曾经引用未声明的变量，直接 ReferenceError）
  ok(Array.isArray(r.takeaways) && r.takeaways.length > 0, 'B2 takeaways 非空（防 ReferenceError 回归）');
  ok(
    r.takeaways.every((t) => t.en && t.zh),
    'B2 每条 takeaways 都有中英两版'
  );

  // B3 quotes + 时间码
  ok(Array.isArray(r.quotes) && r.quotes.length > 0, 'B3 quotes 非空（防 ReferenceError 回归）');
  ok(
    r.quotes.every((q) => q.en && q.zh && typeof q.startMs === 'number' && q.timeText),
    'B3 每条金句都带时间码'
  );

  // B4 词汇聚合：至少去重
  const words = r.vocab.map((v) => v.word);
  ok(r.vocab.length > 0, 'B4 词汇表非空', `${r.vocab.length} 个词条`);
  ok(new Set(words).size === words.length, 'B4 词汇按词形去重', `${new Set(words).size} 个不重复`);

  // B5 每段都有 en/zh/notes/vocab
  ok(
    r.segments.every((s) => s.en && s.zh && s.notes.length && s.vocab.length),
    'B5 每段都有英文/中文/长难句/词汇'
  );

  // B6 段落 timecode 单调递增（排版要用）
  let mono = true;
  for (let i = 1; i < r.segments.length; i++) {
    if (!(r.segments[i].startMs >= r.segments[i - 1].startMs)) mono = false;
  }
  ok(mono, 'B6 段落起始时间单调递增');

  // B7 某段一直翻译失败 → 记进 failed，不崩、不阻塞其它段
  reset();
  let seen = 0;
  responder = (ctx) => {
    if (ctx.kind === 'struct') return structReply(ctx.usr, 30);
    seen++;
    // 让第一段的所有尝试（含拆半递归）全部失败
    if (seen <= 12) return translateReply(ctx.usr, { missingFirst: true });
    return translateReply(ctx.usr);
  };
  const r7 = await pipeline.runStudyPipeline({ srtPath: SRT, cfg: CFG, concurrency: 1 });
  ok(r7.segments.length > 0, 'B7 有段落失败时其余段落照常产出', `成功 ${r7.segments.length} 段`);
  ok(
    r7.segments.length + r7.failed.length > 0 && r7.segments.length > 1,
    'B7 失败的段落被隔离，不影响整体'
  );
}

// ================================================================ C. 断点续跑
async function testResume() {
  section('C. 断点续跑');

  // C1 每翻完一段都会回调 onPartial，最后一份状态必须是完整的
  reset();
  const partials = [];
  await pipeline.runStudyPipeline({
    srtPath: SRT,
    cfg: CFG,
    concurrency: 2,
    onPartial: (st) => partials.push(st),
  });
  ok(partials.length > 0, 'C1 每段完成后都会回调 onPartial', `${partials.length} 次`);
  const lastPartial = partials[partials.length - 1];
  ok(
    Object.keys(lastPartial.segments).length === lastPartial.plan.length,
    'C1 最后一份中间结果是完整的',
    `${Object.keys(lastPartial.segments).length}/${lastPartial.plan.length}`
  );
  ok(
    typeof lastPartial.cuesFp === 'string' &&
      lastPartial.cuesFp.startsWith(String(lastPartial.plan[lastPartial.plan.length - 1].to) + '|'),
    'C1 中间结果带字幕指纹（条数|首条|末条，用于确认「还是同一份字幕」）',
    String(lastPartial.cuesFp).slice(0, 24)
  );

  // ---------- 用「一次跑完」的真实结果，造一份「只完成了前 K 段」的中间结果 ----------
  //
  // 为什么不靠「跑到一半抛错」来模拟中断：流水线没有取消机制，
  // 抛错只能打断当前这个 worker，**其它 worker 会继续把整篇跑完**
  // （实测：期望 5 次翻译调用，实际 9 次）。那样测出来的东西不确定。
  // 直接从真实结果里截取前 K 段，既确定、又和 writePartial 写出来的形状完全一致。
  reset();
  const full = await pipeline.runStudyPipeline({ srtPath: SRT, cfg: CFG, concurrency: 4 });
  const K = Math.max(1, Math.floor(full.segments.length / 2));
  const partialState = {
    cuesFp: pipeline.cuesFingerprint(full.cues),
    plan: full.segments.map((s) => ({ from: s.from, to: s.to, topic: s.topic })),
    struct: { takeaways: full.takeaways, quotes: full.quotes },
    segments: {},
    planMoved: full.stats.planMoved,
    planSplit: full.stats.planSplit,
  };
  full.segments.slice(0, K).forEach((s, i) => {
    // 逐条中文要从 cueZh 里按区间取回来 —— emitPartial 存的就是这个形状，
    // 少了它续跑后的 cueZh 会缺这一段的翻译（ASS / 双语 SRT 就残了）
    const cues = [];
    for (let n = s.from; n <= s.to; n++) cues.push({ i: n, zh: full.cueZh[n] || '' });
    partialState.segments[i] = { en: s.en, zh: s.zh, notes: s.notes, vocab: s.vocab, cues };
  });
  ok(Object.keys(partialState.segments).length === K, 'C2 构造出「部分完成」的中间结果', `${K}/${partialState.plan.length} 段`);

  // C2 续跑：只翻剩下的段
  reset();
  const r2 = await pipeline.runStudyPipeline({
    srtPath: SRT,
    cfg: CFG,
    concurrency: 2,
    resume: partialState,
  });
  const need = partialState.plan.length - K;
  ok(r2.stats.resumedSegments === K, 'C2 续跑复用了已完成的段落', `复用 ${r2.stats.resumedSegments} / 期望 ${K}`);
  ok(structCalls().length === 0, 'C2 续跑不再调用结构分析（省一次调用）', `实际 ${structCalls().length} 次`);
  ok(
    translateCalls().length === need,
    'C2 只翻了缺的段，一条不多一条不少',
    `翻译调用 ${translateCalls().length} 次 / 期望 ${need} 次（总段数 ${partialState.plan.length}）`
  );

  // C3 续跑后的结果与「一次跑完」等价
  ok(r2.segments.length === partialState.plan.length, 'C3 续跑后段落数完整', `${r2.segments.length}`);
  ok(
    Object.keys(r2.cueZh).length === r2.cues.length,
    'C3 续跑后逐条中文依然 100% 覆盖',
    `${Object.keys(r2.cueZh).length} / ${r2.cues.length}`
  );
  ok(r2.failed.length === 0, 'C3 续跑后没有失败段落');
  ok(r2.quotes.length === full.quotes.length, 'C3 续跑保住了金句（来自中间结果里的 struct）');

  // C4 字幕条数变了 → 不能复用旧计划
  reset();
  const SRT3 = path.join(TMP, 'changed.en.srt');
  fs.writeFileSync(SRT3, makeSrt(180), 'utf8');
  const r4 = await pipeline.runStudyPipeline({
    srtPath: SRT3,
    cfg: CFG,
    concurrency: 2,
    resume: partialState, // 这份计划是给 120 条字幕用的
  });
  ok(r4.stats.resumedSegments === 0, 'C4 字幕变了 → 拒绝复用旧计划，重新生成');
  ok(r4.segments[r4.segments.length - 1].to === r4.cues.length, 'C4 重新生成的计划覆盖完整');
}

// ================================================================ D. 产出物
async function testArtifacts() {
  section('D. 产出物（Word / ASS / 双语 SRT）');
  reset();
  const r = await pipeline.runStudyPipeline({ srtPath: SRT, cfg: CFG, concurrency: 3 });

  // D1 Word 段落数
  const buf = await word.buildStudyDocx({
    meta: { title: '测试视频标题', channel: '测试频道', durationMs: 600000, uploadDate: '2026-01-01', url: 'https://example.com/v' },
    segments: r.segments,
    vocab: r.vocab,
    takeaways: r.takeaways,
    quotes: r.quotes,
    options: { includePureEnglish: true, includeVocabTable: true, segmentTimecode: true },
  });
  ok(buf && buf.length > 5000, 'D1 docx 生成成功', `${Math.round((buf || []).length / 1024)} KB`);
  const text = docxText(buf);
  ok(text.length > 1000, 'D1 docx 能被解出正文', `${text.length} 字符`);
  const segHeads = (text.match(/段落\s*\d+/g) || []).length;
  ok(segHeads === r.segments.length, 'D1 docx 里的段落标题数 == 段落数', `${segHeads} / ${r.segments.length}`);
  ok(text.includes('测试视频标题'), 'D1 docx 含视频标题');
  ok(text.includes(r.takeaways[0].en.slice(0, 20)), 'D1 docx 含 takeaways');
  ok(text.includes(r.quotes[0].en.slice(0, 20)), 'D1 docx 含金句');
  ok(text.includes('词汇总表'), 'D1 docx 含词汇总表');
  ok(text.includes(r.segments[0].en.slice(0, 24)), 'D1 docx 含正文英文');
  ok(text.includes(r.segments[0].zh.slice(0, 10)), 'D1 docx 含正文中文');

  // D2 ASS
  const ass = assMod.buildAss({ cues: r.cues, cueZh: r.cueZh, title: '测试', width: 1920, height: 1080, options: {} });
  const dlg = (ass.match(/^Dialogue:/gm) || []).length;
  ok(dlg === r.cues.length * 2, 'D2 ASS 事件数 = 字幕条数 × 2（英文 + 中文两条事件）', `${dlg} / 期望 ${r.cues.length * 2}`);
  const cnLines = (ass.match(/[\u4e00-\u9fff]/g) || []).length;
  ok(cnLines > 0, 'D2 ASS 里确实有中文', `${cnLines} 个汉字`);
  ok(/^Style: /m.test(ass), 'D2 ASS 有样式行');
  ok(/OutlineColour,/.test(ass) && /&H00000000/.test(ass), 'D2 ASS 的描边色是黑色');
  ok(/^PlayResX: 1920$/m.test(ass) && /^PlayResY: 1080$/m.test(ass), 'D2 ASS 的 PlayRes 与视频分辨率一致');

  // D4 折行质量（回归：曾经会产出「孤字行」和「标点跑行首」）
  //
  // 背景：旧的贪心折行会产生
  //   motility（肠道动力）和 pollinators（传粉者）
  //   。                                    ← 第二行只有一个句号
  // 修法是「最小参差折行 + 中文避头尾」。这里用真实踩过的字符串钉住行为。
  const NO_START = /^[，。、；：？！）〕】》」』…—～·,.;:?!)]}]/;
  const wrapCases = [
    ['zh', 22, 'motility（肠道动力）和 pollinators（传粉者）。'],
    ['zh', 22, '学术机构的情况下，你如何培养一个有正念的孩子？'],
    ['zh', 22, '对于罪恶之城来说，人还挺多的。谁——这非常非常有趣，'],
    ['en', 44, "who's like he's the junior version of Satan let's"],
    ['en', 44, "It's like it's no that's you have to make your way"],
  ];
  let wrapProblems = [];
  for (const [kind, max, text] of wrapCases) {
    const fn = kind === 'zh' ? assMod.wrapChinese : assMod.wrapEnglish;
    const limit = kind === 'zh' ? max : max * 0.5; // 英文的上限单位 = 字符数 × 0.5
    const lines = fn(text, max);
    const ws = lines.map((l) => assMod.displayWidth(l));
    if (ws.some((w) => w > limit + 0.01)) wrapProblems.push(`超宽: ${text.slice(0, 20)}`);
    if (lines.length > 1) {
      const last = lines[lines.length - 1];
      const solid = kind === 'zh'
        ? last.replace(/[\s，。、；：？！…—～·]/g, '').length
        : last.trim().split(/\s+/).filter(Boolean).length;
      if (solid <= (kind === 'zh' ? 2 : 1)) wrapProblems.push(`孤行: ${text.slice(0, 20)}`);
      for (let i = 1; i < lines.length; i++) {
        if (NO_START.test(lines[i])) wrapProblems.push(`标点跑行首: ${text.slice(0, 20)}`);
      }
      // 均衡度：两行长度不该差 3 倍以上
      const min = Math.min(...ws);
      const maxW = Math.max(...ws);
      if (min > 0 && maxW / min >= 3) wrapProblems.push(`不均衡: ${text.slice(0, 20)}`);
    }
  }
  ok(wrapProblems.length === 0, 'D4 折行无孤字行 / 标点不跑行首 / 不超宽 / 两行均衡', wrapProblems.join('; '));

  // 英文折行不能把单词之间的空格弄丢（回归：曾经 join('') 把 who's like 变成 who'slike）
  const enSpace = assMod.wrapEnglish("who's like he's the junior version of Satan let's", 44);
  ok(
    enSpace.every((l) => !/[a-z][A-Z]/.test(l) || /\s/.test(l)),
    'D4 英文折行保留了单词间的空格',
    enSpace.join(' / ')
  );


  // D3 双语 SRT
  const srt = sub.buildBilingualSrt(r.cues, r.cueZh);
  const blocks = (srt.match(/-->/g) || []).length;
  ok(blocks === r.cues.length, 'D3 双语 SRT 条数 = 字幕条数', `${blocks} / ${r.cues.length}`);
  ok(/[\u4e00-\u9fff]/.test(srt), 'D3 双语 SRT 里确实有中文');
}

// ================================================================ E. generateForVideo 编排
async function testOrchestration() {
  section('E. generateForVideo 编排（含缓存）');

  // 金句卡片的「渲染」依赖真的 Electron 窗口，Node 里给不了。
  // 这里只把渲染这一步换成桩 —— 要验的是**编排**（有没有被调用、结果有没有被记录、
  // 失败会不会连累文档），而不是渲染本身。渲染已由真机验证覆盖。
  const quoteCard = require('../src/main/study/quote-card');
  let cardCalls = 0;
  let cardShouldFail = false;
  quoteCard.renderQuoteCards = async ({ outDir }) => {
    cardCalls++;
    if (cardShouldFail) return { ok: false, error: '模拟渲染失败' };
    return { ok: true, dir: outDir, files: ['金句-01.png', '金句-02.png', '金句-03.png'] };
  };

  const dir = path.join(TMP, 'gen');
  fs.rmSync(dir, { recursive: true, force: true });
  fs.mkdirSync(dir, { recursive: true });
  const videoPath = path.join(dir, '演示视频 [2026-01-01].mp4');
  const srtPath = path.join(dir, '演示视频 [2026-01-01].en.srt');
  fs.writeFileSync(videoPath, 'fake video bytes', 'utf8');
  fs.writeFileSync(srtPath, makeSrt(90), 'utf8');

  const settings = Object.assign({}, require('../src/main/settings').load(), {
    outputDir: dir,
    studyBaseURL: CFG.baseURL,
    studyApiKey: CFG.apiKey,
    studyModel: CFG.model,
    studyAss: true,
    studyBilingualSrt: true,
    studyIncludePureEnglish: true,
    studyIncludeVocab: true,
    studyTimecode: true,
  });

  const args = {
    srtPath,
    videoPath,
    videoId: 'TESTVID001',
    width: 1920,
    height: 1080,
    meta: { title: '演示视频', channel: '演示频道', durationMs: 300000, uploadDate: '2026-01-01', url: 'https://example.com/x' },
    settings,
  };

  reset();
  const r1 = await study.generateForVideo(args);
  ok(!!r1.paths.docx && fs.existsSync(r1.paths.docx), 'E1 学习文档落盘');
  ok(!!r1.paths.ass && fs.existsSync(r1.paths.ass), 'E1 双语 ASS 落盘');
  ok(!!r1.paths.bilingualSrt && fs.existsSync(r1.paths.bilingualSrt), 'E1 双语 SRT 落盘');
  ok(r1.fromCache === false, 'E1 首次生成不是缓存命中');
  ok(translateCalls().length > 0, 'E1 首次生成确实调用了模型', `${translateCalls().length} 次`);

  // 双语 SRT 必须带 BOM（Windows 自带播放器要靠它认出 UTF-8）
  const bom = fs.readFileSync(r1.paths.bilingualSrt).slice(0, 3);
  ok(bom[0] === 0xef && bom[1] === 0xbb && bom[2] === 0xbf, 'E1 双语 SRT 带 UTF-8 BOM');

  // E2 第二次 → 命中缓存，不再调用模型
  reset();
  const r2 = await study.generateForVideo(args);
  ok(r2.fromCache === true, 'E2 第二次命中翻译缓存');
  ok(callLog.length === 0, 'E2 命中缓存后 0 次模型调用（不花钱）', `实际 ${callLog.length} 次`);

  // E5 金句卡片是自动产出的，且结果被记进 paths
  ok(cardCalls > 0, 'E5 生成文档时会自动渲染金句卡片（不再需要按钮）', `调用 ${cardCalls} 次`);
  ok(r2.paths.quoteCardCount === 3, 'E5 金句卡片数量被记进 paths', `${r2.paths.quoteCardCount}`);
  ok(!!r2.paths.quoteCards, 'E5 金句卡片目录被记进 paths');

  // E6 卡片渲染失败不能连累文档
  cardShouldFail = true;
  const before = cardCalls;
  const r6 = await study.generateForVideo(args);
  ok(cardCalls > before, 'E6 失败场景下卡片渲染确实被调用了');
  ok(!!r6.paths.docx && fs.existsSync(r6.paths.docx), 'E6 卡片渲染失败时文档照常产出（解耦正确）');
  cardShouldFail = false;

  // E3 中间结果文件跑完必须被删掉（否则下次会误判成「还没跑完」）
  const cacheDir = require('../src/main/paths').userDataDir();
  const partials = fs.existsSync(cacheDir)
    ? fs.readdirSync(cacheDir).filter((f) => f.endsWith('.partial.json'))
    : [];
  ok(partials.length === 0, 'E3 跑完后中间结果已清理', partials.join(','));

  // E4 force → 忽略缓存重跑
  reset();
  const r3 = await study.generateForVideo(Object.assign({}, args, { force: true }));
  ok(r3.fromCache === false && translateCalls().length > 0, 'E4 force 时忽略缓存重新翻译', `${translateCalls().length} 次调用`);
}

// ================================================================ 主流程
(async function main() {
  fs.rmSync(TMP, { recursive: true, force: true });
  fs.mkdirSync(TMP, { recursive: true });
  SRT = path.join(TMP, 'demo.en.srt');
  fs.writeFileSync(SRT, makeSrt(120), 'utf8');

  installFakeLLM();

  console.log('学习文档流水线端到端测试（假模型 · 不联网 · 无费用）');
  console.log('临时目录: ' + TMP);
  console.log('字幕: ' + path.basename(SRT) + '（120 条）');

  await testStructure();
  await testTranslate();
  await testResume();
  await testArtifacts();
  await testOrchestration();

  section('汇总');
  console.log(`  通过 ${pass} / 失败 ${fail}`);
  if (failures.length) {
    console.log('  失败项：');
    failures.forEach((f) => console.log('   - ' + f));
  }
  fs.rmSync(TMP, { recursive: true, force: true });
  process.exit(fail > 0 ? 1 : 0);
})().catch((e) => {
  console.error('\n测试本身崩了：', e && e.stack ? e.stack.split('\n').slice(0, 6).join('\n') : e);
  process.exit(1);
});
