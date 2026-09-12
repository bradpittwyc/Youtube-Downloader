'use strict';
/**
 * 金句卡片：把学习文档里的「金句」渲染成图片，方便存手机 / 分享。
 *
 * 为什么用 Electron 截图而不是 ffmpeg drawtext：
 *   drawtext 只能画单行文字，中英混排、自动折行、渐变背景、阴影全都很难做，
 *   而且 CJK 换行基本没法控制。用浏览器渲染 + capturePage 则可以用完整的 CSS，
 *   排版质量和软件界面一致。
 *
 * 注意：渲染在**隐藏窗口**里做，用户不会看到窗口闪烁。
 */
const fs = require('fs');
const path = require('path');
const { BrowserWindow } = require('electron');

/** 卡片尺寸：4:5 竖版，手机上看着最舒服，也是社交平台通用的比例 */
const CARD_W = 1080;
const CARD_H = 1350;

const FONT_EN = 'Times New Roman';
const FONT_ZH = 'Microsoft YaHei';

function esc(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/**
 * 卡片 HTML。
 * 版式：顶部品牌 → 中间金句（英文为主、中文在下）→ 底部出处。
 * 英文用 Times New Roman、中文用微软雅黑，和学习文档保持一致。
 */
function cardHtml(q, meta, opts = {}) {
  const logoData = opts.logoData || '';
  const accent = opts.accent || '#FFD166'; // 和学习文档里中文的颜色一致
  const brand = meta.channel || meta.title || 'YouTube';
  const title = meta.title || '';
  const time = q.timeText || '';

  return `<!DOCTYPE html>
<html lang="zh-CN"><head><meta charset="UTF-8" />
<style>
  * { margin: 0; padding: 0; box-sizing: border-box; }
  html, body { width: ${CARD_W}px; height: ${CARD_H}px; overflow: hidden; }
  body {
    font-family: "${FONT_EN}", "${FONT_ZH}", serif;
    background: #0d0f13;
    background-image:
      radial-gradient(circle at 18% 8%, rgba(255,255,255,0.07), transparent 42%),
      radial-gradient(circle at 88% 92%, rgba(255,209,102,0.10), transparent 48%);
    color: #f2f4f8;
    display: flex; flex-direction: column;
    padding: 78px 82px 66px;
  }
  .top { display: flex; align-items: center; gap: 20px; }
  .top img { height: 46px; }
  .top .brand { font-family: "${FONT_ZH}", sans-serif; font-size: 27px; color: #9aa3b2; letter-spacing: .5px; }

  /* 引号紧贴正文上方，而不是孤零零挂在顶部——那样顶部会空出一大块 */
  .quote { flex: 1; display: flex; flex-direction: column; justify-content: center; }
  .mark { font-family: Georgia, serif; font-size: 132px; line-height: .62; color: rgba(255,255,255,0.14); margin-bottom: 22px; }
  #en { font-size: 58px; line-height: 1.42; letter-spacing: .2px; }
  #zh { font-family: "${FONT_ZH}", sans-serif; font-size: 33px; line-height: 1.68; color: ${accent}; margin-top: 30px; }
  .rule { width: 96px; height: 4px; background: ${accent}; opacity: .85; border-radius: 2px; margin-top: 34px; }

  .bottom { border-top: 1px solid rgba(255,255,255,0.12); padding-top: 26px; display: flex; justify-content: space-between; align-items: flex-end; gap: 24px; }
  .bottom .t { font-family: "${FONT_ZH}", sans-serif; font-size: 24px; color: #8b93a2; max-width: 700px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .bottom .time { font-size: 26px; color: #6f7787; font-variant-numeric: tabular-nums; }
</style></head>
<body>
  <div class="top">
    ${logoData ? `<img src="${logoData}" alt="" />` : ''}
    <span class="brand">${esc(brand)}</span>
  </div>
  <div class="quote">
    <div class="mark">&ldquo;</div>
    <div id="en">${esc(q.en || '')}</div>
    ${q.zh ? `<div id="zh">${esc(q.zh)}</div>` : ''}
    <div class="rule"></div>
  </div>
  <div class="bottom">
    <div class="t">${esc(title)}</div>
    <div class="time">${esc(time)}</div>
  </div>
  <script>
    // 英文长度差异很大：从大字号开始，装不下就逐级缩小，保证不溢出也不裁切
    (function () {
      var box = document.getElementById('en');
      var limit = 620; // 英文区可用高度
      var size = 58;
      while (box.scrollHeight > limit && size > 22) {
        size -= 2;
        box.style.fontSize = size + 'px';
      }
    })();
  </script>
</body></html>`;
}

/**
 * 把一张卡片渲染成 PNG Buffer。
 *
 * 用「写临时 HTML 文件 + loadFile」而不是 data: URL ——
 * 实测 data: URL 会加载失败（ERR_FAILED），而且长度有限制。
 */
async function captureHtml(html, w, h) {
  const os = require('os');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'quote-card-'));
  const file = path.join(dir, 'card.html');
  fs.writeFileSync(file, html, 'utf8');

  const win = new BrowserWindow({
    // 先创建一个小窗口，尺寸稍后用 setBounds 设置。
    // 原因（实测）：窗口在【创建时】会被钳制到屏幕工作区大小
    // （本机 1920x1032，连 1080 高都开不出来），截图会被裁掉底部；
    // 而【创建之后】再 setBounds 就能突破这个限制，拿到完整的 1080x1350。
    width: 400,
    height: 300,
    show: false, // 隐藏渲染，用户看不到窗口闪烁
    frame: false,
    backgroundColor: '#0d0f13',
    webPreferences: { sandbox: false, contextIsolation: true, nodeIntegration: false },
  });
  win.setBounds({ x: 0, y: 0, width: w, height: h });
  try {
    await win.loadFile(file);
    // 等字体就绪 + 页面里那段自适应字号的脚本跑完，再截图
    try {
      await win.webContents.executeJavaScript(
        'document.fonts && document.fonts.ready ? document.fonts.ready.then(function(){return true;}) : true'
      );
    } catch (_) {}
    await new Promise((r) => setTimeout(r, 280));
    const img = await win.webContents.capturePage();
    const png = img.toPNG();
    if (!png || png.length < 500) {
      throw new Error('截图结果为空（隐藏窗口截图可能不被支持）');
    }
    return png;
  } finally {
    if (!win.isDestroyed()) win.destroy();
    try {
      fs.rmSync(dir, { recursive: true, force: true });
    } catch (_) {}
  }
}

/** 读一张 logo 转成 data URI，避免卡片页面再去读文件 */
function logoDataUri() {
  try {
    const p = path.join(__dirname, '..', '..', 'renderer', 'youtube-logo.png');
    if (!fs.existsSync(p)) return '';
    return 'data:image/png;base64,' + fs.readFileSync(p).toString('base64');
  } catch (_) {
    return '';
  }
}

/**
 * 生成某个视频的全部金句卡片。
 * @returns {{ok:boolean, files?:string[], dir?:string, error?:string}}
 */
async function renderQuoteCards({ quotes, meta, outDir, accent }) {
  const list = (quotes || []).filter((q) => q && (q.en || q.zh));
  if (!list.length) return { ok: false, error: '这个视频没有金句' };
  if (!outDir) return { ok: false, error: '缺少输出目录' };

  fs.mkdirSync(outDir, { recursive: true });
  const logoData = logoDataUri();
  const files = [];
  for (let i = 0; i < list.length; i++) {
    const html = cardHtml(list[i], meta || {}, { logoData, accent });
    const png = await captureHtml(html, CARD_W, CARD_H);
    const name = `金句-${String(i + 1).padStart(2, '0')}.png`;
    const p = path.join(outDir, name);
    fs.writeFileSync(p, png);
    files.push(p);
  }
  return { ok: true, files, dir: outDir };
}

module.exports = { renderQuoteCards, cardHtml, captureHtml, CARD_W, CARD_H };
