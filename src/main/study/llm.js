'use strict';
/**
 * 学习文档流水线用的大模型接入层。
 * 统一走 OpenAI 兼容协议（/chat/completions），因此 DeepSeek / OpenAI / 通义 / Kimi /
 * GLM / OpenRouter / 本地 Ollama 都能直接用，只要填对 baseURL + model。
 */

const DEFAULT_TIMEOUT_MS = 300000;

/**
 * 已知模型的档案。
 *
 * 【为什么要这张表】各家模型的行为差异很大，尤其是**推理模型**（会先"想"再答，
 * 思维链单独放在 reasoning_content 里）。实测 deepseek-flash / deepseek-v4-pro：
 *   · 「思考」的 token 也算进 max_tokens —— 给小了会返回【空 content】
 *   · 关掉思考后同样的翻译任务快 40%、省 27% 的 token，质量没差别
 *   · v4-pro 开着思考跑 45 条字幕要 80 秒（flash 只要 6 秒），容易把预算打满导致 JSON 截断
 * 所以「要不要思考」必须按模型和用途分别决定，不能一刀切。
 */
const MODEL_PROFILES = {
  'deepseek-flash': {
    label: 'deepseek-flash（推荐 · 快 · 省）',
    reasoning: true,
    priceIn: 2,
    priceOut: 8,
    note: '原 deepseek-chat 的实际后端，逐段翻译实测 6~10 秒 / 45 条',
  },
  'deepseek-v4-pro': {
    label: 'deepseek-v4-pro（更强 · 慢 8 倍 · 贵）',
    reasoning: true,
    priceIn: 4,
    priceOut: 16,
    note: '思考 token 消耗大，45 条字幕实测 80 秒，容易把 max_tokens 打满',
  },
  // 旧名字。服务器会静默转发到 deepseek-flash（响应里 model 字段就是 deepseek-flash），
  // 但 /v1/models 已经不再列出它，随时可能彻底停用。
  'deepseek-chat': {
    label: 'deepseek-chat（旧名 · 已转发到 flash）',
    reasoning: true,
    deprecated: 'deepseek-flash',
    priceIn: 2,
    priceOut: 8,
    note: '这是旧模型名，服务端已转发到 deepseek-flash，建议改过来',
  },
  'deepseek-reasoner': {
    label: 'deepseek-reasoner（旧名 · 推理专用）',
    reasoning: true,
    deprecated: 'deepseek-v4-pro',
    priceIn: 4,
    priceOut: 16,
    note: '旧模型名，已由 v4-pro 取代',
  },
};

/**
 * 模型名别名归一化 —— **只用于缓存比对**，不改变实际请求用的名字。
 *
 * 为什么要它：缓存键是 `videoId + srtPath`，而模型名是另外单独比对的
 * （`if (j.model !== model) return null`）。所以只要把配置里的
 * `deepseek-chat` 改成 `deepseek-flash`，17 份已付费的翻译缓存会全部失效。
 * 归一化之后「同一个后端的不同名字」共用缓存，改名不花钱。
 */
const MODEL_ALIASES = {
  'deepseek-chat': 'deepseek-flash',
  'deepseek-reasoner': 'deepseek-v4-pro',
};

function canonicalModel(name) {
  const m = String(name == null ? '' : name).trim();
  return MODEL_ALIASES[m.toLowerCase()] || m;
}

/** 取模型档案；不认识的模型返回保守默认（当作推理模型、不关思考） */
function modelProfile(name) {
  const key = String(name == null ? '' : name).trim().toLowerCase();
  if (MODEL_PROFILES[key]) return Object.assign({ id: key }, MODEL_PROFILES[key]);
  return {
    id: key,
    label: key,
    reasoning: true, // 保守：宁可多给预算，也不要返回空 content
    priceIn: 2,
    priceOut: 8,
    note: '未知模型，按推理模型保守处理',
  };
}

/**
 * 提示词版本号。改动提示词时递增，用于让旧的翻译缓存自动失效
 * （否则会拿旧提示词产出的结果去生成新文档，很难排查）。
 */
// 4：结构分析同时返回 takeaways（全文要点）与 quotes（金句）
const PROMPT_VERSION = 4;

/** 推理模型「关掉思考」时要带的参数（实测两个名字都生效） */
const NO_THINK = { reasoning_effort: 'none' };

function joinUrl(baseURL, suffix) {
  return String(baseURL).replace(/\/+$/, '') + suffix;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * 调用一次 chat/completions，带 429/5xx 退避重试。
 *
 * @param {object} cfg  { baseURL, apiKey, model, temperature }
 * @param {Array}  messages
 * @param {number} maxTokens
 * @param {object} opts
 *   · attempts / timeoutMs
 *   · reasoning: 'off' 关掉思考（推理模型专用）。翻译这种任务实测关掉更快更省，
 *     而且能避免思考把 max_tokens 吃光导致返回空 content。
 * @returns {Promise<{content:string, usage:object, finishReason:string}>}
 */
async function callLLM(cfg, messages, maxTokens = 8192, opts = {}) {
  const url = joinUrl(cfg.baseURL, '/chat/completions');
  const body = {
    model: cfg.model,
    messages,
    temperature: cfg.temperature != null ? cfg.temperature : 0.2,
    max_tokens: maxTokens,
    stream: false,
  };
  if (opts.reasoning === 'off') Object.assign(body, NO_THINK);
  const attempts = opts.attempts || 4;
  let lastErr = null;

  for (let i = 0; i < attempts; i++) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), opts.timeoutMs || DEFAULT_TIMEOUT_MS);
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
        const retriable = res.status === 429 || res.status >= 500;
        lastErr = new Error(`HTTP ${res.status}: ${text.slice(0, 200)}`);
        if (retriable && i < attempts - 1) {
          await sleep(1500 * Math.pow(2, i));
          continue;
        }
        throw lastErr;
      }
      let json;
      try {
        json = JSON.parse(text);
      } catch (_) {
        throw new Error('响应不是合法 JSON: ' + text.slice(0, 150));
      }
      const choice = json.choices && json.choices[0];
      const msg = (choice && choice.message) || {};
      const content = msg.content;
      const finish = (choice && choice.finish_reason) || '';
      const reasoningTokens =
        (json.usage && json.usage.completion_tokens_details &&
          json.usage.completion_tokens_details.reasoning_tokens) || 0;

      // 【必须先判断截断，再判断空 content】
      // 推理模型的思考 token 也算进 max_tokens：预算给小了会 finish_reason=length
      // 且 content 为空（或 JSON 被从中间截断）。这**不是格式错误，重试没有意义** ——
      // 重试只会再烧一次钱、再被截断一次。
      if (finish === 'length') {
        const hint =
          reasoningTokens > 0
            ? `模型把 ${reasoningTokens} 个 token 花在「思考」上，把 max_tokens(${maxTokens}) 占满了`
            : `max_tokens(${maxTokens}) 不够`;
        const e = new Error(`输出被截断：${hint}。请调大预算或改用非推理模型。`);
        e.code = 'TRUNCATED';
        e.noRetry = true;
        throw e;
      }
      if (!content) {
        const ranOut = reasoningTokens > 0 ? `（思考用了 ${reasoningTokens} 个 token）` : '';
        const e = new Error(
          `响应里没有 content${ranOut}。若为推理模型，多半是 max_tokens 太小 —— 思考会先吃掉预算。原文：` +
            text.slice(0, 150)
        );
        e.code = 'EMPTY_CONTENT';
        throw e;
      }
      return {
        content,
        usage: json.usage || {},
        finishReason: finish,
      };
    } catch (err) {
      lastErr = err;
      if (err && err.noRetry) throw err; // 截断不重试
      const msg = String(err && err.message);
      const retriable = /abort|timeout|ECONN|ETIMEDOUT|socket|429|50\d/.test(msg);
      if (retriable && i < attempts - 1) {
        await sleep(1500 * Math.pow(2, i));
        continue;
      }
      throw err;
    } finally {
      clearTimeout(timer);
    }
  }
  throw lastErr || new Error('调用失败');
}

/**
 * 拉取该 API 支持的模型列表（GET /v1/models，**免费，不消耗 token**）。
 * 不是所有 OpenAI 兼容端点都实现它，所以失败时返回 ok:false 而不是抛错 ——
 * 界面据此把模型输入框退化成手填即可，不该阻塞用户。
 */
async function listModels(cfg) {
  const url = joinUrl(cfg.baseURL, '/models');
  try {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 20000);
    let res;
    try {
      res = await fetch(url, {
        headers: { Authorization: `Bearer ${cfg.apiKey}` },
        signal: ctrl.signal,
      });
    } finally {
      clearTimeout(timer);
    }
    const text = await res.text();
    if (!res.ok) return { ok: false, error: `HTTP ${res.status}: ${text.slice(0, 120)}`, models: [] };
    const j = JSON.parse(text);
    const models = (j.data || [])
      .map((m) => String((m && m.id) || '').trim())
      .filter(Boolean)
      .sort();
    return { ok: true, models };
  } catch (e) {
    return { ok: false, error: String((e && e.message) || e), models: [] };
  }
}

/**
 * 连通性测试（对应界面上的「测试连接」按钮）。
 *
 * 【max_tokens 不能给太小】原来是 16。推理模型的思考 token 也算进 max_tokens，
 * 16 个 token 会被思考全部吃光 → 返回空 content → 测试永远失败，
 * 哪怕配置完全正确（实测 deepseek-flash / deepseek-v4-pro 都是这个下场）。
 * 给足预算，并且关掉思考 —— 这只是一次「能不能通」的探测，不需要它思考。
 */
async function testConnection(cfg) {
  const t0 = Date.now();
  const r = await callLLM(
    cfg,
    [
      { role: 'system', content: '你是测试助手，只回答用户要求的内容。' },
      { role: 'user', content: '请只回复两个字：正常' },
    ],
    512,
    { attempts: 1, timeoutMs: 60000, reasoning: 'off' }
  );
  return { ok: true, ms: Date.now() - t0, reply: r.content.trim(), usage: r.usage };
}

/** 剥掉模型可能加的 ```json 围栏，再解析 */
function parseJsonLoose(s) {
  let t = String(s).trim();
  const fence = t.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (fence) t = fence[1].trim();
  const first = t.search(/[[{]/);
  if (first > 0) t = t.slice(first);
  const last = Math.max(t.lastIndexOf('}'), t.lastIndexOf(']'));
  if (last >= 0) t = t.slice(0, last + 1);
  return JSON.parse(t);
}

// ---------------------------------------------------------------- 提示词

const STRUCT_SYSTEM = `你是专业的字幕结构化编辑。用户会给你一份 YouTube 自动生成字幕的清洗稿，每行格式为「起始序号-结束序号: 文本」。

这些文本是从自动字幕切分出来的碎片，缺少标点、大小写和完整句子结构。你只做结构分析，不要翻译、不要改写。

【重要】「序号」指的是每行开头的**字幕条目编号**，不是行号。输入里的一行可能覆盖好几条字幕（例如「101-105: ...」），段落边界要用这种条目编号表示。

任务一 · 分段：把整篇内容按语义和主题划分成若干段落，每段在内容上自成一体。

硬性要求：
1. 段落边界必须落在给定的序号边界上；
2. 段落边界必须尽量落在句子结束的位置（文本以 . ? ! 收尾、且下一条以大写字母开头），绝不要把一句话从中间切开；
3. 各段区间必须严格首尾相接、不重叠、不遗漏：第一段从第 1 条开始，最后一段必须正好到最后一条结束（总条数在用户消息开头给出，请直接用它，不要自己数）；
4. 段落数量按内容自然划分，通常 6~25 段；
5. 每段给一个简短的中文主题小标题，6~15 个字，不要带句号或引号。

任务二 · takeaways（全文要点）：用 3~5 条总结整个视频的核心内容。
每条一句话，既要英文 "en"，也要对应的简体中文 "zh"。
要抓真正的主干观点，不要写「本视频介绍了…」这种空话。

任务三 · quotes（金句）：摘取视频中最精彩的 3~6 句话——
有洞察力、有冲击力、值得记住、适合背诵的那种。每条给出：
  "cue"：该句的起始字幕条目编号（整数，必须在 1 到总条数之间）
  "en"：英文原句（从原文原样摘取，可修正明显的语音识别错误）
  "zh"：中文翻译

【输出格式】只输出一个 JSON 对象，不要任何解释、不要 Markdown 代码块。
注意：顶层必须是对象（以 { 开头），不是数组。
字符串里如果出现英文双引号，必须转义成 \\"。
{"plan":[{"from":1,"to":45,"topic":"开场与本期主题"}],"takeaways":[{"en":"...","zh":"..."}],"quotes":[{"cue":12,"en":"...","zh":"..."}]}`;

const TRANSLATE_SYSTEM = `你是资深英中翻译与英语教学编辑。用户会给你一段 YouTube 视频的自动字幕碎片（带序号），以及上一段的结尾作为上下文。

自动字幕的特点：碎片化、无标点、无大小写、专有名词可能有识别错误。

请输出严格的 JSON 对象，包含五个字段：

1. "en"：把碎片重排成通顺的英文段落。补全标点与大小写、合并被切断的句子、去掉 [music] 之类的音效标记。必须忠实原文，不要改写成你自己的话，不要漏掉任何信息。可以顺手修正明显的语音识别错误（例如把人名、专业术语的拼写改对）。
   本段开头若承接上一段未说完的句子，可以借上下文补全，但只输出属于本段的内容。
   术语处理：同一个术语在本段内保持同一种写法；如果上下文里已经出现过某个译法，沿用它的中文译法。

2. "zh"：把 "en" 翻译成自然流畅的简体中文。忠实准确，不要意译扩写。专业术语保留英文原词并在括号内给中文，例如 REM sleep（快速眼动睡眠）。不要逐字硬译，也不要加入原文没有的解释。

3. "notes"：长难句精讲。从本段挑 1~2 个真正值得讲的句子（结构复杂、含地道表达或隐含逻辑），返回数组：
   [{"sentence":"英文原句，必须从 en 里原样摘取","explain":"中文讲解：句子结构怎么拆、难在哪里、为什么这样表达"}]
   本段如果没有值得讲的句子就返回空数组。宁少勿滥，不要为了凑数硬挑。

4. "vocab"：重点词汇。挑 3~5 个对中文学习者真正有价值的词或固定搭配（不要挑 the / is / and 这类基础词），返回数组：
   [{"word":"词或短语","phonetic":"音标","pos":"词性缩写","def":"结合本段语境的中文释义"}]
   宁少勿滥。

5. "cues"：逐条中文。这是一个**字符串**，每行一条，格式固定为「序号|中文」，行数必须与输入的条数完全相等、序号一一对应。

   这一项极其重要：
   - 必须严格一条输入对应一行输出，**绝对不允许把几条合并成一条**，也不允许跳过任何一条；
   - 不要把同一句话的碎片合并——哪怕这几条连起来才是一个完整句子，也要按条分别给出中文；
   - 行数必须与输入条数完全相等，序号必须与输入完全一致。

   正确示例（输入 3 条）：
   "cues": "12|我一直很期待\\n13|这次对话\\n14|我知道很多人会很想了解"

   错误示例（把 12-13 合并了，缺少 13）：
   "cues": "12|我一直很期待这次对话\\n14|我知道很多人会很想了解"

【JSON 转义】所有字符串里的英文双引号必须转义成 \\"，反斜杠写成 \\\\。
英文原文里出现引语、书名、俚语时很容易踩这个坑，写坏 JSON 会导致整段作废重来。

只输出 JSON 对象，不要任何解释、不要 Markdown 代码块。`;

// ---------------------------------------------------------------- 校验

/**
 * 把结构分析的返回拆成三段。
 * 兼容两种形态：老版本只回一个数组；新版本回 { plan, takeaways, quotes }。
 */
function extractStruct(parsed) {
  if (Array.isArray(parsed)) return { plan: parsed, takeaways: [], quotes: [] };
  if (!parsed || typeof parsed !== 'object') return { plan: null, takeaways: [], quotes: [] };
  return {
    plan: Array.isArray(parsed.plan) ? parsed.plan : Array.isArray(parsed.segments) ? parsed.segments : null,
    takeaways: normTakeaways(parsed.takeaways),
    quotes: normQuotes(parsed.quotes),
  };
}

/** 全文要点：最多 5 条，中英都要有 */
function normTakeaways(list) {
  if (!Array.isArray(list)) return [];
  return list
    .map((x) => ({
      en: String((x && x.en) || '').trim(),
      zh: String((x && x.zh) || '').trim(),
    }))
    .filter((x) => x.en || x.zh)
    .slice(0, 5);
}

/** 金句：最多 6 条，cue 用来换算时间码 */
function normQuotes(list) {
  if (!Array.isArray(list)) return [];
  return list
    .map((x) => ({
      cue: Number(x && x.cue) || 0,
      en: String((x && x.en) || '').trim(),
      zh: String((x && x.zh) || '').trim(),
    }))
    .filter((x) => x.en || x.zh)
    .slice(0, 6);
}

function validatePlan(plan, total) {
  const errs = [];
  if (!Array.isArray(plan) || !plan.length) return ['分段计划不是非空数组'];
  let expect = 1;
  plan.forEach((p, i) => {
    if (typeof p.from !== 'number' || typeof p.to !== 'number') {
      errs.push(`第 ${i + 1} 段缺少 from/to`);
      return;
    }
    if (p.from !== expect) errs.push(`第 ${i + 1} 段 from=${p.from}，期望 ${expect}`);
    if (p.to < p.from) errs.push(`第 ${i + 1} 段 to < from`);
    expect = p.to + 1;
    if (!p.topic) errs.push(`第 ${i + 1} 段缺少 topic`);
  });
  if (expect !== total + 1) errs.push(`最后一段到 ${expect - 1}，但总条数是 ${total}`);
  return errs;
}

/**
 * 修复模型给出的分段计划。
 *
 * 为什么需要：validatePlan 要求 plan 精确覆盖 1..total 且首尾相接，
 * 但长字幕下模型几乎必然算错边界 —— 实测那个 1 小时 17 分的视频有 2758 条，
 * 喂进去 639 行，要模型精确对齐到第 2758 条基本是碰运气。
 * 而「分段计划」本身只是把长文切成便于加工的块的启发式，边界差几条无伤大雅，
 * 后面还有「句末吸附」和「大段拆分」两道处理。所以能修就修，不该整单失败。
 *
 * 修法：排序 → 起点一律接上一段（吸收空洞与重叠）→ 裁到 [1,total]
 *       → 结尾没覆盖满就把最后一段拉长。
 *
 * @returns {Array|null} 修好的计划；连一个可用段都没有时返回 null
 */
function repairPlan(raw, total) {
  if (!Array.isArray(raw) || !raw.length || !(Number(total) > 0)) return null;
  const items = [];
  for (const p of raw) {
    const from = Math.round(Number(p && p.from));
    const to = Math.round(Number(p && p.to));
    if (!Number.isFinite(from) || !Number.isFinite(to)) continue;
    items.push({ from, to, topic: String((p && p.topic) || '').trim() });
  }
  if (!items.length) return null;
  items.sort((a, b) => a.from - b.from);

  const out = [];
  let expect = 1;
  for (const p of items) {
    if (expect > total) break;
    const to = Math.min(Math.max(p.to, 1), total);
    if (to < expect) continue; // 整段落在已处理范围内（重叠段）
    out.push({ from: expect, to, topic: p.topic || `第 ${out.length + 1} 部分` });
    expect = to + 1;
  }
  if (!out.length) return null;
  // 结尾没到 total → 把最后一段拉长。宁可最后一段大一点，也不要整份文档生不出来。
  if (out[out.length - 1].to < total) out[out.length - 1].to = total;
  return out;
}

function parseCuesField(raw) {
  if (Array.isArray(raw)) {
    return raw
      .map((c) => ({ i: parseInt(c && c.i, 10), zh: String((c && c.zh) || '').trim() }))
      .filter((c) => Number.isFinite(c.i));
  }
  if (typeof raw !== 'string') return null;
  const out = [];
  for (const line of raw.split(/\r?\n/)) {
    const m = line.trim().match(/^(\d+)\s*[|｜:：]\s*(.*)$/);
    if (m) out.push({ i: parseInt(m[1], 10), zh: m[2].trim() });
  }
  return out;
}

function validateCues(seg, expectedIdx) {
  const parsed = parseCuesField(seg && seg.cues);
  if (!parsed) return { ok: false, missing: expectedIdx, extra: [], parsed: [] };
  const got = new Set(parsed.map((c) => c.i));
  const missing = expectedIdx.filter((i) => !got.has(i));
  const extra = [...got].filter((i) => !expectedIdx.includes(i));
  return { ok: missing.length === 0 && extra.length === 0, missing, extra, parsed };
}

module.exports = {
  callLLM,
  testConnection,
  listModels,
  parseJsonLoose,
  STRUCT_SYSTEM,
  TRANSLATE_SYSTEM,
  validatePlan,
  repairPlan,
  extractStruct,
  normTakeaways,
  normQuotes,
  validateCues,
  parseCuesField,
  PROMPT_VERSION,
  MODEL_PROFILES,
  MODEL_ALIASES,
  canonicalModel,
  modelProfile,
};
