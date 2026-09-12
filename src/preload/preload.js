'use strict';
/**
 * 预加载脚本：通过 contextBridge 暴露受控 API（渲染进程不接触 Node）。
 */
const { contextBridge, ipcRenderer } = require('electron');

function on(channel, handler) {
  const wrapped = (_event, payload) => handler(payload);
  ipcRenderer.on(channel, wrapped);
  return () => ipcRenderer.removeListener(channel, wrapped);
}

contextBridge.exposeInMainWorld('api', {
  info: () => ipcRenderer.invoke('app:info'),

  bin: {
    check: () => ipcRenderer.invoke('bin:check'),
    update: () => ipcRenderer.invoke('bin:update'),
    resetOverride: () => ipcRenderer.invoke('bin:reset-override'),
    onUpdateLog: (cb) => on('bin:update:log', cb),
  },

  settings: {
    get: () => ipcRenderer.invoke('settings:get'),
    set: (patch) => ipcRenderer.invoke('settings:set', patch),
  },

  /** 系统已安装字体（字幕字体选择用） */
  fonts: {
    list: () => ipcRenderer.invoke('fonts:list'),
  },

  /** 已下载索引（按视频 ID 识别本地文件）与作品详情 */
  downloads: {
    index: (opts) => ipcRenderer.invoke('downloads:index', opts),
    local: (id) => ipcRenderer.invoke('downloads:local', { id }),
    details: (url) => ipcRenderer.invoke('video:details', { url }),
  },

  /** Cookies：检测本机浏览器 + 实测配置是否生效 */
  cookies: {
    detect: () => ipcRenderer.invoke('cookies:detect'),
    test: (patch) => ipcRenderer.invoke('cookies:test', patch),
  },

  dialog: {
    pickFolder: (current) => ipcRenderer.invoke('dialog:pickFolder', current),
    pickFile: () => ipcRenderer.invoke('dialog:pickFile'),
    confirm: (opts) => ipcRenderer.invoke('dialog:confirm', opts),
  },

  channel: {
    enumerate: (input, force) => ipcRenderer.invoke('channel:enumerate', { input, force }),
    cancel: () => ipcRenderer.invoke('channel:cancel'),
    clearCache: (input) => ipcRenderer.invoke('channel:clear-cache', input),
    playlistItems: (payload) => ipcRenderer.invoke('channel:playlist-items', payload),
    sessionList: () => ipcRenderer.invoke('channel:session-list'),
    sessionForget: (url) => ipcRenderer.invoke('channel:session-forget', url),
    onProgress: (cb) => on('channel:progress', cb),
    /** 后台静默刷新完成：把最新列表推给界面替换（先给旧列表秒开，再悄悄更新） */
    onRefreshed: (cb) => on('channel:refreshed', cb),
  },

  channels: {
    top: (limit) => ipcRenderer.invoke('channels:top', limit),
    remove: (url) => ipcRenderer.invoke('channels:remove', url),
    categories: () => ipcRenderer.invoke('categories:list'),
  },

  queue: {
    add: (items, options) => ipcRenderer.invoke('queue:add', { items, options }),
    list: () => ipcRenderer.invoke('queue:list'),
    action: (key, action) => ipcRenderer.invoke('queue:action', { key, action }),
    clear: (filter) => ipcRenderer.invoke('queue:clear', filter),
    cancelAll: () => ipcRenderer.invoke('queue:cancel-all'),
    pauseAll: () => ipcRenderer.invoke('queue:pause-all'),
    resumeAll: () => ipcRenderer.invoke('queue:resume-all'),
    onChanged: (cb) => on('queue:changed', cb),
  },

  study: {
    testConnection: (override) => ipcRenderer.invoke('study:test-connection', override),
    estimate: (payload) => ipcRenderer.invoke('study:estimate', payload),
    generate: (key, force) => ipcRenderer.invoke('study:generate', { key, force }),
    keyInfo: () => ipcRenderer.invoke('study:key-info'),
    quoteCards: (key) => ipcRenderer.invoke('study:quote-cards', { key }),
  },

  shell: {
    openPath: (p) => ipcRenderer.invoke('shell:open-path', p),
    showItem: (p) => ipcRenderer.invoke('shell:show-item', p),
    openExternal: (url) => ipcRenderer.invoke('shell:open-external', url),
  },
});
