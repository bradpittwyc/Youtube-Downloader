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
  fontZh: '微软雅黑',
  sizeEn: 50,
  sizeZh: 44,
  /**
   * 描边粗细的兜底值（设置里没给、或给了负数时才用它）。
   * 与 settings.js 的默认值保持一致：作者对比 0~5 各档后选定的 1。
   */
  outline: 1,
  shadow: 0,
  marginLR: 70,
  /** 中文块底边距画面底部的距离 */
  marginV: 48,
  /**
   * 中英之间的额外行距，单位是英文字号的倍数。
   * 0 = libass 自然排版（间距恒等于英文的下伸部空间，实测偏大）；
   * 负值把英文往下拉。默认 -0.20：实测在 1080p / 竖屏 1920 下都明显收紧，
   * 且带下伸部的字母（g/y/p）仍不会碰到中文。
   */
  lineGap: -0.2,
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
    // 先把 ASS 的转义序列还原成它本来的字符，再删反斜杠。
    // 顺序很重要：YouTube 会把消音占位 [ __ ] 转义成 [\h__\h]（\h 是硬空格），
    // 直接删反斜杠会变成 [h__h] 这种垃圾（实测踩过，一条视频里有 200 多处）。
    .replace(/\\[hNn]/g, ' ')
    .replace(/\{/g, '｛')
    .replace(/\}/g, '｝')
    .replace(/\\/g, '')
    .replace(/\r?\n/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * 中文排版的「避头尾」禁则。
 *
 * 避头点：不能出现在【行首】。断在它前面就会变成「上一行塞满、下一行只有一个句号」，
 *   实测最丑的一种断法就是 `motility（肠道动力）和 pollinators（传粉者）\N。`
 * 避尾点：不能出现在【行尾】（开引号、开括号后面不该断）。
 */
const NO_LINE_START = '，。、；：？！）〕】》」』…—～·,.;:?!)]}»';
const NO_LINE_END = '（〔【《「『([{«';

/**
 * 把文本切成「不可再分的单元」，每个单元带自己的显示宽度。
 *  · 英文模式：一个单词一个单元（绝不从单词中间断开）
 *  · 中文模式：一个字一个单元，但连续的拉丁字母/数字整体算一个单元
 *    ——否则 "Huberman Lab Essentials" 会被逐字母切开（实测踩过）
 */
function splitUnits(text, mode) {
  const s = String(text);
  const units = [];
  if (mode === 'en') {
    // ⚠️ 每个词的宽度必须【带上它前面那个空格】。
    // 否则动态规划只用「单词宽度之和」判断是否超行 —— 空格全被漏算，
    // 实测会把实际宽 24.5 的一行（上限 22）判定成 20.5 塞进一行，直接溢出。
    // 拼回去时用空格 join，正好与这里的计入方式对上。
    const words = s.split(/\s+/).filter(Boolean);
    words.forEach((w, i) => units.push({ text: w, w: displayWidth(w) + (i ? 0.5 : 0) }));
  } else {
    let buf = '';
    const flush = () => {
      if (buf) {
        units.push({ text: buf, w: displayWidth(buf) });
        buf = '';
      }
    };
    for (const ch of s) {
      if (/[A-Za-z0-9]/.test(ch)) buf += ch;
      else {
        flush();
        units.push({ text: ch, w: displayWidth(ch) });
      }
    }
    flush();
  }
  return units;
}

/** 贪心折行：只在动态规划解不出来时兜底（例如单个词就比整行还宽） */
function wrapGreedy(units, maxUnits, mode) {
  const joiner = mode === 'en' ? ' ' : '';
  const lines = [];
  let cur = [];
  let w = 0;
  for (const u of units) {
    if (cur.length && w + u.w > maxUnits) {
      lines.push(cur.map((x) => x.text).join(joiner).trim());
      cur = [];
      w = 0;
    }
    cur.push(u);
    w += u.w;
  }
  if (cur.length) lines.push(cur.map((x) => x.text).join(joiner).trim());
  const out = lines.filter((l) => l.length);
  return out.length ? out : [''];
}

/**
 * 均衡折行（minimum-raggedness）+ 中文避头尾禁则。
 *
 * 【为什么不用贪心】贪心是「填到满为止」，必然产生两种难看的结果：
 *   · 上一行塞得满满、下一行只剩一两个字（实测中文 19 处、英文 30 处）
 *   · 两行长度差 3 倍以上（实测 78 处）
 * 最小参差折行反过来求「各行长度尽量接近」，天然消除孤字行。
 *
 * 代价函数：Σ(行内剩余空间)² + 违禁罚分。
 * 总剩余空间 = 行数 × 上限 − 总宽度，是个定值；而「和固定时平方和最小」
 * 正好发生在各行剩余相等的时候 —— 所以这个代价函数给出的就是最均衡的切法。
 *
 * @param {string} text
 * @param {number} maxUnits 每行最多多少「显示宽度单位」（1 个汉字 = 1，1 个拉丁字母 = 0.5）
 * @param {'en'|'zh'} mode
 */
function wrapBalanced(text, maxUnits, mode) {
  const s = String(text).trim();
  if (!s) return [''];
  if (displayWidth(s) <= maxUnits) return [s];

  const units = splitUnits(s, mode);
  const n = units.length;
  if (!n) return [''];
  if (n === 1) return [units[0].text];

  const cum = new Array(n + 1).fill(0);
  for (let i = 0; i < n; i++) cum[i + 1] = cum[i] + units[i].w;

  const INF = Number.POSITIVE_INFINITY;
  const cost = new Array(n + 1).fill(INF);
  const cut = new Array(n + 1).fill(-1);
  cost[0] = 0;

  for (let j = 1; j <= n; j++) {
    for (let i = j - 1; i >= 0; i--) {
      const w = cum[j] - cum[i];
      if (w > maxUnits + 0.01) break; // 再往前只会更宽
      if (cost[i] === INF) continue;
      let pen = 0;
      // 这一行的最后一个字符不能是避尾点
      const tail = units[j - 1].text;
      if (NO_LINE_END.includes(tail[tail.length - 1])) pen += 1e6;
      // 下一行的第一个字符不能是避头点
      if (j < n && NO_LINE_START.includes(units[j].text[0])) pen += 1e6;
      const slack = maxUnits - w;
      const c = cost[i] + slack * slack + pen;
      if (c < cost[j]) {
        cost[j] = c;
        cut[j] = i;
      }
    }
  }

  if (cost[n] === INF) return wrapGreedy(units, maxUnits, mode);

  // 英文单元之间要补回空格（splitUnits 把空格去掉了）；
  // 中文单元是逐字的，直接拼。用 join('') 会把 "who's like" 变成 "who'slike"。
  const joiner = mode === 'en' ? ' ' : '';
  const raw = [];
  for (let j = n; j > 0; ) {
    const i = cut[j];
    if (i < 0) return wrapGreedy(units, maxUnits, mode);
    raw.unshift(units.slice(i, j).map((u) => u.text).join(joiner).trim());
    j = i;
  }
  return raw.filter((l) => l.length).length ? raw.filter((l) => l.length) : [''];
}

/** 英文折行。maxChars 是【字符数】，而 1 个拉丁字符 ≈ 0.5 个显示宽度单位 */
function wrapEnglish(text, maxChars) {
  return wrapBalanced(text, Math.max(4, Number(maxChars) * 0.5), 'en');
}

/**
 * 中文行的折行。按【显示宽度】算，不能按字符个数 ——
 * 一个拉丁字母的宽度约为一个汉字的 0.5 倍。
 */
function wrapChinese(text, maxUnits) {
  return wrapBalanced(text, Math.max(3, Number(maxUnits)), 'zh');
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
  /** 中文块底边距画面底部的距离（事件用 \pos 定位，这个值只在样式里留作兜底） */
  const marginV = S(BASE.marginV);

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
  // 中英拆成两个事件、各自用 \pos 精确定位。
  //
  // 为什么不用「一个事件 + \N 换行」：那样两行间距完全由 libass 按字体度量决定，
  // 实测恒等于英文的下伸部空间（1080p / fs50 下 8px），而 ASS 没有行距标签可调，
  // 想收紧一点都做不到。
  //
  // 实测结论（用 ffmpeg + libass 逐像素量出来的）：
  //   · 行推进 = 字号 × 1.000（两种字体都一样）→「块高 = 行数 × 字号」是精确的
  //   · \pos 定位的事件【不参与】libass 的防重叠计算，位置完全由我们决定
  //   · 英文底边 = 中文底边 − 中文行数×中文字号 − 额外间距，改 1px 就精确移动 1px
  // 顺带记一笔：\fs 配 \fscx/\fscy 把字形缩放回来是【无效】的，libass 仍按缩放后的高度算行距。
  const cx = Math.round(width / 2);
  const yZh = Math.round(height - marginV);
  // 额外行距，单位是英文字号的倍数；负值＝把英文往下拉（默认略微收紧）
  const gapEm = opt.lineGap == null ? BASE.lineGap : Number(opt.lineGap);
  const gapPx = Math.round(gapEm * sizeEn);

  const tagEn = `{\\an2\\c${colorEn}&\\fn${fontEn}\\fs${sizeEn}}`;
  const tagZh = `{\\an2\\c${colorZh}&\\fn${fontZh}\\fs${sizeZh}}`;
  const events = [];

  cues.forEach((c, idx) => {
    const i = idx + 1;
    const en = escAss(c.text);
    const zh = escAss(cueZh[i] || cueZh[String(i)] || '');
    if (!en && !zh) return;
    const start = fmtAssTime(c.start);
    const end = fmtAssTime(Math.max(c.end, c.start + 200));
    const zhLines = zh ? wrapChinese(zh, wrapZh) : [];
    const enLines = en ? wrapEnglish(en, wrapEn) : [];
    // 英文块底边：落在中文块之上，再减去额外行距
    const enBottom = zhLines.length ? yZh - zhLines.length * sizeZh - gapPx : yZh;
    if (enLines.length) {
      events.push(
        `Dialogue: 0,${start},${end},BI,,0,0,0,,{\\pos(${cx},${enBottom})}${tagEn}${enLines.join('\\N')}`
      );
    }
    if (zhLines.length) {
      events.push(`Dialogue: 0,${start},${end},BI,,0,0,0,,{\\pos(${cx},${yZh})}${tagZh}${zhLines.join('\\N')}`);
    }
  });

  return head.concat(events, ['']).join('\r\n');
}

// wrapEnglish / wrapChinese / displayWidth 导出是为了让测试能直接验证折行质量
// （孤字行、避头尾、是否超宽），不必绕道去解析生成出来的 ASS。
module.exports = {
  buildAss,
  toAssColor,
  fmtAssTime,
  escAss,
  BASE,
  BASE_RES_Y,
  wrapEnglish,
  wrapChinese,
  displayWidth,
};
