'use strict';
/**
 * API Key 的加密存储。
 * 优先用 Electron 的 safeStorage（Windows 底层是 DPAPI，绑定当前用户），
 * 拿不到时退化为明文，并在返回值里标明，界面上可以提示用户。
 *
 * 注意：本模块要能在「非 Electron 环境」（命令行工具）下被 require，
 * 所以对 electron 的引用必须容错。
 */
let safeStorage = null;
try {
  safeStorage = require('electron').safeStorage || null;
} catch (_) {
  safeStorage = null;
}

const PREFIX = 'enc:v1:';

function canEncrypt() {
  try {
    return !!(safeStorage && safeStorage.isEncryptionAvailable && safeStorage.isEncryptionAvailable());
  } catch (_) {
    return false;
  }
}

/** 明文 → 存进 settings 的字符串（加密成功时带前缀） */
function seal(plain) {
  const s = String(plain == null ? '' : plain);
  if (!s) return '';
  if (canEncrypt()) {
    try {
      return PREFIX + safeStorage.encryptString(s).toString('base64');
    } catch (_) {
      /* 落到明文 */
    }
  }
  return s;
}

/** settings 里的字符串 → 明文 */
function open(stored) {
  const s = String(stored == null ? '' : stored);
  if (!s) return '';
  if (s.startsWith(PREFIX)) {
    try {
      return safeStorage.decryptString(Buffer.from(s.slice(PREFIX.length), 'base64'));
    } catch (_) {
      return '';
    }
  }
  return s; // 明文存储的历史数据
}

/** 是否为加密存储 */
function isSealed(stored) {
  return String(stored || '').startsWith(PREFIX);
}

/** 打码显示，用于界面回显（绝不返回原文） */
function mask(plain) {
  const s = String(plain || '');
  if (!s) return '';
  if (s.length <= 8) return '****';
  return `${s.slice(0, 4)}****${s.slice(-4)}`;
}

module.exports = { seal, open, isSealed, mask, canEncrypt, PREFIX };
