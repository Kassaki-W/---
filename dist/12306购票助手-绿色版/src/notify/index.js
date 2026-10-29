import { spawn } from 'node:child_process';
import { getDb, nowIso } from '../db/database.js';

/**
 * 通知模块（FR-10）：
 * - 通知渠道固定为桌面通知（Windows 系统弹窗，纯本机，不经任何外部通道，v0.3 已确认）；
 * - 通知内容严格白名单（6.5）：任务名、车次、席别、乘车人数、状态、金额、时间，
 *   绝不携带姓名、证件号；内容不出本机；
 * - 未来如考虑接入任何第三方推送，须先重新评估外发白名单并再次书面确认。
 */

const KEY_STATES = ['SUBMITTED', 'PENDING_PAYMENT', 'FAILED', 'EXPIRED', 'PAID'];

const STATE_TEXT = {
  SUBMITTED: '订单已提交',
  PENDING_PAYMENT: '占座成功，请尽快支付！',
  FAILED: '任务失败',
  EXPIRED: '已过期',
  PAID: '已支付完成',
};

/** 供状态机在关键跃迁时调用；失败只记日志，不阻断主流程（FR-10 例外） */
export function onTaskTransition(taskId, toStatus, reason) {
  if (!KEY_STATES.includes(toStatus)) return;
  try {
    const db = getDb();
    const task = db.prepare('SELECT * FROM tasks WHERE id = ?').get(taskId);
    if (!task) return;

    // 同一事件只推送一次（FR-10）：task + 状态唯一
    const dup = db.prepare('SELECT id FROM notifications WHERE task_id = ? AND event = ?').get(taskId, toStatus);
    if (dup) return;

    const paxCount = JSON.parse(task.passenger_ids ?? '[]').length;
    const train = extractTrain(reason) ?? '见任务';
    const text = [
      `【12306购票助手】${STATE_TEXT[toStatus] ?? toStatus}`,
      `任务：${task.name}`,
      `车次：${train}`,
      `乘车人数：${paxCount}`,
      reason ? `说明：${reason}` : '',
      `时间：${nowIso().slice(0, 19).replace('T', ' ')}`,
    ].filter(Boolean).join('\n');

    const result = desktopNotify('12306 购票助手', text) ? 'ok' : 'failed';
    db.prepare('INSERT INTO notifications (task_id, channel, event, content, result, created_at) VALUES (?, ?, ?, ?, ?, ?)')
      .run(taskId, 'desktop', toStatus, text, result, nowIso());
  } catch (e) {
    // 降级为日志，不阻断（FR-10 例外条款）
    console.error('[notify] 通知失败：', e?.message ?? e);
  }
}

/** 从跃迁原因中提取车次（如「命中 G1 二等座」→ G1）；只提取，不含任何个人信息 */
function extractTrain(reason) {
  const m = String(reason ?? '').match(/(?:命中|订单) ?([GDCS]?\d{1,5})/);
  return m?.[1] ?? null;
}

/** Windows 桌面 Toast 通知（无第三方依赖） */
function desktopNotify(title, body) {
  if (process.platform !== 'win32') return false;
  try {
    const ps = `
[Windows.UI.Notifications.ToastNotificationManager, Windows.UI.Notifications, ContentType = WindowsRuntime] | Out-Null
$t = [Windows.UI.Notifications.ToastNotificationManager]::GetTemplateContent([Windows.UI.Notifications.ToastTemplateType]::ToastText02)
$x = $t.GetElementsByTagName('text')
$x.Item(0).AppendChild($t.CreateTextNode(${psStr(title)})) | Out-Null
$x.Item(1).AppendChild($t.CreateTextNode(${psStr(body)})) | Out-Null
[Windows.UI.Notifications.ToastNotificationManager]::CreateToastNotifier('${'12306 购票助手'}').Show([Windows.UI.Notifications.ToastNotification]::new($t))`;
    spawn('powershell', ['-NoProfile', '-WindowStyle', 'Hidden', '-Command', ps], { stdio: 'ignore' })
      .on('error', () => { /* 桌面通知失败不影响主流程 */ });
    return true;
  } catch {
    return false;
  }
}

/** PowerShell 单引号字符串转义 */
function psStr(s) {
  return `'${String(s).replace(/'/g, "''").replace(/[\r\n]+/g, ' ')}'`;
}
