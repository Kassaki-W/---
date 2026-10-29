import { getDb, nowIso } from '../db/database.js';
import { onTaskTransition } from '../notify/index.js';
import { log } from '../logger.js';

/**
 * 任务状态机（3.2）：全部跃迁以白名单校验，每次跃迁写入 task_events 流水。
 * 终态：PAID / EXPIRED / CANCELLED。只有 PAID 由人工支付动作触发（FR-08）。
 */

export const TaskState = {
  DRAFT: 'DRAFT',
  ARMED: 'ARMED',
  RUNNING: 'RUNNING',
  SUBMITTED: 'SUBMITTED',
  NO_TICKET: 'NO_TICKET',
  FAILED: 'FAILED',
  WAITING: 'WAITING',
  QUEUED: 'QUEUED',
  PENDING_PAYMENT: 'PENDING_PAYMENT',
  PAID: 'PAID',
  EXPIRED: 'EXPIRED',
  CANCELLED: 'CANCELLED',
};

// 允许的跃迁（对应方案 3.2 的状态图）
export const TRANSITIONS = {
  DRAFT: ['ARMED'],
  ARMED: ['RUNNING', 'CANCELLED'],
  RUNNING: ['SUBMITTED', 'NO_TICKET', 'FAILED', 'CANCELLED'],
  NO_TICKET: ['WAITING'],
  WAITING: ['RUNNING'],
  SUBMITTED: ['QUEUED', 'FAILED'],
  QUEUED: ['PENDING_PAYMENT', 'FAILED'],
  PENDING_PAYMENT: ['PAID', 'EXPIRED'],
  FAILED: ['WAITING'],
  // PAID / EXPIRED / CANCELLED 为终态
};

/** 生命周期中的活跃态：处于这些状态的任务被调度引擎与休眠阻止逻辑关注 */
export const ACTIVE_STATES = [TaskState.ARMED, TaskState.RUNNING, TaskState.WAITING];

/**
 * 执行一次状态跃迁。非法跃迁抛错；成功则更新任务状态并写流水。
 */
export function transition(taskId, to, reason = null) {
  const db = getDb();
  const task = db.prepare('SELECT id, status, name FROM tasks WHERE id = ?').get(taskId);
  if (!task) throw new Error(`任务 ${taskId} 不存在`);
  const from = task.status;
  if (from === to) return task;
  const allowed = TRANSITIONS[from] ?? [];
  if (!allowed.includes(to)) {
    throw new Error(`非法状态跃迁：${from} → ${to}（任务 ${taskId}「${task.name}」）`);
  }
  const now = nowIso();
  db.prepare('UPDATE tasks SET status = ?, updated_at = ? WHERE id = ?').run(to, now, taskId);
  db.prepare('INSERT INTO task_events (task_id, from_status, to_status, reason, created_at) VALUES (?, ?, ?, ?, ?)')
    .run(taskId, from, to, reason, now);
  log.info('state', `任务「${task.name}」状态跃迁`, { taskId, from, to, reason: reason ?? undefined });
  onTaskTransition(taskId, to, reason); // 关键跃迁推送（FR-10），失败不阻断
  return { ...task, status: to };
}

/** 事件流水 */
export function events(taskId) {
  return getDb().prepare(
    'SELECT id, from_status, to_status, reason, created_at FROM task_events WHERE task_id = ? ORDER BY id DESC LIMIT 200'
  ).all(taskId);
}
