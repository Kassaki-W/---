import { log } from '../logger.js';

/**
 * 时钟校准（FR-04 / 6.1）：
 * - 启动时与网络时间源校准一次，运行期按固定间隔复查漂移，超阈值告警；
 * - 「所有时刻以开抢时刻为唯一基准」——开抢判断一律用 now()（含校准偏移）。
 * 时间源选 12306 自己的响应 Date 头：抢票能否成功取决于平台侧时钟，对齐它最有意义。
 */

let offsetMs = 0; // 服务端时间 - 本地时间
let lastCalibratedAt = 0;
let timer = null;

const DRIFT_WARN_MS = 2000;
const RECHECK_INTERVAL_MS = 5 * 60 * 1000;

async function calibrateOnce() {
  const before = Date.now();
  const res = await fetch('https://kyfw.12306.cn/otn/leftTicket/init', { method: 'HEAD' });
  const after = Date.now();
  const dateHeader = res.headers.get('date');
  if (!dateHeader) throw new Error('响应无 Date 头');
  // Date 头精度为秒；取请求中点作本地参考，误差 ≤ 0.5s + 半程网络
  const serverMs = new Date(dateHeader).getTime() + 500;
  offsetMs = serverMs - Math.round((before + after) / 2);
  lastCalibratedAt = Date.now();
  log.info('clock', `时钟校准完成，本地与服务端偏移 ${offsetMs}ms`);
}

export async function startClock() {
  try {
    await calibrateOnce();
  } catch (e) {
    offsetMs = 0;
    log.warn('clock', `启动校准失败，暂用本地时钟（${String(e)}）；持续失败将影响开抢精度`);
  }
  timer = setInterval(async () => {
    try {
      const before = offsetMs;
      await calibrateOnce();
      if (Math.abs(offsetMs - before) > DRIFT_WARN_MS) {
        log.warn('clock', `时钟漂移超阈值：偏移由 ${before}ms 变为 ${offsetMs}ms`, { offsetMs });
      }
    } catch { /* 校准失败沿用旧偏移 */ }
  }, RECHECK_INTERVAL_MS);
  timer.unref();
}

/** 校准后的当前时刻（毫秒），开抢判断的唯一时钟 */
export function now() {
  return Date.now() + offsetMs;
}

export function clockInfo() {
  return { offsetMs, lastCalibratedAt: lastCalibratedAt ? new Date(lastCalibratedAt).toISOString() : null };
}

export function stopClock() {
  if (timer) clearInterval(timer);
}
