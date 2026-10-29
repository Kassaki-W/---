import fs from 'node:fs';
import path from 'node:path';
import { LOG_DIR } from './config.js';

/**
 * 按天切分的本地日志（FR-10 / 6.5）。
 * 规则：日志不落身份证号原文，只允许后四位或哈希（由调用方保证）。
 */

let currentDate = null;
let stream = null;

function today() {
  return new Date().toISOString().slice(0, 10);
}

function getStream() {
  const d = today();
  if (stream && currentDate === d) return stream;
  if (stream) stream.end();
  fs.mkdirSync(LOG_DIR, { recursive: true });
  currentDate = d;
  stream = fs.createWriteStream(path.join(LOG_DIR, `app-${d}.log`), { flags: 'a' });
  return stream;
}

function write(level, module, message, extra) {
  const line = JSON.stringify({
    ts: new Date().toISOString(),
    level,
    module,
    message,
    ...(extra !== undefined ? { extra } : {}),
  });
  getStream().write(line + '\n');
  // 控制台同步可见，便于开发期观察
  const tag = extra !== undefined ? ` ${JSON.stringify(extra)}` : '';
  console.log(`[${level}] ${new Date().toLocaleString()} ${module} ${message}${tag}`);
}

export const log = {
  info: (module, message, extra) => write('info', module, message, extra),
  warn: (module, message, extra) => write('warn', module, message, extra),
  error: (module, message, extra) => write('error', module, message, extra),
};
