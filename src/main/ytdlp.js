'use strict';
/**
 * yt-dlp 进程封装：
 *  - run()        一次性执行并收集输出
 *  - spawnLines() 流式执行，按行回调（用于进度解析）
 *  - killTree()   连子进程一起杀（关键：防止 ffmpeg / 下载进程变孤儿）
 *
 * 编码说明（实测于中文 Windows / code page 936）：
 *  yt-dlp 的纯文本输出默认使用系统 ANSI 代码页（GBK），
 *  如果按 UTF-8 解码，非 ASCII 字符会变成 U+FFFD，
 *  导致「文件名 / 路径」完全错乱（如 World’s → World??s）。
 *  解决办法有两层：
 *   1. 所有调用都加 --encoding utf-8（已实测有效）
 *   2. 解码仍做兜底：按行切分后若发现 U+FFFD，则用 GBK 重新解码
 *  另外：必须按「字节」切行、整行再解码，否则多字节字符会被 chunk 边界切断。
 */
const { spawn } = require('child_process');

const BASE_FLAGS = ['--ignore-config', '--no-warnings', '--no-cache-dir', '--encoding', 'utf-8'];

function childEnv() {
  return Object.assign({}, process.env, {
    NO_COLOR: '1',
    PYTHONIOENCODING: 'utf-8',
  });
}

let gbkDecoder;
function countReplacement(s) {
  const m = s.match(/\uFFFD/g);
  return m ? m.length : 0;
}

/** 智能解码一段字节：优先 UTF-8，若出现替换字符则退回系统 ANSI(GBK) */
function decodeBuffer(buf) {
  const utf8 = buf.toString('utf8');
  if (!utf8.includes('\uFFFD')) return utf8;
  try {
    if (gbkDecoder === undefined) {
      try {
        gbkDecoder = new TextDecoder('gbk', { fatal: false });
      } catch (_) {
        gbkDecoder = null;
      }
    }
    if (gbkDecoder) {
      const gbk = gbkDecoder.decode(buf);
      if (countReplacement(gbk) < countReplacement(utf8)) return gbk;
    }
  } catch (_) {
    /* 忽略，返回 utf8 */
  }
  return utf8;
}

/** 按字节切行 + 整行解码，避免多字节字符被 chunk 边界切断 */
function makeLineSplitter(onLine) {
  let pending = Buffer.alloc(0);
  return {
    push(chunk) {
      pending = pending.length ? Buffer.concat([pending, chunk]) : chunk;
      let idx;
      while ((idx = pending.indexOf(0x0a)) >= 0) {
        let lineBuf = pending.subarray(0, idx);
        pending = pending.subarray(idx + 1);
        if (lineBuf.length && lineBuf[lineBuf.length - 1] === 0x0d) {
          lineBuf = lineBuf.subarray(0, lineBuf.length - 1);
        }
        if (lineBuf.length) safeCall(onLine, decodeBuffer(lineBuf));
      }
    },
    flush() {
      if (pending.length) {
        const b = pending;
        pending = Buffer.alloc(0);
        const line = decodeBuffer(b);
        if (line.trim()) safeCall(onLine, line);
      }
    },
  };
}

function safeCall(fn, arg) {
  if (!fn) return;
  try {
    fn(arg);
  } catch (err) {
    console.error('[ytdlp] line handler error:', err && err.message);
  }
}

/**
 * 执行 yt-dlp 并收集完整 stdout/stderr。
 * @returns {Promise<{code:number, stdout:string, stderr:string}>}
 */
function run(bin, args, opts = {}) {
  return new Promise((resolve, reject) => {
    if (!bin) return reject(new Error('yt-dlp 可执行文件未找到'));
    const child = spawn(bin, args, {
      windowsHide: true,
      env: childEnv(),
      cwd: opts.cwd || undefined,
    });
    const outChunks = [];
    const errChunks = [];
    let outLen = 0;
    let errLen = 0;
    let settled = false;
    const maxBuffer = opts.maxBuffer || 512 * 1024 * 1024;

    child.stdout.on('data', (d) => {
      if (outLen < maxBuffer) {
        outChunks.push(d);
        outLen += d.length;
      }
    });
    child.stderr.on('data', (d) => {
      if (errLen < 16 * 1024 * 1024) {
        errChunks.push(d);
        errLen += d.length;
      }
    });
    child.on('error', (err) => {
      if (!settled) {
        settled = true;
        reject(err);
      }
    });
    child.on('close', (code) => {
      if (settled) return;
      settled = true;
      resolve({
        code: code == null ? -1 : code,
        stdout: decodeBuffer(Buffer.concat(outChunks)),
        stderr: decodeBuffer(Buffer.concat(errChunks)),
      });
    });

    if (opts.onChild) opts.onChild(child);
  });
}

/**
 * 流式执行，按行回调。返回 { child, done }。
 * done: Promise<{code:number, stderr:string}>
 */
function spawnLines(bin, args, opts = {}) {
  if (!bin) throw new Error('yt-dlp 可执行文件未找到');
  const child = spawn(bin, args, {
    windowsHide: true,
    env: childEnv(),
    cwd: opts.cwd || undefined,
  });

  const outSplitter = makeLineSplitter((l) => safeCall(opts.onStdoutLine, l));
  const errSplitter = makeLineSplitter((l) => safeCall(opts.onStderrLine, l));
  let stderrTail = '';

  child.stdout.on('data', (d) => outSplitter.push(d));
  child.stderr.on('data', (d) => {
    errSplitter.push(d);
    stderrTail = (stderrTail + decodeBuffer(d)).slice(-4000);
  });

  const done = new Promise((resolve, reject) => {
    child.on('error', reject);
    child.on('close', (code) => {
      outSplitter.flush();
      errSplitter.flush();
      resolve({ code: code == null ? -1 : code, stderr: stderrTail });
    });
  });

  return { child, done };
}

/** 连子进程一起干掉（Windows 下 taskkill /T） */
function killTree(child) {
  return new Promise((resolve) => {
    if (!child || child.killed || child.exitCode != null) return resolve();
    const pid = child.pid;
    if (!pid) return resolve();
    if (process.platform === 'win32') {
      const k = spawn('taskkill', ['/pid', String(pid), '/T', '/F'], { windowsHide: true });
      k.on('close', () => resolve());
      k.on('error', () => {
        try {
          child.kill('SIGKILL');
        } catch (_) {}
        resolve();
      });
    } else {
      try {
        process.kill(-pid, 'SIGKILL');
      } catch (_) {
        try {
          child.kill('SIGKILL');
        } catch (_) {}
      }
      resolve();
    }
  });
}

/** 把 stderr 里的 yt-dlp 行提取为可读错误信息 */
function extractErrors(stderr) {
  if (!stderr) return '';
  const lines = stderr
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => /^(ERROR|WARNING):/i.test(l));
  return lines.slice(0, 5).join('\n');
}

module.exports = {
  BASE_FLAGS,
  run,
  spawnLines,
  killTree,
  extractErrors,
  childEnv,
  decodeBuffer,
};
