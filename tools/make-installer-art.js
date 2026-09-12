'use strict';
/**
 * 生成安装程序的品牌素材（NSIS 只认 BMP，所以先用 Electron 渲染再转）。
 *
 *   installerSidebar.bmp   164x314  向导左侧竖条（欢迎页/完成页）
 *   installerHeader.bmp    150x57   内页右上角的页眉图
 *
 * 尺寸是 Windows 安装向导（MUI2）的固定规格，不能随便改，
 * 否则会被拉伸变形。BMP 必须是 24 位（NSIS 不支持带 alpha 的 32 位）。
 */
const fs = require('fs');
const path = require('path');
const os = require('os');
const { spawnSync } = require('child_process');
const { app, BrowserWindow } = require('electron');

const ROOT = path.join(__dirname, '..');
const BUILD = path.join(ROOT, 'build');
const FFMPEG = path.join(ROOT, 'resources', 'bin', 'ffmpeg.exe');
const LOGO = path.join(BUILD, 'youtube-logo.png');
const TMP = path.join(os.tmpdir(), 'installer-art');

const VERSION = require(path.join(ROOT, 'package.json')).version;

function logoDataUri() {
  return 'data:image/png;base64,' + fs.readFileSync(LOGO).toString('base64');
}

/** 向导左侧竖条 164x314（内容宽只有 132px，字距要算准，否则会挤到边或孤字换行） */
function sidebarHtml() {
  return `<!DOCTYPE html><html><head><meta charset="UTF-8"><style>
    * { margin:0; padding:0; box-sizing:border-box; }
    html,body { width:164px; height:314px; overflow:hidden; }
    body {
      font-family: "Microsoft YaHei", sans-serif;
      background: linear-gradient(165deg, #141922 0%, #0b0e13 52%, #1a1208 100%);
      color:#e8edf5; display:flex; flex-direction:column;
      padding:20px 16px 14px;
    }
    .logo { width:62px; height:auto; }
    .name { font-size:15px; font-weight:700; letter-spacing:.3px; margin-top:14px; white-space:nowrap; }
    .sub  { font-size:9.5px; color:#7f8a9c; margin-top:5px; white-space:nowrap; }
    .line { height:2px; width:30px; background:#ff4d4d; border-radius:1px; margin:13px 0 11px; }
    .feat { font-size:9.5px; color:#98a3b4; line-height:1.95; white-space:nowrap; }
    .feat i { color:#ffd166; font-style:normal; margin-right:5px; }
    .foot { margin-top:auto; }
    .foot .bar { height:1px; background:rgba(255,255,255,.09); margin-bottom:9px; }
    .foot .t { font-size:9px; color:#5c6675; letter-spacing:.3px; }
    .foot .v { font-size:9px; color:#7a8496; margin-top:3px; }
  </style></head><body>
    <img class="logo" src="${logoDataUri()}" />
    <div class="name">YouTube 下载器</div>
    <div class="sub">批量下载 · 双语学习资料</div>
    <div class="line"></div>
    <div class="feat">
      <div><i>·</i>整频道批量识别下载</div>
      <div><i>·</i>断点续传 · 失败重试</div>
      <div><i>·</i>双语字幕与学习文档</div>
      <div><i>·</i>金句一键成图</div>
    </div>
    <div class="foot">
      <div class="bar"></div>
      <div class="t">正在安装</div>
      <div class="v">版本 ${VERSION}</div>
    </div>
  </body></html>`;
}

/**
 * 内页页眉 150x57。
 * 这里空间极小：logo 38px + 间距 8 + 文字。实测 46px logo + 12px 字会溢出换行，
 * 所以缩到 38px / 10px 并且强制 nowrap。
 */
function headerHtml() {
  return `<!DOCTYPE html><html><head><meta charset="UTF-8"><style>
    * { margin:0; padding:0; box-sizing:border-box; }
    html,body { width:150px; height:57px; overflow:hidden; }
    body {
      font-family:"Microsoft YaHei", sans-serif;
      background:#0b0e13;
      display:flex; align-items:center; gap:8px; padding:0 11px;
    }
    img { width:38px; height:auto; flex-shrink:0; }
    .t { font-size:10px; color:#dfe6f0; font-weight:600; white-space:nowrap; }
  </style></head><body>
    <img src="${logoDataUri()}" />
    <span class="t">YouTube 下载器</span>
  </body></html>`;
}

async function render(html, w, h, outName) {
  const dir = fs.mkdtempSync(path.join(TMP, 'r-'));
  const file = path.join(dir, 'a.html');
  fs.writeFileSync(file, html, 'utf8');
  const win = new BrowserWindow({
    width: 400, height: 300, show: false, frame: false,
    backgroundColor: '#0b0e13',
    webPreferences: { sandbox: false, contextIsolation: true, nodeIntegration: false },
  });
  // 创建后再 setBounds —— 窗口创建时会被钳制到屏幕工作区
  win.setBounds({ x: 0, y: 0, width: w, height: h });
  try {
    await win.loadFile(file);
    try {
      await win.webContents.executeJavaScript(
        'document.fonts && document.fonts.ready ? document.fonts.ready.then(function(){return true;}) : true'
      );
    } catch (_) {}
    await new Promise((r) => setTimeout(r, 260));
    const png = (await win.webContents.capturePage()).toPNG();
    const pngPath = path.join(dir, 'a.png');
    fs.writeFileSync(pngPath, png);
    const bmpPath = path.join(BUILD, outName);
    // 转成 24 位 BMP（NSIS 不认 32 位带 alpha 的）
    const r = spawnSync(
      FFMPEG,
      ['-hide_banner', '-loglevel', 'error', '-y', '-i', pngPath, '-pix_fmt', 'bgr24', '-frames:v', '1', bmpPath],
      { windowsHide: true }
    );
    if (r.status !== 0) throw new Error('BMP 转换失败: ' + String(r.stderr));
    return bmpPath;
  } finally {
    if (!win.isDestroyed()) win.destroy();
    try {
      fs.rmSync(dir, { recursive: true, force: true });
    } catch (_) {}
  }
}

app.whenReady().then(async () => {
  const keeper = new BrowserWindow({ width: 200, height: 200, show: false });
  await keeper.loadURL('about:blank');
  fs.mkdirSync(TMP, { recursive: true });
  try {
    const a = await render(sidebarHtml(), 164, 314, 'installerSidebar.bmp');
    const b = await render(headerHtml(), 150, 57, 'installerHeader.bmp');
    fs.copyFileSync(a, path.join(BUILD, 'uninstallerSidebar.bmp'));
    for (const f of ['installerSidebar.bmp', 'installerHeader.bmp', 'uninstallerSidebar.bmp']) {
      const p = path.join(BUILD, f);
      console.log(`  ${f.padEnd(24)} ${(fs.statSync(p).size / 1024).toFixed(1)} KB`);
    }
  } catch (e) {
    console.log('  失败: ' + (e && e.message));
  }
  app.exit(0);
});
