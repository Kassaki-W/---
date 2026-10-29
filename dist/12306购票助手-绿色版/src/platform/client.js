/**
 * 平台访问层（7.1）：唯一与 12306 通信的模块。
 * 封装：Cookie 管理、扫码登录、登录态校验。
 * 后续余票查询 / 提交订单 / 排队轮询（步骤 3、5）都收敛在这里，平台接口变更只改本文件。
 */

const BASE = 'https://kyfw.12306.cn';
const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36';

/** 简易 Cookie 罐：本机单用户场景足够；可序列化后加密持久化（FR-01） */
export class CookieJar {
  constructor(cookies = {}) {
    this.cookies = cookies; // name -> value
  }

  /** 从响应的 set-cookie 头吸收 */
  absorb(response) {
    const raw = response.headers.getSetCookie?.() ?? [];
    for (const line of raw) {
      const [pair] = line.split(';');
      const idx = pair.indexOf('=');
      if (idx > 0) {
        const name = pair.slice(0, idx).trim();
        const value = pair.slice(idx + 1).trim();
        if (value && value !== 'deleted') this.cookies[name] = value;
      }
    }
  }

  toHeader() {
    return Object.entries(this.cookies)
      .map(([k, v]) => `${k}=${v}`)
      .join('; ');
  }

  static fromJSON(json) {
    try {
      return new CookieJar(JSON.parse(json));
    } catch {
      return new CookieJar();
    }
  }

  toJSON() {
    return JSON.stringify(this.cookies);
  }
}

export class Client12306 {
  constructor(jar = new CookieJar()) {
    this.jar = jar;
  }

  async post(path, form = {}) {
    const body = new URLSearchParams(form).toString();
    const res = await fetch(BASE + path, {
      method: 'POST',
      headers: {
        'User-Agent': UA,
        'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8',
        Referer: `${BASE}/otn/leftTicketInit`,
        Origin: BASE,
        Cookie: this.jar.toHeader(),
      },
      body,
    });
    this.jar.absorb(res);
    const text = await res.text();
    try {
      return { httpStatus: res.status, data: JSON.parse(text) };
    } catch {
      return { httpStatus: res.status, data: null, text };
    }
  }

  // ---- 扫码登录（FR-01）----

  /** 生成登录二维码：返回 { uuid, image }，image 为 data URL 可直接展示 */
  async createQr() {
    const { data } = await this.post('/passport/web/create-qr64', { appid: 'otn' });
    if (data?.result_code === '0') {
      return { ok: true, uuid: data.uuid, image: data.image };
    }
    return { ok: false, reason: data?.result_message ?? `create-qr64 异常: ${JSON.stringify(data)}` };
  }

  /**
   * 轮询二维码状态：
   * result_code '0' 待扫码；'1' 已扫码待确认；'2' 已确认（继续 uamtk 换票）；'3' 过期
   */
  async checkQr(uuid, deviceId = '', expiration = '') {
    const { data } = await this.post('/passport/web/checkqr', {
      appid: 'otn',
      uuid,
      RAIL_DEVICEID: deviceId,
      RAIL_EXPIRATION: expiration,
    });
    return data; // 原样返回给上层判断
  }

  /** 扫码确认后：换取 appToken */
  async uamtk() {
    const { data } = await this.post('/passport/web/auth/uamtk', { appid: 'otn' });
    return data;
  }

  /** 用 tk 换取正式登录态（写入 Cookie） */
  async uamauthClient(tk) {
    const { data } = await this.post('/otn/uamauthclient', { tk });
    return data;
  }

  // ---- 登录态校验（FR-01：每次开抢前校验；6.6 失效即全局暂停） ----

  /** 返回 { loggedIn, raw } */
  async checkUser() {
    const { data } = await this.post('/otn/login/checkUser', { _json_att: '' });
    return { loggedIn: data?.data?.flag === true, raw: data };
  }
}
