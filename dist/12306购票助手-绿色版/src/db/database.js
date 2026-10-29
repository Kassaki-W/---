import fs from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { DB_PATH, DATA_DIR } from '../config.js';
import { log } from '../logger.js';

/**
 * 本地 SQLite（7.4 数据模型）。
 * 单机单用户，同步 API 足够；敏感字段在写入前由调用方加密。
 */

let db = null;

const SCHEMA = `
-- 登录会话（FR-01）
CREATE TABLE IF NOT EXISTS sessions (
  id INTEGER PRIMARY KEY CHECK (id = 1),        -- 单用户，单行
  status TEXT NOT NULL DEFAULT 'invalid',       -- valid / invalid
  credential_enc TEXT,                          -- 加密后的凭证
  last_checked_at TEXT,
  updated_at TEXT NOT NULL
);

-- 乘车人档案（FR-02）
CREATE TABLE IF NOT EXISTS passengers (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  id_type TEXT NOT NULL DEFAULT '身份证',
  id_number_enc TEXT NOT NULL,                  -- 加密存储
  id_number_hash TEXT NOT NULL UNIQUE,          -- HMAC，用于唯一约束与精确匹配
  id_last4 TEXT NOT NULL,                       -- 脱敏展示用后四位
  verified INTEGER NOT NULL DEFAULT 0,          -- 是否已通过平台实名核验
  is_default INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

-- 抢票任务（FR-03 / 3.2 状态机）
CREATE TABLE IF NOT EXISTS tasks (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  from_station TEXT NOT NULL,
  from_station_code TEXT,
  to_station TEXT NOT NULL,
  to_station_code TEXT,
  ride_date TEXT NOT NULL,                      -- YYYY-MM-DD
  train_codes TEXT NOT NULL,                    -- JSON 有序数组（FR-09）
  seat_prefs TEXT NOT NULL,                     -- JSON 有序席别数组
  accept_no_seat INTEGER NOT NULL DEFAULT 0,
  passenger_ids TEXT NOT NULL,                  -- JSON 数组
  start_time TEXT NOT NULL,                     -- 开抢时刻 YYYY-MM-DD HH:MM:SS
  retry_policy TEXT NOT NULL DEFAULT 'continuous',
  time_window_end TEXT,                         -- 时间窗结束（通常发车时刻）
  status TEXT NOT NULL DEFAULT 'DRAFT',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

-- 状态跃迁流水
CREATE TABLE IF NOT EXISTS task_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  task_id INTEGER NOT NULL REFERENCES tasks(id),
  from_status TEXT,
  to_status TEXT NOT NULL,
  reason TEXT,
  created_at TEXT NOT NULL
);

-- 订单
CREATE TABLE IF NOT EXISTS orders (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  task_id INTEGER NOT NULL REFERENCES tasks(id),
  order_no TEXT,
  train_code TEXT,
  seat_type TEXT,
  amount TEXT,
  status TEXT NOT NULL DEFAULT 'pending',       -- pending / paid / expired / cancelled
  pay_deadline TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

-- 通知记录（FR-10）
CREATE TABLE IF NOT EXISTS notifications (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  task_id INTEGER,
  channel TEXT NOT NULL,
  event TEXT NOT NULL,
  content TEXT NOT NULL,
  result TEXT NOT NULL,
  created_at TEXT NOT NULL
);

-- 全局设置（提前量、重试间隔、通知配置、访问口令等）
CREATE TABLE IF NOT EXISTS settings (
  key TEXT PRIMARY KEY,
  value TEXT,
  updated_at TEXT NOT NULL
);
`;

export function getDb() {
  if (db) return db;
  fs.mkdirSync(DATA_DIR, { recursive: true });
  db = new DatabaseSync(DB_PATH);
  db.exec('PRAGMA journal_mode = WAL;');
  db.exec(SCHEMA);
  // 初始化单行会话记录
  const now = new Date().toISOString();
  db.prepare(
    `INSERT OR IGNORE INTO sessions (id, status, updated_at) VALUES (1, 'invalid', ?)`
  ).run(now);
  log.info('db', '数据库已就绪', { path: DB_PATH });
  return db;
}

export function nowIso() {
  return new Date().toISOString();
}
