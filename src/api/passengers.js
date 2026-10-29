import { Router } from 'express';
import { getDb, nowIso } from '../db/database.js';
import { encrypt, decrypt, hashId } from '../db/crypto.js';
import { validateIdCard, normalizeIdCard } from '../utils/idcard.js';
import { log } from '../logger.js';

/**
 * 乘车人档案（FR-02）：
 * - 姓名 + 证件号必填；证件号格式与校验位校验，不合格拒绝保存；
 * - 同一证件号唯一；界面脱敏展示；日志不落原文（6.5）；
 * - 被 ARMED 任务引用的乘车人不可删除。
 */

export const passengersApi = Router();

/** 脱敏：姓名保留姓，证件号只露后四位 */
function mask(row) {
  const name = row.name;
  const maskedName = name.length <= 1 ? name : name[0] + '*'.repeat(name.length - 1);
  return {
    id: row.id,
    name,              // 档案管理界面用真实姓名；通知/日志侧不得携带（FR-10/6.5）
    idType: row.id_type,
    idMasked: `**************${row.id_last4}`,
    verified: !!row.verified,
    isDefault: !!row.is_default,
    createdAt: row.created_at,
  };
}

passengersApi.get('/', (_req, res) => {
  const rows = getDb().prepare('SELECT * FROM passengers ORDER BY is_default DESC, id').all();
  res.json(rows.map(mask));
});

passengersApi.post('/', (req, res) => {
  const { name, idNumber, idType = '身份证', isDefault = false } = req.body ?? {};
  if (!name || typeof name !== 'string') return res.status(400).json({ error: '姓名必填' });

  const id = normalizeIdCard(idNumber);
  const err = validateIdCard(id);
  if (err) return res.status(400).json({ error: `证件号不合法：${err}` });

  const db = getDb();
  const hash = hashId(id);
  const dup = db.prepare('SELECT id FROM passengers WHERE id_number_hash = ?').get(hash);
  if (dup) return res.status(409).json({ error: '该证件号已存在，如需修改请直接编辑', id: dup.id });

  // 6.5：原文只以密文入库；哈希用于唯一约束与下单精确匹配
  const now = nowIso();
  const info = db.prepare(
    `INSERT INTO passengers (name, id_type, id_number_enc, id_number_hash, id_last4, verified, is_default, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, 0, ?, ?, ?)`
  ).run(name.trim(), idType, encrypt(id), hash, id.slice(-4), isDefault ? 1 : 0, now, now);

  log.info('passengers', '新增乘车人', { id: info.lastInsertRowid, idLast4: id.slice(-4) });
  res.json({ ok: true, id: info.lastInsertRowid });
});

passengersApi.put('/:id', (req, res) => {
  const db = getDb();
  const row = db.prepare('SELECT * FROM passengers WHERE id = ?').get(req.params.id);
  if (!row) return res.status(404).json({ error: '乘车人不存在' });

  const { name, idNumber, isDefault } = req.body ?? {};
  const newName = name !== undefined ? String(name).trim() : row.name;
  if (!newName) return res.status(400).json({ error: '姓名不能为空' });

  let idEnc = row.id_number_enc;
  let hash = row.id_number_hash;
  let last4 = row.id_last4;

  if (idNumber !== undefined) {
    const id = normalizeIdCard(idNumber);
    const err = validateIdCard(id);
    if (err) return res.status(400).json({ error: `证件号不合法：${err}` });
    hash = hashId(id);
    const dup = db.prepare('SELECT id FROM passengers WHERE id_number_hash = ? AND id != ?').get(hash, row.id);
    if (dup) return res.status(409).json({ error: '该证件号已存在' });
    idEnc = encrypt(id);
    last4 = id.slice(-4);
  }

  db.prepare(
    `UPDATE passengers SET name = ?, id_number_enc = ?, id_number_hash = ?, id_last4 = ?, is_default = ?, updated_at = ? WHERE id = ?`
  ).run(newName, idEnc, hash, last4, isDefault !== undefined ? (isDefault ? 1 : 0) : row.is_default, nowIso(), row.id);

  log.info('passengers', '修改乘车人', { id: row.id, idLast4: last4 });
  res.json({ ok: true });
});

/** 标记/取消「已核验」（FR-02：未核验者不能被任务选中）。
 *  程序无法替用户确认平台实名状态，由用户在 12306 官方 App 核实后手动标记。 */
passengersApi.post('/:id/verify', (req, res) => {
  const db = getDb();
  const row = db.prepare('SELECT id FROM passengers WHERE id = ?').get(req.params.id);
  if (!row) return res.status(404).json({ error: '乘车人不存在' });
  const verified = req.body?.verified ? 1 : 0;
  db.prepare('UPDATE passengers SET verified = ?, updated_at = ? WHERE id = ?').run(verified, nowIso(), row.id);
  log.info('passengers', '更新核验标记', { id: row.id, verified: !!verified });
  res.json({ ok: true, verified: !!verified });
});

passengersApi.delete('/:id', (req, res) => {
  const db = getDb();
  const id = Number(req.params.id);
  // 被 ARMED/RUNNING/WAITING 任务引用的乘车人不可删除（FR-02）
  const ref = db.prepare(
    `SELECT id, name FROM tasks WHERE status IN ('ARMED','RUNNING','WAITING') AND EXISTS (
       SELECT 1 FROM json_each(tasks.passenger_ids) WHERE json_each.value = ?)`
  ).get(id);
  if (ref) {
    return res.status(409).json({ error: `该乘车人被武装中任务「${ref.name}」引用，请先解除引用` });
  }
  const info = db.prepare('DELETE FROM passengers WHERE id = ?').run(id);
  if (info.changes === 0) return res.status(404).json({ error: '乘车人不存在' });
  log.info('passengers', '删除乘车人', { id });
  res.json({ ok: true });
});
