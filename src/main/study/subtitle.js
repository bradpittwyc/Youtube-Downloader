'use strict';
/**
 * 字幕解析与清洗（学习文档流水线的第一步，纯本地、不产生任何 API 费用）
 *
 * 这里集中了三个实测出来的关键处理，缺一个成品质量就会明显下降：
 *  1. collapseRolling —— YouTube 自动字幕是「滚动累加」式的，每条会重复上一条的内容。
 *     实测 29 分钟视频 1602 条里有 800 条是重复（重复正文 28826 字符）。
 *     不去重直接送大模型，token 白烧一倍以上，还会把同一句翻译好几遍。
 *  2. splitCuesAtSentences —— 一个 cue 里常常装着「上一句结尾 + 下一句开头」，
 *     不切开的话分段边界必然切断句子（实测 17/24 段出现残句）。
 *  3. endsSentence / snapPlanToSentences —— 把分段边界吸附到句末。
 */
const fs = require('fs');

const TIME_RE = /(\d{2}):(\d{2}):(\d{2})[,.](\d{3})\s*-->\s*(\d{2}):(\d{2}):(\d{2})[,.](\d{3})/;

function toMs(h, m, s, ms) {
  return ((+h * 60 + +m) * 60 + +s) * 1000 + +ms;
}

/** 解析 SRT → [{start, end, lines[]}] */
function parseSrt(text) {
  const blocks = String(text).replace(/\r/g, '').split(/\n{2,}/);
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

/** 去掉内联标签、音效标记、换说话人标记 */
function cleanLine(s) {
  return String(s)
    .replace(/<[^>]*>/g, '')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&#39;/gi, "'")
    .replace(/&quot;/gi, '"')
    .replace(/\[(music|applause|laughter|sighs|inaudible|noise|sound|silence)\]/gi, ' ')
    .replace(/>>+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/** 折叠「滚动累加」式自动字幕，只保留每条新增的内容 */
function collapseRolling(cues) {
  const out = [];
  let prevLines = [];
  let dropped = 0;
  let dupChars = 0;

  for (const c of cues) {
    const curLines = c.lines.map(cleanLine).filter(Boolean);
    if (!curLines.length) {
      prevLines = curLines;
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
    if (text) out.push({ start: c.start, end: c.end, text });
    else dropped++;
    prevLines = curLines;
  }

  // 合并零时长的过渡条目
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

const ABBR_RE = /(?:^|\s)(?:Dr|Mr|Mrs|Ms|Prof|St|vs|etc|Inc|Ltd|Jr|Sr|Fig|No|approx|dept|est|al|i\.e|e\.g)\.$/i;

/** 在句子边界处切分 cue（排除 Dr. / etc. 这类缩写） */
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

function endsSentence(text) {
  return /[.!?]["'”’)\]]?$/.test(String(text).trim());
}

/** 一步到位：读 SRT → 清洗 → 句末切分 */
function loadCues(srtPath) {
  const raw = fs.readFileSync(srtPath, 'utf8');
  const parsed = parseSrt(raw);
  const { cues: collapsed, dropped, dupChars } = collapseRolling(parsed);
  const cues = splitCuesAtSentences(collapsed);
  return {
    cues,
    stats: {
      raw: parsed.length,
      collapsed: collapsed.length,
      dropped,
      dupChars,
      final: cues.length,
      words: cues.reduce((s, c) => s + c.text.split(/\s+/).length, 0),
      chars: cues.reduce((s, c) => s + c.text.length, 0),
      durationMs: cues.length ? cues[cues.length - 1].end : 0,
    },
  };
}

function fmtTime(ms) {
  const s = Math.max(0, Math.floor(ms / 1000));
  const h = String(Math.floor(s / 3600)).padStart(2, '0');
  const m = String(Math.floor((s % 3600) / 60)).padStart(2, '0');
  const ss = String(s % 60).padStart(2, '0');
  return `${h}:${m}:${ss}`;
}

function fmtSrtTime(ms) {
  const s = Math.max(0, Math.floor(ms));
  const h = String(Math.floor(s / 3600000)).padStart(2, '0');
  const m = String(Math.floor((s % 3600000) / 60000)).padStart(2, '0');
  const sec = String(Math.floor((s % 60000) / 1000)).padStart(2, '0');
  const msec = String(s % 1000).padStart(3, '0');
  return `${h}:${m}:${sec},${msec}`;
}

function fmtDurationCn(ms) {
  const s = Math.round(ms / 1000);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const ss = s % 60;
  if (h > 0) return `${h} 小时 ${m} 分`;
  if (m > 0) return `${m} 分 ${ss} 秒`;
  return `${ss} 秒`;
}

/** 把碎片拼成较长的行（带序号区间），用于结构分析，省 token */
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
 * 生成中英双语 SRT。
 * cues 是清洗后的碎片（带原时间码），逐条中文来自模型输出。
 * 每条显示两行：英文原文 + 中文。
 */
function buildBilingualSrt(cues, cueZhMap, opts = {}) {
  const lines = [];
  let n = 0;
  cues.forEach((c, idx) => {
    const i = idx + 1;
    const zh = cueZhMap[i] || cueZhMap[String(i)];
    if (!zh) return;
    n++;
    lines.push(String(n));
    lines.push(`${fmtSrtTime(c.start)} --> ${fmtSrtTime(c.end)}`);
    lines.push(c.text.trim());
    lines.push(zh.trim());
    lines.push('');
  });
  return lines.join('\r\n');
}

module.exports = {
  parseSrt,
  cleanLine,
  collapseRolling,
  splitCuesAtSentences,
  endsSentence,
  loadCues,
  fmtTime,
  fmtSrtTime,
  fmtDurationCn,
  buildStructureLines,
  buildBilingualSrt,
};
