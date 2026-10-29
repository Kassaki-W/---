import { spawn } from 'node:child_process';
import { getDb, nowIso } from '../db/database.js';
import { decrypt } from '../db/crypto.js';
import { TaskState, transition, ACTIVE_STATES } from './stateMachine.js';
import { now, startClock, clockInfo } from './clock.js';
import { queryLeftTicket } from '../platform/tickets.js';
import { submitOrder } from '../platform/submit.js';
import * as session from '../session/manager.js';
import { getSettingNum } from '../settings.js';
import { log } from '../logger.js';

/**
 * 调度引擎（FR-04，系统核心）：
 * - 进程内定时器 + 单调校准时钟；到达「开抢时刻 − 提前量」把 ARMED 转 RUNNING；
 * - RUNNING 内串行轮询：查询 → 按候选车次序匹配 → 席别不降级；无票回 WAITING 重试；
 * - 多任务按创建顺序串行，不做并发压测（6.2）；限流退避、不提高频率（6.4）；
 * - 运行期阻止系统休眠（7.3）。
 */

const TICK_MS = 200;          // 主循环节拍
const RATE_LIMIT_BACKOFF_FACTOR = 2; // 命中限流时的退避倍率

/** taskId -> { abort: bool } 运行控制 */
const running = new Map();
let loopTimer = null;
let sleeperProc = null;

export async function startEngine() {
  await startClock();
  loopTimer = setInterval(tick, TICK_MS);
  loopTimer.unref();
  log.info('engine', '调度引擎已启动', clockInfo());
}

export function stopEngine() {
  if (loopTimer) clearInterval(loopTimer);
  for (const ctl of running.values()) ctl.abort = true;
  releaseSleepLock();
}

/** 用户手动停止运行中的任务（RUNNING → CANCELLED） */
export function cancelTask(taskId) {
  const ctl = running.get(taskId);
  if (ctl) ctl.abort = true;
}

function tick() {
  const armed = getDb().prepare(
    `SELECT id, name, start_time, time_window_end FROM tasks WHERE status = 'ARMED' ORDER BY start_time, id`
  ).all();
  for (const t of armed) {
    const fireAt = new Date(t.start_time.replace(' ', 'T') + '+08:00').getTime() - getAdvanceMs();
    if (now() >= fireAt) {
      const delayed = now() > new Date(t.start_time.replace(' ', 'T') + '+08:00').getTime();
      transition(t.id, TaskState.RUNNING, delayed ? '延迟启动（错过开抢时刻但在时间窗内）' : '到达开抢时刻');
      // 串行执行：当前无任务在跑才启动（6.2 多任务队列串行）
      if (![...running.keys()].length) runTask(t.id);
      else log.info('engine', `任务「${t.name}」等待其他任务完成，进入串行队列`, { taskId: t.id, queue: true });
    }
  }
  // FR-04 例外：错过整个时间窗的 ARMED 任务直接过期
  for (const t of armed) {
    const windowEnd = windowEndMs(t);
    if (windowEnd && now() > windowEnd && !running.has(t.id)) {
      transition(t.id, TaskState.EXPIRED, '已错过整个时间窗');
    }
  }
  updateSleepLock();
}

function windowEndMs(task) {
  if (!task.time_window_end) return null;
  return new Date(task.time_window_end.replace(' ', 'T') + '+08:00').getTime();
}

function getAdvanceMs() {
  const sec = getSettingNum('advance_seconds') ?? 0;
  return Math.round(sec * 1000);
}

function getRetryMs() {
  return Math.max(1, getSettingNum('retry_interval') ?? 5) * 1000;
}

/** 任务运行主循环（FR-05 / FR-09 / 6.3 / 6.4） */
async function runTask(taskId) {
  const ctl = { abort: false };
  running.set(taskId, ctl);
  try {
    // 开抢前登录态校验（FR-01）；失效为全局阻断（6.6）
    const v = await session.validateSession();
    if (!v.valid) {
      transition(taskId, TaskState.FAILED, `会话失效：${v.reason}。已全局暂停，请重新登录`);
      return;
    }

    const task = loadTask(taskId);
    if (!task) return;
    const trainCodes = JSON.parse(task.train_codes);
    const seatPrefs = JSON.parse(task.seat_prefs);
    const passengerIds = JSON.parse(task.passenger_ids);
    const windowEnd = windowEndMs(task);
    let round = 0;

    for (;;) {
      if (ctl.abort) return; // 用户手动停止
      round += 1;
      if (windowEnd && now() > windowEnd) {
        transition(taskId, TaskState.EXPIRED, `超出时间窗（共 ${round - 1} 轮）`);
        return;
      }

      let list;
      try {
        list = await queryLeftTicket({ date: task.ride_date, fromStation: task.from_station, toStation: task.to_station });
      } catch (e) {
        // 网络/限流：退避，不提高频率（6.4）
        const wait = getRetryMs() * RATE_LIMIT_BACKOFF_FACTOR;
        log.warn('engine', `查询失败，退避 ${wait / 1000}s 后重试`, { taskId, round, error: String(e) });
        if (!(await waitMs(wait, ctl))) return;
        continue;
      }

      const hit = matchCandidates(list, trainCodes, seatPrefs, task.accept_no_seat);
      if (hit) {
        log.info('engine', `第 ${round} 轮命中候选：${hit.trainCode} ${hit.seatType}`, { taskId, round });
        await submitHit(taskId, task, hit, list, passengerIds, ctl);
        return;
      }

      transition(taskId, TaskState.NO_TICKET, `第 ${round} 轮无票`);
      transition(taskId, TaskState.WAITING, `第 ${round} 轮结束，${getRetryMs() / 1000}s 后下一轮`);
      if (!(await waitMs(getRetryMs(), ctl))) return;
      transition(taskId, TaskState.RUNNING, `第 ${round + 1} 轮开始`);
    }
  } catch (e) {
    try { transition(taskId, TaskState.FAILED, `运行异常：${String(e)}`); } catch { /* 已在终态 */ }
  } finally {
    running.delete(taskId);
  }
}

/**
 * 命中后的提交链路（FR-06 / FR-07）：
 * 提交前校验（含单一订单口径）→ 串行单发提交 → 轮询占座 → PENDING_PAYMENT。
 */
async function submitHit(taskId, task, hit, list, passengerIds, ctl) {
  const db = getDb();

  // 单一订单口径（6.2）：同一任务存在未完成订单时复用，不重复提交
  const existing = db.prepare(
    "SELECT id, order_no FROM orders WHERE task_id = ? AND status = 'pending'"
  ).get(taskId);
  if (existing) {
    transition(taskId, TaskState.SUBMITTED, '复用已有未完成订单');
    transition(taskId, TaskState.QUEUED, '复用已有订单，进入待支付');
    transition(taskId, TaskState.PENDING_PAYMENT, `订单 ${maskOrderNo(existing.order_no)} 待支付`);
    return;
  }

  // 提交前校验：乘车人均已核验且与配置一致（FR-06 清单）
  const passengers = passengerIds.map((pid) => {
    const p = db.prepare('SELECT name, id_number_enc, verified FROM passengers WHERE id = ?').get(pid);
    if (!p || !p.verified) throw new Error(`乘车人 #${pid} 不存在或未核验，提交拦截`);
    return { name: p.name, idNo: decrypt(p.id_number_enc), seatType: hit.seatType };
  });

  const trainInfo = list.find((t) => t.trainCode === hit.trainCode);
  const ctx = {
    trainNo: trainInfo.trainNo,
    rideDate: task.ride_date,
    fromName: task.from_station,
    toName: task.to_station,
    fromCode: task.from_station_code,
    toCode: task.to_station_code,
    secretStr: trainInfo.secretStr,
    bedLevelInfo: trainInfo.bedLevelInfo,
    seatDiscountInfo: trainInfo.seatDiscountInfo,
    passengers,
  };

  // 串行单发：提交 + 轮询期间不再发起任何新提交（6.2）
  let orderId = null;
  try {
    orderId = await submitOrder(hit, ctx, (phase) => {
      if (phase === 'SUBMITTED') transition(taskId, TaskState.SUBMITTED, `命中 ${hit.trainCode} ${hit.seatType}，订单已受理`);
      if (phase === 'QUEUED') transition(taskId, TaskState.QUEUED, '排队轮询中');
    });
  } catch (e) {
    // 会话失效属全局阻断（6.6）；其余提交错误按不可重试处理（6.4），保留日志
    transition(taskId, TaskState.FAILED, `提交失败：${String(e)}`);
    return;
  }

  const now = nowIso();
  // 平台通常给出约 30 分钟支付窗口；以本机记录兜底做倒计时提醒（FR-08）
  const payDeadline = new Date(Date.now() + 30 * 60 * 1000).toISOString();
  db.prepare(
    `INSERT INTO orders (task_id, order_no, train_code, seat_type, status, pay_deadline, created_at, updated_at)
     VALUES (?, ?, ?, ?, 'pending', ?, ?, ?)`
  ).run(taskId, orderId, hit.trainCode, hit.seatType, payDeadline, now, now);
  transition(taskId, TaskState.PENDING_PAYMENT, `占座成功，订单 ${maskOrderNo(orderId)} 待支付（请尽快在官方页面完成支付）`);
}

/** 订单号脱敏：日志与状态原因只保留后六位 */
function maskOrderNo(no) {
  const s = String(no ?? '');
  return s.length <= 6 ? s : `****${s.slice(-6)}`;
}

/** 候选车次按序 × 席别按优先级匹配，不降级、不越出候选范围（6.3 / FR-09） */
export function matchCandidates(list, trainCodes, seatPrefs, acceptNoSeat) {
  const byCode = new Map(list.map((t) => [t.trainCode, t]));
  for (const code of trainCodes) {
    const t = byCode.get(code);
    if (!t || !t.canWebBuy) continue;
    for (const seat of seatPrefs) {
      const v = t.seats[seat];
      if (v === '有' || (Number.isFinite(Number(v)) && Number(v) > 0)) {
        return { trainCode: code, seatType: seat, remain: v };
      }
      // 席别只按给定优先级匹配，上一优先级无票不自动改选其他席别
    }
  }
  // 「接受无座」为独立开关，关闭时无座不进入候选
  if (acceptNoSeat) {
    for (const code of trainCodes) {
      const t = byCode.get(code);
      if (t?.canWebBuy && t.seats['无座'] === '有') return { trainCode: code, seatType: '无座', remain: '有' };
    }
  }
  return null;
}

function loadTask(id) {
  return getDb().prepare('SELECT * FROM tasks WHERE id = ?').get(id);
}

/** 可中断等待：返回 false 表示被中止 */
function waitMs(ms, ctl) {
  return new Promise((resolve) => {
    const start = Date.now();
    const iv = setInterval(() => {
      if (ctl.abort) { clearInterval(iv); resolve(false); }
      else if (Date.now() - start >= ms) { clearInterval(iv); resolve(true); }
    }, 100);
  });
}

// ---- 运行期阻止系统休眠（7.3）：有活跃任务时挂起系统睡眠锁 ----

function updateSleepLock() {
  const hasActive = getDb().prepare(
    `SELECT COUNT(*) AS n FROM tasks WHERE status IN (${ACTIVE_STATES.map(() => '?').join(',')})`
  ).get(...ACTIVE_STATES).n > 0;
  if (hasActive && !sleeperProc && process.platform === 'win32') {
    // SetThreadExecutionState(ES_CONTINUOUS|ES_SYSTEM_REQUIRED|ES_DISPLAY_REQUIRED) = 0x80000003
    sleeperProc = spawn('powershell', [
      '-NoProfile', '-Command',
      'Add-Type -Namespace Win32 -Name Power -MemberDefinition "[DllImport(\\"kernel32.dll\\")] public static extern uint SetThreadExecutionState(uint state);"; while($true){ [Win32.Power]::SetThreadExecutionState(2147483651); Start-Sleep -Seconds 60 }',
    ], { stdio: 'ignore', detached: false });
    sleeperProc.on('exit', () => { sleeperProc = null; });
    log.info('engine', '存在活跃任务，已阻止系统休眠');
  } else if (!hasActive && sleeperProc) {
    releaseSleepLock();
  }
}

function releaseSleepLock() {
  if (sleeperProc) {
    try { sleeperProc.kill(); } catch { /* 忽略 */ }
    sleeperProc = null;
    log.info('engine', '无活跃任务，已解除休眠阻止');
  }
}
