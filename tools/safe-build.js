/**
 * 安全打包：如果有任务正在跑（下载 / 翻译 / 生成文档），直接拒绝打包。
 *
 * 背景：打包前必须关掉 App（否则 electron-builder 会 EPERM 失败），
 * 而「关掉 App」会杀掉正在进行的下载和翻译。我犯过两次这个错：
 *   第一次导致作者的学习文档卡在 18/93，界面上还一直骗人；
 *   第二次又打断了一个刚跑到 10/11 段的任务。
 * 之前只是在脚本里 print 一句警告，但它拦不住流程 —— 现在改成真的退出。
 */
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const UD = path.join(process.env.APPDATA, 'youtube-downloader');
let busy = [];
try {
  const q = JSON.parse(fs.readFileSync(path.join(UD, 'queue.json'), 'utf8').replace(/^\uFEFF/, ''));
  busy = q.filter((it) => it.studying || it.status === 'downloading' || it.status === 'queued');
} catch (e) {
  console.log('  ⚠ 读不到 queue.json：' + e.message);
}

/**
 * 【关键】还要看 App 到底有没有在运行。
 * 队列里的 studying / downloading 可能只是上次被杀时留下的**过期标记**
 * （App 一重启就会被 load() 里的自愈逻辑复位），
 * 光看这些字段会误判成「正在跑」而白白拦住打包。
 * 反过来只要 App 没在运行，就不可能有任务真的在跑。
 */
function appRunning() {
  try {
    const out = execFileSync(
      'powershell',
      ['-NoProfile', '-Command', '(Get-Process | Where-Object { $_.ProcessName -like "*YouTube Downloader*" }).Count'],
      { encoding: 'utf8', windowsHide: true }
    );
    return Number(String(out).trim()) > 0;
  } catch (_) {
    return false;
  }
}

if (busy.length && !appRunning()) {
  console.log('  队列里有 ' + busy.length + ' 个像是「正在跑」的任务，但 App 没在运行 ——');
  console.log('  那只是上次退出留下的过期标记，不拦打包。');
  busy = [];
}

if (busy.length) {
  console.log('');
  console.log('  ✋ 拒绝打包：有 ' + busy.length + ' 个任务正在跑');
  for (const it of busy) {
    console.log('     · ' + String(it.title).slice(0, 44));
    console.log('       ' + (it.studyStage ? '翻译/生成：' + it.studyStage : it.stage || it.status));
  }
  console.log('');
  console.log('  打包会强制关闭 App，正在跑的任务会被打断。');
  console.log('  等它跑完（或先在界面上取消）再打包。');
  process.exit(1);
}

console.log('  ✅ 没有任务在跑，开始打包');

// 关掉 App 后等一下，让文件句柄释放（不等待会 EPERM: dxcompiler.dll）
try {
  execFileSync(
    'powershell',
    [
      '-NoProfile',
      '-Command',
      'Get-Process | Where-Object { $_.ProcessName -like "*YouTube Downloader*" -or $_.ProcessName -like "*YouTubeDownloader-Portable*" } | Stop-Process -Force -ErrorAction SilentlyContinue',
    ],
    { stdio: 'ignore' }
  );
} catch (_) {}
execFileSync('powershell', ['-NoProfile', '-Command', 'Start-Sleep -Seconds 3'], { stdio: 'ignore' });
console.log('  ✅ App 已关闭，句柄已释放');
