'use strict';
/**
 * 网络诊断：把「为什么下不动」变成一句人话。
 *
 * 背景：YouTube 的「Sign in to confirm you're not a bot」风控是按 **IP** 判定的，
 * 而且对**机房 IP**（云服务器、VPS）极其严格。实测本机出口是 Oracle 云机房，
 * 于是所有请求一律被拦 —— 但用户看到的只有一屏英文报错，根本不知道原因。
 *
 * 这里做三件事：
 *   1. 查当前出口 IP，并判断它是不是机房 IP
 *   2. 扫本机常见代理端口（Clash / v2ray 之类）
 *   3. 实测 yt-dlp 能不能拿到视频信息
 */
const https = require('https');
const http = require('http');
const net = require('net');

/** 常见代理客户端在本机监听的端口 */
const PROXY_PORTS = [
  { port: 7897, name: 'Clash Verge' },
  { port: 7890, name: 'Clash' },
  { port: 7891, name: 'Clash (socks)' },
  { port: 10808, name: 'v2rayN' },
  { port: 10809, name: 'v2rayN (http)' },
  { port: 1080, name: '通用 SOCKS' },
  { port: 2080, name: 'Nekoray' },
  { port: 8889, name: '其它' },
];

function httpGet(url, timeoutMs) {
  return new Promise((resolve) => {
    let req;
    const lib = url.startsWith('https:') ? https : http;
    try {
      req = lib.get(url, { timeout: timeoutMs || 8000 }, (res) => {
        let data = '';
        res.on('data', (c) => (data += c));
        res.on('end', () => resolve({ ok: res.statusCode === 200, status: res.statusCode, body: data }));
      });
    } catch (e) {
      return resolve({ ok: false, error: String(e && e.message) });
    }
    req.on('timeout', () => {
      req.destroy();
      resolve({ ok: false, error: '超时' });
    });
    req.on('error', (e) => resolve({ ok: false, error: String(e && e.message) }));
  });
}

/** 某个端口上有没有程序在监听（不真连，只测能不能建立 TCP 连接） */
function portOpen(port, host) {
  return new Promise((resolve) => {
    const sock = new net.Socket();
    let done = false;
    const finish = (v) => {
      if (done) return;
      done = true;
      sock.destroy();
      resolve(v);
    };
    sock.setTimeout(600);
    sock.on('connect', () => finish(true));
    sock.on('timeout', () => finish(false));
    sock.on('error', () => finish(false));
    sock.connect(port, host || '127.0.0.1');
  });
}

/**
 * @param {string} bin yt-dlp 路径
 * @param {(args:string[])=>Promise<{code:number,stdout:string,stderr:string}>} run 执行器
 * @param {object} settings 当前设置（用它的 proxy）
 * @param {string} probeUrl 用来实测的视频地址
 */
async function diagnose({ bin, run, settings, probeUrl }) {
  const out = { steps: [] };

  // ---- 1) 出口 IP ----
  const ipRes = await httpGet('https://api.ipify.org?format=json');
  let ip = '';
  try {
    ip = JSON.parse(ipRes.body || '{}').ip || '';
  } catch (_) {}
  out.ip = ip;

  if (ip) {
    const infoRes = await httpGet(
      `http://ip-api.com/json/${ip}?fields=status,country,regionName,city,isp,org,as,hosting,mobile,proxy`
    );
    try {
      const j = JSON.parse(infoRes.body || '{}');
      out.geo = j;
      out.isDatacenter = j.hosting === true;
    } catch (_) {}
  }

  // ---- 2) 本机代理端口 ----
  const found = await Promise.all(
    PROXY_PORTS.map(async (p) => ((await portOpen(p.port)) ? p : null))
  );
  out.proxies = found.filter(Boolean);
  out.currentProxy = String((settings && settings.proxy) || '').trim();

  // ---- 3) yt-dlp 实测 ----
  if (bin && probeUrl) {
    try {
      const r = await run(bin, [
        '--no-warnings', '--encoding', 'utf-8', '--no-playlist', '--skip-download',
        '--print', '%(title)s', probeUrl,
      ]);
      const text = String((r.stdout || '') + '\n' + (r.stderr || ''));
      if (/Sign in to confirm|not a bot/i.test(text)) {
        out.ytdlp = { ok: false, kind: 'botcheck' };
      } else if (r.code === 0 && String(r.stdout || '').trim()) {
        out.ytdlp = { ok: true, title: String(r.stdout).trim().split('\n')[0].slice(0, 60) };
      } else {
        out.ytdlp = { ok: false, kind: 'error', detail: (r.stderr || '').slice(-300) };
      }
    } catch (e) {
      out.ytdlp = { ok: false, kind: 'error', detail: String(e && e.message) };
    }
  }

  // ---- 4) 给出结论 ----
  const advice = [];
  if (out.isDatacenter) {
    advice.push(
      `你的网络出口是【机房 IP】（${(out.geo && out.geo.org) || '云服务商'}），` +
        'YouTube 对这类 IP 的风控极其严格，几乎必然触发「确认你不是机器人」。'
    );
    advice.push('解决办法：让代理软件真正接管 YouTube 的流量，换一个住宅出口 IP。');
  }
  if (out.proxies.length && !out.currentProxy) {
    advice.push(
      `检测到本机有代理在监听（${out.proxies.map((p) => p.port).join('、')}），` +
        '但软件里没有配置代理。可以把它填进设置。'
    );
  }
  if (out.currentProxy && out.ytdlp && !out.ytdlp.ok) {
    advice.push('已经配了代理但仍被拦，说明该代理的出口 IP 也被风控了，换一个节点试试。');
  }
  if (out.ytdlp && out.ytdlp.kind === 'botcheck' && !out.isDatacenter) {
    advice.push('出口 IP 不是机房，可能只是短时间请求太频繁。等几分钟再试即可。');
  }
  advice.push('另一个可靠办法：导出 cookies.txt 并在设置里选择它（登录态能显著降低风控概率）。');
  out.advice = advice;

  return out;
}

module.exports = { diagnose, PROXY_PORTS };
