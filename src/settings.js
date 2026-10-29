import { getDb } from './db/database.js';

/** 读取设置项的数字值；不存在或非法返回 null */
export function getSettingNum(key) {
  const row = getDb().prepare('SELECT value FROM settings WHERE key = ?').get(key);
  if (!row?.value) return null;
  const n = Number(row.value);
  return Number.isFinite(n) ? n : null;
}

/** 读取设置项的字符串值；不存在返回 null */
export function getSettingStr(key) {
  const row = getDb().prepare('SELECT value FROM settings WHERE key = ?').get(key);
  return row?.value ?? null;
}
