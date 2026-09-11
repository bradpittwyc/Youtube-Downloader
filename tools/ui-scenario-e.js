/**
 * UI 场景 E：确认新增的音频相关界面元素渲染正确（打开设置弹窗后返回状态）
 */
(async () => {
  const $ = (id) => document.getElementById(id);
  await new Promise((r) => setTimeout(r, 1500));
  $('btnSettings').click();
  await new Promise((r) => setTimeout(r, 1800));
  return {
    ok: true,
    barAlsoAudioChecked: $('alsoAudio') ? $('alsoAudio').checked : 'MISSING',
    barAudioOnlyChecked: $('audioOnly') ? $('audioOnly').checked : 'MISSING',
    setVideoCodec: $('setVideoCodec') ? $('setVideoCodec').value : 'MISSING',
    setVideoCodecOptions: $('setVideoCodec')
      ? Array.from($('setVideoCodec').options).map((o) => o.value)
      : 'MISSING',
    setAudioFormat: $('setAudioFormat') ? $('setAudioFormat').value : 'MISSING',
    setAlsoAudioChecked: $('setAlsoAudio') ? $('setAlsoAudio').checked : 'MISSING',
    outputDir: $('setOutputDir') ? $('setOutputDir').value : 'MISSING',
    settingsVisible: !$('settingsModal').classList.contains('hidden'),
  };
})();
