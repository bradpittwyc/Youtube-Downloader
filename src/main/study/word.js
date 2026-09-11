'use strict';
/**
 * Word 学习文档生成。
 *
 * 原则：**大模型只负责语言，排版完全由代码决定**。
 * 模型返回的是结构化数据（en / zh / notes / vocab），这里用 docx 库确定性地渲染，
 * 因此版式永远稳定、可复现，不会出现「这次用 ## 下次用 **」的漂移。
 *
 * 排版要点：
 *  · 中英文字体必须分别指定（docx 的 font 支持 ascii/eastAsia），否则中文会掉进默认字体
 *  · 正文 11pt、行距 1.5，长时间阅读不累
 *  · 时间码用灰色小字，方便回看视频定位
 *  · 页眉放视频标题、页脚放页码
 */
const {
  Document,
  Packer,
  Paragraph,
  TextRun,
  Header,
  Footer,
  PageNumber,
  AlignmentType,
  Table,
  TableRow,
  TableCell,
  WidthType,
  BorderStyle,
  ShadingType,
} = require('docx');

const FONT = { ascii: 'Georgia', hAnsi: 'Georgia', eastAsia: '微软雅黑' };
const FONT_UI = { ascii: 'Segoe UI', hAnsi: 'Segoe UI', eastAsia: '微软雅黑' };

const GRAY = '808080';
const DARK = '1F1F1F';
const ACCENT = 'B03A2E';

function fmtDuration(ms) {
  const s = Math.round((ms || 0) / 1000);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const ss = s % 60;
  return h > 0 ? `${h} 小时 ${m} 分` : m > 0 ? `${m} 分 ${ss} 秒` : `${ss} 秒`;
}

function tc(ms) {
  const s = Math.max(0, Math.floor((ms || 0) / 1000));
  const h = String(Math.floor(s / 3600)).padStart(2, '0');
  const m = String(Math.floor((s % 3600) / 60)).padStart(2, '0');
  const ss = String(s % 60).padStart(2, '0');
  return `${h}:${m}:${ss}`;
}

function makeStyles() {
  const mk = (id, run, paragraph) => ({ id, name: id, basedOn: 'Normal', next: 'Normal', run, paragraph });
  return {
    default: { document: { run: { font: FONT, size: 22, color: DARK } } },
    paragraphStyles: [
      mk('DocTitle', { font: FONT_UI, size: 36, bold: true, color: DARK }, { spacing: { after: 80 } }),
      mk('MetaLine', { font: FONT_UI, size: 18, color: GRAY }, { spacing: { after: 20 } }),
      mk('SegHeading', { font: FONT_UI, size: 26, bold: true, color: ACCENT }, { spacing: { before: 320, after: 60 } }),
      mk('BodyEN', { font: FONT, size: 22, color: '000000' }, { spacing: { line: 340, after: 100 } }),
      mk('BodyZH', { font: FONT, size: 22, color: DARK }, { spacing: { line: 340, after: 160 } }),
      mk('NoteQ', { font: FONT, size: 20, italics: true, color: '2E4053' }, { spacing: { line: 300, after: 40 }, indent: { left: 240 } }),
      mk('NoteA', { font: FONT, size: 20, color: '34495E' }, { spacing: { line: 300, after: 120 }, indent: { left: 240 } }),
      mk('VocabLine', { font: FONT, size: 19, color: '2C3E50' }, { spacing: { line: 280, after: 40 }, indent: { left: 240 } }),
      mk('AppTitle', { font: FONT_UI, size: 28, bold: true, color: DARK }, { spacing: { before: 200, after: 120 } }),
    ],
  };
}

/** 支持 \n 换行的 TextRun 数组 */
function runs(text, font, extra) {
  const parts = String(text == null ? '' : text).split('\n');
  const out = [];
  parts.forEach((line, i) => {
    if (i > 0) out.push(new TextRun({ break: 1 }));
    out.push(new TextRun(Object.assign({ text: line, font: font || FONT }, extra || {})));
  });
  return out;
}

/**
 * 生成学习文档。
 * @param {object} input { meta, segments, vocab, options }
 * @returns {Promise<Buffer>}
 */
async function buildStudyDocx(input) {
  const meta = input.meta || {};
  const segments = input.segments || [];
  const vocab = input.vocab || [];
  const opt = Object.assign(
    { includePureEnglish: true, includeVocabTable: true, segmentTimecode: true },
    input.options || {}
  );

  const children = [];

  children.push(
    new Paragraph({
      style: 'DocTitle',
      children: [new TextRun({ text: meta.title || '视频学习文档', font: FONT_UI, size: 36, bold: true })],
    })
  );

  const metaBits = [];
  if (meta.channel) metaBits.push(`频道：${meta.channel}`);
  if (meta.durationMs) metaBits.push(`时长：${fmtDuration(meta.durationMs)}`);
  if (meta.uploadDate) metaBits.push(`上传：${meta.uploadDate}`);
  if (meta.url) metaBits.push(`链接：${meta.url}`);
  metaBits.push(`生成：${new Date().toLocaleString('zh-CN', { hour12: false })}`);
  for (const b of metaBits) {
    children.push(new Paragraph({ style: 'MetaLine', children: runs(b, FONT_UI, { size: 18, color: GRAY }) }));
  }

  // ---------- 正文：逐段中英对照 ----------
  for (const seg of segments) {
    const head = [
      new TextRun({ text: `段落 ${seg.index}　${seg.topic || ''}`, font: FONT_UI, size: 26, bold: true, color: ACCENT }),
    ];
    if (opt.segmentTimecode && seg.startMs != null) {
      head.push(new TextRun({ text: `　[${tc(seg.startMs)}]`, font: FONT_UI, size: 18, color: GRAY }));
    }
    children.push(new Paragraph({ style: 'SegHeading', children: head }));

    if (seg.en) children.push(new Paragraph({ style: 'BodyEN', children: runs(seg.en, FONT) }));
    if (seg.zh) children.push(new Paragraph({ style: 'BodyZH', children: runs(seg.zh, FONT) }));

    for (const n of seg.notes || []) {
      children.push(
        new Paragraph({ style: 'NoteQ', children: runs(`◆ ${n.sentence}`, FONT, { size: 20, italics: true, color: '2E4053' }) })
      );
      children.push(
        new Paragraph({ style: 'NoteA', children: runs(`　 ${n.explain}`, FONT, { size: 20, color: '34495E' }) })
      );
    }

    for (const v of seg.vocab || []) {
      const line = `${v.word}${v.phonetic ? '  ' + v.phonetic : ''}${v.pos ? '  ' + v.pos : ''}　—　${v.def || ''}`;
      children.push(new Paragraph({ style: 'VocabLine', children: runs(`· ${line}`, FONT, { size: 19, color: '2C3E50' }) }));
    }
  }

  // ---------- 附录一：纯英文版 ----------
  if (opt.includePureEnglish) {
    children.push(
      new Paragraph({
        style: 'AppTitle',
        pageBreakBefore: true,
        children: [new TextRun({ text: '附录一　纯英文版', font: FONT_UI, size: 28, bold: true })],
      })
    );
    for (const seg of segments) {
      if (!seg.en) continue;
      children.push(new Paragraph({ style: 'BodyEN', children: runs(seg.en, FONT) }));
    }
  }

  // ---------- 附录二：词汇总表 ----------
  if (opt.includeVocabTable && vocab.length) {
    children.push(
      new Paragraph({
        style: 'AppTitle',
        pageBreakBefore: true,
        children: [new TextRun({ text: '附录二　词汇总表', font: FONT_UI, size: 28, bold: true })],
      })
    );
    children.push(
      new Paragraph({
        style: 'MetaLine',
        children: runs(`共 ${vocab.length} 个词条，按在本文中出现的段落数排序`, FONT_UI, { size: 18, color: GRAY }),
      })
    );

    const cell = (text, o) =>
      new TableCell({
        margins: { top: 50, bottom: 50, left: 100, right: 100 },
        shading: o && o.fill ? { type: ShadingType.CLEAR, fill: o.fill } : undefined,
        children: [
          new Paragraph({
            children: [
              new TextRun({
                text: String(text == null ? '' : text),
                font: o && o.ui ? FONT_UI : FONT,
                size: 18,
                bold: !!(o && o.bold),
              }),
            ],
          }),
        ],
      });

    const header = new TableRow({
      tableHeader: true,
      children: ['词汇', '音标', '词性', '释义', '段数'].map((t) => cell(t, { bold: true, ui: true, fill: 'F2F3F4' })),
    });
    const rows = vocab.map(
      (v) =>
        new TableRow({
          children: [
            cell(v.word, { bold: true }),
            cell(v.phonetic || ''),
            cell(v.pos || ''),
            cell(v.def || ''),
            cell(String(v.count || 1)),
          ],
        })
    );

    children.push(
      new Table({
        width: { size: 100, type: WidthType.PERCENTAGE },
        borders: {
          top: { style: BorderStyle.SINGLE, size: 2, color: 'D5D8DC' },
          bottom: { style: BorderStyle.SINGLE, size: 2, color: 'D5D8DC' },
          left: { style: BorderStyle.SINGLE, size: 2, color: 'D5D8DC' },
          right: { style: BorderStyle.SINGLE, size: 2, color: 'D5D8DC' },
          insideHorizontal: { style: BorderStyle.SINGLE, size: 2, color: 'E5E7E9' },
          insideVertical: { style: BorderStyle.SINGLE, size: 2, color: 'E5E7E9' },
        },
        columnWidths: [2400, 1900, 900, 4900, 900],
        rows: [header].concat(rows),
      })
    );
  }

  const doc = new Document({
    creator: 'YouTube 下载器',
    title: meta.title || '视频学习文档',
    description: '中英对照学习文档',
    styles: makeStyles(),
    sections: [
      {
        properties: { page: { margin: { top: 1100, bottom: 1100, left: 1200, right: 1200 } } },
        headers: {
          default: new Header({
            children: [
              new Paragraph({
                alignment: AlignmentType.RIGHT,
                children: [
                  new TextRun({ text: String(meta.title || '').slice(0, 60), font: FONT_UI, size: 16, color: GRAY }),
                ],
              }),
            ],
          }),
        },
        footers: {
          default: new Footer({
            children: [
              new Paragraph({
                alignment: AlignmentType.CENTER,
                children: [
                  new TextRun({ text: '第 ', font: FONT_UI, size: 16, color: GRAY }),
                  new TextRun({ children: [PageNumber.CURRENT], font: FONT_UI, size: 16, color: GRAY }),
                  new TextRun({ text: ' 页 / 共 ', font: FONT_UI, size: 16, color: GRAY }),
                  new TextRun({ children: [PageNumber.TOTAL_PAGES], font: FONT_UI, size: 16, color: GRAY }),
                  new TextRun({ text: ' 页', font: FONT_UI, size: 16, color: GRAY }),
                ],
              }),
            ],
          }),
        },
        children,
      },
    ],
  });

  return Packer.toBuffer(doc);
}

module.exports = { buildStudyDocx };
