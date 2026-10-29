import { Router } from 'express';
import { getDb, nowIso } from '../db/database.js';
import { telecode } from '../platform/stations.js';
import { queryLeftTicket } from '../platform/tickets.js';
import { TaskState, transition, events as taskEvents } from '../scheduler/stateMachine.js';
import { cancelTask } from '../scheduler/engine.js';
import * as session from '../session/manager.js';
import { getSettingNum } from '../settings.js';
import { log } from '../logger.js';

/**
 * 抢票任务（FR-03 / FR-04 / FR-11 武装前置校验）。
 * 创建时做字段级校验并用一次真实余票查询验证候选车次存在性与时间窗。
 */

export const tasksApi = Router();

const SEAT_NAMES = ['商务座', '一等座', '二等座', '高级软卧', '软卧', '动卧', '硬卧', '软座', '硬座', '无座'];
const PRESALE_DAYS = 15;

function bad(res, msg) {
  return res.status(400).json({ error: msg });
}

tasksApi.get('/', (_req, res) => {
  const rows = getDb().prepare('SELECT * FROM tasks ORDER BY start_time, id').all();
  res.json(rows.map((t) => ({
    ...t,
    train_codes: JSON.parse(t.train_codes),
    seat_prefs: JSON.parse(t.seat_prefs),
    passenger_ids: JSON.parse(t.passenger_ids),
  })));
});

tasksApi.get('/:id/events', (req, res) => {
  res.json(taskEvents(Number(req.params.id)));
});

tasksApi.post('/', async (req, res) => {
  const body = req.body ?? {};
  try {
    // ---- 字段表逐项校验（FR-03）----
    if (!body.name || !String(body.name).trim()) return bad(res, '任务名必填');
    const fromStation = String(body.fromStation ?? '').trim();
    const toStation = String(body.toStation ?? '').trim();
    if (!fromStation || !toStation) return bad(res, '出发站与到达站必填');
    if (fromStation === toStation) return bad(res, '到达站不得与出发站相同');
    const fromCode = await telecode(fromStation).catch(() => null);
    const toCode = await telecode(toStation).catch(() => null);
    if (!fromCode) return bad(res, `无法识别出发站「${fromStation}」`);
    if (!toCode) return bad(res, `无法识别到达站「${toStation}」`);

    const rideDate = String(body.rideDate ?? '');
    if (!/^\d{4}-\d{2}-\d{2}$/.test(rideDate)) return bad(res, '乘车日期格式须为 YYYY-MM-DD');
    const maxDate = new Date(Date.now() + PRESALE_DAYS * 86400_000).toISOString().slice(0, 10);
    if (rideDate < new Date().toISOString().slice(0, 10)) return bad(res, '乘车日期不能早于今天');
    if (rideDate > maxDate) return bad(res, `乘车日期超出预售期（最长 ${maxDate}）`);

    const trainCodes = Array.isArray(body.trainCodes) ? body.trainCodes.map(String) : [];
    if (!trainCodes.length) return bad(res, '候选车次至少一条');
    if (new Set(trainCodes).size !== trainCodes.length) return bad(res, '候选车次有重复项');

    const seatPrefs = Array.isArray(body.seatPrefs) ? body.seatPrefs.map(String) : [];
    if (!seatPrefs.length) return bad(res, '席别优先级至少一项');
    if (seatPrefs.some((s) => !SEAT_NAMES.includes(s))) return bad(res, `席别仅支持：${SEAT_NAMES.join('/')}`);
    if (new Set(seatPrefs).size !== seatPrefs.length) return bad(res, '席别优先级有重复项');

    const passengerIds = Array.isArray(body.passengerIds) ? body.passengerIds.map(Number) : [];
    if (!passengerIds.length) return bad(res, '乘车人至少选择一人');
    const db = getDb();
    for (const pid of passengerIds) {
      if (!db.prepare('SELECT id FROM passengers WHERE id = ?').get(pid)) {
        return bad(res, `乘车人 #${pid} 不存在`);
      }
    }

    const startTime = String(body.startTime ?? '').trim();
    if (!/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(startTime)) return bad(res, '开抢时刻格式须为 YYYY-MM-DD HH:MM:SS');
    if (new Date(startTime.replace(' ', 'T') + '+08:00').getTime() <= Date.now()) {
      return bad(res, '开抢时刻不得早于当前时刻');
    }

    const acceptNoSeat = Boolean(body.acceptNoSeat);

    // ---- 候选车次存在性验证：一次真实余票查询（FR-03 例外条款）----
    const list = await queryLeftTicket({ date: rideDate, fromStation, toStation });
    const byCode = new Map(list.map((t) => [t.trainCode, t]));
    for (const code of trainCodes) {
      if (!byCode.has(code)) return bad(res, `候选车次「${code}」在 ${rideDate} ${fromStation}→${toStation} 不存在`);
    }
    // 时间窗：候选车次中最早发车时刻；无数据则当日 23:59（6.4 超窗统一 EXPIRED）
    const departTimes = trainCodes.map((c) => byCode.get(c).fromTime).filter(Boolean).sort();
    const windowEnd = `${rideDate} ${departTimes[0] ?? '23:59:59'}`;

    const now = nowIso();
    const info = db.prepare(
      `INSERT INTO tasks (name, from_station, from_station_code, to_station, to_station_code, ride_date,
        train_codes, seat_prefs, accept_no_seat, passenger_ids, start_time, retry_policy, time_window_end,
        status, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'continuous', ?, 'DRAFT', ?, ?)`
    ).run(
      String(body.name).trim(), fromStation, fromCode, toStation, toCode, rideDate,
      JSON.stringify(trainCodes), JSON.stringify(seatPrefs), acceptNoSeat ? 1 : 0,
      JSON.stringify(passengerIds), startTime, windowEnd, now, now
    );
    log.info('tasks', '任务已创建', { taskId: info.lastInsertRowid, name: body.name, windowEnd });
    res.json({ ok: true, id: info.lastInsertRowid, windowEnd });
  } catch (e) {
    log.error('tasks', '任务创建失败', { error: String(e) });
    res.status(502).json({ error: `创建失败：${e.message}` });
  }
});

/** 武装（FR-03：校验全通过 → ARMED；FR-11 前置校验） */
tasksApi.post('/:id/arm', (req, res) => {
  const db = getDb();
  const task = db.prepare('SELECT * FROM tasks WHERE id = ?').get(req.params.id);
  if (!task) return res.status(404).json({ error: '任务不存在' });
  if (task.status !== TaskState.DRAFT) return bad(res, `仅 DRAFT 状态可武装（当前 ${task.status}）`);

  // 前置校验 1：会话有效（FR-01 例外）
  if (session.getStatus().status !== 'valid') {
    return bad(res, '未登录或会话失效，请先在「登录 / 会话」页扫码登录');
  }
  // 前置校验 2：提前量已填写（FR-11 例外）
  if (getSettingNum('advance_seconds') === null) {
    return bad(res, '提前量未设置，请先到「设置」页填写');
  }
  // 前置校验 3：乘车人须已核验（FR-02 / FR-03 字段表）
  const passengerIds = JSON.parse(task.passenger_ids);
  for (const pid of passengerIds) {
    const p = db.prepare('SELECT id, verified FROM passengers WHERE id = ?').get(pid);
    if (!p) return bad(res, `乘车人 #${pid} 已不存在`);
    if (!p.verified) return bad(res, `乘车人 #${pid} 未标记已核验，无法武装`);
  }

  try {
    transition(task.id, TaskState.ARMED, '校验通过，等待开抢时刻');
    res.json({ ok: true });
  } catch (e) {
    bad(res, e.message);
  }
});

/** 取消 / 手动停止 */
tasksApi.post('/:id/cancel', (req, res) => {
  const db = getDb();
  const task = db.prepare('SELECT id, status, name FROM tasks WHERE id = ?').get(req.params.id);
  if (!task) return res.status(404).json({ error: '任务不存在' });
  const cancellable = [TaskState.DRAFT, TaskState.ARMED, TaskState.RUNNING];
  if (!cancellable.includes(task.status)) {
    return bad(res, `当前状态 ${task.status} 不可取消`);
  }
  try {
    transition(task.id, TaskState.CANCELLED, '用户手动取消');
    cancelTask(task.id); // 若在跑，通知引擎中止
    res.json({ ok: true });
  } catch (e) {
    bad(res, e.message);
  }
});

/** 标记已支付（人工在官方页面完成支付后确认，FR-08：程序不参与支付输入） */
tasksApi.post('/:id/paid', (req, res) => {
  const db = getDb();
  const task = db.prepare('SELECT id, status FROM tasks WHERE id = ?').get(req.params.id);
  if (!task) return res.status(404).json({ error: '任务不存在' });
  if (task.status !== TaskState.PENDING_PAYMENT) return bad(res, `仅待支付状态可确认支付（当前 ${task.status}）`);
  try {
    transition(task.id, TaskState.PAID, '用户确认已支付');
    res.json({ ok: true });
  } catch (e) {
    bad(res, e.message);
  }
});
