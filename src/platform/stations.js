import fs from 'node:fs';
import { DATA_DIR } from '../config.js';
import { log } from '../logger.js';

/**
 * 车站名 → 电报码（平台访问层的一部分）。
 * 12306 官方车站表 station_name.js 拉取一次后缓存到本机 data/stations.json，
 * 后续查询不再依赖该文件在线可用。
 */

const CACHE_PATH = `${DATA_DIR}/stations.json`;
const SOURCE_URL = 'https://kyfw.12306.cn/otn/resources/js/framework/station_name.js';

let stations = null; // { name -> telecode }

async function loadStations() {
  if (stations) return stations;
  if (fs.existsSync(CACHE_PATH)) {
    try {
      stations = JSON.parse(fs.readFileSync(CACHE_PATH, 'utf8'));
      return stations;
    } catch { /* 缓存损坏则重新拉取 */ }
  }

  const res = await fetch(SOURCE_URL, {
    headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36' },
  });
  const text = await res.text();
  // 格式：@bjb|北京北|VAP|beijingbei|bjb|0|... 每条以 | 分隔：拼音简写|站名|电报码|拼音|...
  const map = {};
  for (const m of text.matchAll(/@([a-z]+)\|([^|]+)\|([A-Z]+)\|/g)) {
    map[m[2]] = m[3];
  }
  if (Object.keys(map).length < 100) throw new Error(`车站表解析异常，仅解析到 ${Object.keys(map).length} 条`);
  fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.writeFileSync(CACHE_PATH, JSON.stringify(map), 'utf8');
  stations = map;
  log.info('stations', '车站表已拉取并缓存', { count: Object.keys(map).length });
  return stations;
}

/** 按名称/拼音模糊搜索车站（站名 + 城市提示，FR-03 字段表） */
export async function searchStations(q) {
  const all = await loadStations();
  const list = Object.keys(all);
  if (!q) return list.slice(0, 30).map((name) => ({ name, code: all[name] }));
  const needle = q.toLowerCase();
  return list.filter((name) => name.includes(needle)).slice(0, 30)
    .map((name) => ({ name, code: all[name] }));
}

/** 精确解析车站电报码；不认识即拒绝（FR-03：必须为平台可识别的车站） */
export async function telecode(name) {
  const all = await loadStations();
  const code = all[name];
  if (!code) throw new Error(`无法识别车站「${name}」，请从下拉列表中选择`);
  return code;
}
