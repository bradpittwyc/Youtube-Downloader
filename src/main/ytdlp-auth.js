'use strict';
/**
 * yt-dlp 的身份 / 网络参数（Cookies、代理）。
 *
 * 为什么单独成模块：这些参数必须出现在【每一次】yt-dlp 调用里 ——
 * 下载、抓字幕、频道枚举、视频探测、作品详情。
 *
 * 之前只在「下载」那一步加了 `--cookies`，结果**识别阶段照样被 YouTube 风控拦**，
 * 用户配了 cookie 也完全不起作用（实测踩过：错误提示让配 cookie，配了却没用）。
 */
const fs = require('fs');
const path = require('path');

/** 支持的浏览器（取值对应 yt-dlp 的 --cookies-from-browser） */
const BROWSERS = [
  { id: 'edge', name: 'Edge' },
  { id: 'chrome', name: 'Chrome' },
  { id: 'firefox', name: 'Firefox' },
  { id: 'brave', name: 'Brave' },
  { id: 'chromium', name: 'Chromium' },
  { id: 'vivaldi', name: 'Vivaldi' },
  { id: 'opera', name: 'Opera' },
  { id: 'whale', name: 'Naver Whale' },
];

/** 各浏览器在 Windows 上的 Cookie 库位置（用来判断"装没装"） */
function cookieDbPaths(id) {
  const L = process.env.LOCALAPPDATA || '';
  const R = process.env.APPDATA || '';
  switch (id) {
    case 'chrome':
      return [path.join(L, 'Google', 'Chrome', 'User Data', 'Default', 'Network', 'Cookies')];
    case 'edge':
      return [path.join(L, 'Microsoft', 'Edge', 'User Data', 'Default', 'Network', 'Cookies')];
    case 'brave':
      return [path.join(L, 'BraveSoftware', 'Brave-Browser', 'User Data', 'Default', 'Network', 'Cookies')];
    case 'chromium':
      return [path.join(L, 'Chromium', 'User Data', 'Default', 'Network', 'Cookies')];
    case 'vivaldi':
      return [path.join(L, 'Vivaldi', 'User Data', 'Default', 'Network', 'Cookies')];
    case 'whale':
      return [path.join(L, 'Naver', 'Naver Whale', 'User Data', 'Default', 'Network', 'Cookies')];
    case 'opera':
      return [path.join(R, 'Opera Software', 'Opera Stable', 'Network', 'Cookies')];
    case 'firefox':
      return [path.join(R, 'Mozilla', 'Firefox', 'Profiles')];
    default:
      return [];
  }
}

/** 哪些浏览器本机装了（有 Cookie 库就算装了），供界面标注 */
function detectBrowsers() {
  return BROWSERS.map((b) => {
    const ps = cookieDbPaths(b.id);
    const available =
      ps.length > 0 &&
      ps.some((p) => {
        try {
          return fs.existsSync(p);
        } catch (_) {
          return false;
        }
      });
    return Object.assign({}, b, { available });
  });
}

/**
 * 生成身份/网络参数。
 * cookies.txt 文件优先于浏览器读取 —— 文件是用户明确指定的，更可控、也更好排错。
 */
function authArgs(settings) {
  const s = settings || {};
  const a = [];
  const file = String(s.cookieFile || '').trim();
  const browser = String(s.cookieBrowser || '').trim();
  if (file) {
    if (fs.existsSync(file)) a.push('--cookies', file);
    else console.warn('[auth] cookies 文件不存在，已忽略:', file);
  } else if (browser) {
    a.push('--cookies-from-browser', browser);
  }
  const proxy = String(s.proxy || '').trim();
  if (proxy) a.push('--proxy', proxy);
  return a;
}

/** 给界面/日志看的一句话描述 */
function authSummary(settings) {
  const s = settings || {};
  const file = String(s.cookieFile || '').trim();
  const browser = String(s.cookieBrowser || '').trim();
  if (file) return fs.existsSync(file) ? `使用 cookies.txt（${path.basename(file)}）` : 'cookies.txt 文件不存在';
  if (browser) return `从 ${browser} 读取 Cookies`;
  return '未启用';
}

/**
 * 把 Cookies 相关的原始报错翻译成「能照着做」的提示。
 *
 * 最常见的一种：Chrome / Edge 127+ 启用了「应用绑定加密」（App-Bound Encryption），
 * 第三方工具（含 yt-dlp）无法解密其 Cookie 库，报 "Failed to decrypt with DPAPI"。
 * 实测本机 Edge 就是这个情况，而 Firefox 装了但没用过、没有 Cookie 库。
 */
function explainCookieError(raw) {
  const s = String(raw || '');
  if (/Failed to decrypt with DPAPI|app-bound/i.test(s)) {
    return (
      '读取失败：该浏览器的 Cookie 库被「应用绑定加密」保护，第三方工具解不开。\n' +
      'Chrome / Edge 127 及以上都是这样。请改用导出 cookies.txt 的方式，或换用 Firefox。'
    );
  }
  if (/could not find .* cookies database/i.test(s)) {
    return '读取失败：这个浏览器没有可用的 Cookie 库（可能装了但没登录过、或从没用过）。请改用导出 cookies.txt 的方式。';
  }
  if (/Permission denied|EBUSY|being used by another process/i.test(s)) {
    return '读取失败：Cookie 库正被浏览器占用。请完全退出该浏览器后重试。';
  }
  if (/Sign in to confirm|not a bot/i.test(s)) {
    return '仍然被 YouTube 当作机器人拦截 —— 说明这次 Cookies 没起作用（比如读取到的不是登录态）。';
  }
  return s.slice(0, 300);
}

module.exports = { BROWSERS, cookieDbPaths, detectBrowsers, authArgs, authSummary, explainCookieError };
