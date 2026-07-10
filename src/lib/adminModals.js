// Модалки админа: «МОПы (кабинеты)» и «Клиенты» — дословный перенос из public/index.html.
// Императивные (innerHTML в #mopsList/#clientsList/#clientForm). Форматы /api/mop и /api/user-data не менялись.
import { getSession } from './session.js'
import { escapeHtml } from './format.js'

const $ = (id) => document.getElementById(id)

// ===== МОПы =====
function openMopsModal() {
  if (window.__switchToChat) window.__switchToChat()
  const ov = $('mopsOverlay'); if (ov) ov.style.display = 'block'
  loadMopsList()
}
function closeMopsModal() { const ov = $('mopsOverlay'); if (ov) ov.style.display = 'none' }

async function loadMopsList() {
  const box = $('mopsList')
  try {
    const r = await fetch('/api/mop?action=list&session=' + encodeURIComponent(getSession()))
    const d = await r.json()
    if (!d.ok) { box.innerHTML = '<div style="color:var(--red);">Ошибка загрузки</div>'; return }
    const accounts = d.accounts || [], plans = d.plans || {}, crm = d.mopsFromCrm || []
    let rafflePrize = ''
    try { const rr = await (await fetch('/api/mop?action=get_raffle&session=' + encodeURIComponent(getSession()))).json(); if (rr.ok && rr.raffle) rafflePrize = rr.raffle.prize || '' } catch (e) { /* ignore */ }
    let html = `<div style="background:var(--gold-bg);border:1px solid var(--gold);border-radius:12px;padding:14px;margin-bottom:16px;">
      <div style="font-size:13px;font-weight:700;margin-bottom:8px;">🎁 Приз розыгрыша месяца</div>
      <div style="font-size:11px;color:var(--txt3);margin-bottom:8px;">Видят все МОПы, кто закрыл план. Бюджет до 1 млн.</div>
      <div style="display:flex;gap:8px;">
        <input id="rafflePrizeInput" value="${escapeHtml(rafflePrize)}" placeholder="Напр. AirPods Pro" style="flex:1;padding:9px;border-radius:8px;border:1px solid var(--line2);background:var(--bg2);color:var(--txt);font-size:13px;">
        <button onclick="saveRaffle()" style="padding:9px 14px;border-radius:8px;background:var(--gold);color:#000;border:none;font-weight:600;cursor:pointer;font-size:13px;">Сохранить</button>
      </div>
    </div>
    <div style="background:var(--card);border:1px solid var(--line2);border-radius:12px;padding:14px;margin-bottom:16px;">
      <div style="font-size:13px;font-weight:700;margin-bottom:10px;">+ Создать аккаунт МОПу</div>
      <select id="mopNewId" style="width:100%;padding:10px;border-radius:9px;border:1px solid var(--line2);background:var(--bg2);color:var(--txt);font-size:14px;margin-bottom:8px;">
        <option value="">— выберите менеджера из CRM —</option>
        ${crm.map((m) => `<option value="${escapeHtml(m.id || m.name)}" data-name="${escapeHtml(m.name)}">${escapeHtml(m.name)}</option>`).join('')}
      </select>
      <input id="mopNewLogin" placeholder="Логин (напр. komiljon)" style="width:100%;padding:10px;border-radius:9px;border:1px solid var(--line2);background:var(--bg2);color:var(--txt);font-size:14px;margin-bottom:8px;">
      <select id="mopNewRole" style="width:100%;padding:10px;border-radius:9px;border:1px solid var(--line2);background:var(--bg2);color:var(--txt);font-size:14px;margin-bottom:8px;">
        <option value="sales">Sales (фикса 2 млн)</option>
        <option value="presales">Pre-Sales (фикса 1 млн)</option>
      </select>
      <input id="mopNewPass" placeholder="Пароль" style="width:100%;padding:10px;border-radius:9px;border:1px solid var(--line2);background:var(--bg2);color:var(--txt);font-size:14px;margin-bottom:8px;">
      <input id="mopNewPlan" type="number" placeholder="Личный план (выручка, сум)" style="width:100%;padding:10px;border-radius:9px;border:1px solid var(--line2);background:var(--bg2);color:var(--txt);font-size:14px;margin-bottom:10px;">
      <button onclick="createMopAccount()" style="width:100%;padding:11px;border-radius:9px;background:var(--accent);color:#fff;border:none;font-weight:600;cursor:pointer;">Создать аккаунт</button>
    </div>`
    if (accounts.length) {
      html += '<div style="font-size:13px;font-weight:700;margin-bottom:8px;">Аккаунты МОПов:</div>'
      html += accounts.map((a) => `<div style="background:var(--card);border:1px solid var(--line);border-radius:10px;padding:12px;margin-bottom:8px;">
        <div style="display:flex;justify-content:space-between;align-items:center;">
          <div><b style="font-size:14px;">${escapeHtml(a.name || a.login)}</b><div style="font-size:12px;color:var(--txt3);">логин: ${escapeHtml(a.login)}</div></div>
          <button onclick="deleteMopAccount('${escapeHtml(a.login)}')" style="padding:6px 10px;border-radius:8px;background:var(--red-bg);color:var(--red);border:none;font-size:12px;cursor:pointer;">Удалить</button>
        </div>
        <div style="display:flex;gap:8px;margin-top:10px;align-items:center;">
          <span style="font-size:12px;color:var(--txt3);">Роль:</span>
          <select onchange="setMopRole('${escapeHtml(a.login)}',this.value)" style="flex:1;padding:7px;border-radius:7px;border:1px solid var(--line2);background:var(--bg2);color:var(--txt);font-size:13px;">
            <option value="sales"${(a.mopRole || 'sales') === 'sales' ? ' selected' : ''}>Sales (2 млн)</option>
            <option value="presales"${a.mopRole === 'presales' ? ' selected' : ''}>Pre-Sales (1 млн)</option>
          </select>
        </div>
        <div style="display:flex;gap:8px;margin-top:8px;align-items:center;">
          <span style="font-size:12px;color:var(--txt3);">План:</span>
          <input id="plan_${a.mopId}" type="number" value="${plans[a.mopId] || 0}" style="flex:1;padding:7px;border-radius:7px;border:1px solid var(--line2);background:var(--bg2);color:var(--txt);font-size:13px;">
          <button onclick="setMopPlan('${a.mopId}')" style="padding:7px 12px;border-radius:7px;background:var(--card2);border:1px solid var(--line2);color:var(--txt);font-size:12px;cursor:pointer;">Сохранить</button>
        </div>
      </div>`).join('')
    } else { html += '<div style="color:var(--txt3);font-size:13px;text-align:center;padding:10px;">Пока нет аккаунтов МОПов.</div>' }
    box.innerHTML = html
    const sel = $('mopNewId')
    if (sel) sel.onchange = function () { const o = sel.options[sel.selectedIndex]; const nm = o.getAttribute('data-name') || ''; const lg = $('mopNewLogin'); if (lg && !lg.value) lg.value = nm.split(' ')[0].toLowerCase().replace(/[^a-zа-я0-9]/gi, '') }
  } catch (e) { box.innerHTML = '<div style="color:var(--red);">Ошибка</div>' }
}

async function createMopAccount() {
  const sel = $('mopNewId')
  const opt = sel.options[sel.selectedIndex]
  const name = opt ? (opt.getAttribute('data-name') || '') : ''
  let mopId = sel.value
  if (!mopId || mopId === 'undefined' || mopId === '') mopId = name
  const login = $('mopNewLogin').value.trim()
  const password = $('mopNewPass').value
  const plan = $('mopNewPlan').value
  const mopRole = $('mopNewRole').value
  if (!name || !mopId || mopId === 'undefined') { alert('Выберите менеджера из списка (если список пуст — нажмите «Обновить из amoCRM» в дашборде)'); return }
  if (!login || !password) { alert('Введите логин и пароль'); return }
  const r = await fetch('/api/mop', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ session: getSession(), action: 'create', login, password, mopId, name, mopRole }) })
  const d = await r.json()
  if (d.ok) {
    if (plan) await fetch('/api/mop', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ session: getSession(), action: 'set_plan', mopId, plan }) })
    loadMopsList()
    alert('Аккаунт создан для: ' + name)
  } else { alert(d.error || 'Ошибка создания') }
}
async function deleteMopAccount(login) {
  if (!confirm('Удалить аккаунт ' + login + '?')) return
  await fetch('/api/mop', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ session: getSession(), action: 'delete', login }) })
  loadMopsList()
}
async function setMopRole(login, mopRole) {
  await fetch('/api/mop', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ session: getSession(), action: 'set_role', login, mopRole }) })
}
async function saveRaffle() {
  const prize = $('rafflePrizeInput').value.trim()
  const r = await fetch('/api/mop', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ session: getSession(), action: 'set_raffle', prize }) })
  const d = await r.json()
  if (d.ok) { const btn = window.event.target; btn.textContent = '✓'; setTimeout(() => btn.textContent = 'Сохранить', 1200) }
}
async function setMopPlan(mopId) {
  const plan = $('plan_' + mopId).value
  const r = await fetch('/api/mop', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ session: getSession(), action: 'set_plan', mopId, plan }) })
  const d = await r.json()
  if (d.ok) { const btn = window.event.target; btn.textContent = '✓'; setTimeout(() => btn.textContent = 'Сохранить', 1200) }
}

// ===== КЛИЕНТЫ =====
function openClientsModal() { const ov = $('clientsOverlay'); if (ov) ov.style.display = 'block'; loadClientsList() }
function closeClientsModal() { const ov = $('clientsOverlay'); if (ov) ov.style.display = 'none'; const f = $('clientForm'); if (f) f.style.display = 'none' }

async function loadClientsList() {
  const box = $('clientsList')
  box.innerHTML = '<div style="font-size:12px;color:var(--txt3);">Загрузка...</div>'
  try {
    const r = await fetch('/api/user-data', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ action: 'clients-list', session: getSession() }) })
    const d = await r.json()
    if (!d.ok) { box.innerHTML = '<div style="font-size:12px;color:var(--red);">' + (d.error || 'Ошибка') + '</div>'; return }
    if (!d.clients || !d.clients.length) { box.innerHTML = '<div style="font-size:12px;color:var(--txt3);">Пока нет клиентов. Добавьте первого.</div>'; return }
    box.innerHTML = d.clients.map((c) => `
      <div style="display:flex;justify-content:space-between;align-items:center;padding:10px 12px;border:1px solid var(--line);border-radius:9px;margin-bottom:8px;">
        <div>
          <div style="font-size:13.5px;font-weight:600;">${escapeHtml(c.name)}</div>
          <div style="font-size:11px;color:var(--txt3);">${escapeHtml(c.subdomain)}.amocrm.ru · логин: ${escapeHtml(c.login)}</div>
        </div>
        <button onclick="deleteClient('${escapeHtml(c.org)}')" style="background:var(--card);border:1px solid var(--line2);color:var(--red);border-radius:7px;padding:5px 10px;font-size:12px;cursor:pointer;">Удалить</button>
      </div>`).join('')
  } catch (e) { box.innerHTML = '<div style="font-size:12px;color:var(--red);">' + String(e) + '</div>' }
}
async function deleteClient(org) {
  if (!confirm('Удалить клиента ' + org + '? Данные подключения будут стёрты.')) return
  await fetch('/api/user-data', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ action: 'client-delete', session: getSession(), org }) })
  loadClientsList()
}
function cInput(id, label, ph) {
  return `<div><div style="font-size:11px;color:var(--txt2);margin-bottom:3px;">${label}</div>
    <input id="${id}" placeholder="${ph}" style="width:100%;padding:8px 10px;border-radius:8px;border:1px solid var(--line2);background:var(--card);color:var(--txt);font-size:13px;box-sizing:border-box;"></div>`
}
function openClientForm() {
  const f = $('clientForm')
  f.style.display = 'block'
  f.innerHTML = `
    <div style="font-size:13px;font-weight:700;margin-bottom:10px;">Новый клиент</div>
    <div style="display:flex;flex-direction:column;gap:8px;">
      ${cInput('cf_name', 'Название', 'Автошкола Драйв')}
      ${cInput('cf_org', 'Код (латиницей, без пробелов)', 'avtodrive')}
      ${cInput('cf_sub', 'Субдомен amoCRM', 'avtodrive')}
      ${cInput('cf_token', 'Токен доступа amoCRM', '')}
      <button onclick="probeClient()" style="padding:9px;border-radius:8px;background:var(--card);border:1px solid var(--accent);color:var(--accent);font-size:12.5px;font-weight:600;cursor:pointer;">Проверить связь и подтянуть воронки</button>
      <div id="cf_probe"></div>
      ${cInput('cf_login', 'Логин для клиента', 'avtodrive')}
      ${cInput('cf_pass', 'Пароль для клиента', '')}
      <div style="border-top:1px solid var(--line);margin-top:6px;padding-top:10px;">
        <div style="font-size:11.5px;color:var(--txt2);margin-bottom:6px;">Финансы клиента (необязательно) — ссылка на Google-таблицу с открытым доступом «по ссылке»:</div>
        ${cInput('cf_sheet', 'Ссылка или ID Google-таблицы', 'https://docs.google.com/spreadsheets/d/...')}
      </div>
    </div>
    <button onclick="saveClient()" id="cf_saveBtn" style="width:100%;margin-top:12px;padding:11px;border-radius:9px;background:var(--accent);border:none;color:#fff;font-size:13.5px;font-weight:600;cursor:pointer;">Сохранить клиента</button>
  `
}
let _probeData = null
async function probeClient() {
  const sub = $('cf_sub').value.trim()
  const token = $('cf_token').value.trim()
  const box = $('cf_probe')
  if (!sub || !token) { box.innerHTML = '<div style="font-size:11.5px;color:var(--red);">Введите субдомен и токен</div>'; return }
  box.innerHTML = '<div style="font-size:11.5px;color:var(--txt3);">Проверяю...</div>'
  try {
    const r = await fetch('/api/user-data', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ action: 'client-probe', session: getSession(), subdomain: sub, token }) })
    const d = await r.json()
    if (!d.ok) { box.innerHTML = '<div style="font-size:11.5px;color:var(--red);">' + (d.error || 'Ошибка связи') + '</div>'; return }
    _probeData = d
    const pipeOpts = d.pipelines.map((p) => `<option value="${p.id}">${escapeHtml(p.name)}</option>`).join('')
    box.innerHTML = `<div style="background:var(--card);border:1px solid var(--green);border-radius:8px;padding:10px;margin:6px 0;">
      <div style="font-size:11.5px;color:var(--green);margin-bottom:8px;">✓ Связь есть! Воронок: ${d.pipelines.length}, менеджеров: ${d.users.length}</div>
      <div style="font-size:11px;color:var(--txt2);margin-bottom:3px;">Воронка</div>
      <select id="cf_pipe" onchange="onPipeChange()" style="width:100%;padding:7px;border-radius:7px;border:1px solid var(--line2);background:var(--bg);color:var(--txt);font-size:12.5px;margin-bottom:8px;">${pipeOpts}</select>
      <div id="cf_statuses"></div>
      <div style="font-size:11px;color:var(--txt2);margin:8px 0 3px;">Менеджеры (отметьте продажников)</div>
      <div id="cf_users" style="max-height:140px;overflow-y:auto;border:1px solid var(--line);border-radius:7px;padding:6px;">${d.users.map((u) => `<label style="display:flex;gap:7px;align-items:center;font-size:12px;padding:3px;"><input type="checkbox" class="cf_mop" value="${u.id}" data-name="${escapeHtml(u.name)}">${escapeHtml(u.name)}</label>`).join('')}</div>
    </div>`
    onPipeChange()
  } catch (e) { box.innerHTML = '<div style="font-size:11.5px;color:var(--red);">' + String(e) + '</div>' }
}
function onPipeChange() {
  if (!_probeData) return
  const pid = $('cf_pipe').value
  const pipe = _probeData.pipelines.find((p) => String(p.id) === String(pid))
  if (!pipe) return
  const opts = pipe.statuses.map((s) => `<option value="${escapeHtml(s.name)}">${escapeHtml(s.name)}</option>`).join('')
  $('cf_statuses').innerHTML = `
    <div style="font-size:11px;color:var(--txt2);margin-bottom:3px;">Статус «Продажа»</div>
    <select id="cf_sold" style="width:100%;padding:7px;border-radius:7px;border:1px solid var(--line2);background:var(--bg);color:var(--txt);font-size:12.5px;margin-bottom:6px;">${opts}</select>
    <div style="font-size:11px;color:var(--txt2);margin-bottom:3px;">Статус «Отказ/Потеря»</div>
    <select id="cf_lost" style="width:100%;padding:7px;border-radius:7px;border:1px solid var(--line2);background:var(--bg);color:var(--txt);font-size:12.5px;">${opts}</select>`
}
async function saveClient() {
  const g = (id) => { const e = $(id); return e ? e.value.trim() : '' }
  const client = {
    name: g('cf_name'), org: g('cf_org').toLowerCase().replace(/[^a-z0-9_-]/g, ''),
    subdomain: g('cf_sub'), token: g('cf_token'),
    login: g('cf_login'), password: g('cf_pass'), role: 'admin',
  }
  const sheetRaw = g('cf_sheet')
  if (sheetRaw) { const mm = sheetRaw.match(/\/d\/([a-zA-Z0-9_-]+)/); client.financeSheetId = mm ? mm[1] : sheetRaw.trim() }
  if (!client.name || !client.org || !client.subdomain || !client.token || !client.login || !client.password) { alert('Заполните все поля'); return }
  if (_probeData) {
    const pipe = _probeData.pipelines.find((p) => String(p.id) === String($('cf_pipe').value))
    if (pipe) client.pipeline = pipe.name
    client.sold = g('cf_sold'); client.lost = g('cf_lost')
    const mops = {}
    document.querySelectorAll('.cf_mop:checked').forEach((c) => { mops[c.value] = c.getAttribute('data-name') })
    client.mops = mops
  }
  const btn = $('cf_saveBtn')
  if (btn) { btn.disabled = true; btn.textContent = 'Сохранение...' }
  try {
    const r = await fetch('/api/user-data', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ action: 'client-save', session: getSession(), client }) })
    const d = await r.json()
    if (d.ok) { alert('Клиент добавлен! Логин: ' + client.login); $('clientForm').style.display = 'none'; loadClientsList() } else alert('Ошибка: ' + (d.error || '—'))
  } catch (e) { alert(String(e)) }
  if (btn) { btn.disabled = false; btn.textContent = 'Сохранить клиента' }
}

let _inited = false
export function initAdminModals() {
  if (_inited) return
  _inited = true
  Object.assign(window, {
    openMopsModal, closeMopsModal, loadMopsList, createMopAccount, deleteMopAccount, setMopRole, saveRaffle, setMopPlan,
    openClientsModal, closeClientsModal, loadClientsList, deleteClient, openClientForm, cInput, probeClient, onPipeChange, saveClient,
  })
}
