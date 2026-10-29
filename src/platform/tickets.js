import { CookieJar, Client12306 } from './client.js';
import { telecode } from './stations.js';
import { log } from '../logger.js';

/**
 * 余票查询（FR-05，只读链路）。
 * 接口路径平台会调整（7.3「接口易变」）：尝试多个已知路径，全部收敛在本文件。
 */

const QUERY_PATHS = ['/otn/leftTicket/query', '/otn/leftTicket/queryZ', '/otn/leftTicket/queryG', '/otn/leftTicket/queryA'];

// 席别在结果串中的分隔位置（12306 leftTicket 查询结果的公开约定）
const SEAT_INDEX = {
  商务座: 32,
  一等座: 31,
  二等座: 30,
  高级软卧: 21,
  软卧: 23,
  动卧: 33,
  硬卧: 28,
  软座: 24,
  硬座: 29,
  无座: 26,
};

let queryClient = null;

/** 查询前先访问一次余票页，取得必要的会话 Cookie */
async function ensureClient() {
  if (queryClient) return queryClient;
  const client = new Client12306();
  try {
    await fetch('https://kyfw.12306.cn/otn/leftTicket/init', {
      headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36' },
    }).then((r) => client.jar.absorb(r));
  } catch { /* 拿不到也不阻塞：部分路径不校验该 Cookie */ }
  queryClient = client;
  return client;
}

/**
 * 查询余票。返回按车次排序的数组：
 * { trainCode, fromTime, arriveTime, duration, canWebBuy, seats: { '二等座': '有'|'21'|'无' , ... } }
 */
export async function queryLeftTicket({ date, fromStation, toStation }) {
  const [fromCode, toCode] = await Promise.all([telecode(fromStation), telecode(toStation)]);
  const client = await ensureClient();
  const params = new URLSearchParams({
    'leftTicketDTO.train_date': date,
    'leftTicketDTO.from_station': fromCode,
    'leftTicketDTO.to_station': toCode,
    purpose_codes: 'ADULT',
  });

  let lastError = null;
  for (const path of QUERY_PATHS) {
    let res;
    try {
      res = await fetch(`https://kyfw.12306.cn${path}?${params}`, {
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
          Referer: 'https://kyfw.12306.cn/otn/leftTicket/init',
          Cookie: client.jar.toHeader(),
        },
      });
      client.jar.absorb(res);
    } catch (e) {
      lastError = e;
      continue;
    }
    const text = await res.text();
    if (res.status === 405 || text.includes('<html')) {
      lastError = new Error(`${path} 返回非 JSON（状态 ${res.status}）`);
      continue;
    }
    let data;
    try {
      data = JSON.parse(text);
    } catch {
      lastError = new Error(`${path} 返回无法解析`);
      continue;
    }
    if (data.status === false || !data.data) {
      // 该路径不可用时平台返回 c_url 提示换路径
      lastError = new Error(data.messages?.join(';') ?? '查询被拒绝');
      continue;
    }
    return parseResult(data);
  }
  throw lastError ?? new Error('所有查询路径均不可用');
}

function parseResult(data) {
  const nameMap = data.data.map ?? {}; // telecode -> 站名
  const list = (data.data.result ?? []).map((line) => {
    const f = line.split('|');
    const seats = {};
    for (const [seat, idx] of Object.entries(SEAT_INDEX)) {
      const v = f[idx];
      if (v !== undefined && v !== '' && v !== '--') seats[seat] = v; // 有 / 数字 / 无
    }
    return {
      trainCode: f[3],
      // 提交链路所需原生字段（7.3：全部收敛在平台访问层）
      trainNo: f[2],                    // 平台内部车次号（区别于显示车次）
      secretStr: f[0],
      fromCode: f[6],
      toCode: f[7],
      fromStationNo: f[16],
      toStationNo: f[17],
      locationCode: f[15],
      bedLevelInfo: f[53],              // submitOrderRequest 需要
      seatDiscountInfo: f[54],          // submitOrderRequest 需要
      // 展示字段
      fromStation: nameMap[f[6]] ?? f[6],
      toStation: nameMap[f[7]] ?? f[7],
      fromTime: f[8],
      arriveTime: f[9],
      duration: f[10],
      canWebBuy: f[11] === 'Y',
      seats,
    };
  });
  log.info('tickets', '余票查询完成', { count: list.length });
  return list;
}
