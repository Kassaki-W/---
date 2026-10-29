import { getDb, nowIso } from '../db/database.js';
import { encrypt, decrypt } from '../db/crypto.js';
import { Client12306, CookieJar } from '../platform/client.js';
import { log } from '../logger.js';

/**
 * 会话生命周期（FR-01 / 6.6）：
 * - 扫码登录一次，凭证加密落库，启动时自动续用；
 * - 每次任务开抢前校验；失效为全局阻断事件：暂停全部任务、禁止武装、等人工重登。
 */

/** 进行中的扫码登录（内存态，不落库） */
let pendingLogin = null;

function db() {
  return getDb();
}

export function getStatus() {
  const row = db().prepare('SELECT status, last_checked_at FROM sessions WHERE id = 1').get();
  return {
    status: row?.status ?? 'invalid',
    lastCheckedAt: row?.last_checked_at ?? null,
    username: row?.status === 'valid' ? pendingLogin?.username ?? null : null,
  };
}

/** 恢复已持久化的登录态：返回可用的客户端；无效则返回 null */
export function restoreClient() {
  const row = db().prepare('SELECT credential_enc FROM sessions WHERE id = 1').get();
  if (!row?.credential_enc) return null;
  const json = decrypt(row.credential_enc);
  if (!json) return null;
  const jar = CookieJar.fromJSON(json);
  return new Client12306(jar);
}

async function saveCredential(client, username = null) {
  db().prepare('UPDATE sessions SET status = ?, credential_enc = ?, last_checked_at = ?, updated_at = ? WHERE id = 1')
    .run('valid', encrypt(client.jar.toJSON()), nowIso(), nowIso());
  log.info('session', '登录态已加密落库', { username: username ?? '-' });
}

/** 持久化运行期补充的 Cookie（如提交链路注入的设备指纹），供下次复用 */
export function persistClientJar(client) {
  saveCredential(client);
}

/** 校验登录态；失效时执行全局阻断（6.6） */
export async function validateSession() {
  const client = restoreClient();
  if (!client) {
    markInvalid('本机无登录凭证');
    return { valid: false, reason: '本机无登录凭证' };
  }
  try {
    const { loggedIn, raw } = await client.checkUser();
    if (loggedIn) {
      await saveCredential(client);
      return { valid: true };
    }
    markInvalid('平台校验未通过', raw);
    return { valid: false, reason: '平台校验未通过' };
  } catch (e) {
    // 网络错误不等于登录失效：不改状态，仅记录
    log.warn('session', '登录态校验网络异常，保持原状态', { error: String(e) });
    return { valid: false, networkError: true, reason: '网络异常，稍后重试' };
  }
}

function markInvalid(reason, raw = null) {
  db().prepare('UPDATE sessions SET status = ?, credential_enc = NULL, last_checked_at = ?, updated_at = ? WHERE id = 1')
    .run('invalid', nowIso(), nowIso());
  log.warn('session', '会话失效，进入全局阻断：暂停全部任务，等待人工重新登录', { reason, raw: raw ? JSON.stringify(raw).slice(0, 200) : null });
  // 步骤 4 接入调度引擎后，此处将广播暂停全部 ARMED/RUNNING/WAITING 任务
}

// ---- 扫码登录流程 ----

export async function startQrLogin() {
  const client = new Client12306();
  const r = await client.createQr();
  if (!r.ok) {
    log.error('session', '生成登录二维码失败', { reason: r.reason });
    return { ok: false, reason: r.reason };
  }
  pendingLogin = { client, uuid: r.uuid, startedAt: Date.now() };
  log.info('session', '登录二维码已生成，等待扫码');
  return { ok: true, image: r.image };
}

/**
 * 轮询扫码进度。返回：
 * { state: 'waiting' | 'scanned' | 'confirmed' | 'expired' | 'error', ... }
 */
export async function pollQrLogin() {
  if (!pendingLogin) return { state: 'expired', reason: '没有进行中的扫码登录，请重新生成' };
  try {
    const data = await pendingLogin.client.checkQr(pendingLogin.uuid);
    const code = String(data?.result_code ?? '');
    if (code === '0') return { state: 'waiting' };
    if (code === '1') return { state: 'scanned', message: '已扫码，请在手机上确认' };
    if (code === '2') {
      const tkData = await pendingLogin.client.uamtk();
      const tk = tkData?.newapptk ?? tkData?.tk;
      if (!tk) {
        log.error('session', '换取凭证失败', { raw: JSON.stringify(tkData).slice(0, 200) });
        return { state: 'error', message: '换取登录凭证失败，请重试' };
      }
      const userData = await pendingLogin.client.uamauthClient(tk);
      const username = userData?.username ?? null;
      await saveCredential(pendingLogin.client, username);
      pendingLogin = null;
      return { state: 'confirmed', username };
    }
    if (code === '3') {
      pendingLogin = null;
      return { state: 'expired', message: '二维码已过期，请重新生成' };
    }
    return { state: 'error', message: data?.result_message ?? `未知状态码 ${code}` };
  } catch (e) {
    log.error('session', '扫码轮询异常', { error: String(e) });
    return { state: 'error', message: '网络异常，请重试' };
  }
}

/** 主动登出：清空本机凭证（6.5 清空数据的组成部分） */
export function logout() {
  db().prepare("UPDATE sessions SET status = 'invalid', credential_enc = NULL, last_checked_at = NULL, updated_at = ? WHERE id = 1")
    .run(nowIso());
  pendingLogin = null;
  log.info('session', '已登出并清空本机凭证');
}
