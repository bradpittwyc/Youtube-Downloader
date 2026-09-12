# AGENTS.md — 给 AI 助手的交接说明

> 这个文件是给**接手这个仓库的 AI 助手**看的，不是给最终用户看的（用户文档在 `README.md`）。
> 目的：省掉重新踩坑的时间。**动手前请先读完「环境陷阱」和「开发循环」两节。**

---

## 1. 这个项目是什么

Windows 桌面版 YouTube 批量下载器（Electron）。核心链路：

```
粘贴频道链接 → 识别全部内容（Videos/Shorts/Live/Podcasts/播放列表）
            → 批量下载（可断点续传）
            → 导出 MP3 + 抓字幕
            → 调大模型生成中英对照学习文档（Word）+ 双语 ASS 字幕
            → 可把文档里的金句渲染成图片
```

- **作者的使用场景**：把 YouTube 视频变成可用于英语学习的语料
- **仓库**：`https://github.com/bradpittwyc/Youtube-Downloader`（私有）
- **当前版本**：见 `package.json`；`git tag` 有全部历史版本
- **技术栈**：Electron 44 + electron-builder；无前端框架，原生 DOM
- **运行时依赖极少**：只有 `docx`（生成 Word）。**不要轻易引入新依赖**，作者明确不喜欢臃肿

---

## 2. 关键路径

| 项 | 位置 |
|---|---|
| 源码 | `src/main/`（主进程）、`src/preload/`、`src/renderer/`（界面） |
| 内置二进制 | `resources/bin/yt-dlp.exe`、`resources/bin/ffmpeg.exe`（**不打进 asar**，走 `extraResources`） |
| 用户数据 | `%APPDATA%\youtube-downloader\`（`settings.json` / `queue.json` / `channels.json` / `study-cache/`） |
| **实际下载目录** | `F:\YouTube下载\`（不在仓库里！） |
| 构建产物 | `dist/`（**gitignore，不入库**） |

**用户的机器**：Windows 10.0.22621，Node 24，**PowerShell 5.1（没有 pwsh）**，Word 已安装。

---

## 3. ⚠️ 环境陷阱（这一节最省时间）

这些都是实际卡住过人的，README 里没写：

### 3.1 `ELECTRON_RUN_AS_NODE` 会让打包版"打不开"

如果 shell 环境里有 `ELECTRON_RUN_AS_NODE=1`，启动打包后的 exe 会**以纯 Node 模式运行然后静默退出**
（报 `bad option: --exec=...`），看起来像程序坏了。

**启动前先清掉：**

```powershell
Remove-Item env:ELECTRON_RUN_AS_NODE -ErrorAction SilentlyContinue
& "dist\win-unpacked\YouTube Downloader.exe"
```

（不影响用户双击启动，只影响命令行。）

### 3.2 构建前必须先关掉 App

App 在运行时构建会失败：

```
EPERM: operation not permitted, unlink 'dist\win-unpacked\dxcompiler.dll'
```

```powershell
Get-Process | Where-Object { $_.ProcessName -like "*YouTube Downloader*" } | Stop-Process -Force
Start-Sleep -Seconds 3    # 等文件句柄释放，别省
```

### 3.3 PowerShell 5.1 的坑（用 Node 绕过更省事）

| 坑 | 表现 | 对策 |
|---|---|---|
| `Set-Content -Encoding UTF8` 会写 **BOM** | 写坏 `queue.json` 这类要精确格式的文件 | 写文件用 `write` 工具或 Node 的 `fs` |
| `Test-Path` / `Get-Item` 把 `[` `]` 当**通配符** | "文件明明在却判断为不存在" | 一律用 `-LiteralPath` |
| 全角引号 `""` 会**截断字符串** | `git commit -m "…"` 报语法错 | 提交信息写进临时文件，用 `git commit -F <file>` |
| `-match` **区分大小写**了吗？否，不区分 | 误判 | 需要区分时用 `-cmatch` |
| `ConvertTo-Json` 把**单元素数组退化成对象** | JSON 结构不对 | 用 Node 处理 JSON |
| 没有 `Join-String` | 脚本报错 | 换 `-join` |
| 用内联 `node -e "…"` 跑含引号/中文的 JS | PowerShell 转义把它搅烂 | **把脚本写成文件再 `node file.js`** |

### 3.4 大尺寸隐藏窗口截图会被钳制

如果要做"渲染大图"这类功能（参考 `src/main/study/quote-card.js`）：
**窗口尺寸在「创建时」会被钳到屏幕工作区**（本机 1920×1032，连 1080 高都开不出来），截图会被裁。

**解法：先建小窗口，创建之后再 `setBounds`** —— 实测能突破钳制。

另外：销毁**唯一**窗口会触发 Electron 的 `window-all-closed` 默认退出，
导致后续 `loadFile` 全部 `ERR_FAILED`（真实 App 有主窗口所以没事，**测试脚本要自己留个常驻窗口**）。

---

## 4. 开发循环（**别每次都打包**）

打包一次约 **2 分钟**，但验证改动通常只需要几秒。

### 4.1 用 `--exec` 钩子直接驱动界面（推荐）

`main.js` 末尾有个开发钩子，能在**渲染进程里执行任意 JS 并回传结果**：

```powershell
Remove-Item env:ELECTRON_RUN_AS_NODE -ErrorAction SilentlyContinue
$env:YTDL_DEV_EXEC='1'      # 打包版需要这个；开发模式（npm start）不需要
& "dist\win-unpacked\YouTube Downloader.exe" "--exec=E:\path\to\scenario.js"
```

- 脚本在渲染进程里跑，可以访问 `window.api`、真实 DOM
- 结果以 `[exec] result: <JSON>` 打印到 stdout
- **不会自动退出**（方便接着截图）
- 另有 `--capture=<png>` 截图后退出

**这是本项目最主要的验证手段**：写个 scenario 脚本 → 跑 → 看输出的 JSON → 必要时截图。
`tools/ui-scenario-*.js` 是现成例子。

⚠️ **scenario 脚本必须放在 gitignore 的目录里**（如 `.probe/`），且**绝不能包含 API key**。
用完删掉。

### 4.2 截图核实界面

```powershell
& ".\tools\capture-window.ps1" -TitleMatch "YouTube" -ProcessName "YouTube Downloader" -Out "docs\trial.png"
```

用 `PrintWindow` 抓窗口，**不受遮挡影响**。抓完用 `read_image` 工具看。

### 4.3 纯逻辑的单元验证

不需要 Electron 的模块（如 `queue.js` 的错误分级、`downloads-index.js` 的扫描），
**mock 掉 `electron` 模块**后可以直接用 Node 跑：

```js
const Module = require('module');
const orig = Module._load;
Module._load = function (req, ...rest) {
  if (req === 'electron') return { app: { isPackaged: false, getPath: (n) => UD, getAppPath: () => process.cwd(), getVersion: () => '1' }, safeStorage: null };
  return orig.call(this, req, ...rest);
};
```

### 4.4 集成测试

`npm test`（`tools/integration-test.js`）**会真实联网**，跑得慢（可能超过 5 分钟），
环境变量 `YTLD_QUICK=1` 可加速。**别在验证小改动时跑它。**

### 4.5 独立跑 Electron 脚本（不启动 App）

有些验证不需要整个 App，可以直接：

```powershell
& ".\node_modules\electron\dist\electron.exe" ".probe\render-test.js"
```

（例如验证 `study/quote-card.js` 的渲染。）

---

## 5. 项目约定

### 5.1 提交信息

**必须用文件传**，否则 PowerShell 会把全角引号当字符串结束符：

```powershell
# 1. 用 write 工具把信息写到 commit-msg.txt
git add -A
git commit -q -F "commit-msg.txt"
Remove-Item "commit-msg.txt" -Force
git add -A; git commit -q --amend --no-edit     # 确认临时文件没被带进提交
```

风格：**中文**，写明「问题 → 改法 → 实测结果」，不要只写"修复 bug"。
作者很看重"为什么这么改"。

### 5.2 发版流程

1. 改 `package.json` 的 `version`
2. 在 `CHANGELOG.md` **顶部**加一条（同样写清问题/改法/实测）
3. `npm run dist`（先关 App！）
4. 提交 → `git tag -a vX.Y.Z -m "…"` → `git push`
   （已配置 `push.followTags=true`，推送时会带上 tag）

**构建产物不入库**。策略是「源码 + tag 在 GitHub，本地不留」，
需要旧版本时从 tag 重建（约 2 分钟）。

### 5.3 验证标准（作者的要求）

做完一个改动，**必须实测过再声称成功**。作者明确要求：

- 「每步都要验证过再声称成功」
- 改完界面后**把 App 重新启动并弹到前台**
- 不要用"应该可以"、"理论上"这类说法

---

## 6. 代码结构速查

| 文件 | 职责 |
|---|---|
| `src/main/main.js` | 窗口、全部 IPC、开发钩子 |
| `src/main/queue.js` | 下载队列：调度、进度、断点续传、重试退避、下载后链路（音频/字幕/文档） |
| `src/main/channel.js` | 频道识别、播放列表展开、视频详情 |
| `src/main/settings.js` | 设置默认值与迁移 |
| `src/main/downloads-index.js` | 按视频 ID 识别本地已下载（边车文件） |
| `src/main/ytdlp-auth.js` | Cookies / 代理参数（**所有 yt-dlp 调用共用**） |
| `src/main/study/` | 学习文档流水线：字幕解析 → LLM 翻译 → Word / ASS / 金句卡片 |
| `src/renderer/app.js` | 全部界面逻辑（IIFE，**不要写 `const api = window.api`**） |

---

## 7. 不要做的事

- **不要引入新依赖**（尤其前端框架、图像库）——渲染大图用 Electron 自带的 `capturePage`，图标用 `tools/make-icon.js`
- **不要给 `yt-dlp` 加 `--download-archive`**（历史上导致过两个 bug，已移除）
- **不要把 cookie/代理只加在下载那一步**——识别、字幕、探测全都要（见 `ytdlp-auth.js`）
- **不要用 `--no-part`**（破坏断点续传）
- **不要在渲染层写 `const api = window.api`**（会全黑）
- **不要提交 `tools/probe.config.json`**（含 API key）
- **不要主动提一堆新功能**——作者只要他明确要的东西

---

## 8. 已知限制（现状，不是 bug）

- **Cookies 从浏览器读取对本机 Edge 无效**：Chrome/Edge 127+ 用了「应用绑定加密」，
  第三方工具解不开（yt-dlp 已知限制）。可靠路径是导出 `cookies.txt`
- **YouTube 风控**：按 IP 判定，实测**切换 player_client（8 种）全部绕不过**。
  已实现分级退避重试（20s→1m→3m→5m）
- **文档生成失败没有自动重试**（下载有，文档没有）——作者明确说暂时不做
- 学习文档需要配置大模型 API（DeepSeek 等 OpenAI 兼容接口），key 用 `safeStorage` 加密存储
