/** 从 CHANGELOG.md 抽出指定版本的段落，作为 Release 说明。用法：node tools/extract-notes.js vX.Y.Z <输出文件> */
const fs = require('fs');
const path = require('path');

const version = process.argv[2];
const out = process.argv[3] || path.join(require('os').tmpdir(), `relnotes-${version}.md`);
if (!version) {
  console.error('用法: node tools/extract-notes.js vX.Y.Z [输出文件]');
  process.exit(1);
}

const changelog = path.resolve(__dirname, '..', 'CHANGELOG.md');
const lines = fs.readFileSync(changelog, 'utf8').split(/\r?\n/);

const start = lines.findIndex((l) => l.startsWith(`## ${version} `) || l.startsWith(`## ${version} —`));
if (start < 0) {
  console.error(`  CHANGELOG 里找不到 ${version} 的段落（标题要写成「## ${version} — …」）`);
  process.exit(1);
}
let end = lines.length;
for (let i = start + 1; i < lines.length; i++) {
  if (/^## v/.test(lines[i])) {
    end = i;
    break;
  }
}
const body = lines.slice(start, end).join('\n').replace(/\n---\s*$/, '').trimEnd();
fs.writeFileSync(out, body + '\n', 'utf8');
console.log(`  ${version} 的说明已写到 ${out}（${body.split('\n').length} 行）`);
