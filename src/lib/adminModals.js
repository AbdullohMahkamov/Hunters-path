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
          <div><b style="font-size:14px;">${escapeHtml(a.name || a.login)}</b><div style="font-size:12px;color:var(--txt3);">логин: ${escapeHtml(a.login)}</div><div style="font-size:12px;color:var(--txt2);margin-top:2px;">код: <span style="font-family:ui-monospace,monospace;font-weight:700;color:var(--accent);user-select:all;cursor:text;">${escapeHtml(a.password || '—')}</span></div></div>
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

// ===== ГЕЙМИФИКАЦИЯ (админ) =====
const gv = (id) => { const el = $(id); return el ? el.value : '' }
const gnum = (id) => { const n = parseFloat(gv(id)); return isNaN(n) ? 0 : n }

function openGamiModal() {
  if (window.__switchToChat) window.__switchToChat()
  const ov = $('gamiOverlay'); if (ov) ov.style.display = 'block'
  window._gamiTab = 'settings'
  loadGamiConfig()
}
function closeGamiModal() { const ov = $('gamiOverlay'); if (ov) ov.style.display = 'none' }

async function loadGamiConfig() {
  const body = $('gamiBody')
  if (body) body.innerHTML = '<div style="color:var(--txt3);font-size:13px;">Загрузка...</div>'
  try {
    const r = await fetch('/api/gamification?action=get_config&session=' + encodeURIComponent(getSession()))
    const d = await r.json()
    if (!d.ok) { if (body) body.innerHTML = '<div style="color:var(--red);">' + (d.error || 'Ошибка') + '</div>'; return }
    window._gamiCfg = d.config
    renderGamiTabs(); renderGamiTab()
  } catch (e) { if (body) body.innerHTML = '<div style="color:var(--red);">' + String(e) + '</div>' }
}

function renderGamiTabs() {
  const tabs = [['settings', 'Настройки'], ['case', 'Кейс'], ['levels', 'Уровни'], ['balances', 'Баллы'], ['inventory', 'Инвентарь']]
  const wrap = $('gamiTabs'); if (!wrap) return
  wrap.innerHTML = tabs.map(([k, t]) => `<button onclick="gamiSwitchTab('${k}')" style="padding:8px 14px;border-radius:9px;border:1px solid ${window._gamiTab === k ? 'var(--accent)' : 'var(--line2)'};background:${window._gamiTab === k ? 'var(--accent-bg)' : 'var(--card)'};color:${window._gamiTab === k ? 'var(--accent)' : 'var(--txt2)'};font-size:13px;font-weight:600;cursor:pointer;">${t}</button>`).join('')
}

function gamiSwitchTab(t) { collectCurrentGamiTab(); window._gamiTab = t; renderGamiTabs(); renderGamiTab() }

function collectCurrentGamiTab() {
  const c = window._gamiCfg; if (!c) return
  if (window._gamiTab === 'settings') {
    const en = $('g_enabled'); if (en) c.enabled = en.checked
    c.points = { reach: gnum('g_p_reach'), fastCall: gnum('g_p_fast'), taskDone: gnum('g_p_task'), noOverdueDay: gnum('g_p_day') }
    if ($('g_case_price')) c.case.price = gnum('g_case_price')
    if ($('g_case_perday')) c.case.perDay = Math.max(1, gnum('g_case_perday'))
    if ($('g_case_img')) c.case.image = gv('g_case_img').trim()
  } else if (window._gamiTab === 'case') {
    const items = []
    ;(c.case.items || []).forEach((_, i) => {
      if (!$('g_ci_name_' + i)) return
      items.push({ name: gv('g_ci_name_' + i).trim(), chance: gnum('g_ci_chance_' + i), value: gnum('g_ci_value_' + i), image: gv('g_ci_img_' + i).trim() })
    })
    if (items.length) c.case.items = items
  } else if (window._gamiTab === 'levels') {
    ;(c.levels || []).forEach((lv, i) => {
      if (!$('g_lv_name_' + i)) return
      lv.name = gv('g_lv_name_' + i).trim()
      lv.reach = gnum('g_lv_reach_' + i); lv.conv = gnum('g_lv_conv_' + i); lv.tasks = gnum('g_lv_tasks_' + i)
      lv.call = gnum('g_lv_call_' + i); lv.plan = gnum('g_lv_plan_' + i)
      lv.prizeName = gv('g_lv_pname_' + i).trim(); lv.prizeValue = gnum('g_lv_pval_' + i); lv.prizeImage = gv('g_lv_pimg_' + i).trim()
    })
  }
}

function renderGamiTab() {
  const c = window._gamiCfg, body = $('gamiBody'); if (!c || !body) return
  const t = window._gamiTab
  const inp = (id, val, w) => `<input id="${id}" value="${val != null ? String(val).replace(/"/g, '&quot;') : ''}" style="width:${w || '100%'};padding:8px 9px;border-radius:8px;border:1px solid var(--line2);background:var(--bg2);color:var(--txt);font-size:13px;">`
  const num = (id, val, w) => `<input id="${id}" type="number" value="${val != null ? val : 0}" style="width:${w || '100%'};padding:8px 9px;border-radius:8px;border:1px solid var(--line2);background:var(--bg2);color:var(--txt);font-size:13px;">`
  const saveBtn = '<button onclick="saveGami()" style="margin-top:16px;width:100%;padding:11px;border-radius:9px;background:var(--accent);border:none;color:#fff;font-weight:600;font-size:14px;cursor:pointer;">Сохранить</button>'
  const fld = (lbl, ctrl) => `<div style="margin-bottom:11px;"><div style="font-size:12px;color:var(--txt3);margin-bottom:5px;">${lbl}</div>${ctrl}</div>`

  if (t === 'settings') {
    body.innerHTML =
      `<label style="display:flex;align-items:center;gap:9px;font-size:14px;font-weight:600;margin-bottom:18px;cursor:pointer;"><input type="checkbox" id="g_enabled" ${c.enabled ? 'checked' : ''} style="width:18px;height:18px;"> Геймификация включена</label>` +
      '<div style="display:grid;grid-template-columns:1fr 1fr;gap:0 14px;">' +
      fld('Баллы за дозвон (>40 сек)', num('g_p_reach', c.points.reach)) +
      fld('Баллы за 1-й звонок < 15 мин', num('g_p_fast', c.points.fastCall)) +
      fld('Баллы за выполненную задачу', num('g_p_task', c.points.taskDone)) +
      fld('Баллы за день без просрочек', num('g_p_day', c.points.noOverdueDay)) +
      fld('Цена кейса (баллы)', num('g_case_price', c.case.price)) +
      fld('Открытий кейса в день', num('g_case_perday', c.case.perDay != null ? c.case.perDay : 2)) +
      '</div>' +
      fld('URL фото кейса (если пусто — рисуем лут-кейс)', `<input id="g_case_img" value="${(c.case.image || '').replace(/"/g, '&quot;')}" placeholder="https://…" style="width:100%;padding:8px 9px;border-radius:8px;border:1px solid var(--line2);background:var(--bg2);color:var(--txt);font-size:13px;">`) +
      saveBtn +
      '<button onclick="resetEconomy()" style="margin-top:9px;width:100%;padding:10px;border-radius:9px;background:var(--gold-bg);border:1px solid var(--gold);color:var(--gold);font-size:13px;font-weight:600;cursor:pointer;">Сбросить экономику к стандартной (призы и фото сохранятся)</button>' +
      '<button onclick="resetGami()" style="margin-top:8px;width:100%;padding:9px;border-radius:9px;background:transparent;border:1px solid var(--line2);color:var(--txt3);font-size:12.5px;cursor:pointer;">Сбросить ВСЁ к стандартному (сотрёт призы/фото)</button>'
  } else if (t === 'case') {
    const rows = (c.case.items || []).map((it, i) =>
      `<div style="border:1px solid var(--line);border-radius:10px;padding:9px;margin-bottom:8px;background:var(--card);">
        <div style="display:grid;grid-template-columns:1fr 74px 96px 32px;gap:7px;align-items:center;margin-bottom:6px;">
          ${inp('g_ci_name_' + i, it.name)}
          ${num('g_ci_chance_' + i, it.chance)}
          ${num('g_ci_value_' + i, it.value)}
          <button onclick="removeCaseItem(${i})" style="width:32px;height:32px;border-radius:8px;background:var(--red-bg);color:var(--red);border:none;font-size:16px;cursor:pointer;">×</button>
        </div>
        <div style="display:flex;align-items:center;gap:8px;">
          ${it.image ? `<img src="${String(it.image).replace(/"/g, '&quot;')}" style="width:34px;height:34px;border-radius:7px;object-fit:cover;border:1px solid var(--line2);flex:0 0 auto;">` : '<div style="width:34px;height:34px;border-radius:7px;background:var(--bg2);border:1px dashed var(--line2);flex:0 0 auto;"></div>'}
          <input id="g_ci_img_${i}" value="${(it.image || '').replace(/"/g, '&quot;')}" placeholder="URL фото приза (необязательно)" style="flex:1;padding:8px 9px;border-radius:8px;border:1px solid var(--line2);background:var(--bg2);color:var(--txt);font-size:12.5px;">
        </div>
      </div>`).join('')
    body.innerHTML =
      '<div style="display:grid;grid-template-columns:1fr 74px 96px 32px;gap:7px;font-size:11px;color:var(--txt3);text-transform:uppercase;letter-spacing:.4px;margin-bottom:7px;"><span>Приз</span><span>Шанс %</span><span>Стоим.</span><span></span></div>' +
      '<div id="g_case_items" oninput="gamiCaseSum()">' + rows + '</div>' +
      `<div id="g_case_sum_wrap" style="font-size:13px;margin:10px 0 4px;color:var(--txt2);">Сумма шансов: <b id="g_case_sum">—</b>% <span style="color:var(--txt3);">(должна быть 100%)</span></div>` +
      '<button onclick="addCaseItem()" style="width:100%;padding:9px;border-radius:9px;background:var(--card2);border:1px dashed var(--line2);color:var(--txt2);font-size:13px;cursor:pointer;">+ Добавить предмет</button>' +
      saveBtn
    gamiCaseSum()
  } else if (t === 'levels') {
    const th = (x) => `<th style="text-align:left;font-size:11px;color:var(--txt3);font-weight:600;padding:0 6px 8px;white-space:nowrap;">${x}</th>`
    const rows = (c.levels || []).map((lv, i) =>
      `<tr>
        <td style="padding:3px 6px;color:var(--txt3);font-weight:700;">${i + 1}</td>
        <td style="padding:3px 6px;">${inp('g_lv_name_' + i, lv.name, '110px')}</td>
        <td style="padding:3px 6px;">${num('g_lv_reach_' + i, lv.reach, '64px')}</td>
        <td style="padding:3px 6px;">${num('g_lv_conv_' + i, lv.conv, '64px')}</td>
        <td style="padding:3px 6px;">${num('g_lv_tasks_' + i, lv.tasks, '64px')}</td>
        <td style="padding:3px 6px;">${num('g_lv_call_' + i, lv.call, '64px')}</td>
        <td style="padding:3px 6px;">${num('g_lv_plan_' + i, lv.plan, '64px')}</td>
        <td style="padding:3px 6px;">${inp('g_lv_pname_' + i, lv.prizeName, '150px')}</td>
        <td style="padding:3px 6px;">${num('g_lv_pval_' + i, lv.prizeValue, '110px')}</td>
        <td style="padding:3px 6px;">${inp('g_lv_pimg_' + i, lv.prizeImage, '180px')}</td>
      </tr>`).join('')
    body.innerHTML =
      '<div style="overflow-x:auto;"><table style="border-collapse:collapse;min-width:1000px;"><thead><tr>' +
      th('#') + th('Название') + th('Дозвон %') + th('Конв. %') + th('Задачи %') + th('Звонок ≤мин') + th('План %') + th('Название приза') + th('Стоим. приза') + th('Фото приза (URL)') +
      '</tr></thead><tbody>' + rows + '</tbody></table></div>' + saveBtn
  } else if (t === 'balances') {
    body.innerHTML = '<div style="font-size:12.5px;color:var(--txt3);margin-bottom:12px;">Начисли баллы вручную (например, для бонуса или теста). Можно и списать — введи отрицательное число.</div><div id="g_bal_list"><div style="color:var(--txt3);font-size:13px;">Загрузка...</div></div>'
    loadGamiBalances()
  } else if (t === 'inventory') {
    body.innerHTML = '<div id="g_inv_list"><div style="color:var(--txt3);font-size:13px;">Загрузка...</div></div>'
    loadGamiInventory()
  }
}

function gamiCaseSum() {
  const c = window._gamiCfg; if (!c) return
  let sum = 0
  ;(c.case.items || []).forEach((_, i) => { if ($('g_ci_chance_' + i)) sum += gnum('g_ci_chance_' + i) })
  const el = $('g_case_sum'); if (el) { el.textContent = Math.round(sum * 10) / 10; el.style.color = Math.round(sum) === 100 ? 'var(--green)' : 'var(--red)' }
}
function addCaseItem() { collectCurrentGamiTab(); window._gamiCfg.case.items.push({ name: 'Новый приз', chance: 0, value: 0 }); renderGamiTab() }
function removeCaseItem(i) { collectCurrentGamiTab(); window._gamiCfg.case.items.splice(i, 1); renderGamiTab() }

async function saveGami() {
  collectCurrentGamiTab()
  try {
    const r = await fetch('/api/gamification', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ session: getSession(), action: 'set_config', config: window._gamiCfg }) })
    const d = await r.json()
    if (d.ok) { window._gamiCfg = d.config; alert('Сохранено'); renderGamiTab() }
    else alert('Ошибка: ' + (d.error || '—'))
  } catch (e) { alert(String(e)) }
}

async function resetEconomy() {
  if (!confirm('Сбросить баллы, цену кейса и лимит открытий к стандартным? Призы, уровни и фото останутся.')) return
  try {
    const r = await fetch('/api/gamification', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ session: getSession(), action: 'reset_economy' }) })
    const d = await r.json()
    if (d.ok) { window._gamiCfg = d.config; renderGamiTab(); alert('Экономика сброшена: цена ' + d.config.case.price + ', ' + d.config.case.perDay + '/день') } else alert('Ошибка: ' + (d.error || '—'))
  } catch (e) { alert(String(e)) }
}

async function resetGami() {
  if (!confirm('Сбросить все настройки геймификации к стандартным? Текущие призы/уровни/баллы будут заменены.')) return
  try {
    const r = await fetch('/api/gamification', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ session: getSession(), action: 'reset_config' }) })
    const d = await r.json()
    if (d.ok) { window._gamiCfg = d.config; renderGamiTab(); alert('Сброшено к стандартным') } else alert('Ошибка: ' + (d.error || '—'))
  } catch (e) { alert(String(e)) }
}

async function loadGamiBalances() {
  const box = $('g_bal_list'); if (!box) return
  try {
    const r = await fetch('/api/gamification?action=list_balances&session=' + encodeURIComponent(getSession()))
    const d = await r.json()
    if (!d.ok) { box.innerHTML = '<div style="color:var(--red);">' + (d.error || 'Ошибка') + '</div>'; return }
    const list = d.balances || []
    if (!list.length) { box.innerHTML = '<div style="color:var(--txt3);font-size:13px;text-align:center;padding:14px;">Нет аккаунтов МОПов.</div>'; return }
    box.innerHTML = list.map((b) => {
      const mid = String(b.mopId)
      const midJs = mid.replace(/'/g, "\\'")
      return `<div style="display:flex;align-items:center;gap:9px;padding:10px 12px;border:1px solid var(--line);border-radius:10px;margin-bottom:8px;background:var(--card);">
        <div style="flex:1;min-width:0;">
          <b style="font-size:13.5px;">${escapeHtml(b.mopName || mid)}</b>
          <div style="font-size:12px;color:var(--txt3);">Баланс: <b style="color:var(--gold);">${(b.balance || 0).toLocaleString('ru-RU')}</b> балл.${b.bonus ? ` · бонус ${b.bonus.toLocaleString('ru-RU')}` : ''}</div>
        </div>
        <input id="g_grant_${mid}" type="number" placeholder="напр. 5000" style="width:100px;padding:8px 9px;border-radius:8px;border:1px solid var(--line2);background:var(--bg2);color:var(--txt);font-size:13px;">
        <button onclick="grantPoints('${midJs}')" style="padding:8px 13px;border-radius:8px;background:var(--accent);border:none;color:#fff;font-size:12.5px;font-weight:600;cursor:pointer;white-space:nowrap;">Начислить</button>
      </div>`
    }).join('')
  } catch (e) { box.innerHTML = '<div style="color:var(--red);">' + String(e) + '</div>' }
}
async function grantPoints(mopId) {
  const el = $('g_grant_' + mopId)
  const amt = el ? parseInt(el.value, 10) : 0
  if (!amt) { alert('Введите число баллов'); return }
  try {
    const r = await fetch('/api/gamification', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ session: getSession(), action: 'grant_points', mopId, amount: amt }) })
    const d = await r.json()
    if (d.ok) { loadGamiBalances() } else alert('Ошибка: ' + (d.error || '—'))
  } catch (e) { alert(String(e)) }
}

async function loadGamiInventory() {
  const box = $('g_inv_list'); if (!box) return
  try {
    const r = await fetch('/api/gamification?action=list_inventory&session=' + encodeURIComponent(getSession()))
    const d = await r.json()
    if (!d.ok) { box.innerHTML = '<div style="color:var(--red);">' + (d.error || 'Ошибка') + '</div>'; return }
    const list = d.inventory || []
    if (!list.length) { box.innerHTML = '<div style="color:var(--txt3);font-size:13px;text-align:center;padding:14px;">Пока нет выигранных призов.</div>'; return }
    box.innerHTML = list.map((it) => {
      const pend = it.status !== 'delivered'
      const val = it.value ? ` · ${(it.value).toLocaleString('ru-RU')}` : ''
      const tag = it.type === 'level' ? `Ур. ${it.level}` : 'Кейс'
      return `<div style="display:flex;align-items:center;gap:11px;padding:10px 12px;border:1px solid var(--line);border-radius:10px;margin-bottom:8px;background:var(--card);">
        <div style="flex:1;min-width:0;">
          <div style="font-size:13.5px;font-weight:600;">${escapeHtml(it.mopName || it.mopId)} <span style="color:var(--txt3);font-weight:500;">— ${escapeHtml(it.name)}${val}</span></div>
          <div style="font-size:11px;color:var(--txt3);margin-top:2px;">${tag} · ${new Date(it.wonAt).toLocaleDateString('ru-RU')}</div>
        </div>
        ${pend
          ? `<button onclick="gamiDeliver('${escapeHtml(String(it.mopId))}','${it.id}')" style="padding:7px 13px;border-radius:8px;background:var(--accent);border:none;color:#fff;font-size:12.5px;font-weight:600;cursor:pointer;white-space:nowrap;">Выдано</button>`
          : '<span style="font-size:11px;font-weight:700;text-transform:uppercase;color:var(--green);background:var(--green-bg);padding:4px 10px;border-radius:999px;">Выдано</span>'}
      </div>`
    }).join('')
  } catch (e) { box.innerHTML = '<div style="color:var(--red);">' + String(e) + '</div>' }
}
async function gamiDeliver(mopId, itemId) {
  await fetch('/api/gamification', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ session: getSession(), action: 'mark_delivered', mopId, itemId }) })
  loadGamiInventory()
}

let _inited = false
export function initAdminModals() {
  if (_inited) return
  _inited = true
  Object.assign(window, {
    openMopsModal, closeMopsModal, loadMopsList, createMopAccount, deleteMopAccount, setMopRole, saveRaffle, setMopPlan,
    openClientsModal, closeClientsModal, loadClientsList, deleteClient, openClientForm, cInput, probeClient, onPipeChange, saveClient,
    openGamiModal, closeGamiModal, gamiSwitchTab, saveGami, addCaseItem, removeCaseItem, gamiCaseSum, gamiDeliver, resetGami, resetEconomy, loadGamiBalances, grantPoints,
  })
}
