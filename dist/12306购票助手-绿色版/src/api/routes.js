import { Router } from 'express';
import { getDb, nowIso } from '../db/database.js';
import * as session from '../session/manager.js';
import { passengersApi } from './passengers.js';
import { ticketsApi } from './tickets.js';
import { tasksApi } from './tasks.js';
import { ordersApi } from './orders.js';
import { LOG_DIR } from '../config.js';
import fs from 'node:fs';
import path from 'node:path';
import { log } from '../logger.js';

/**
 * 本地 REST API（7.5 契约）。
 * session / passengers / tickets / tasks / orders 已接入（步骤 2-6）。
 */

export const api = Router();
api.use('/passengers', passengersApi); // /api/passengers
api.use(ticketsApi);                   // /api/stations, /api/tickets
api.use('/tasks', tasksApi);           // /api/tasks
api.use('/orders', ordersApi);         // /api/orders

// ---- 健康检查 ----
api.get('/health', (_req, res) => {
  res.json({ ok: true, ts: nowIso() });
});

// ---- 会话（FR-01） ----
api.get('/session', (_req, res) => {
  const s = session.getStatus();
  res.json({ status: s.status, lastCheckedAt: s.lastCheckedAt, username: s.username });
});

// 生成登录二维码
api.post('/session/qrcode', async (_req, res) => {
  const r = await session.startQrLogin();
  if (!r.ok) return res.status(502).json({ error: r.reason });
  res.json({ ok: true, image: r.image });
});

// 轮询扫码进度
api.get('/session/qrcode', async (_req, res) => {
  const r = await session.pollQrLogin();
  res.json(r);
});

// 主动校验登录态
api.post('/session/validate', async (_req, res) => {
  res.json(await session.validateSession());
});

// 登出（清空本机凭证）
api.post('/session/logout', (_req, res) => {
  session.logout();
  res.json({ ok: true });
});

// ---- 日志查询（FR-11 日志页）：最近 N 行，敏感字段日志侧已保证不落原文 ----
api.get('/logs', (req, res) => {
  const n = Math.min(1000, Number(req.query.n) || 200);
  try {
    const files = fs.existsSync(LOG_DIR)
      ? fs.readdirSync(LOG_DIR).filter((f) => f.endsWith('.log')).sort().slice(-2)
      : [];
    let lines = [];
    for (const f of files) {
      const content = fs.readFileSync(path.join(LOG_DIR, f), 'utf8').trimEnd();
      lines = lines.concat(content.split('\n').slice(-n));
    }
    res.json(lines.slice(-n).map((l) => { try { return JSON.parse(l); } catch { return { raw: l }; } }));
  } catch (e) {
    res.json([]);
  }
});

// ---- 清空全部数据（6.5：一键删除会话、乘车人与日志；含其派生数据任务/订单） ----
api.post('/purge', (req, res) => {
  if (req.body?.confirm !== 'DELETE') return res.status(400).json({ error: '缺少确认参数' });
  const db = getDb();
  for (const table of ['task_events', 'orders', 'notifications', 'tasks', 'passengers']) {
    db.prepare(`DELETE FROM ${table}`).run();
  }
  session.logout();
  try {
    if (fs.existsSync(LOG_DIR)) fs.rmSync(LOG_DIR, { recursive: true, force: true });
  } catch { /* 日志文件被占用时跳过，下次启动清理 */ }
  log.warn('purge', '已执行清空全部数据');
  res.json({ ok: true });
});

// ---- 设置（提前量等，FR-11） ----
api.get('/settings', (_req, res) => {
  const rows = getDb().prepare('SELECT key, value FROM settings').all();
  const map = Object.fromEntries(rows.map((r) => [r.key, r.value]));
  res.json({
    advanceSeconds: num(map.advance_seconds),
    retryInterval: num(map.retry_interval) ?? 5,
    lanAccess: map.lan_access === 'true',
    accessPassword: map.access_password ?? '',
    uabCollina: map.uab_collina ?? '',
  });
});

api.put('/settings', (req, res) => {
  const body = req.body ?? {};
  const pairs = [];
  if (body.advanceSeconds !== undefined) {
    // 提前量：秒，支持毫秒级小数（FR-11 / 6.1）
    const v = Number(body.advanceSeconds);
    if (!Number.isFinite(v) || v < 0) return res.status(400).json({ error: '提前量必须为非负数字（秒）' });
    pairs.push(['advance_seconds', String(v)]);
  }
  if (body.retryInterval !== undefined) pairs.push(['retry_interval', String(Number(body.retryInterval) || 5)]);
  if (body.accessPassword !== undefined) pairs.push(['access_password', String(body.accessPassword)]);
  if (body.uabCollina !== undefined) pairs.push(['uab_collina', String(body.uabCollina).trim()]);
  if (body.lanAccess !== undefined) {
    // 强制口令：开启局域网访问前必须已设置访问口令（FR-11 / 7.3）
    const pwd = body.accessPassword !== undefined ? String(body.accessPassword) : currentSetting('access_password');
    if (body.lanAccess === true && !pwd) {
      return res.status(400).json({ error: '开启手机访问前必须先设置访问口令' });
    }
    pairs.push(['lan_access', String(Boolean(body.lanAccess))]);
    if (body.lanAccess === true) {
      log.info('settings', '已开启局域网访问，需重启服务使监听地址生效');
    }
  }

  const db = getDb();
  const stmt = db.prepare('INSERT INTO settings (key, value, updated_at) VALUES (?, ?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at');
  for (const [k, v] of pairs) stmt.run(k, v, nowIso());
  res.json({ ok: true });
});

function currentSetting(key) {
  return getDb().prepare('SELECT value FROM settings WHERE key = ?').get(key)?.value ?? '';
}

function num(v) {
  if (v === undefined || v === null || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}
