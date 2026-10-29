import { Router } from 'express';
import { getDb, nowIso } from '../db/database.js';
import { paymentPageUrl } from '../platform/submit.js';
import { transition } from '../scheduler/stateMachine.js';

/**
 * 订单（FR-08 支付闭环）：只做展示、跳转官方支付页与人工状态确认。
 * 程序不参与任何支付输入（2.3 红线）。
 */

export const ordersApi = Router();

ordersApi.get('/', (req, res) => {
  const db = getDb();
  const status = req.query.status;
  const rows = (status
    ? db.prepare('SELECT * FROM orders WHERE status = ? ORDER BY id DESC').all(String(status))
    : db.prepare('SELECT * FROM orders ORDER BY id DESC LIMIT 200').all());
  res.json(rows.map((o) => ({ ...o, paymentUrl: o.status === 'pending' ? paymentPageUrl(o.id) : null })));
});

/** 确认订单已支付 / 已取消（人工在官方页面操作后回填状态） */
ordersApi.post('/:id/status', (req, res) => {
  const status = String(req.body?.status ?? '');
  if (!['paid', 'cancelled'].includes(status)) {
    return res.status(400).json({ error: "status 仅支持 'paid' / 'cancelled'" });
  }
  const db = getDb();
  const order = db.prepare('SELECT * FROM orders WHERE id = ?').get(req.params.id);
  if (!order) return res.status(404).json({ error: '订单不存在' });
  db.prepare('UPDATE orders SET status = ?, updated_at = ? WHERE id = ?').run(status, nowIso(), order.id);

  // 订单状态同步回任务状态机（PENDING_PAYMENT → PAID / EXPIRED）
  if (order.task_id && order.status === 'pending') {
    const task = db.prepare('SELECT id, status FROM tasks WHERE id = ?').get(order.task_id);
    if (task?.status === 'PENDING_PAYMENT') {
      try {
        transition(task.id, status === 'paid' ? 'PAID' : 'EXPIRED', `订单人工确认为 ${status}`);
      } catch { /* 任务可能已被其它路径流转 */ }
    }
  }
  res.json({ ok: true });
});
