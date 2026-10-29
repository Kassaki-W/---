import { Router } from 'express';
import { queryLeftTicket } from '../platform/tickets.js';
import { searchStations } from '../platform/stations.js';
import { log } from '../logger.js';

/**
 * 只读链路 API：车站搜索 + 余票查询（FR-05）。
 * 查询失败原样返回原因，不做静默重试（重试策略属于任务引擎，步骤 4/5）。
 */

export const ticketsApi = Router();

ticketsApi.get('/stations', async (req, res) => {
  try {
    res.json(await searchStations(String(req.query.q ?? '')));
  } catch (e) {
    log.error('tickets', '车站表加载失败', { error: String(e) });
    res.status(502).json({ error: `车站表加载失败：${e.message}` });
  }
});

ticketsApi.get('/tickets', async (req, res) => {
  const { date, from, to } = req.query;
  if (!date || !from || !to) return res.status(400).json({ error: 'date / from / to 均必填' });
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(date))) return res.status(400).json({ error: '日期格式须为 YYYY-MM-DD' });
  try {
    const list = await queryLeftTicket({ date, fromStation: String(from), toStation: String(to) });
    res.json({ ok: true, list });
  } catch (e) {
    log.warn('tickets', '余票查询失败', { error: String(e), from, to, date });
    res.status(502).json({ error: `余票查询失败：${e.message}` });
  }
});
