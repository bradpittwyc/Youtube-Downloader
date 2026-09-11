'use strict';
/**
 * 生成中英双语 ASS 字幕（可分别设色 + 黑描边）。
 *
 * 为什么必须是 ASS 而不是 SRT：
 *   SRT 是纯文本、零样式能力；mov_text（MP4 内嵌字幕）对样式支持极不一致。
 *   只有 ASS 支持「每行独立字体 / 颜色 / 描边 / 位置」，这是"中英不同色 + 黑边"的唯一途径。
 *
 * 关键实现点：
 *  · ASS 颜色是 &HAABBGGRR（透明度 + BGR 倒序），不是 RGB —— 最容易写错的地方
 *  · PlayResX/PlayResY 必须与视频实际分辨率一致，否则字号与定位会整体错乱
 *  · 字号/描边/边距都要按分辨率等比缩放（竖屏 Shorts 是 1080x1920，是横屏的 1.78 倍）
 *  · Alignment=2 是底部对齐，MarginV 是「距底部距离」，所以数值大的反而在上面
 */

const BASE_RES_Y = 1080; // 下列基准值都是针对 PlayResY = 1080 调的

const BASE = {
  fontEn: 'Times New Roman',
  fontZh: 'Microsoft YaHei',
  sizeEn: 50,
  sizeZh: 44,
  outline: 3,
  shadow: 0,
  marginLR: 70,
  /** 整个双语块距底部的距离（中英合并成一个事件，所以只要一个值） */
  marginV: 48,
  wrapEnChars: 44,
  wrapZhChars: 22,
};

/** #RRGGBB（界面里给用户填的）→ ASS 的 &HAABBGGRR */
function toAssColor(hex, alpha = 0) {
  const m = String(hex || '').trim().replace(/^#/, '').match(/^([0-9a-fA-F]{6})$/);
  if (!m) return '&H00FFFFFF';
  const s = m[1];
  const r = s.slice(0, 2);
  const g = s.slice(2, 4);
  const b = s.slice(4, 6);
  const a = Math.max(0, Math.min(255, Math.round(alpha))).toString(16).padStart(2, '0');
  return `&H${a}${b}${g}${r}`.toUpperCase();
}

/** 毫秒 → ASS 时间 H:MM:SS.cc（百分秒） */
function fmtAssTime(ms) {
  const cs = Math.max(0, Math.round((ms || 0) / 10));
  const h = Math.floor(cs / 360000);
  const m = Math.floor((cs % 360000) / 6000);
  const s = Math.floor((cs % 6000) / 100);
  const c = cs % 100;
  return `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}.${String(c).padStart(2, '0')}`;
}

/**
 * ASS 文本转义：花括号会被当作样式覆盖块、反斜杠是转义符，
 * 出现在正文里会导致整行显示异常，统一换成全角或去掉。
 */
function escAss(text) {
  return String(text == null ? '' : text)
    .replace(/\{/g, '｛')
    .replace(/\}/g, '｝')
    .replace(/\\/g, '')
    .replace(/\r?\n/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/** 英文按单词折行，避免切断单词 */
function wrapEnglish(text, maxChars) {
  const words = String(text).split(/\s+/).filter(Boolean);
  const lines = [];
  let cur = '';
  for (const w of words) {
    if (!cur.length) cur = w;
    else if ((cur + ' ' + w).length <= maxChars) cur += ' ' + w;
    else {
      lines.push(cur);
      cur = w;
    }
  }
  if (cur) lines.push(cur);
  return lines.length ? lines : [''];
}

/**
 * 中文行的折行。
 * 关键：中英混排要按【显示宽度】算，不能按字符个数——
 * 一个拉丁字母的宽度约为一个汉字的 0.5 倍。否则 "Huberman Lab Essentials"
 * 会被当成 23 个字宽，直接把英文单词从中间切断（
 * 实测踩过：出现 "…Lab Esse\Nntials…" 这种断词）。
 * 同时保证不在英文单词内部断行。
 */
function isWide(ch) {
  const c = ch.codePointAt(0);
  return (
    (c >= 0x1100 && c <= 0x115f) ||
    (c >= 0x2e80 && c <= 0xa4cf) ||
    (c >= 0xac00 && c <= 0xd7a3) ||
    (c >= 0xf900 && c <= 0xfaff) ||
    (c >= 0xfe30 && c <= 0xfe6f) ||
    (c >= 0xff00 && c <= 0xff60) ||
    (c >= 0xffe0 && c <= 0xffe6)
  );
}

function displayWidth(s) {
  let w = 0;
  for (const ch of String(s)) w += isWide(ch) ? 1 : 0.5;
  return w;
}

const BREAK_AFTER = /[，。、；：？！,.;:?!…—”』」）)]/;

function wrapChinese(text, maxUnits) {
  const s = String(text).trim();
  if (!s) return [''];
  if (displayWidth(s) <= maxUnits) return [s];

  const lines = [];
  let cur = '';
  let w = 0;
  const push = () => {
    const t = cur.trim();
    if (t) lines.push(t);
    cur = '';
    w = 0;
  };

  for (const ch of s) {
    const cw = isWide(ch) ? 1 : 0.5;
    if (w + cw > maxUnits && cur) {
      // 不要在英文单词中间断开：往回退到最近的空格，把半个单词带到下一行
      const latinPair = /[A-Za-z0-9]/.test(ch) && /[A-Za-z0-9]$/.test(cur);
      if (latinPair) {
        const sp = cur.lastIndexOf(' ');
        if (sp > 0) {
          const carry = cur.slice(sp + 1).trim();
          cur = cur.slice(0, sp);
          push();
          cur = carry;
          w = displayWidth(carry);
        }
      }
      if (w + cw > maxUnits) push();
    }
    cur += ch;
    w += cw;
    // 只要接近行宽上限又刚好遇到标点，就优先在这里断——比硬按宽度断更自然，
    // 能避免出现「最可操 / 作的」这种把词拆开的断法。
    if (w >= maxUnits - 6 && BREAK_AFTER.test(ch)) push();
  }
  push();
  return lines.length ? lines : [''];
}

/**
 * 生成 ASS 字幕内容。
 * @param {object} o
 * @param {Array}  o.cues    [{start, end, text}]  清洗后的字幕碎片（英文）
 * @param {object} o.cueZh   { 序号(1基): 中文 }   逐条中文
 * @param {string} [o.title] 视频标题（写进 Script Info）
 * @param {number} [o.width]  视频宽（像素）
 * @param {number} [o.height] 视频高（像素）
 * @param {object} [o.options] 样式覆盖
 * @returns {string} ASS 文本
 */
function buildAss(o) {
  const cues = o.cues || [];
  const cueZh = o.cueZh || {};
  const opt = o.options || {};

  const width = Math.max(1, Math.round(Number(o.width) || 1920));
  const height = Math.max(1, Math.round(Number(o.height) || 1080));
  // 以高度为基准等比缩放：竖屏 1080x1920 会得到 1.78 倍的字号/描边，视觉大小才一致
  const scale = (height / BASE_RES_Y) * (Number(opt.fontScale) > 0 ? Number(opt.fontScale) : 1);

  const colorEn = toAssColor(opt.colorEn || '#FFFFFF');
  const colorZh = toAssColor(opt.colorZh || '#FFD700');
  const outlineColor = toAssColor(opt.outlineColor || '#000000');
  const borderStyle = Number(opt.borderStyle) === 3 ? 3 : 1; // 1=描边 3=背景框
  const backColor = toAssColor(opt.backColor || '#000000', 128); // 仅背景框模式使用
  const outline = Math.max(0, (Number(opt.outlineWidth) >= 0 ? Number(opt.outlineWidth) : BASE.outline) * scale);
  const shadow = Math.max(0, (Number(opt.shadow) || BASE.shadow) * scale);

  const S = (v) => Math.round(v * scale);
  const sizeEn = S(BASE.sizeEn);
  const sizeZh = S(BASE.sizeZh);
  const fontEn = opt.fontEn || BASE.fontEn;
  const fontZh = opt.fontZh || BASE.fontZh;

  // 只定义一个样式（中英合并成同一个事件，见下方说明），差异全部靠行内标签覆盖
  const styleBi = [
    'BI',
    fontEn,
    sizeEn,
    colorEn,
    '&H000000FF',
    outlineColor,
    backColor,
    '0,0,0,0',
    '100,100,0,0',
    borderStyle,
    outline.toFixed(1),
    shadow.toFixed(1),
    '2',
    S(BASE.marginLR),
    S(BASE.marginLR),
    S(BASE.marginV),
    '1',
  ].join(',');

  const head = [
    '[Script Info]',
    '; 由 YouTube 下载器生成（中英双语，可分别设色）',
    `Title: ${escAss(o.title || '')}`,
    'ScriptType: v4.00+',
    'WrapStyle: 0',
    'ScaledBorderAndShadow: yes',
    'YCbCr Matrix: TV.601',
    `PlayResX: ${width}`,
    `PlayResY: ${height}`,
    '',
    '[V4+ Styles]',
    'Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding',
    `Style: ${styleBi}`,
    '',
    '[Events]',
    'Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text',
  ];

  // 每行能装多少字符，必须由【可用宽度 ÷ 字号】推导，否则文字会溢出画面、
  // 被 libass 自动折行（实测：竖屏 1080 宽 + 字号 89，33 个字符就装不下了）。
  // 用户设置只作为「可读性上限」，与硬性宽度上限取较小值。
  const availW = Math.max(200, width - S(BASE.marginLR) * 2);
  const capEn = Math.floor(availW / (0.48 * S(BASE.sizeEn))); // 拉丁字符平均约 0.48 字宽
  const capZh = Math.floor(availW / (1.0 * S(BASE.sizeZh))); // 汉字按 1 字宽
  const wantEn = Number(opt.wrapEnChars) > 0 ? Number(opt.wrapEnChars) : BASE.wrapEnChars;
  const wantZh = Number(opt.wrapZhChars) > 0 ? Number(opt.wrapZhChars) : BASE.wrapZhChars;
  const wrapEn = Math.max(8, Math.min(wantEn, capEn));
  const wrapZh = Math.max(6, Math.min(wantZh, capZh));

  // 中英合并成【同一个事件】。
  // 为什么不用两条独立事件各挂一个样式：libass 有防重叠机制，
  // 两个时间相同的块一旦位置交叠就会被自动挪开，把精心设的 MarginV 彻底打乱
  // （实测踩过：无论怎么调 MarginV，中文都跑到英文上面去，因为位置由防重叠算法接管了）。
  // 合并成一个事件后，中英作为一个整体被定位，绝不会被拆散；
  // 两行的颜色/字体/字号差异用行内标签 {\r\c..\fn..\fs..} 覆盖即可。
  const tagEn = `{\\r\\c${colorEn}&\\fn${fontEn}\\fs${sizeEn}}`;
  const tagZh = `{\\r\\c${colorZh}&\\fn${fontZh}\\fs${sizeZh}}`;
  const events = [];

  cues.forEach((c, idx) => {
    const i = idx + 1;
    const en = escAss(c.text);
    const zh = escAss(cueZh[i] || cueZh[String(i)] || '');
    if (!en && !zh) return;
    const start = fmtAssTime(c.start);
    const end = fmtAssTime(Math.max(c.end, c.start + 200));
    const parts = [];
    if (en) parts.push(tagEn + wrapEnglish(en, wrapEn).join('\\N'));
    if (zh) parts.push(tagZh + wrapChinese(zh, wrapZh).join('\\N'));
    events.push(`Dialogue: 0,${start},${end},BI,,0,0,0,,${parts.join('\\N')}`);
  });

  return head.concat(events, ['']).join('\r\n');
}

module.exports = { buildAss, toAssColor, fmtAssTime, escAss, BASE, BASE_RES_Y };
