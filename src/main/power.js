'use strict';
/**
 * 全部任务完成后的自动关机。
 *
 * 安全上的两个关键决定：
 *
 * 1. **必须真的跑过任务才允许关机**（armed 标志）。
 *    否则一打开软件、队列恰好是空的，就会立刻把机器关掉 —— 那是灾难。
 *    所以只有观察到「有任务在下载/排队」之后，才会把关机许可打开。
 *
 * 2. **一定要能取消**。
 *    用 Windows 原生的 `shutdown /s /t <秒>`，这样系统会弹出提示，
 *    而且 `shutdown /a` 能随时中止。界面上也给一个显眼的取消按钮。
 *
 * 另外：一有新任务进来就立刻取消已排定的关机 —— 用户显然还没弄完。
 */
const { spawn } = require('child_process');

/** 处于这些状态说明还有活没干完 */
const BUSY = new Set(['downloading', 'queued', 'paused']);

let timer = null; // 关机倒计时的定时器（我们自己维护，便于界面显示剩余秒数）
let scheduledAt = 0;
let delaySec = 0;
let armed = false; // 是否「见过任务在跑」—— 没有它会在空队列时误关机
let onStateChange = null;

function runShutdown(args) {
  try {
    const p = spawn('shutdown', args, { windowsHide: true, detached: true, stdio: 'ignore' });
    p.unref();
    return true;
  } catch (_) {
    return false;
  }
}

function emit(state) {
  if (typeof onStateChange === 'function') {
    try {
      onStateChange(state);
    } catch (_) {}
  }
}

/** 当前状态（给界面用） */
function state() {
  const left = scheduledAt ? Math.max(0, Math.round((scheduledAt - Date.now()) / 1000)) : 0;
  return { scheduled: !!scheduledAt, secondsLeft: left, armed, delaySec };
}

/** 排定关机；调用前应确保确实该关 */
function schedule(seconds, message) {
  const sec = Math.max(10, Math.round(Number(seconds) || 60));
  cancel({ silent: true }); // 先清掉旧的，避免叠加
  delaySec = sec;
  scheduledAt = Date.now() + sec * 1000;
  // 走系统原生命令：这样任务栏会显示系统提示，用户也能用 shutdown /a 中止
  runShutdown(['/s', '/t', String(sec), '/c', message || 'YouTube 下载器：全部任务已完成，即将关机']);
  timer = setTimeout(() => {
    timer = null;
    scheduledAt = 0;
    emit({ scheduled: false, secondsLeft: 0, fired: true, armed });
  }, sec * 1000);
  emit(state());
  return state();
}

/** 取消关机 */
function cancel(opts) {
  if (timer) {
    clearTimeout(timer);
    timer = null;
  }
  const was = !!scheduledAt;
  scheduledAt = 0;
  delaySec = 0;
  if (was) runShutdown(['/a']); // 中止系统那边已排定的关机
  if (!(opts && opts.silent)) {
    if (was) emit({ scheduled: false, secondsLeft: 0, canceled: true, armed });
  }
  return was;
}

/**
 * 队列状态变化时调用。
 * @param {number} busy 还在跑的任务数
 * @param {object} settings
 * @param {number} failed 失败的任务数
 * @returns {boolean} 本次是否刚刚排定了关机
 */
function onQueueChange(busy, settings, failed) {
  // 一有任务在跑就上锁并取消已排定的关机
  if (busy > 0) {
    if (scheduledAt) cancel();
    else if (timer) cancel({ silent: true });
    armed = true;
    return false;
  }
  if (!settings || !settings.shutdownAfterDone) return false;
  if (!armed) return false; // 从没见过任务在跑 → 绝不能关
  if (scheduledAt) return false; // 已经排过了
  // 有失败任务且用户不想关 → 留着机器，让用户自己看
  if (failed > 0 && settings.shutdownEvenIfFailed === false) return false;
  schedule(settings.shutdownDelaySec, 'YouTube 下载器：全部任务已完成，即将关机');
  return true;
}

/** 用户关掉开关时调用 */
function reset() {
  cancel({ silent: true });
  armed = false;
}

function setListener(fn) {
  onStateChange = fn;
}

module.exports = { onQueueChange, schedule, cancel, state, reset, setListener, BUSY };
