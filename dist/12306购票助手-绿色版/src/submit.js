import fs from 'node:fs';
import { restoreClient, persistClientJar } from '../session/manager.js';
import { getSettingStr } from '../settings.js';
import { log } from '../logger.js';

/**
 * 提交订单链路（FR-06 / FR-07）——2026-10 逆向自官方 queryLeftTicket_end_js.js 的现行流程。
 * ⚠ 平台接口易变（7.3）：提交实现全部收敛在本文件，每个环节的响应都会记日志，
 * 真实小流量验证时如遇接口变更只需修这里。
 *
 * 现行流程（旧教程里的 checkOrderInfo 已被平台移除）：
 * ① POST leftTicket/submitOrderRequest
 *      响应 data.result = "location_code#key_check_isChange#leftTicketStr#isAsync"（# 分隔）
 * ② POST confirmPassenger/initDc?N（空表单）→ 完整下单页，取 globalRepeatSubmitToken
 * ③ POST confirmPassenger/getQueueCountAsync（排队信息，含 isCheckOrderInfo）
 * ④ POST confirmPassenger/confirmSingleForQueueAsys（isAsync）或 confirmSingleForQueue
 *      关键参数：key_check_isChange / train_location / leftTicketStr（均来自①）
 * ⑤ 轮询 confirmPassenger/resultOrderForDcQueue → 拿订单号即占座成功（PENDING_PAYMENT）
 */

const BASE = 'https://kyfw.12306.cn';
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36';

/** 现代 Chromium 必带的客户端特征头（缺了会被 WAF 识别为脚本并「系统繁忙」） */
const SEC_HEADERS = {
  'Sec-Fetch-Dest': 'empty',
  'Sec-Fetch-Mode': 'cors',
  'Sec-Fetch-Site': 'same-origin',
  'sec-ch-ua': '"Not/A)Brand";v="8", "Chromium";v="126", "Google Chrome";v="126"',
  'sec-ch-ua-mobile': '?0',
  'sec-ch-ua-platform': '"Windows"',
  'Cache-Control': 'no-cache',
  'If-Modified-Since': '0',
};
const SEC_HEADERS_DOC = {
  ...SEC_HEADERS,
  'Sec-Fetch-Dest': 'document',
  'Sec-Fetch-Mode': 'navigate',
  'Sec-Fetch-User': '?1',
  'Upgrade-Insecure-Requests': '1',
};

/** 席别显示名 → 平台席别代码（passengerTicketStr 使用） */
export const SEAT_CODE = {
  商务座: '9', 特等座: 'P', 一等座: 'M', 二等座: 'O', 高级软卧: '6',
  软卧: '4', 动卧: 'F', 硬卧: '3', 软座: '2', 硬座: '1', 无座: 'WZ',
};

export class SubmitFlow {
  constructor(client) {
    this.client = client;
    this.token = null;            // globalRepeatSubmitToken（②）
    this.locationCode = null;     // train_location（②表单）
    this.keyCheckIsChange = null; // ②表单
    this.leftTicketStr = null;    // ②表单
    this.isAsync = null;          // ②表单
    this.purposeCodes = '00';     // ②表单（下单阶段用 00，非查询阶段的 ADULT）
  }

  async post(path, form, { rawSecretStr = null, referer = null } = {}) {
    // secretStr 已是平台侧 URL 编码串，浏览器原样放入 body（不做二次编码），
    // 其余字段正常 encodeURIComponent，因此这里手工拼 body。
    let body;
    if (rawSecretStr !== null) {
      const rest = new URLSearchParams(Object.entries(form)).toString();
      body = `secretStr=${rawSecretStr}&` + rest;
    } else {
      body = new URLSearchParams(form).toString();
    }
    const res = await fetch(BASE + path, {
      method: 'POST',
      headers: {
        'User-Agent': UA,
        ...SEC_HEADERS,
        'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8',
        Referer: referer ?? `${BASE}/otn/confirmPassenger/initDc`,
        Origin: BASE,
        'X-Requested-With': 'XMLHttpRequest',
        Accept: 'application/json, text/javascript, */*; q=0.01',
        'Accept-Language': 'zh-CN,zh;q=0.9',
        Cookie: this.client.jar.toHeader(),
      },
      body,
    });
    this.client.jar.absorb(res);
    const text = await res.text();
    try {
      return JSON.parse(text);
    } catch {
      throw new Error(`${path} 返回非 JSON（状态 ${res.status}）: ${text.slice(0, 120)}`);
    }
  }

  /** 浏览器在提交链路前会调 login/checkUser，其 attributes 作为 _json_att 全程携带 */
  async fetchJsonAtt() {
    try {
      const { loggedIn, raw } = await this.client.checkUser();
      this.jsonAtt = String(raw?.attributes ?? '');
      return loggedIn;
    } catch {
      this.jsonAtt = '';
      return false;
    }
  }

  /**
   * 补齐浏览器环境 Cookie（confirmPassenger 阶段校验，缺失会被「系统繁忙」软拒）：
   * - 用会话客户端访问一次余票页，吸收 route 等服务端下发的 Cookie；
   * - RAIL_DEVICEID/RAIL_EXPIRATION 由浏览器 JS 指纹生成，这里注入合法格式的替代值
   *   （32 位十六进制 + 未来时间戳，公开的通行做法）。
   */
  async ensureDeviceCookies() {
    for (const warmup of [`${BASE}/`, `${BASE}/otn/leftTicket/init`]) {
      try {
        const res = await fetch(warmup, {
          headers: {
            'User-Agent': UA,
            ...SEC_HEADERS_DOC,
            Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
            'Accept-Language': 'zh-CN,zh;q=0.9',
            Cookie: this.client.jar.toHeader(),
          },
        });
        this.client.jar.absorb(res);
      } catch { /* 拉不到不阻塞 */ }
    }

    const jar = this.client.jar.cookies;
    if (!jar.RAIL_DEVICEID) {
      const hex = '0123456789ABCDEF';
      jar.RAIL_DEVICEID = Array.from({ length: 32 }, () => hex[Math.floor(Math.random() * 16)]).join('');
      jar.RAIL_EXPIRATION = String(Date.now() + 30 * 86400 * 1000);
      log.info('submit', '已注入设备指纹 Cookie');
    }
    // _uab_collina：阿里风控行为指纹 Cookie，由页面 JS 生成，订单写接口的门禁之一。
    // 优先使用用户从浏览器复制的真实值（设置页可填），否则按通行做法生成。
    if (!jar._uab_collina) {
      const fromUser = getSettingStr('uab_collina');
      if (fromUser) {
        jar._uab_collina = fromUser;
        log.info('submit', '已注入用户提供的 _uab_collina');
      } else {
        jar._uab_collina = String(Date.now()) + String(Math.floor(Math.random() * 1e8)).padStart(8, '0');
        log.info('submit', '已注入生成版 _uab_collina（可在设置页填浏览器真实值）');
      }
    }
  }

  /** 步骤间人味延迟（毫秒）：全链路 200ms 内完成会显得机械 */
  static get STEP_GAP_MS() { return 250; }

  /** ① 提交所选车次，登记进服务端会话（"0"=正常继续）。字段与浏览器逐一对齐（含 undefined= 空参） */
  async submitOrderRequest({ secretStr, rideDate, fromName, toName, bedLevelInfo, seatDiscountInfo }) {
    const today = new Date();
    const backTrainDate = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, '0')}-${String(today.getDate()).padStart(2, '0')}`;
    const data = await this.post('/otn/leftTicket/submitOrderRequest', {
      train_date: rideDate,
      back_train_date: backTrainDate, // 浏览器回程框默认当天
      tour_flag: 'dc',
      purpose_codes: 'ADULT',
      query_from_station_name: fromName,
      query_to_station_name: toName,
      bed_level_info: bedLevelInfo ?? '',
      seat_discount_info: seatDiscountInfo ?? '',
      undefined: '',                  // 平台前端 bug 产物，浏览器每次都带，保持一致
      _json_att: this.jsonAtt ?? '',
    }, { rawSecretStr: secretStr ?? '', referer: `${BASE}/otn/leftTicket/init` });

    if (data?.status !== true && data?.status !== 1) {
      const msg = data?.messages?.[0] ?? JSON.stringify(data).slice(0, 200);
      throw new Error(`提交车次被拒：${msg}`);
    }
    log.info('submit', '车次已登记', { hint: typeof data.data === 'string' ? data.data : '(对象)' });
  }

  /** ② 打开下单页：必须带完整浏览器头，否则服务端返回无表单的空壳页 */
  async initDc() {
    const res = await fetch(`${BASE}/otn/confirmPassenger/initDc?N`, {
      method: 'POST',
      headers: {
        'User-Agent': UA,
        ...SEC_HEADERS_DOC,
        Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8',
        'Accept-Language': 'zh-CN,zh;q=0.9',
        Referer: `${BASE}/otn/leftTicket/init`,
        Origin: BASE,
        'Content-Type': 'application/x-www-form-urlencoded',
        Cookie: this.client.jar.toHeader(),
      },
      body: '_json_att=',
    });
    this.client.jar.absorb(res);
    const html = await res.text();
    const tm = html.match(/var globalRepeatSubmitToken\s*=\s*'([^']+)'/);
    if (!tm) throw new Error('initDc 解析失败：未取得提交令牌（可能未登记车次或会话失效）');
    this.token = tm[1];

    // 表单对象含 \xA5/\u 转义且键值多为单引号，不能用 JSON.parse，逐字段提取
    const pick = (key, { last = false } = {}) => {
      const re = new RegExp(`['"]?${key}['"]?\\s*:\\s*['"]([^'"]*)['"]`, 'g');
      let m, out = null;
      while ((m = re.exec(html)) !== null) {
        out = m[1];
        if (!last && out) break; // 首个非空；last=true 时取最后一个
      }
      return out;
    };
    this.keyCheckIsChange = pick('key_check_isChange');
    this.leftTicketStr = pick('leftTicketStr');
    this.locationCode = pick('train_location', { last: true }); // orderRequestDTO 内为 null，取末个非空
    this.isAsync = pick('isAsync');
    this.purposeCodes = pick('purpose_codes') ?? '00';
    const leftDetails = html.match(/['"]leftDetails['"]\s*:\s*\[([^\]]*)\]/)?.[1];

    if (!this.keyCheckIsChange || !this.leftTicketStr) {
      try { fs.writeFileSync('data/debug/initdc-fail.html', html, 'utf8'); } catch { /* 忽略 */ }
      throw new Error(`initDc 页面缺关键参数（key_check_isChange=${this.keyCheckIsChange} leftTicketStr=${this.leftTicketStr}），页面 ${html.length}B，已存 data/debug/initdc-fail.html`);
    }
    log.info('submit', 'initDc 成功', {
      hasToken: true, isAsync: this.isAsync, purposeCodes: this.purposeCodes,
      trainLocation: this.locationCode, leftDetails: leftDetails ? leftDetails.length : 0,
    });
  }

  /** ②b 拉取平台乘车人列表：passengerTicketStr 的手机号与 allEncStr 必须取自这里（只记条数不记姓名） */
  async loadPassengerDTOs() {
    const data = await this.post('/otn/confirmPassenger/getPassengerDTOs', {
      _json_att: this.jsonAtt ?? '',
      REPEAT_SUBMIT_TOKEN: this.token,
    });
    if (data?.status !== true && data?.status !== 1) {
      throw new Error(`拉取平台乘车人失败：${data?.messages?.[0] ?? JSON.stringify(data).slice(0, 150)}`);
    }
    this.platformPassengers = data?.data?.normal_passengers ?? [];
    // 原始响应落盘（仅本机 data/debug/，用于诊断字段结构；排查后请删除）
    try {
      const { DATA_DIR } = await import('../config.js');
      fs.mkdirSync(`${DATA_DIR}/debug`, { recursive: true });
      fs.writeFileSync(`${DATA_DIR}/debug/platform-passengers.json`, JSON.stringify(data, null, 1), 'utf8');
    } catch { /* 忽略 */ }
    log.info('submit', 'getPassengerDTOs', { count: this.platformPassengers.length });
    return this.platformPassengers;
  }

  /** 把本地乘车人匹配到平台档案，返回 passengerTicketStr / oldPassengerStr（9 段新格式）。
   *  平台返回的 passenger_id_no 是掩码串（如 1201***********21X），按掩码模板匹配：
   *  长度一致且每个非 * 字符与本地证件号同位置一致即命中；提交时原样回传掩码串+allEncStr。 */
  buildPassengerStrs(passengers) {
    const norm = (s) => String(s ?? '').trim().toUpperCase();
    const matchesTemplate = (tpl, full) => {
      if (!tpl || !full || tpl.length !== full.length) return false;
      for (let i = 0; i < tpl.length; i++) {
        if (tpl[i] !== '*' && tpl[i] !== full[i]) return false;
      }
      return true;
    };
    const ticketParts = [];
    const oldParts = [];
    for (const p of passengers) {
      const local = norm(p.idNo);
      const rec = this.platformPassengers.find((r) => matchesTemplate(norm(r.passenger_id_no), local));
      if (!rec) {
        const platTails = this.platformPassengers
          .map((r) => `${(r.passenger_name ?? '?').slice(0, 1)}**…${String(r.passenger_id_no ?? '').trim().slice(-4)}`)
          .join('、');
        log.error('submit', '乘车人平台匹配失败', {
          localTail: local.slice(-4),
          platformCount: this.platformPassengers.length,
        });
        throw new Error(
          `乘车人「${p.name.slice(0, 1)}**」未在平台档案中匹配到（本地证件尾号 ${local.slice(-4)}；` +
          `平台档案 ${this.platformPassengers.length} 人：${platTails || '空'}）。` +
          `若平台确有此人，请检查本地证件号是否录入有误`
        );
      }
      ticketParts.push(`${this.seatType},0,1,${rec.passenger_name},1,${rec.passenger_id_no},${rec.mobile_no ?? ''},N,${rec.allEncStr ?? ''}`);
      oldParts.push(`${rec.passenger_name},1,${rec.passenger_id_no},1_`);
    }
    return { passengerTicketStr: ticketParts.join('_'), oldPassengerStr: oldParts.join('') };
  }

  /** ③ 排队信息（展示性质，失败不阻断提交）。train_date 须为浏览器 Date.toString() 格式（当日零点） */
  async queueCount(rideDate, trainNo, trainCode, fromCode, toCode) {
    try {
      const data = await this.post('/otn/confirmPassenger/getQueueCountAsync', {
        train_date: browserDateStr(rideDate),
        train_no: trainNo,
        stationTrainCode: trainCode,
        seatType: this.seatType,
        fromStationTelecode: fromCode,
        toStationTelecode: toCode,
        leftTicket: this.leftTicketStr ?? '',
        purpose_codes: this.purposeCodes,
        isCheckOrderInfo: 'N',
        REPEAT_SUBMIT_TOKEN: this.token,
        _json_att: this.jsonAtt ?? '',
      });
      log.info('submit', 'getQueueCountAsync', { resp: JSON.stringify(data?.data ?? data).slice(0, 200) });
    } catch (e) {
      log.warn('submit', '排队信息查询失败（不阻断）', { error: String(e) });
    }
  }

  /** ④ 正式提交（2026-10 浏览器实测：同步接口 + 7 个附加字段 + 9 段乘车人串，无 tour_flag） */
  async confirm(passengerTicketStr, oldPassengerStr) {
    // 浏览器在下单页停留数秒才提交；1.5s 冲完是机器特征，补一段拟人停留
    const dwell = Number(process.env.CONFIRM_DWELL_MS ?? 8000);
    log.info('submit', `下单页拟人停留 ${dwell}ms …`);
    await sleep(dwell);
    const common = {
      passengerTicketStr,
      oldPassengerStr,
      purpose_codes: this.purposeCodes ?? '00',
      key_check_isChange: this.keyCheckIsChange ?? '',
      leftTicketStr: this.leftTicketStr ?? '',
      train_location: this.locationCode ?? '',
      choose_seats: '',
      seatDetailType: '000',
      is_jy: 'N',
      is_cj: 'N',
      encryptedData: '',
      whatsSelect: '1',
      roomType: '00',
      dwAll: 'N',
      _json_att: this.jsonAtt ?? '',
      REPEAT_SUBMIT_TOKEN: this.token,
    };
    // 参数完整性自检（脱敏：只记长度）
    log.info('submit', 'confirm 参数长度', {
      pts: passengerTicketStr.length, ops: oldPassengerStr.length,
      key: (this.keyCheckIsChange ?? '').length, lts: (this.leftTicketStr ?? '').length,
      loc: (this.locationCode ?? '').length, token: (this.token ?? '').length,
      jsonAtt: (this.jsonAtt ?? '').length, pax: this.platformPassengers.length,
    });

    // 同步接口（浏览器现行）；Referer 与浏览器一致带查询串
    const data = await this.post('/otn/confirmPassenger/confirmSingleForQueue', common, {
      referer: `${BASE}/otn/confirmPassenger/initDc?N`,
    });
    const ok = data?.data?.submitStatus === true;
    log.info('submit', 'confirm 提交', { ok, resp: JSON.stringify(data).slice(0, 250) });

    if (!ok) throw new Error(`提交被拒：${data?.data?.errMsg ?? JSON.stringify(data).slice(0, 200)}`);
    return data.data;
  }

  /**
   * ⑤ 轮询出票结果（浏览器真实流程）：
   * 先循环 GET queryOrderWaitTime（waitTime<0 或出现 orderId 即出票完成），
   * 再以 orderSequence_no 调一次 resultOrderForDcQueue 确认。
   */
  async pollResult(times = 40, intervalMs = 1000) {
    let orderId = null;
    for (let i = 0; i < times; i++) {
      await new Promise((r) => setTimeout(r, intervalMs));
      const url = `${BASE}/otn/confirmPassenger/queryOrderWaitTime?random=${Date.now()}&tourFlag=dc&_json_att=${encodeURIComponent(this.jsonAtt ?? '')}`;
      const res = await fetch(url, {
        headers: {
          'User-Agent': UA,
          ...SEC_HEADERS,
          Accept: 'application/json, text/javascript, */*; q=0.01',
          'X-Requested-With': 'XMLHttpRequest',
          Referer: `${BASE}/otn/confirmPassenger/initDc`,
          Cookie: this.client.jar.toHeader(),
        },
      });
      this.client.jar.absorb(res);
      const data = await res.json().catch(() => ({}));
      const d = data?.data ?? {};
      if (data?.status === false || d.queryOrderWaitTimeStatus === false) {
        throw new Error(d.errMsg ?? '排队状态查询失败');
      }
      if (d.orderId) orderId = String(d.orderId);
      // waitTime<0 表示处理结束（-1 处理中完成，-2/-3 异常；-100 排队完成）
      if (d.waitTime !== undefined && d.waitTime < 0) break;
    }
    if (!orderId) throw new Error('排队轮询超时，未拿到订单号');

    // 收尾：resultOrderForDcQueue 确认占座
    const data = await this.post('/otn/confirmPassenger/resultOrderForDcQueue', {
      orderSequence_no: orderId,
      _json_att: this.jsonAtt ?? '',
      REPEAT_SUBMIT_TOKEN: this.token,
    });
    const ok = data?.data?.submitStatus === true || data?.status === true;
    log.info('submit', 'resultOrderForDcQueue 确认', { ok, orderId: orderId.slice(-6) });
    if (!ok) throw new Error(`订单确认失败：${JSON.stringify(data).slice(0, 150)}`);
    log.info('submit', '占座成功，已生成待支付订单');
    return orderId;
  }
}

/**
 * 执行一次完整提交。
 * @param {object} hit matchCandidates 的命中结果 { trainCode, seatType }
 * @param {object} ctx { trainNo, rideDate, fromName, toName, fromCode, toCode,
 *   secretStr, bedLevelInfo, seatDiscountInfo, passengers: [{name,idNo,seatType}] }
 * @param {(phase: 'SUBMITTED'|'QUEUED') => void} onPhase 阶段回调（供引擎写状态）
 * @returns { orderId } 占座成功后的订单号
 */
export async function submitOrder(hit, ctx, onPhase = () => {}) {
  const client = restoreClient();
  if (!client) throw new Error('会话失效，无法提交（6.6 全局阻断）');

  const flow = new SubmitFlow(client);
  flow.seatType = SEAT_CODE[hit.seatType] ?? hit.seatType;

  // ⓪ 浏览器行为：链路前 checkUser（取 _json_att）+ 补齐设备环境 Cookie
  await flow.fetchJsonAtt();
  await flow.ensureDeviceCookies();
  persistClientJar(flow.client); // 环境 Cookie 落库复用
  await sleep(SubmitFlow.STEP_GAP_MS);

  // ① 登记车次（secretStr 原样回传，不二次编码）
  await flow.submitOrderRequest({
    secretStr: ctx.secretStr,
    rideDate: ctx.rideDate,
    fromName: ctx.fromName,
    toName: ctx.toName,
    bedLevelInfo: ctx.bedLevelInfo,
    seatDiscountInfo: ctx.seatDiscountInfo,
  });
  await sleep(SubmitFlow.STEP_GAP_MS);

  // ② 下单页令牌
  await flow.initDc();
  await sleep(SubmitFlow.STEP_GAP_MS);

  // ②b 平台乘车人列表：手机号与 allEncStr 必须取自平台，本地拼不出（2026 新格式）
  await flow.loadPassengerDTOs();
  await sleep(SubmitFlow.STEP_GAP_MS);

  // 乘车人串：席别,票位,票型,姓名,证件类型,证件号,手机号,接收短信,allEncStr
  // 全程只在本机内存拼接，绝不入日志（6.5）
  const { passengerTicketStr, oldPassengerStr } = flow.buildPassengerStrs(ctx.passengers);

  // ③ 正式提交（浏览器的现行流程没有排队人数查询环节）
  await flow.confirm(passengerTicketStr, oldPassengerStr);
  onPhase('SUBMITTED');

  // ⑤ 轮询占座结果
  const orderId = await flow.pollResult();
  onPhase('QUEUED');
  return orderId;
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

const WEEK = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const MON = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/** 浏览器端 $("#train_date") → new Date(...) → toString() 的等价串（当日零点，GMT+0800） */
function browserDateStr(rideDate) {
  const [y, m, d] = rideDate.split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d, -8)); // 当日零点（北京时间的 UTC 表示）
  return `${WEEK[dt.getUTCDay()]} ${MON[dt.getUTCMonth()]} ${String(d).padStart(2, '0')} ${y} 00:00:00 GMT+0800`;
}

/**
 * 待支付订单的官方支付入口（FR-08：跳转官方页面，程序不参与支付输入）。
 */
export function paymentPageUrl(_orderId) {
  // 未完成订单列表页（用户在此完成支付）
  return 'https://kyfw.12306.cn/otn/view/train_order.html';
}
