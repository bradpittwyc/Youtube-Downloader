/** 建 Release，带重试（GitHub 的 releases 接口今天很不稳） */
const { execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const version = process.argv[2] || '1.25.0';
const tag = 'v' + version;
const title = process.argv[3] || `${tag} 自动升级`;

// 从 CHANGELOG 抽说明
const notesFile = path.join(require('os').tmpdir(), `rn-${tag}.md`);
execFileSync(process.execPath, [path.resolve(__dirname, '..', 'tools', 'extract-notes.js'), tag, notesFile], {
  stdio: 'inherit',
  windowsHide: true,
});
const notes = fs.readFileSync(notesFile, 'utf8');

const setup = `dist/YouTubeDownloader-Setup-${version}.exe`;
const portable = `dist/YouTubeDownloader-Portable-${version}.exe`;

function retry(label, fn, times = 8) {
  for (let i = 1; i <= times; i++) {
    try {
      const out = fn();
      console.log(`  ${label} 第 ${i} 次 ✅${out ? '  ' + out.trim().slice(0, 90) : ''}`);
      return true;
    } catch (e) {
      const msg = String((e.stderr || e.message || '')).split('\n')[0].slice(0, 60);
      console.log(`  ${label} 第 ${i} 次 ❌ ${msg}`);
      const until = Date.now() + 4000;
      while (Date.now() < until) {}
    }
  }
  return false;
}

const gh = (args) => execFileSync('gh', args, { encoding: 'utf8', windowsHide: true });

// ① 先建一个不带说明的 release（说明大了接口就 502）
const created = retry('建 Release', () => gh(['release', 'create', tag, '--title', title, '--notes', tag]));
if (!created) {
  console.log('  建 Release 失败，退出');
  process.exit(1);
}

// ② 传附件
retry('传附件', () => gh(['release', 'upload', tag, setup, portable, '--clobber']));

// ③ 补标题与说明
const id = gh(['api', `/repos/bradpittwyc/Youtube-Downloader/releases/tags/${tag}`, '--jq', '.id']).trim();
console.log('  release id = ' + id);
retry('设标题', () => gh(['api', '-X', 'PATCH', `/repos/bradpittwyc/Youtube-Downloader/releases/${id}`, '-f', `name=${title}`, '--jq', '.name']));
retry('设说明', () => gh(['api', '-X', 'PATCH', `/repos/bradpittwyc/Youtube-Downloader/releases/${id}`, '-f', `body=${notes}`, '--jq', '.body']));

// ④ 核对
const info = JSON.parse(gh(['release', 'view', tag, '--json', 'tagName,name,assets']));
console.log('');
console.log(`  ${info.tagName}  「${info.name}」`);
for (const a of info.assets) console.log(`    ✅ ${a.name}  ${(a.size / 1048576).toFixed(1)} MB`);
