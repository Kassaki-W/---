import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/** 项目根目录 */
export const ROOT_DIR = path.resolve(__dirname, '..');

/** 运行时数据目录（数据库、日志） */
export const DATA_DIR = path.join(ROOT_DIR, 'data');
export const DB_PATH = path.join(DATA_DIR, 'app.db');
export const LOG_DIR = path.join(DATA_DIR, 'logs');

/** 静态控制台目录 */
export const WEB_DIR = path.join(ROOT_DIR, 'web');

/** 服务默认只监听本机回环地址；「允许手机访问」开启后改为 0.0.0.0（FR-11） */
export const DEFAULT_HOST = '127.0.0.1';
export const DEFAULT_PORT = 12306;

/** 敏感字段加密密钥文件（首次启动自动生成，不出本机） */
export const KEY_PATH = path.join(DATA_DIR, 'secret.key');
