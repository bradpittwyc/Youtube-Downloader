# YouTube 下载器（Windows 桌面版）

粘贴博主主页 → 自动识别 **Videos / Shorts / Live 直播 / Podcasts** 全部内容 → 勾选批量下载 → **字幕自动翻译成中英对照 Word 学习文档**。

内置 `yt-dlp` 与 `ffmpeg`，**用户无需安装 Python 或任何额外依赖**，双击即用。

---

## 交付物

| 文件 | 说明 |
|---|---|
| `dist/YouTubeDownloader-Setup-<版本>.exe` | **安装版**（约 149 MB）。可选安装目录，自动创建开始菜单与桌面快捷方式，带标准卸载程序 |
| `dist/YouTubeDownloader-Portable-<版本>.exe` | **免安装版**（约 149 MB）。双击直接运行，不写注册表 |
| `src/` | 全部源码 |
| `tools/` | 测试与验证脚本 |
| `CHANGELOG.md` | 每个版本的改动记录 |

> 构建产物**不在版本库里归档**（`dist/`、`releases/` 都被 `.gitignore` 排除）。
> 历史版本请从 git tag 重建，见下方「版本备份、回滚与重建」。

> 安装包体积主要来自 Electron 运行时（约 100 MB）与 `ffmpeg.exe`（96 MB）。这是"用户零依赖"的代价。

---

## 学习文档（v1.1.0 新增）

字幕下载完成后**自动调用大模型**，产出两份与视频同名的文件：

```
标题 [2026-08-23].mp4          视频（带原声）
标题 [2026-08-23].mp3          同名音频
标题 [2026-08-23].en.srt       英文字幕
标题 [2026-08-23].zh-en.srt    中英双语字幕（播放器可直接加载）
标题 [2026-08-23].学习文档.docx 中英对照学习文档
```

Word 文档包含：

- 标题与元信息（频道 / 时长 / 上传日期 / 链接 / 翻译模型）
- 逐段：**英文段落 + 中文翻译 + 长难句精讲 + 重点词汇**，每段带 `[时间码]` 便于回看视频
- 附录一：纯英文版（无中文干扰，用于复读）
- 附录二：词汇总表（表格，按出现段数排序）
- 页眉放视频标题，页脚放页码

### 配置大模型

在「设置 → 学习文档」里填三项即可，统一走 **OpenAI 兼容协议**：

| 项 | 说明 |
|---|---|
| API 地址 | 如 `https://api.deepseek.com/v1`；OpenAI / 通义 / Kimi / GLM / OpenRouter / 本地 Ollama 同理 |
| API Key | 用 Windows DPAPI 加密后存本机，**不会**回传到界面 |
| 模型名 | 如 `deepseek-chat` |

填完点「测试连接」可直接验证。

### 费用

生成前会**预估 token 与费用**，队列里实时累计本次花费。实测 29 分钟英文视频约 **两三毛钱**、耗时约 4~5 分钟。

费用护栏（最短时长 / 单视频上限 / 本批累计上限）已实现但**默认全部为 0 即不限制**——下载完一律自动生成。想启用就去设置里填数字。

翻译结果会落盘缓存，**改排版选项重新生成不产生费用**；切换模型或改提示词会自动失效重译。

### 没有大模型也能用

不填 API Key 时，下载、音频、字幕功能完全不受影响，只是不生成学习文档（队列里会提示"尚未配置大模型 API"）。

---

## 功能

### 识别与列表

- 支持 `@handle`、`youtube.com/@handle`、`/videos` 等标签页链接、`/channel/UC...`、单个视频、播放列表；域名自动归一化
- 四分类抓取，Live 细分「正在直播 / 即将开播 / 往期回放」
- Podcasts 标签页的「播放列表容器」自动二级展开为单集
- 频道无某标签时明确提示（区分「没有该标签」与「真的出错」）
- 跨分类去重：同一视频只出现一次
- 搜索筛选、全选/反选/仅选未下载、滚动增量加载
- 30 分钟频道缓存，可强制重新抓取

### 下载

- 画质：最佳 / 2160p / 1440p / 1080p / 720p / 480p / 360p
- 视频编码策略：画质优先（最佳编码 + AAC）／兼容优先（H.264 + AAC）
- **视频必定带原声**：音频强制 AAC 封装进 MP4
- **同时下载音频（默认开启）**：本地 ffmpeg 抽轨导出同名 MP3，不重复下载
- **字幕下载（默认开启）**：原生语言字幕（默认 `en`），SRT/VTT/ASS 可选，失败不影响视频
- **学习文档（默认开启）**：字幕下完自动翻译排版
- 文件名默认 `标题 [上传日期].扩展名`
- 仅音频 MP3 模式、限速、代理、Cookies 文件、直播从头录制

### 队列

- 并发数可调（1–6）、暂停/继续/重试/移除、全部暂停/继续、清除已完成
- 实时进度、速度、剩余时间
- **断点续传三层保障**：yt-dlp 字节级 `.part` 续传 + 队列状态落盘跨重启继续 + `--download-archive` 去重
- 取消/退出用 `taskkill /T` 杀进程树，绝不留孤儿下载进程
- 每个任务可单独「打开/音频/字幕/双语/文档」并支持「重做」（走缓存秒出，Ctrl+点击强制重译）

### 系统

- 内置 yt-dlp.exe + ffmpeg.exe，用户零依赖
- 内核一键更新（下载到用户目录，无需管理员权限），可恢复内置版本
- 默认下载目录 `F:\YouTube下载`，并有「F → 其他非 C 盘 → 系统视频目录」降级链与盘符自愈
- NSIS 安装包 + 免安装版

1. **字节级**：yt-dlp 原生 `.part` 续传（已实测：暂停在 6.54 MB，恢复后从该位置继续增长，yt-dlp 明确输出 `Resuming download at byte ...`）
2. **任务级**：队列状态实时落盘，**关掉软件再打开会自动继续未完成的任务**
3. **去重级**：`--download-archive` 记录已下载视频，避免重复下载

暂停/取消/退出时会用 `taskkill /T` 杀掉 **整个进程树**，确保不会留下仍在后台偷偷下载的孤儿进程（已实测验证）。

---

## 使用方法

1. 运行安装版或免安装版
2. 粘贴博主主页链接，点「识别」（或直接回车）
3. 在分类标签页里勾选想要的内容，可选填搜索框筛选
4. 底部选择画质 / 是否仅音频 MP3 / 保存目录
5. 点「开始下载」，右侧队列显示实时进度

**数据存放位置**
- 默认下载目录：**`F:\YouTube下载`**（刻意不占 C 盘）
  - F 盘不存在时会自动依次尝试 D / E / G / H… 等其他非 C 盘数据盘，全都不可用才退回系统「视频」目录
  - 只选可写且剩余空间 ≥ 2GB 的盘；若设置的盘符之后不存在了（如拔掉移动硬盘），启动时自动回退，不会导致下载全部失败
  - 可在底部「保存到」或设置里随时改
- 配置目录：`%APPDATA%\youtube-downloader\`
  - `settings.json` 设置
  - `queue.json` 下载队列
  - `download-archive.txt` 已下载记录
  - `channel-cache/` 频道列表缓存

---

## 开发与构建

```bash
npm install          # 安装依赖（首次会下载 Electron 运行时）
npm start            # 开发模式运行
npm test             # 运行集成测试（真实联网，54 项）
npm run dist         # 打包出 NSIS 安装包 + 免安装版
npm run pack         # 只生成未打包目录 dist/win-unpacked
```

### 测试与验证

| 脚本 | 作用 |
|---|---|
| `tools/integration-test.js` | 54 项集成测试：链接解析、真实频道枚举、MP3 提取、暂停/断点续传、**"部分流已存在"误判回归**、错误处理、编码乱码回归。用 mock 掉 `electron` 模块直接驱动 `src/main` 的真实代码 |
| `tools/ui-scenario-a.js` | 真实 DOM 事件驱动：粘贴频道 → 识别 → 切分类 → 勾选（验证渲染层↔preload↔主进程 完整接线） |
| `tools/ui-scenario-b.js` | 真实 DOM 事件驱动：单个视频 → 选画质 → 开始下载 → 观察队列进度 |
| `tools/ui-scenario-c.js` | 打包后（`app.isPackaged=true`）端到端验证 |
| `tools/capture-window.ps1` | 用 `PrintWindow` 抓取指定窗口截图（不受窗口遮挡影响） |

UI 脚本用法（开发期）：

```bash
npx electron . --disable-gpu --exec=tools/ui-scenario-a.js
```

打包后的程序需要显式设置环境变量才允许该验证钩子：

```powershell
$env:YTDL_DEV_EXEC=1
& "dist\win-unpacked\YouTube Downloader.exe" "--exec=tools/ui-scenario-c.js"
```

---

## 版本备份、回滚与重建

### 备份策略：源码 + tag 在 GitHub，本地不留构建产物

远程仓库：**https://github.com/bradpittwyc/Youtube-Downloader**（私有）

每个版本都打了 git tag（`v1.0.0` … `v1.8.2`，共 20 个），**全部已推送到远程**。
`releases/`、`dist/`、`node_modules/` 都被 `.gitignore` 排除，**不会**上传 ——
也就是说 **GitHub 上只有源码和 tag，没有构建好的 exe**。

这是有意为之：最占体积的 `resources/bin/ffmpeg.exe`(96 MB) 本身在 git 里，
所以重建任何版本都只是「装依赖 + 打包」，约 2 分钟。为此上传上百 MB 的 exe 不划算。

### 重建任意版本

```powershell
$tag = 'v1.7.1'
git worktree add ..\_rebuild $tag      # 把该版本检出到旁边目录，不动当前工作区
cd ..\_rebuild
npm install                            # node_modules 未被跟踪，需要装一次
npm run dist                           # 产出 dist\*.exe
cd ..\youtubedownloader
git worktree remove ..\_rebuild
```

想省事也可以直接在临时目录 `git clone -b v1.7.1 <repo> && npm install && npm run dist`。

### 回退源码

```bash
git checkout v1.7.1          # 切到那个版本（只读查看用）
git switch -c rollback-1.7   # 或基于它开分支继续改
```

### 发版流程

```powershell
# 1. 改 package.json 的 version
# 2. 提交
git add -A; git commit -m "v1.9.0: ..."
# 3. 打 tag（已配置 push.followTags=true，推送时会自动带上 tag）
git tag -a v1.9.0 -m "v1.9.0 ..."
git push
# 4. 构建（产物留在 dist\，不必再归档到 releases\）
npm run dist
```

> **注意**：`push.followTags` 只推送「指向已推送提交」的 tag。
> 打完 tag 后务必确认 `git ls-remote --tags origin` 里有它 ——
> 曾经踩过 `gh repo create --push` 只推分支、**20 个 tag 一个都没上去**的坑。

### 回滚时的注意事项

**`%APPDATA%\youtube-downloader\`（设置 / 队列 / 缓存）是所有版本共用的，不会跟着回滚。**
几个具体的坑：

| 回滚到 | 风险 |
|---|---|
| ≤ v1.5.0 | `--download-archive` 重新生效，"删了文件仍判为已下载""换清晰度下不动"会回来 |
| ≤ v1.7.1（从 v1.8.x 退） | 学习缓存里是 `promptVersion=4`，旧版本视为不匹配 → **重新翻译，会产生 API 费用** |
| 其他 | settings.json / queue.json 里多出的新字段会被旧版本忽略，基本安全 |

要彻底干净地回滚，先把 `%APPDATA%\youtube-downloader\` 改名备份，让旧版本从默认设置重新开始。

---

## 技术实现要点

- **Electron 44** + **electron-builder 26**（NSIS 安装包 + portable）
- 主进程负责一切网络与进程操作，渲染进程通过 `contextBridge` 走 IPC，开启 `contextIsolation`、关闭 `nodeIntegration`
- 进度采集用 yt-dlp 的 `--progress-template` 输出机器可读行（`DL|状态|已下载|总量|速度|ETA|文件名`），再按"多路流加权求和"计算总进度
- 频道枚举用 `--flat-playlist --dump-single-json` 一次性拿全量列表（实测 856 个视频约 18 秒）
- `--print after_move:%(filepath)s` 拿到合并后真实落盘路径，供"打开文件夹"使用
- 取消/退出统一走 `taskkill /pid <pid> /T /F` 杀进程树

---

## 踩坑记录（重要）

这些都是实际调试中踩到并已修复的坑，改代码前请先读：

1. **yt-dlp 的纯文本输出是系统 ANSI 代码页（中文 Windows 为 GBK），不是 UTF-8**
   会导致文件名/路径里的非 ASCII 字符变成 `U+FFFD`（如 `World’s` → `World??s`）。
   必须加 `--encoding utf-8`，并**按字节切行、整行再解码**（否则多字节字符会被 chunk 边界切断）。JSON 输出因为默认转义非 ASCII 所以不受影响，掩盖了这个问题。

2. **`contextBridge` 暴露的 `window.api` 是全局对象上的"不可配置属性"**
   渲染脚本里写 `const api = window.api` 会直接抛 `SyntaxError: Identifier 'api' has already been declared`，整个脚本不执行、**界面全黑**。必须把渲染代码包进 IIFE。

3. **`--print` 会隐含 `--quiet` 和 `--simulate`**，把进度输出全部吃掉
   必须同时加 `--no-quiet --no-simulate`，否则进度条永远是 0。

4. **CSP 白名单**：YouTube 缩略图在 `i.ytimg.com`，频道头像在 `yt3.googleusercontent.com`，两者都要放行。

5. **取消/退出必须杀进程树**：只 `child.kill()` 会留下孤儿 `yt-dlp.exe` 继续在后台下载。

6. **Windows 路径含空格时参数必须加引号**：`child_process.spawn` 传数组是安全的；但 PowerShell 的 `Start-Process -ArgumentList` 不自动加引号，会把参数切断。

7. **断点续传时 yt-dlp 会对"已存在的那一路流"打印 `has already been downloaded`**
   不能据此判定整单跳过——否则明明下载了几十 MB、成功产出成品，界面却显示"已存在，跳过"。判定条件必须是"本轮一个字节都没下"。

8. **`streams` 标签页在无直播历史的频道会直接报错**（`This channel does not have a streams tab`）
   必须区分"没有该标签"（正常，降级为空）与"真的出错"（要报给用户）。另外标签页键名与分类键名必须统一（`streams` ↔ `live`），否则状态查询会全部落空。

9. **直播不要加 `--no-part`**：虽然能少一个临时文件，但会**彻底破坏断点续传**。

10. **Windows PowerShell 5.1 按 ANSI 读取无 BOM 的 `.ps1`**，脚本里写中文会导致解析失败。工具脚本一律用纯 ASCII。

11. **默认下载目录不能硬编码 `F:\`**：换台没有 F 盘的机器会直接崩或下载全部失败。已实现"优先 F 盘 → 其他非 C 盘 → 系统视频目录"的降级链，并在启动时自愈不存在的盘符。

12. **【最严重】下载的视频没有声音** —— 根因是 **Opus 被塞进了 MP4 容器**
    YouTube 在较高画质下提供的是 AV1/VP9 视频 + **Opus** 音频。若直接 `bv*+ba` 再 `--merge-output-format mp4`，
    得到的是 `Audio: opus` 装在 `.mp4` 里 —— 这是非标准组合，**大多数播放器和剪辑软件解不出音频轨**，
    表现就是"有画面没声音"（用 ffmpeg 查流信息才能看出音频轨其实存在）。
    修复：格式串里强制优先取 m4a/AAC 音频，即 `bv*+ba[ext=m4a]/bv*+ba/b`；
    这样只改变音频选择，**不改变视频流的选择**，因此已下载一半的 AV1 分片仍能断点续传。
    回归测试见 T7（不只是断言"有音频轨"，还会真正尝试解码音频流）。

13. **PowerShell 的 `Test-Path` / `Get-Item` 默认把 `[` `]` 当通配符**
    而本工具的默认文件名模板是 `%(title)s [%(id)s].%(ext)s`，几乎每个文件名都带方括号。
    在 PowerShell 脚本里判断这类路径必须用 `-LiteralPath`，否则会得到"文件明明存在却判断为不存在"的假象。
    （调试期间因此产生过两次误导性结论：`.part` 文件"凭空消失"、ffmpeg 转换"失败"。Node 的 `fs` 没有这个问题。）

---

## 已知限制

- **正在直播**：默认从当前时刻开始录制，需要一直挂着直到直播结束；勾选"直播从头录制"则从开头抓取，但需要该直播支持回看（DVR）
- **尚未开播**的直播会被拒绝并提示，暂不支持预约等待
- 大频道首次全量枚举需要 20–60 秒（有 30 分钟缓存）
- **未做代码签名**：首次运行会弹 Windows SmartScreen 提示，需点"更多信息 → 仍要运行"。正式签名需购买代码签名证书
- 会员专属／年龄限制／触发机器人验证的内容需要自行提供 `cookies.txt`（设置里可选）
- v1.0 未包含字幕下载、播放列表批量按分P重命名等进阶功能
- YouTube 改版可能导致内置 yt-dlp 失效，届时用设置里的「一键更新 yt-dlp」即可

---

## 免责声明

本工具仅用于下载你有权下载的内容（例如自己的作品、已获授权的内容、或平台允许离线保存的内容）。
下载受版权保护的内容可能违反 YouTube 服务条款，使用风险由使用者自行承担。
