'use strict';
/**
 * 学习文档流水线用的大模型接入层。
 * 统一走 OpenAI 兼容协议（/chat/completions），因此 DeepSeek / OpenAI / 通义 / Kimi /
 * GLM / OpenRouter / 本地 Ollama 都能直接用，只要填对 baseURL + model。
 */

const DEFAULT_TIMEOUT_MS = 300000;

/**
 * 提示词版本号。改动提示词时递增，用于让旧的翻译缓存自动失效
 * （否则会拿旧提示词产出的结果去生成新文档，很难排查）。
 */
const PROMPT_VERSION = 3;

function joinUrl(baseURL, suffix) {
  return String(baseURL).replace(/\/+$/, '') + suffix;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * 调用一次 chat/completions，带 429/5xx 退避重试。
 * @returns {Promise<{content:string, usage:object}>}
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
      const content = choice && choice.message && choice.message.content;
      if (!content) throw new Error('响应里没有 content: ' + text.slice(0, 150));
      return {
        content,
        usage: json.usage || {},
        finishReason: choice.finish_reason || '',
      };
    } catch (err) {
      lastErr = err;
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

/** 连通性测试（对应界面上的「测试连接」按钮） */
async function testConnection(cfg) {
  const t0 = Date.now();
  const r = await callLLM(
    cfg,
    [
      { role: 'system', content: '你是测试助手，只回答用户要求的内容。' },
      { role: 'user', content: '请只回复两个字：正常' },
    ],
    16,
    { attempts: 1, timeoutMs: 30000 }
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

任务：把整篇内容按语义和主题划分成若干段落，每段在内容上自成一体。

硬性要求：
1. 段落边界必须落在给定的序号边界上；
2. 段落边界必须尽量落在句子结束的位置（文本以 . ? ! 收尾、且下一条以大写字母开头），绝不要把一句话从中间切开；
3. 各段区间必须严格首尾相接、不重叠、不遗漏：第一段从第 1 条开始，最后一段到最后一条结束；
4. 段落数量按内容自然划分，通常 6~25 段；
5. 每段给一个简短的中文主题小标题，不超过 15 个字。

只输出 JSON 数组，不要任何解释、不要 Markdown 代码块。格式：
[{"from":1,"to":45,"topic":"开场与本期主题"}]`;

const TRANSLATE_SYSTEM = `你是资深英中翻译与英语教学编辑。用户会给你一段 YouTube 视频的自动字幕碎片（带序号），以及上一段的结尾作为上下文。

自动字幕的特点：碎片化、无标点、无大小写、专有名词可能有识别错误。

请输出严格的 JSON 对象，包含五个字段：

1. "en"：把碎片重排成通顺的英文段落。补全标点与大小写、合并被切断的句子、去掉 [music] 之类的音效标记。必须忠实原文，不要改写成你自己的话，不要漏掉任何信息。可以顺手修正明显的语音识别错误（例如把人名、专业术语的拼写改对）。

2. "zh"：把 "en" 翻译成自然流畅的简体中文。忠实准确，不要意译扩写。专业术语保留英文原词并在括号内给中文，例如 REM sleep（快速眼动睡眠）。

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

只输出 JSON 对象，不要任何解释、不要 Markdown 代码块。`;

// ---------------------------------------------------------------- 校验

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
  parseJsonLoose,
  STRUCT_SYSTEM,
  TRANSLATE_SYSTEM,
  validatePlan,
  validateCues,
  parseCuesField,
  PROMPT_VERSION,
};
