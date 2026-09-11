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
  },

  channels: {
    top: (limit) => ipcRenderer.invoke('channels:top', limit),
    remove: (url) => ipcRenderer.invoke('channels:remove', url),
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
  },

  shell: {
    openPath: (p) => ipcRenderer.invoke('shell:open-path', p),
    showItem: (p) => ipcRenderer.invoke('shell:show-item', p),
  },
});
