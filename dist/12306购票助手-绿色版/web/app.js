/**
 * 控制台前端（骨架）。步骤 2-8 逐步充实各页签。
 */

// ---- 页签切换 ----
document.getElementById('tabs').addEventListener('click', (e) => {
  const btn = e.target.closest('button[data-tab]');
  if (!btn) return;
  document.querySelectorAll('#tabs button').forEach((b) => b.classList.toggle('active', b === btn));
  document.querySelectorAll('.tab-panel').forEach((p) => p.classList.toggle('active', p.id === `tab-${btn.dataset.tab}`));
});

// ---- 会话状态条（FR-01 / 6.6：失效时红色置顶告警） ----
async function refreshSessionBar() {
  try {
    const res = await fetch('/api/session');
    const data = await res.json();
    const bar = document.getElementById('session-bar');
    const text = document.getElementById('session-text');
    bar.className = `session-bar ${data.status}`;
    text.textContent = data.status === 'valid' ? '会话状态：有效' : '会话状态：无效 — 请先在「登录 / 会话」页扫码登录';
  } catch {
    document.getElementById('session-bar').className = 'session-bar unknown';
    document.getElementById('session-text').textContent = '会话状态：服务未连接';
  }
}

document.getElementById('server-url').textContent = location.origin;
refreshSessionBar();
setInterval(refreshSessionBar, 30_000);

// ---- 登录 / 会话页（FR-01：扫码登录 + 状态 + 登出） ----
const qrImg = document.getElementById('qr-img');
const qrArea = document.getElementById('qr-area');
const qrTip = document.getElementById('qr-tip');
const loginStatus = document.getElementById('login-status');
let qrTimer = null;

document.getElementById('btn-qr').addEventListener('click', async () => {
  qrArea.classList.add('hidden');
  loginStatus.textContent = '正在生成二维码…';
  loginStatus.className = 'login-status';
  try {
    const res = await fetch('/api/session/qrcode', { method: 'POST' });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || '生成失败');
    // 12306 返回裸 base64（无 data: 前缀），两种都兼容
    qrImg.src = data.image.startsWith('data:') ? data.image : `data:image/png;base64,${data.image}`;
    qrArea.classList.remove('hidden');
    qrTip.textContent = '请用 12306 官方 App 扫码并确认';
    loginStatus.textContent = '二维码已生成，等待扫码…';
    startQrPolling();
  } catch (e) {
    loginStatus.textContent = `生成二维码失败：${e.message}`;
    loginStatus.className = 'login-status bad';
  }
});

function startQrPolling() {
  clearInterval(qrTimer);
  qrTimer = setInterval(async () => {
    try {
      const res = await fetch('/api/session/qrcode');
      const data = await res.json();
      if (data.state === 'waiting') return;
      if (data.state === 'scanned') {
        qrTip.textContent = data.message || '已扫码，请在手机上确认';
        return;
      }
      clearInterval(qrTimer);
      if (data.state === 'confirmed') {
        qrArea.classList.add('hidden');
        loginStatus.textContent = `登录成功：${data.username ?? ''}`;
        loginStatus.className = 'login-status ok';
        refreshSessionBar();
      } else if (data.state === 'expired') {
        loginStatus.textContent = data.message || '二维码已过期，请重新生成';
        loginStatus.className = 'login-status bad';
        qrArea.classList.add('hidden');
      } else {
        loginStatus.textContent = data.message || '登录异常，请重试';
        loginStatus.className = 'login-status bad';
      }
    } catch { /* 网络抖动，下一轮再试 */ }
  }, 2000);
}

document.getElementById('btn-validate').addEventListener('click', async () => {
  loginStatus.textContent = '正在校验…';
  loginStatus.className = 'login-status';
  try {
    const res = await fetch('/api/session/validate', { method: 'POST' });
    const data = await res.json();
    if (data.valid) {
      loginStatus.textContent = '登录态有效';
      loginStatus.className = 'login-status ok';
    } else {
      loginStatus.textContent = `登录态无效：${data.reason ?? '未知原因'}`;
      loginStatus.className = 'login-status bad';
    }
    refreshSessionBar();
  } catch (e) {
    loginStatus.textContent = `校验请求失败：${e.message}`;
    loginStatus.className = 'login-status bad';
  }
});

document.getElementById('btn-logout').addEventListener('click', async () => {
  if (!confirm('确认登出并清空本机登录凭证？')) return;
  await fetch('/api/session/logout', { method: 'POST' });
  loginStatus.textContent = '已登出';
  loginStatus.className = 'login-status';
  qrArea.classList.add('hidden');
  refreshSessionBar();
});

// ---- 余票查询（FR-05 只读验证） ----
const stationList = document.getElementById('station-list');
const queryResult = document.getElementById('query-result');

async function loadStationList(q = '') {
  const res = await fetch(`/api/stations?q=${encodeURIComponent(q)}`);
  const list = await res.json();
  if (Array.isArray(list)) {
    stationList.innerHTML = list.map((s) => `<option value="${s.name}">`).join('');
  }
}

// 输入时按需刷新联想列表
let stationTimer = null;
['q-from', 'q-to'].forEach((id) => {
  document.getElementById(id).addEventListener('input', (e) => {
    clearTimeout(stationTimer);
    stationTimer = setTimeout(() => loadStationList(e.target.value.trim()), 250);
  });
});
loadStationList();

document.getElementById('q-date').value = new Date(Date.now() + 86400_000).toISOString().slice(0, 10);

document.getElementById('btn-query').addEventListener('click', async () => {
  const from = document.getElementById('q-from').value.trim();
  const to = document.getElementById('q-to').value.trim();
  const date = document.getElementById('q-date').value;
  if (!from || !to || !date) { queryResult.innerHTML = '<p class="hint">请填写出发、到达与日期</p>'; return; }
  queryResult.innerHTML = '<p class="hint">查询中…</p>';
  try {
    const res = await fetch(`/api/tickets?date=${date}&from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}`);
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || '查询失败');
    renderTickets(data.list);
  } catch (e) {
    queryResult.innerHTML = `<p class="hint">⚠ ${e.message}</p>`;
  }
});

function seatClass(v) {
  if (v === '无' || v === '--') return 'seat-none';
  if (v === '候补') return 'seat-few';
  if (v === '有') return 'seat-num';
  return Number(v) > 10 ? 'seat-num' : 'seat-few';
}

function renderTickets(list) {
  if (!list.length) { queryResult.innerHTML = '<p class="hint">该日期区间无车次数据</p>'; return; }
  const seatKeys = ['商务座', '一等座', '二等座', '高级软卧', '软卧', '动卧', '硬卧', '软座', '硬座', '无座'];
  const head = ['车次', ...seatKeys, '出发-到达', '历时', '可购'].map((h) => `<th>${h}</th>`).join('');
  const rows = list.map((t) => {
    const seats = seatKeys.map((k) => {
      const v = t.seats[k];
      return v === undefined ? '<td></td>' : `<td class="${seatClass(v)}">${v}</td>`;
    }).join('');
    return `<tr><td><b>${t.trainCode}</b></td>${seats}<td>${t.fromTime}-${t.arriveTime}</td><td>${t.duration}</td><td>${t.canWebBuy ? '是' : '否'}</td></tr>`;
  }).join('');
  queryResult.innerHTML = `<table class="data"><thead><tr>${head}</tr></thead><tbody>${rows}</tbody></table>`;
}

// ---- 乘车人管理（FR-02） ----
const pTableBody = document.querySelector('#p-table tbody');
const pFormTitle = document.getElementById('p-form-title');
let editingId = null;

async function loadPassengers() {
  const res = await fetch('/api/passengers');
  const list = await res.json();
  loadPassengerChoices();
  pTableBody.innerHTML = list.map((p) => `
    <tr>
      <td>${p.name}</td>
      <td>${p.idMasked}</td>
      <td>${p.verified ? '是' : '否'}</td>
      <td>${p.isDefault ? '是' : ''}</td>
      <td>
        <button class="btn" data-edit="${p.id}" data-name="${p.name}">编辑</button>
        <button class="btn" data-verify="${p.id}" data-v="${p.verified ? 1 : 0}">${p.verified ? '取消核验' : '标记核验'}</button>
        <button class="btn danger" data-del="${p.id}">删除</button>
      </td>
    </tr>`).join('');
}

pTableBody.addEventListener('click', async (e) => {
  const editBtn = e.target.closest('[data-edit]');
  const delBtn = e.target.closest('[data-del]');
  if (editBtn) {
    editingId = editBtn.dataset.edit;
    document.getElementById('p-name').value = editBtn.dataset.name;
    document.getElementById('p-id').value = '';
    document.getElementById('p-id').placeholder = '留空则不修改证件号';
    pFormTitle.textContent = `编辑乘车人 #${editingId}`;
    document.getElementById('p-cancel').classList.remove('hidden');
  }
  if (delBtn) {
    if (!confirm('确认删除该乘车人？')) return;
    const res = await fetch(`/api/passengers/${delBtn.dataset.del}`, { method: 'DELETE' });
    if (!res.ok) alert((await res.json()).error);
    loadPassengers();
  }
  const verifyBtn = e.target.closest('[data-verify]');
  if (verifyBtn) {
    const verified = verifyBtn.dataset.v === '1';
    if (!verified && !confirm('请确认已在 12306 官方 App 完成该乘车人实名核验？')) return;
    await fetch(`/api/passengers/${verifyBtn.dataset.verify}/verify`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ verified: !verified }),
    });
    loadPassengers();
  }
});

document.getElementById('p-save').addEventListener('click', async () => {
  const name = document.getElementById('p-name').value.trim();
  const idNumber = document.getElementById('p-id').value.trim();
  const isDefault = document.getElementById('p-default').checked;
  const body = { name, isDefault };
  if (idNumber) body.idNumber = idNumber;
  const url = editingId ? `/api/passengers/${editingId}` : '/api/passengers';
  const method = editingId ? 'PUT' : 'POST';
  const res = await fetch(url, { method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  const data = await res.json();
  if (!res.ok) { alert(data.error); return; }
  resetPassengerForm();
  loadPassengers();
});

document.getElementById('p-cancel').addEventListener('click', resetPassengerForm);

function resetPassengerForm() {
  editingId = null;
  pFormTitle.textContent = '新增乘车人';
  document.getElementById('p-name').value = '';
  document.getElementById('p-id').value = '';
  document.getElementById('p-id').placeholder = '18 位身份证号';
  document.getElementById('p-default').checked = false;
  document.getElementById('p-cancel').classList.add('hidden');
}

loadPassengers();

// ---- 抢票任务（FR-03 / FR-04 / FR-11） ----
const tTableBody = document.querySelector('#t-table tbody');
const paxBox = document.getElementById('t-pax-box');
let passengersCache = [];

document.getElementById('t-date').value = new Date(Date.now() + 86400_000).toISOString().slice(0, 10);

async function loadPassengerChoices() {
  passengersCache = await (await fetch('/api/passengers')).json();
  paxBox.innerHTML = passengersCache.length
    ? passengersCache.map((p) => `<label><input type="checkbox" value="${p.id}" ${p.verified ? '' : 'disabled'} /> ${p.name}${p.verified ? '' : '（未核验）'}</label>`).join('')
    : '<span class="hint">暂无乘车人，请先到「乘车人」页添加</span>';
}
loadPassengerChoices();

document.getElementById('t-create').addEventListener('click', async () => {
  const body = {
    name: document.getElementById('t-name').value.trim(),
    fromStation: document.getElementById('t-from').value.trim(),
    toStation: document.getElementById('t-to').value.trim(),
    rideDate: document.getElementById('t-date').value,
    trainCodes: document.getElementById('t-trains').value.split(/[,，]/).map((s) => s.trim().toUpperCase()).filter(Boolean),
    seatPrefs: document.getElementById('t-seats').value.split(/[,，]/).map((s) => s.trim()).filter(Boolean),
    startTime: document.getElementById('t-start').value.replace('T', ' '),
    acceptNoSeat: document.getElementById('t-noseat').checked,
    passengerIds: [...paxBox.querySelectorAll('input:checked')].map((i) => Number(i.value)),
  };
  if (body.startTime.length === 16) body.startTime += ':00';
  const res = await fetch('/api/tasks', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  const data = await res.json();
  if (!res.ok) { alert(data.error); return; }
  loadTasks();
});

async function loadTasks() {
  const list = await (await fetch('/api/tasks')).json();
  const nowMs = Date.now();
  tTableBody.innerHTML = list.map((t) => {
    const startMs = new Date(t.start_time.replace(' ', 'T') + '+08:00').getTime();
    const diff = Math.floor((startMs - nowMs) / 1000);
    const countdown = ['RUNNING', 'WAITING'].includes(t.status) ? '进行中'
      : t.status === 'DRAFT' && diff > 0 ? formatCountdown(diff)
      : t.status === 'DRAFT' ? '已过时刻' : '—';
    const names = t.passenger_ids.map((id) => passengersCache.find((p) => p.id === id)?.name ?? `#${id}`).join('、');
    const ops = [];
    if (t.status === 'DRAFT') ops.push(`<button class="btn primary" data-arm="${t.id}">武装</button>`);
    if (['DRAFT', 'ARMED', 'RUNNING'].includes(t.status)) ops.push(`<button class="btn danger" data-cancel="${t.id}">取消</button>`);
    if (t.status === 'PENDING_PAYMENT') ops.push(`<button class="btn primary" data-paid="${t.id}">已支付</button>`);
    ops.push(`<button class="btn" data-events="${t.id}">流水</button>`);
    return `<tr>
      <td><b>${t.name}</b></td>
      <td>${t.ride_date}<br/><span class="hint">${t.from_station}→${t.to_station}</span></td>
      <td>${t.train_codes.join('→')}</td>
      <td>${t.seat_prefs.join('>')}${t.accept_no_seat ? '<br/><span class="hint">接受无座</span>' : ''}</td>
      <td>${names || '—'}</td>
      <td>${t.start_time}</td>
      <td class="${diff > 0 && diff < 600 ? 'countdown-soon' : ''}" data-countdown="${t.id}">${countdown}</td>
      <td><span class="status-pill status-${t.status}">${t.status}</span></td>
      <td>${ops.join(' ')}</td>
    </tr>`;
  }).join('');
}

function formatCountdown(sec) {
  const d = Math.floor(sec / 86400), h = Math.floor((sec % 86400) / 3600), m = Math.floor((sec % 3600) / 60), s = sec % 60;
  return d > 0 ? `${d}天${h}时${m}分` : h > 0 ? `${h}时${m}分${s}秒` : `${m}分${s}秒`;
}

tTableBody.addEventListener('click', async (e) => {
  const arm = e.target.closest('[data-arm]');
  const cancel = e.target.closest('[data-cancel]');
  const paid = e.target.closest('[data-paid]');
  const ev = e.target.closest('[data-events]');
  if (arm) {
    const res = await fetch(`/api/tasks/${arm.dataset.arm}/arm`, { method: 'POST' });
    if (!res.ok) alert((await res.json()).error);
    loadTasks();
  }
  if (cancel) {
    if (!confirm('确认取消该任务？')) return;
    await fetch(`/api/tasks/${cancel.dataset.cancel}/cancel`, { method: 'POST' });
    loadTasks();
  }
  if (paid) {
    const res = await fetch(`/api/tasks/${paid.dataset.paid}/paid`, { method: 'POST' });
    if (!res.ok) alert((await res.json()).error);
    loadTasks();
  }
  if (ev) {
    const events = await (await fetch(`/api/tasks/${ev.dataset.events}/events`)).json();
    alert(events.map((x) => `${x.created_at.slice(0, 19).replace('T', ' ')}  ${x.from_status ?? '∅'} → ${x.to_status}${x.reason ? `（${x.reason}）` : ''}`).join('\n') || '暂无流水');
  }
});

// 任务列表与倒计时刷新
loadTasks();
setInterval(loadTasks, 5000);

// ---- 待支付横幅（FR-08：置顶高亮 + 倒计时 + 跳官方支付页） ----
const payBanner = document.getElementById('pay-banner');
const payText = document.getElementById('pay-text');
const payCountdown = document.getElementById('pay-countdown');
let pendingOrder = null;

async function refreshPayBanner() {
  try {
    const list = await (await fetch('/api/orders?status=pending')).json();
    pendingOrder = list[0] ?? null;
    payBanner.classList.toggle('hidden', !pendingOrder);
    if (pendingOrder) {
      payText.textContent = `待支付：${pendingOrder.train_code} ${pendingOrder.seat_type}，订单号尾号 ${String(pendingOrder.order_no).slice(-6)}`;
    }
  } catch { /* 忽略瞬时错误 */ }
}

setInterval(() => {
  if (!pendingOrder) return;
  const left = Math.floor((new Date(pendingOrder.pay_deadline).getTime() - Date.now()) / 1000);
  if (left <= 0) { payCountdown.textContent = '支付窗口已到，请尽快确认订单状态'; return; }
  const m = Math.floor(left / 60), s = left % 60;
  payCountdown.textContent = `剩余 ${m}分${String(s).padStart(2, '0')}秒`;
}, 1000);

document.getElementById('btn-pay').addEventListener('click', () => {
  if (pendingOrder?.paymentUrl) window.open(pendingOrder.paymentUrl, '_blank');
});
document.getElementById('btn-paid').addEventListener('click', async () => {
  if (!pendingOrder) return;
  await fetch(`/api/orders/${pendingOrder.id}/status`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ status: 'paid' }) });
  refreshPayBanner();
  loadTasks();
});
document.getElementById('btn-cancel-order').addEventListener('click', async () => {
  if (!pendingOrder || !confirm('确认该订单已在官方页面取消？')) return;
  await fetch(`/api/orders/${pendingOrder.id}/status`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ status: 'cancelled' }) });
  refreshPayBanner();
  loadTasks();
});

refreshPayBanner();
setInterval(refreshPayBanner, 5000);

// ---- 设置页（FR-11 / 6.1 提前量 / 手机访问 / 清空数据） ----
async function loadSettings() {
  const s = await (await fetch('/api/settings')).json();
  document.getElementById('s-advance').value = s.advanceSeconds ?? '';
  document.getElementById('s-retry').value = s.retryInterval ?? 5;
  document.getElementById('s-lan').checked = !!s.lanAccess;
  document.getElementById('s-pwd').value = s.accessPassword ?? '';
  document.getElementById('s-uab').value = s.uabCollina ?? '';
}
loadSettings();

document.getElementById('s-save').addEventListener('click', async () => {
  const body = {
    advanceSeconds: document.getElementById('s-advance').value === '' ? undefined : Number(document.getElementById('s-advance').value),
    retryInterval: Number(document.getElementById('s-retry').value) || 5,
    lanAccess: document.getElementById('s-lan').checked,
    accessPassword: document.getElementById('s-pwd').value,
    uabCollina: document.getElementById('s-uab').value.trim(),
  };
  const res = await fetch('/api/settings', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  const data = await res.json();
  if (!res.ok) { alert(data.error); loadSettings(); return; }
  alert('已保存。' + (body.lanAccess ? '手机访问需重启程序后生效。' : ''));
});

document.getElementById('s-purge').addEventListener('click', async () => {
  if (!confirm('将删除本机全部数据（登录凭证、乘车人、任务、订单、日志），不可恢复。确认继续？')) return;
  const input = prompt('请输入 DELETE 以确认：');
  if (input !== 'DELETE') return;
  await fetch('/api/purge', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ confirm: 'DELETE' }) });
  alert('已清空全部数据。');
  location.reload();
});

// ---- 日志页 ----
async function loadLogs() {
  const lines = await (await fetch('/api/logs?n=300')).json();
  document.getElementById('log-view').textContent = lines
    .map((l) => l.raw ?? `${(l.ts ?? '').slice(0, 19).replace('T', ' ')} [${l.level}] ${l.module} ${l.message}${l.extra ? ' ' + JSON.stringify(l.extra) : ''}`)
    .join('\n');
}
document.getElementById('l-refresh').addEventListener('click', loadLogs);
loadLogs();
