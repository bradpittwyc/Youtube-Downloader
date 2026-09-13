'use strict';
/**
 * 自动升级：检查 GitHub Releases → 下载安装包 → 静默升级 → 自动重启。
 *
 * 【为什么不用 electron-updater】本项目从第一天起就只有 1 个运行时依赖（docx），
 * 这是它最值钱的工程属性之一。而这里要做的事情并不复杂：
 * 查一个公开的 releases 接口、下一个文件、跑一次安装包。为此引入
 * electron-updater 及其 8 个传递依赖不划算。
 *
 * 【实测过的关键事实】（v1.24.0 发布时验证）
 *   · 安装包支持 `/S` 静默原地升级：v1.23.0 → 运行 v1.24.0 的 Setup /S → 版本变成 1.24.0 ✅
 *   · 但 `/S` 会跳过完成页，`runAfterFinish` **不触发** —— 装完 App 不会自己起来，
 *     所以必须由本模块负责重启（用一段临时 .cmd 等安装结束再拉起 App）
 *   · 仓库必须**公开**：私有仓库的 Release 匿名访问返回 404。
 *     实测公开后 releases API 返回 200、附件可下载（HTTP 206）。
 *   · 现有安装是 per-machine（D:\Program Files + /allusers），
 *     所以升级时会弹**一次 UAC 确认**，允许之后就是全自动。
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { spawn } = require('child_process');

const REPO = 'bradpittwyc/Youtube-Downloader';
const API_LATEST = `https://api.github.com/repos/${REPO}/releases/latest`;
const RELEASES_PAGE = `https://github.com/${REPO}/releases`;

/** "1.24.0" / "v1.24.0" → [1,24,0] */
function parseVersion(v) {
  return String(v || '')
    .replace(/^v/i, '')
    .split(/[.\-+]/)
    .map((x) => parseInt(x, 10) || 0);
}

/** a 是否比 b 新 */
function isNewer(a, b) {
  const x = parseVersion(a);
  const y = parseVersion(b);
  const n = Math.max(x.length, y.length);
  for (let i = 0; i < n; i++) {
    const xi = x[i] || 0;
    const yi = y[i] || 0;
    if (xi > yi) return true;
    if (xi < yi) return false;
  }
  return false;
}

async function fetchJson(url, timeoutMs = 20000) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      headers: { Accept: 'application/vnd.github+json', 'User-Agent': 'YouTubeDownloader-Updater' },
      signal: ctrl.signal,
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return await res.json();
  } finally {
    clearTimeout(timer);
  }
}

/**
 * 检查有没有新版本。
 * @returns {Promise<object>} 永远不抛错 —— 网络问题只返回 {ok:false,error}
 */
async function checkForUpdate(currentVersion) {
  try {
    const rel = await fetchJson(API_LATEST);
    const latest = String(rel.tag_name || '').replace(/^v/i, '');
    if (!latest) return { ok: false, error: 'release 里没有版本号' };

    const assets = Array.isArray(rel.assets) ? rel.assets : [];
    // 优先 Setup（能原地升级），没有就退而求其次用 Portable
    const setup = assets.find((a) => /Setup-[\d.]+\.exe$/i.test(a.name));
    const portable = assets.find((a) => /Portable-[\d.]+\.exe$/i.test(a.name));
    const asset = setup || portable || null;

    return {
      ok: true,
      current: currentVersion,
      latest,
      hasUpdate: isNewer(latest, currentVersion),
      title: rel.name || rel.tag_name || '',
      notes: rel.body || '',
      publishedAt: rel.published_at || '',
      pageUrl: rel.html_url || RELEASES_PAGE,
      asset: asset
        ? {
            name: asset.name,
            url: asset.browser_download_url,
            size: asset.size || 0,
            // GitHub 现在直接给 sha256；拿不到就跳过校验
            sha256: /^sha256:/i.test(asset.digest || '') ? asset.digest.slice(7) : '',
            isSetup: !!setup,
          }
        : null,
    };
  } catch (e) {
    const msg = String((e && e.message) || e);
    return {
      ok: false,
      error: /404/.test(msg)
        ? '读不到 Release（仓库若为私有，匿名访问会返回 404）'
        : msg,
    };
  }
}

/** 下载安装包到临时目录，边下边报进度、下完校验 sha256 */
async function downloadUpdate(asset, destPath, onProgress) {
  const ctrl = new AbortController();
  const res = await fetch(asset.url, { signal: ctrl.signal, redirect: 'follow' });
  if (!res.ok) throw new Error(`下载失败 HTTP ${res.status}`);

  const total = Number(res.headers.get('content-length')) || asset.size || 0;
  const hash = crypto.createHash('sha256');
  let received = 0;
  let lastTick = 0;

  await new Promise((resolve, reject) => {
    const out = fs.createWriteStream(destPath);
    out.on('error', reject);
    res.body.on('error', reject);
    res.body.on('data', (chunk) => {
      received += chunk.length;
      hash.update(chunk);
      out.write(chunk);
      const now = Date.now();
      if (onProgress && now - lastTick > 250) {
        lastTick = now;
        onProgress({ received, total, percent: total ? received / total : 0 });
      }
    });
    res.body.on('end', () => {
      out.end(() => {
        if (onProgress) onProgress({ received, total, percent: 1 });
        resolve();
      });
    });
    res.body.on('aborted', () => reject(new Error('下载中断')));
  });

  const actual = hash.digest('hex');
  if (asset.sha256 && actual.toLowerCase() !== asset.sha256.toLowerCase()) {
    try {
      fs.unlinkSync(destPath);
    } catch (_) {}
    throw new Error('安装包校验失败（sha256 不匹配），已删除，请重试或从 Releases 页手动下载');
  }
  return { path: destPath, bytes: received, verified: !!asset.sha256 };
}

/**
 * 静默安装并重启。
 *
 * 【为什么要绕一层 .cmd】`/S` 模式不会触发安装器的 runAfterFinish，
 * 装完 App 不会自己起来。所以写一段临时批处理：等 2 秒（让本进程退干净）
 * → 静默安装 → 再拉起 App。用 `&&` 串联保证装完才启动。
 *
 * @param {string} installerPath 已下载好的安装包
 * @param {string} appExePath    要重启的可执行文件（就是当前运行的自己）
 */
function applyUpdateAndRestart(installerPath, appExePath) {
  const bat = path.join(os.tmpdir(), `ytdl-update-${Date.now()}.cmd`);
  const script = [
    '@echo off',
    'rem 等本进程完全退出，否则安装器替换不了正在占用的文件',
    'timeout /t 2 /nobreak >nul',
    `"${installerPath}" /S`,
    'rem 装完再把 App 拉起来；/S 不会触发安装器的 runAfterFinish，只能自己来',
    `start "" "${appExePath}"`,
    'del "%~f0"',
    '',
  ].join('\r\n');
  fs.writeFileSync(bat, script, 'utf8');

  const child = spawn('cmd.exe', ['/c', bat], {
    detached: true,
    stdio: 'ignore',
    windowsHide: true,
  });
  child.unref();
  return { ok: true, bat };
}

module.exports = {
  REPO,
  RELEASES_PAGE,
  parseVersion,
  isNewer,
  checkForUpdate,
  downloadUpdate,
  applyUpdateAndRestart,
};
