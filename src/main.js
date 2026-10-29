import express from 'express';
import { spawn } from 'node:child_process';
import { api } from './api/routes.js';
import { getDb } from './db/database.js';
import { startEngine } from './scheduler/engine.js';
import { WEB_DIR, DEFAULT_HOST, DEFAULT_PORT } from './config.js';
import { log } from './logger.js';

/**
 * 入口：启动本地 Web 服务（7.1 总体架构）。
 * 默认只监听 127.0.0.1；「允许手机访问」开启后监听 0.0.0.0 并要求访问口令（FR-11）。
 */

const host = process.env.HOST || DEFAULT_HOST;
const port = Number(process.env.PORT) || DEFAULT_PORT;

const app = express();
app.use(express.json());
app.use(express.static(WEB_DIR));
app.use('/api', api);

// 启动数据库（建表）与调度引擎（时钟校准 + 任务定时）
getDb();
startEngine();

app.listen(port, host, () => {
  log.info('main', `服务已启动`, { url: `http://${host}:${port}` });
  openBrowser(`http://127.0.0.1:${port}`);
});

/** 双击启动场景下自动打开浏览器（7.2 打包要求） */
function openBrowser(url) {
  if (process.env.NO_BROWSER) return;
  const cmd = process.platform === 'win32' ? 'cmd' : 'open';
  const args = process.platform === 'win32' ? ['/c', 'start', '', url] : [url];
  try {
    spawn(cmd, args, { detached: true, stdio: 'ignore' }).unref();
  } catch (e) {
    log.warn('main', '自动打开浏览器失败，请手动访问', { url, error: String(e) });
  }
}
