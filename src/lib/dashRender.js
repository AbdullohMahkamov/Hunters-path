// Рендер дашборда — дословный перенос applyLiveDash и под-рендеров из public/index.html.
// Работает на реальном DOM статического скелета дашборда (те же id). Числа/логика 1:1.
// Раздел «Маркетинг» (renderAdsets, meta-ads) переносится позже — здесь не вызывается.
import { state, getGoal } from './appState.js'
import { getSession, getRole, getOrg, orgQ } from './session.js'
// getRole используется в reviewSusp (by: роль ревьюера)
import { escapeHtml } from './format.js'

// orgSettings — дефолт 1:1 из монолита; loadOrgSettings подтягивает сохранённые.
export let orgSettings = { goal: null, workdays: [1, 2, 3, 4, 5, 6], workStart: '10:00', workEnd: '20:00', margin: null, adSpend: null, adSpendMonth: null, adSpendAll: null }

let suspData = []
let suspReviewed = {}
let _lastDashData = null
let _discPeriod = 'month'
let _discData = null
let overviewExtrasLoaded = false
let ovFinYear = null, ovFinMonth = null

// Валюта текущего дашборда (из кэша: dashboard.currency). UZS — без юнита (как было, hunter не тронут);
// USD — префикс «$». Задаётся при загрузке данных (см. window._dashData = d).
let _dashCurrency = 'UZS'
export function setDashCurrency(c) { _dashCurrency = c || 'UZS' }
// отслеживается ли выручка (из кэша totals.revenueTracked). false → CRM не отдаёт суммы оплат:
// показываем «н/д», а не $0, чтобы не читать отсутствие данных как реальный ноль. Дефолт true (hunter/amoCRM).
let _revTracked = true
// полный формат суммы с юнитом (для мест, где раньше был хардкод «сум»)
export function fmtCur(n, uz) {
  const num = new Intl.NumberFormat('ru-RU').format(Math.round(Number(n) || 0))
  return _dashCurrency === 'USD' ? '$' + num : num + ' ' + (uz ? "so'm" : 'сум')
}
export function fmtSum(n) {
  n = Number(n) || 0
  const neg = n < 0; const a = Math.abs(n)
  let s
  if (a >= 1000000) s = (a / 1000000).toFixed(a >= 10000000 ? 0 : 1).replace('.', ',') + 'М'
  else if (a >= 1000) s = Math.round(a / 1000) + 'К'
  else s = String(a)
  const body = (neg ? '-' : '') + s
  return _dashCurrency === 'USD' ? '$' + body : body
}

function fmtMin(m) {
  if (m == null) return '—'
  if (m < 60) return m + ' мин'
  if (m < 60 * 24) return (m / 60).toFixed(1).replace('.', ',') + ' ч'
  return Math.round(m / 60 / 24) + ' дн'
}

function hintIcon(key) { return `<span class="hint" onclick="showHint('${key}',event)">?</span>` }

function countWorkdays(year, month, workdays) {
  const daysInMonth = new Date(year, month + 1, 0).getDate()
  const today = new Date()
  const isCurrentMonth = (today.getFullYear() === year && today.getMonth() === month)
  const todayDate = today.getDate()
  let passed = 0, total = 0
  for (let d = 1; d <= daysInMonth; d++) {
    const dow = new Date(year, month, d).getDay()
    if (!workdays.includes(dow)) continue
    total++
    if (isCurrentMonth && d <= todayDate) passed++
    else if (!isCurrentMonth) passed++
  }
  return { passed, total, daysInMonth }
}

export function applyLiveDash(d) {
  window._dashData = d
  setDashCurrency(d && (d.currency || (d.totals && d.totals.currency)))
  _revTracked = !(d && d.totals && d.totals.revenueTracked === false)
  const t = d.totals
  const set = (id, v) => { const e = document.getElementById(id); if (e) e.textContent = v }
  const per = window._dashPeriod || 'month'
  const convVal = per === 'all' && t.convAll != null ? t.convAll : t.conv
  const noContactVal = per === 'all' && t.noContactPctAll != null ? t.noContactPctAll : t.noContactPct
  const leadsVal = per === 'all' && t.leadsAll != null ? t.leadsAll : t.leads

  // === СЕГОДНЯ ===
  const setT = (id, v) => { const e = document.getElementById(id); if (e) e.textContent = v }
  setT('tdLeads', t.leadsToday != null ? t.leadsToday : '—')
  setT('tdSold', t.soldToday != null ? t.soldToday : '—')
  setT('tdRev', !_revTracked ? 'н/д' : (t.revenueToday != null ? fmtSum(t.revenueToday) : '—'))

  const isAll = per === 'all'
  const soldShown = isAll && t.soldAll != null ? t.soldAll : t.sold
  const revShown = isAll && t.revenueAll != null ? t.revenueAll : t.revenue

  set('kpiSold', soldShown)
  set('kpiSoldH', isAll ? 'за всё время' : ('из плана ' + (t.needPerMonth || 141)))
  set('kpiRevenue', _revTracked ? fmtSum(revShown) : 'н/д')
  const rh = document.getElementById('ovRevH'); if (rh) rh.textContent = !_revTracked ? 'нет оплат в CRM' : (isAll ? 'за всё время' : 'этот месяц')
  set('kpiConv', String(convVal).replace('.', ',') + '%')
  const convLeads = isAll ? (t.leadsAll != null ? t.leadsAll : t.leads) : (t.leads != null ? t.leads : 0)
  const convSold = isAll ? (t.soldTeamAll != null ? t.soldTeamAll : t.soldAll) : (t.soldTeam != null ? t.soldTeam : t.sold)
  const uzL = state.lang === 'uz'
  const ch = document.getElementById('ovConvH')
  if (ch) ch.textContent = uzL ? `${convLeads != null ? convLeads : '—'} lid → ${convSold != null ? convSold : '—'} sotuv` : `лидов ${convLeads != null ? convLeads : '—'} → продаж ${convSold != null ? convSold : '—'}`
  const chkSold = isAll ? (t.soldAll != null ? t.soldAll : t.sold) : t.sold
  const chkRev = isAll ? (t.revenueAll != null ? t.revenueAll : t.revenue) : (t.newSalesRevenue != null ? t.newSalesRevenue : t.revenue)
  const avgCheck = (chkSold > 0) ? Math.round(chkRev / chkSold) : 0
  set('kpiCheck', !_revTracked ? 'н/д' : (avgCheck > 0 ? fmtSum(avgCheck) : '—'))
  const chkH = document.getElementById('ovCheckH'); if (chkH) chkH.textContent = isAll ? (uzL ? 'butun davr' : 'за всё время') : (uzL ? 'tushum ÷ sotuv' : 'выручка ÷ продажи')
  const sl = document.getElementById('ovSoldLbl'); if (sl) sl.textContent = isAll ? 'Продаж (всё время)' : 'Продаж'
  const rl = document.getElementById('ovRevLbl'); if (rl) rl.textContent = isAll ? 'Выручка (всё время)' : 'Выручка'
  set('mkLeads', leadsVal != null ? leadsVal : '—')
  set('mkNoContact', (noContactVal != null ? noContactVal : 0) + '%')
  loadOverviewExtras()

  // Топ по продажам — по ВЫРУЧКЕ (сортировка, бар и значение)
  const bySales = [...(d.mopsBySales || [])].sort((a, b) => (b.revenue || 0) - (a.revenue || 0))
  const maxRev = Math.max(1, ...bySales.map((m) => m.revenue || 0))
  const topEl = document.getElementById('topSalesChart')
  if (topEl) topEl.innerHTML = bySales.map((m, i) => `
    <div class="mop-row">
      <div class="mop-name">${i + 1}. ${escapeHtml(m.name)}</div>
      <div class="mop-bar-wrap"><div class="mop-bar" style="width:${Math.round((m.revenue || 0) / maxRev * 100)}%;background:var(--accent);"></div></div>
      <div class="mop-val">${fmtSum(m.revenue || 0)}</div>
    </div>`).join('') || '<div style="font-size:12px;color:var(--txt3);">Нет данных за месяц</div>'

  renderPlanFact(d)
  renderForecast(d)
  renderVelocity(d)
  renderAdsets(d)
  renderSignals(d)

  const byConv = d.mopsByConv || []
  const mopEl = document.getElementById('mopChart')
  if (mopEl) mopEl.innerHTML = byConv.map((m) => `
    <div style="padding:9px 0;border-top:1px solid var(--line);">
      <div style="display:flex;align-items:center;gap:10px;">
        <div class="mop-name" style="width:120px;">${escapeHtml(m.name)}</div>
        <div class="mop-bar-wrap"><div class="mop-bar" style="width:${Math.round(Math.min(100, m.conv / 3.5 * 100))}%;background:${m.conv >= 2.5 ? 'var(--green)' : (m.conv < 1.3 ? 'var(--red)' : 'var(--accent)')};"></div></div>
        <div class="mop-val" style="color:${m.conv >= 2.5 ? 'var(--green)' : (m.conv < 1.3 ? 'var(--red)' : 'var(--txt)')};">${m.conv}%</div>
      </div>
      <div style="font-size:11px;color:var(--txt3);margin-top:3px;margin-left:130px;">${m.leads} лидов · ${m.sold} продаж · дозвон ${m.reachPct}%${m.fakeNums ? ` · ${m.fakeNums} нереальных номеров` : ''}</div>
    </div>`).join('') || '<div style="font-size:12px;color:var(--txt3);">Нет данных</div>'

  const probs = (per === 'all' && d.problemsAll ? d.problemsAll : d.problems) || []
  const maxP = Math.max(1, ...probs.map((p) => p.count))
  const probEl = document.getElementById('problemsChart')
  if (probEl) probEl.innerHTML = probs.map((p) => `
    <div class="mop-row">
      <div class="mop-name" style="width:150px;">${escapeHtml(p.name)}</div>
      <div class="mop-bar-wrap"><div class="mop-bar" style="width:${Math.round(p.count / maxP * 100)}%;background:var(--red);"></div></div>
      <div class="mop-val">${p.count}</div>
    </div>`).join('') || '<div style="font-size:12px;color:var(--txt3);">Нет потерь за период</div>'

  if (d.speed && d.speed.mops) renderDiscipline(d.speed)
}

function renderForecast(d) {
  _lastDashData = d
  const box = document.getElementById('forecastChart'); if (!box) return
  const uz = state.lang === 'uz'
  const t = (d && d.totals) || {}
  const earned = t.revenue || 0
  const goal = getGoal()
  const now = new Date()
  const wd = orgSettings.workdays && orgSettings.workdays.length ? orgSettings.workdays : [1, 2, 3, 4, 5, 6]
  const { passed, total } = countWorkdays(now.getFullYear(), now.getMonth(), wd)
  let forecast = null
  if (passed > 0) { const perDay = earned / passed; forecast = Math.round(perDay * total) }
  const goalPct = goal > 0 && forecast != null ? Math.round(forecast / goal * 100) : null
  const factPct = goal > 0 ? Math.round(earned / goal * 100) : null
  const fc = (n) => fmtSum(n)
  let html = ''
  html += '<div style="display:grid;grid-template-columns:repeat(3,1fr);gap:10px;">'
  html += `<div style="background:var(--card);border:1px solid var(--line);border-radius:10px;padding:11px 12px;">
    <div style="font-size:11px;color:var(--txt2);">${uz ? 'Bugungacha kassa' : 'Заработано сейчас'}</div>
    <div style="font-size:19px;font-weight:700;color:var(--green);margin-top:2px;">${fc(earned)}</div>
    <div style="font-size:10px;color:var(--txt3);">${factPct != null ? (uz ? `maqsadning ${factPct}%` : `${factPct}% от цели`) : ''}</div>
  </div>`
  html += `<div style="background:var(--card);border:1px solid var(--line);border-radius:10px;padding:11px 12px;">
    <div style="font-size:11px;color:var(--txt2);">${uz ? 'Oy oxiriga prognoz' : 'Прогноз к концу месяца'}</div>
    <div style="font-size:19px;font-weight:700;color:var(--accent);margin-top:2px;">${forecast != null ? fc(forecast) : '—'}</div>
    <div style="font-size:10px;color:var(--txt3);">${uz ? `${passed}/${total} ish kuni oʻtdi` : `прошло ${passed} из ${total} раб. дней`}</div>
  </div>`
  html += `<div style="background:var(--card);border:1px solid var(--line);border-radius:10px;padding:11px 12px;cursor:pointer;" onclick="editForecastGoal()" title="${uz ? 'Maqsadni oʻzgartirish' : 'Изменить цель'}">
    <div style="font-size:11px;color:var(--txt2);">${uz ? 'Maqsad ✏️' : 'Цель ✏️'}</div>
    <div style="font-size:19px;font-weight:700;margin-top:2px;">${goal > 0 ? fc(goal) : '—'}</div>
    <div style="font-size:10px;color:var(--txt3);">${goalPct != null ? (uz ? `prognoz: ${goalPct}%` : `прогноз: ${goalPct}%`) : ''}</div>
  </div>`
  html += '</div>'
  if (goal > 0) {
    const fp = Math.min(100, Math.round(earned / goal * 100))
    const pp = Math.min(100, goalPct || 0)
    html += `<div style="margin-top:12px;">
      <div style="height:10px;background:var(--card2);border-radius:6px;overflow:hidden;position:relative;">
        <div style="position:absolute;left:0;top:0;height:100%;width:${pp}%;background:var(--accent);opacity:.3;"></div>
        <div style="position:absolute;left:0;top:0;height:100%;width:${fp}%;background:var(--green);"></div>
      </div>
      <div style="display:flex;justify-content:space-between;font-size:10px;color:var(--txt3);margin-top:4px;">
        <span>${uz ? 'Yashil — bugungacha, ochiq — prognoz' : 'Зелёное — сейчас, светлое — прогноз'}</span>
        <span>${uz ? 'maqsad 100%' : 'цель 100%'}</span>
      </div>
    </div>`
  }
  if (goalPct != null) {
    let verdict, vcolor
    const gap = goal - (forecast || 0)
    const perDayTarget = total > 0 ? goal / total : 0
    const targetToDate = Math.round(perDayTarget * passed)
    const behindNow = targetToDate - earned
    if (behindNow <= 0) { verdict = uz ? '✅ Grafikda yoki oldinda — zoʻr temp!' : '✅ В графике или опережаешь — отличный темп!'; vcolor = 'var(--green)' }
    else if (behindNow <= perDayTarget) { verdict = uz ? '⚠️ Grafikdan biroz ortda' : '⚠️ Немного отстаёшь от графика'; vcolor = 'var(--gold)' }
    else { verdict = uz ? '🔴 Grafikdan ortda qolyapsiz' : '🔴 Отстаёшь от графика'; vcolor = 'var(--red)' }
    html += `<div style="font-size:12px;color:${vcolor};margin-top:10px;font-weight:500;">${verdict}</div>`
    html += `<div style="font-size:12px;color:var(--txt2);margin-top:6px;">
      ${uz ? 'Bugungacha reja' : 'План на сегодня'}: <b>${fc(targetToDate)}</b> · ${uz ? 'aslida' : 'по факту'}: <b>${fc(earned)}</b>${behindNow > 0 ? ` · ${uz ? 'ortda' : 'отстаём на'} <b style="color:var(--red);">${fc(behindNow)}</b>` : ` · ${uz ? 'oldinda' : 'опережаем на'} <b style="color:var(--green);">${fc(-behindNow)}</b>`}
    </div>`
    if (gap > 0) {
      const daysLeft = Math.max(1, total - passed)
      const needPerDay = Math.round((goal - earned) / daysLeft)
      html += `<div style="font-size:12px;color:var(--txt2);margin-top:4px;">
        ${uz ? `Maqsadga chiqish uchun qolgan ${daysLeft} ish kunida kuniga` : `Чтобы выйти на цель — оставшиеся ${daysLeft} раб. дн. по`} <b>${fc(needPerDay)}/${uz ? 'kun' : 'день'}</b>.
      </div>`
    }
    const askCtx = uz
      ? `Oylik maqsadim ${fc(goal)}. Bugungacha reja ${fc(targetToDate)} edi, aslida ${fc(earned)} kassa — ${behindNow > 0 ? `${fc(behindNow)} ortdaman` : 'grafikdaman'}. Oy oxiriga prognoz ${forecast != null ? fc(forecast) : '—'}. ${passed}/${total} ish kuni oʻtdi, ${Math.max(0, total - passed)} kun qoldi. Maqsadga yetish uchun aniq reja ber: nima qilishim kerak, qaysi menejerlarga eʼtibor berish, qaysi lidlarni yopish. Konkret qadamlar bilan.`
      : `Моя цель на месяц ${fc(goal)}. План на сегодня был ${fc(targetToDate)}, по факту заработано ${fc(earned)} — ${behindNow > 0 ? `отстаю на ${fc(behindNow)}` : 'иду в графике'}. Прогноз к концу месяца ${forecast != null ? fc(forecast) : '—'}. Прошло ${passed} из ${total} рабочих дней, осталось ${Math.max(0, total - passed)}. Дай конкретный план, как выйти на цель: что делать, на каких менеджеров нажать, какие лиды закрывать. Пошагово и по делу.`
    html += `<button onclick='askForecastHelp(${JSON.stringify(askCtx)})' style="margin-top:12px;width:100%;padding:10px;border-radius:9px;background:var(--accent);border:none;color:#fff;font-size:13px;font-weight:600;cursor:pointer;display:flex;align-items:center;justify-content:center;gap:7px;">
      <svg class="ic" width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path d="M12 2a7 7 0 0 0-7 7c0 2.4 1.2 4.5 3 5.7V17a1 1 0 0 0 1 1h6a1 1 0 0 0 1-1v-2.3c1.8-1.2 3-3.3 3-5.7a7 7 0 0 0-7-7zM9 21h6"/></svg>
      ${uz ? 'Yordamchidan yechim soʻrash' : 'Спросить помощника, как догнать'}
    </button>`
  }
  box.innerHTML = html
}

function renderVelocity(d) {
  const box = document.getElementById('velocityChart'); if (!box) return
  const v = d && d.velocity
  const uz = state.lang === 'uz'
  if (!v || (v.median == null && (!v.stages || !v.stages.length))) {
    box.innerHTML = '<div style="font-size:12px;color:var(--txt3);">' + (uz ? 'Maʼlumot yoʻq' : 'Нет данных') + '</div>'
    return
  }
  const fmtDays = (n) => {
    if (n == null) return '—'
    if (n < 1) return uz ? '<1 kun' : '<1 дня'
    const r = Math.round(n)
    return r + ' ' + (uz ? 'kun' : (r % 10 === 1 && r % 100 !== 11 ? 'день' : (r % 10 >= 2 && r % 10 <= 4 && (r % 100 < 10 || r % 100 >= 20) ? 'дня' : 'дней')))
  }
  let html = '<div style="display:grid;grid-template-columns:1fr 1fr;gap:10px;margin-bottom:14px;">'
  html += `<div style="background:var(--card);border:1px solid var(--line);border-radius:10px;padding:11px 13px;">
    <div style="font-size:11.5px;color:var(--txt2);">${uz ? 'Median: lid → sotuv' : 'Медиана: лид → продажа'}</div>
    <div style="font-size:20px;font-weight:700;color:var(--accent);margin-top:2px;">${fmtDays(v.median)}</div>
    <div style="font-size:10.5px;color:var(--txt3);">${uz ? 'odatda shuncha vaqt' : 'обычно столько идёт сделка'}</div>
  </div>`
  html += `<div style="background:var(--card);border:1px solid var(--line);border-radius:10px;padding:11px 13px;">
    <div style="font-size:11.5px;color:var(--txt2);">${uz ? 'Oʻrtacha vaqt' : 'Среднее время'}</div>
    <div style="font-size:20px;font-weight:700;margin-top:2px;">${fmtDays(v.avg)}</div>
    <div style="font-size:10.5px;color:var(--txt3);">${v.count || 0} ${uz ? 'sotuv boʻyicha' : 'сделок в расчёте'}</div>
  </div>`
  html += '</div>'
  const stages = (v.stages || []).filter((s) => s.name)
  if (stages.length) {
    const max = Math.max(1, ...stages.map((s) => s.count))
    html += `<div style="font-size:12px;font-weight:600;color:var(--txt2);margin-bottom:8px;">${uz ? 'Ochiq lidlar bosqichlar boʻyicha' : 'Открытые лиды по этапам'}</div>`
    html += stages.map((s) => `
      <div style="margin-bottom:8px;">
        <div style="display:flex;justify-content:space-between;font-size:12px;margin-bottom:3px;">
          <span style="color:var(--txt);">${escapeHtml(s.name)}</span>
          <span style="color:var(--txt2);font-weight:600;">${s.count}</span>
        </div>
        <div style="height:7px;background:var(--card2);border-radius:6px;overflow:hidden;">
          <div style="height:100%;width:${Math.round(s.count / max * 100)}%;background:var(--accent);border-radius:6px;"></div>
        </div>
      </div>`).join('')
    html += `<div style="font-size:11px;color:var(--txt3);margin-top:8px;">${uz ? 'Katta ustun — lidlar shu bosqichda toʻplanib qolgan (torlik).' : 'Длинная полоса — лиды скопились на этом этапе (узкое место).'}</div>`
  }
  box.innerHTML = html
}

function renderPlanFact(d) {
  const box = document.getElementById('planFactChart'); if (!box) return
  const mops = d.mopsBySales || []
  if (!mops.length) { box.innerHTML = '<div style="font-size:12px;color:var(--txt3);">Нет данных. Обновите из amoCRM.</div>'; return }
  const goal = getGoal()
  const list = [...mops].sort((a, b) => (b.revenue || 0) - (a.revenue || 0))
  const fallbackPer = Math.max(1, Math.round(goal / list.length)) // если личный план МОПа не задан
  const totalPlan = list.reduce((s, m) => s + (m.plan > 0 ? m.plan : fallbackPer), 0)
  const uz = state.lang === 'uz'
  box.innerHTML = list.map((m) => {
    const planV = m.plan > 0 ? m.plan : fallbackPer // личный план МОПа (из кабинета)
    const fact = m.revenue || 0
    const pct = Math.round(fact / planV * 100)
    const color = pct >= 100 ? 'var(--green)' : (pct >= 50 ? 'var(--accent)' : 'var(--red)')
    return `<div style="padding:10px 0;border-top:1px solid var(--line);">
      <div style="display:flex;align-items:center;gap:10px;">
        <div class="mop-name" style="width:120px;">${escapeHtml(m.name)}</div>
        <div class="mop-bar-wrap"><div class="mop-bar" style="width:${Math.min(100, pct)}%;background:${color};"></div></div>
        <div class="mop-val" style="color:${color};white-space:nowrap;">${fmtSum(fact)} / ${fmtSum(planV)}</div>
      </div>
      <div style="font-size:11px;color:var(--txt3);margin-top:3px;margin-left:130px;">${uz ? 'reja bajarilishi' : 'выполнение плана'}: ${pct}%</div>
    </div>`
  }).join('') + `<div style="font-size:11px;color:var(--txt3);margin-top:9px;">${uz ? 'Umumiy reja' : 'Общий план'}: ${fmtSum(totalPlan)}</div>`
}

async function loadOverviewExtras() {
  if (!overviewExtrasLoaded) {
    overviewExtrasLoaded = true
    try { const r = await fetch('/api/finance', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ session: getSession() }) }); ovFinMonth = await r.json() } catch (e) { ovFinMonth = null }
    try { const r = await fetch('/api/finance', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ action: 'year', session: getSession() }) }); const d = await r.json(); ovFinYear = (d && d.ok) ? d.year : null } catch (e) { ovFinYear = null }
  }
  renderOverviewMoney()
}

function renderOverviewMoney() {
  const uz = state.lang === 'uz'
  const per = window._dashPeriod || 'month'
  const fmt = (n) => n == null ? '—' : fmtCur(n, uz)
  const set = (id, v) => { const e = document.getElementById(id); if (e) e.textContent = v }
  let profShown, profH
  if (per === 'all' && ovFinYear && ovFinYear.length) {
    profShown = ovFinYear.reduce((a, y) => a + (y.profit || 0), 0)
    profH = uz ? 'butun davr' : 'за всё время'
  } else {
    profShown = ovFinMonth && ovFinMonth.ok ? ovFinMonth.profit : null
    profH = uz ? 'shu oy' : 'этот месяц'
  }
  set('kpiProfit', profShown != null ? fmtSum(profShown) : '—')
  const pk = document.getElementById('kpiProfit'); if (pk) pk.style.color = (profShown != null && profShown < 0) ? 'var(--red)' : ''
  const ph = document.getElementById('ovProfitH'); if (ph) ph.textContent = profH
  const box = document.getElementById('overviewSalesSum')
  const lbl = document.getElementById('ovSalesSumLbl')
  const dt = window._dashData && window._dashData.totals
  if (per === 'all') {
    if (lbl) lbl.textContent = uz ? 'Sotuvlar summasi (butun davr)' : 'Сумма продаж (всё время)'
    const total = dt && dt.revenueAll != null ? dt.revenueAll : null
    const cnt = dt && dt.soldAll != null ? dt.soldAll : null
    if (box) box.innerHTML = `<div style="font-size:24px;font-weight:700;color:var(--accent);">${fmt(total)}</div>
        <div style="font-size:11px;color:var(--txt3);margin-top:4px;">${cnt != null ? cnt + (uz ? ' ta sotuv · ' : ' продаж · ') : ''}${uz ? 'amoCRM, butun baza' : 'amoCRM, вся база'}</div>`
  } else {
    if (lbl) lbl.textContent = uz ? 'Sotuvlar summasi (shu oy)' : 'Сумма продаж (текущий месяц)'
    const rev = dt && dt.revenue != null ? dt.revenue : null
    const cnt = dt && dt.sold != null ? dt.sold : null
    if (box) box.innerHTML = `<div style="font-size:24px;font-weight:700;color:var(--accent);">${fmt(rev)}</div>
        <div style="font-size:11px;color:var(--txt3);margin-top:4px;">${cnt != null ? cnt + (uz ? ' ta sotuv · ' : ' продаж · ') : ''}${uz ? 'amoCRM, shu oy' : 'amoCRM, этот месяц'}</div>`
  }
}

function renderSignals(d) {
  const box = document.getElementById('signalsBox'); if (!box) return
  const t = d.totals || {}
  const uz = state.lang === 'uz'
  const sig = []
  if (t.noContactPct >= 30) sig.push({ lvl: 'red', txt: uz ? `Aloqagacha yo‘qotish ${t.noContactPct}% — lidlar suhbatsiz yo‘qolyapti` : `Потеря до контакта ${t.noContactPct}% — лиды гибнут без разговора` })
  if (t.conv > 0 && t.conv < 2) sig.push({ lvl: 'red', txt: uz ? `Jamoa konversiyasi ${t.conv}% — juda past` : `Конверсия команды ${t.conv}% — очень низкая` })
  const zero = (d.mopsBySales || []).filter((m) => m.sold === 0 && m.leads > 3)
  if (zero.length) sig.push({ lvl: 'red', txt: uz ? `${zero.map((m) => m.name).join(', ')} — 0 sotuv, lidlar bor` : `${zero.map((m) => m.name).join(', ')} — 0 продаж при наличии лидов` })
  const _goal = getGoal(), _earned = t.revenue || 0
  const _goalPct = _goal > 0 ? Math.round(_earned / _goal * 100) : null
  if (_goalPct != null && _goalPct < 40) {
    const day = new Date().getDate()
    if (day > 10) sig.push({ lvl: 'orange', txt: uz ? `Oy o‘rtasi, maqsadning ${_goalPct}%i bajarildi — sur'atni oshiring` : `Середина месяца, цель выполнена на ${_goalPct}% — нужно ускоряться` })
  }
  const topProb = (d.problems || [])[0]
  if (topProb && topProb.count > 1000) sig.push({ lvl: 'orange', txt: uz ? `«${topProb.name}» — ${topProb.count} lid yo‘qoldi, alohida ishlash kerak` : `«${topProb.name}» — ${topProb.count} потерянных лидов, нужна отдельная работа` })
  const sp = (d.speed && d.speed.mops) || []
  const dashM = d.mopsByConv || []
  const reachOf = (name) => { const dm = dashM.find((x) => x.name === name); return (dm && dm.reachPct != null) ? dm.reachPct : null }
  const lowReach = [], lateCall = [], fewTask = [], badDone = []
  sp.forEach((m) => {
    const r = reachOf(m.name)
    if (r != null && r < 40) lowReach.push(`${m.name} (${r}%)`)
    if (m.medianFirstCallMin != null && m.medianFirstCallMin > 180) lateCall.push(`${m.name} (${fmtMin(m.medianFirstCallMin)})`)
    if (m.taskRate != null && m.reached > 0 && m.taskRate < 50) fewTask.push(`${m.name} (${m.taskRate}%)`)
    if (m.tasksTotal > 0 && m.tasksDonePct != null && m.tasksDonePct < 50) badDone.push(`${m.name} (${m.tasksDonePct}%)`)
  })
  if (lowReach.length) sig.push({ lvl: 'red', txt: (uz ? 'Past dozvon: ' : 'Низкий дозвон: ') + lowReach.join(', ') })
  if (lateCall.length) sig.push({ lvl: 'orange', txt: (uz ? 'Kech 1-qo‘ng‘iroq: ' : 'Поздний 1-й звонок: ') + lateCall.join(', ') })
  if (fewTask.length) sig.push({ lvl: 'orange', txt: (uz ? 'Kam vazifa qo‘yiladi: ' : 'Мало задач после разговора: ') + fewTask.join(', ') })
  if (badDone.length) sig.push({ lvl: 'orange', txt: (uz ? 'Vazifalar bajarilmagan: ' : 'Задачи не выполнены: ') + badDone.join(', ') })
  if (!sig.length) {
    box.innerHTML = `<div style="background:var(--green-bg);border:1px solid var(--green);border-radius:11px;padding:12px 14px;margin-bottom:14px;font-size:13px;color:var(--green);">${uz ? '✓ Kritik signallar yo‘q — hammasi joyida' : '✓ Критичных сигналов нет — всё под контролем'}</div>`
    return
  }
  box.innerHTML = `<div style="margin-bottom:14px;">
    <div style="font-size:12px;color:var(--txt3);text-transform:uppercase;letter-spacing:.4px;margin-bottom:8px;">${uz ? 'Signallar' : 'Сигналы'} (${sig.length})</div>
    ${sig.map((s) => {
      const c = s.lvl === 'red' ? 'var(--red)' : 'var(--gold)'
      const bg = s.lvl === 'red' ? 'var(--red-bg)' : 'var(--gold-bg)'
      return `<div style="display:flex;gap:9px;align-items:flex-start;background:${bg};border:1px solid ${c};border-radius:10px;padding:10px 12px;margin-bottom:7px;">
        <div style="width:7px;height:7px;border-radius:50%;background:${c};margin-top:5px;flex:0 0 auto;"></div>
        <div style="font-size:13px;color:var(--txt);line-height:1.45;">${escapeHtml(s.txt)}</div>
      </div>`
    }).join('')}
  </div>`
}

export function setDiscPeriodReal(per) {
  _discPeriod = per
  const m = document.getElementById('disc-per-month'), t = document.getElementById('disc-per-today')
  if (m) m.classList.toggle('on', per === 'month'); if (t) t.classList.toggle('on', per === 'today')
  if (_discData) renderDiscipline(_discData)
}

function renderDiscipline(sp) {
  _discData = sp
  const uz = state.lang === 'uz'
  const isToday = _discPeriod === 'today'
  const chart = document.getElementById('disciplineChart'); if (!chart) return
  if (isToday && !Array.isArray(sp.mopsDay)) {
    chart.innerHTML = '<div style="font-size:12px;color:var(--gold);padding:4px 0;">' + (uz ? '«Intizomni yangilash»ni bosing — bugungi maʼlumot hali yuklanmagan' : 'Нажмите «Обновить дисциплину» — данные за сегодня ещё не загружены') + '</div>'
    return
  }
  const mops = isToday ? (sp.mopsDay || []) : (sp.mops || [])
  if (!mops.length) { chart.innerHTML = '<div style="font-size:12px;color:var(--txt3);">' + (isToday ? (uz ? 'Bugun uchun maʼlumot yoʻq' : 'Сегодня ещё нет обработанных лидов') : (uz ? 'Oy uchun maʼlumot yoʻq' : 'Нет данных за месяц')) + '</div>'; return }
  chart.innerHTML = mops.map((m) => {
    const speedOk = m.medianFirstCallMin != null && m.medianFirstCallMin <= 30
    const speedBad = m.medianFirstCallMin != null && m.medianFirstCallMin > 180
    const taskOk = m.taskRate >= 60
    let reach
    if (isToday) { reach = m.reachedPct } else {
      reach = m.reachedPct
      const dashMops = (window._dashData && window._dashData.mopsByConv) || []
      const dm = dashMops.find((x) => x.name === m.name)
      if (dm && dm.reachPct != null) reach = dm.reachPct
    }
    const reachOk = (reach || 0) >= 60
    const reachBad = (reach || 0) < 30
    const doneOk = (m.tasksDonePct || 0) >= 70
    const doneBad = (m.tasksDonePct || 0) < 40
    const c = (ok, bad) => ok ? 'var(--green)' : (bad ? 'var(--red)' : 'var(--txt2)')
    const doneDisplay = m.tasksTotal ? `${m.tasksDonePct}% <span style="color:var(--txt3);font-weight:400;">(${m.tasksDone} из ${m.tasksTotal})</span>` : '<span style="color:var(--txt3);font-weight:400;">нет задач</span>'
    let reachAbs = '', fakeNote = ''
    if (isToday) {
      if (m.reached != null && m.leads) reachAbs = ` <span style="font-size:10px;color:var(--txt3);">(${m.reached} из ${m.leads})</span>`
      const fnD = m.fakeNums || 0 // нереальные номера сегодня (неверный номер + дубль), исключены из дневного знаменателя дозвона
      if (fnD) fakeNote = ` <span style="font-size:10px;color:var(--txt3);">· ${fnD} ${uz ? 'notoʻgʻri raqam' : 'нереальных номеров'}</span>`
    } else if (!isToday) {
      const dashMops = (window._dashData && window._dashData.mopsByConv) || []
      const dm = dashMops.find((x) => x.name === m.name)
      const denom = (dm && dm.reachDenom != null) ? dm.reachDenom : (dm ? dm.leads : m.leads) // знаменатель дозвона = реальные лиды (без брака)
      if (dm && dm.reached != null && denom) { reachAbs = ` <span style="font-size:10px;color:var(--txt3);">(${dm.reached} из ${denom})</span>` } else if (m.reached != null && m.leads) { reachAbs = ` <span style="font-size:10px;color:var(--txt3);">(${m.reached} из ${m.leads})</span>` }
      const fn = (dm && dm.fakeNums) || 0 // нереальные номера (Xato raqam + Dubl), исключены из знаменателя — показываем отдельно, не прячем
      if (fn) fakeNote = ` <span style="font-size:10px;color:var(--txt3);">· ${fn} ${uz ? 'notoʻgʻri raqam' : 'нереальных номеров'}</span>`
    }
    const reachCell = isToday
      ? `<div>📞 % дозвона${hintIcon('reach')}: <b style="color:${reach != null ? c(reachOk, reachBad) : 'var(--txt3)'}">${reach != null ? reach + '%' : '—'}</b>${reachAbs}${m.calledLeads != null ? ` <span style="font-size:10px;color:var(--txt3);">· звонили ${m.calledLeads}</span>` : ''}${fakeNote}</div>`
      : `<div>📞 % дозвона${hintIcon('reach')}: <b style="color:${reach != null ? c(reachOk, reachBad) : 'var(--txt3)'}">${reach != null ? reach + '%' : '—'}</b>${reachAbs}${fakeNote}</div>`
    return `<div style="background:var(--card);border:1px solid var(--line);border-radius:10px;padding:11px 12px;margin-bottom:9px;">
      <div style="font-size:14px;font-weight:600;margin-bottom:7px;">${escapeHtml(m.name)} <span style="font-size:11px;color:var(--txt3);font-weight:400;">· ${m.leads} ${uz ? 'lid' : 'лидов'}</span></div>
      <div style="display:grid;grid-template-columns:1fr 1fr;gap:6px 12px;font-size:12px;">
        <div>⚡ 1-й звонок (создание)${hintIcon('firstcall')}: <b style="color:${c(speedOk, speedBad)}">${fmtMin(m.medianFirstCallMin)}</b></div>
        <div>⚡ 1-й звонок (назначение): <b style="color:${m.medianFirstCallAssignMin != null ? c(m.medianFirstCallAssignMin <= 30, m.medianFirstCallAssignMin > 180) : 'var(--txt3)'}">${m.medianFirstCallAssignMin != null ? fmtMin(m.medianFirstCallAssignMin) : '—'}</b></div>
        ${reachCell}
        <div>📋 Ставит задачи${hintIcon('tasks')}: <b style="color:${c(taskOk, m.taskRate < 30)}">${m.taskRate}%</b></div>
        <div>✅ Задач выполнено${hintIcon('tasksdone')}: <b style="color:${m.tasksTotal ? c(doneOk, doneBad) : 'var(--txt3)'}">${doneDisplay}</b></div>
      </div>
    </div>`
  }).join('')
}

// ===== ПОДОЗРИТЕЛЬНЫЕ (счётчики) =====
export function applySuspicious(d) {
  const fromSync = (d && d.suspicious) || []
  const fromSpeed = (d && d.speed && d.speed.suspicious2) || []
  suspData = fromSync.concat(fromSpeed)
  loadSuspReviewed()
  loadOrgSettings()
  loadMetaSpend()
}

async function loadSuspReviewed() {
  if (!getSession()) return
  try {
    const r = await fetch('/api/user-data', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ action: 'susp-status', session: getSession() }) })
    const d = await r.json()
    suspReviewed = (d && d.reviewed) || {}
  } catch (e) { suspReviewed = {} }
  updateSuspCount()
}

function updateSuspCount() {
  const active = suspData.filter((s) => !suspReviewed[s.id])
  const el = document.getElementById('suspCount')
  if (el) { el.textContent = active.length; el.style.background = active.length ? 'var(--red-bg)' : 'var(--card2)'; el.style.color = active.length ? 'var(--red)' : 'var(--txt3)' }
  ;['money', 'calls', 'funnel', 'tasks'].forEach((cat) => {
    const n = active.filter((s) => (s.cat || 'money') === cat).length
    const tile = document.getElementById('suspN-' + cat)
    if (tile) { tile.textContent = n; tile.style.background = n ? 'var(--red-bg)' : 'var(--card2)'; tile.style.color = n ? 'var(--red)' : 'var(--txt3)' }
  })
}

// loadOrgSettings — подтягивает сохранённые настройки (цель/рабочие дни) для прогноза.
async function loadOrgSettings() {
  if (!getSession()) return
  try {
    const r = await fetch('/api/user-data', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ action: 'settings-get', session: getSession() }) })
    const d = await r.json()
    if (d && d.ok && d.settings) {
      orgSettings = { ...orgSettings, ...d.settings }
      if (_lastDashData) renderForecast(_lastDashData)
    }
  } catch (e) { /* ignore */ }
}

// setDashPeriod с перерисовкой (замена визуальной заглушки, когда данные есть)
export function setDashPeriodReal(per) {
  window._dashPeriod = per
  ;['per', 'tr-per', 'mk-per', 'sl-per'].forEach((pfx) => {
    const m = document.getElementById(pfx + '-month'), a = document.getElementById(pfx + '-all')
    if (m) m.classList.toggle('on', per === 'month')
    if (a) a.classList.toggle('on', per === 'all')
  })
  const ml = document.getElementById('mkLeadsLbl')
  if (ml) ml.textContent = per === 'all' ? (state.lang === 'uz' ? 'Lidlar (butun davr)' : 'Лидов (всё время)') : (state.lang === 'uz' ? 'Oylik lidlar' : 'Лидов за месяц')
  if (window._dashData) applyLiveDash(window._dashData)
  renderOverviewMoney()
  // динамика реагирует на период (месяц/всё время)
  const trendsGrp = document.getElementById('dg-trends')
  if (trendsGrp && trendsGrp.style.display !== 'none' && typeof window.renderTrendsPeriod === 'function') window.renderTrendsPeriod()
}

// ===== НАСТРОЙКИ ОРГАНИЗАЦИИ =====
async function saveOrgSettings(partial) {
  try {
    await fetch('/api/user-data', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ action: 'settings-set', session: getSession(), settings: partial }) })
  } catch (e) { /* ignore */ }
}
function editForecastGoal() {
  const uz = state.lang === 'uz'
  const cur = orgSettings.goal || getGoal()
  const inp = prompt(uz ? 'Oylik maqsad (summa, soʻm):' : 'Цель по выручке на месяц (сум):', cur)
  if (inp === null) return
  const cleaned = parseInt(String(inp).replace(/[^0-9]/g, ''), 10)
  if (!cleaned || cleaned <= 0) { alert(uz ? 'Nol emas, masalan 250000000' : 'Введите число больше нуля, например 250000000'); return }
  orgSettings.goal = cleaned
  state.goal = cleaned; save()
  saveOrgSettings({ goal: cleaned })
  renderForecast(_lastDashData)
}

// ===== МОДАЛКА: ПОДОЗРИТЕЛЬНЫЕ =====
const AMO_BASE = 'https://huntercademy.amocrm.ru/leads/detail/'
let suspCatFilter = null
let suspHistoryMode = false
function fmtSuspSum(n) { return n ? fmtCur(n, state.lang === 'uz') : 'нет бюджета' }
function fmtSuspDate(unix) { if (!unix) return ''; const d = new Date(unix * 1000); return d.toLocaleDateString('ru-RU') }
function openSuspModal(cat) { suspCatFilter = cat || null; suspHistoryMode = false; document.getElementById('suspOverlay').style.display = 'block'; renderSuspModal() }
function closeSuspModal() { document.getElementById('suspOverlay').style.display = 'none' }
function toggleSuspHistory() { suspHistoryMode = !suspHistoryMode; renderSuspModal() }
function renderSuspModal() {
  const body = document.getElementById('suspModalBody')
  const title = document.getElementById('suspModalTitle')
  const histBtn = document.getElementById('suspHistBtn')
  if (!body) return
  if (suspHistoryMode) {
    title.textContent = 'История проверок'
    histBtn.textContent = '← Назад'
    const hist = Object.entries(suspReviewed).map(([id, v]) => ({ id, ...v })).sort((a, b) => (b.at || 0) - (a.at || 0))
    if (!hist.length) { body.innerHTML = '<div style="font-size:13px;color:var(--txt3);padding:20px;text-align:center;">История пуста</div>'; return }
    body.innerHTML = hist.map((h) => {
      const dd = h.deal || {}
      const stColor = h.status === 'checked' ? 'var(--green)' : 'var(--txt3)'
      const stText = h.status === 'checked' ? 'Проверено' : 'Отклонено'
      return `<div style="padding:12px 0;border-bottom:1px solid var(--line);">
        <div style="display:flex;justify-content:space-between;gap:8px;">
          <b style="font-size:13.5px;">${escapeHtml(dd.name || ('Сделка ' + h.id))}</b>
          <span style="font-size:11.5px;color:${stColor};font-weight:600;white-space:nowrap;">${stText}</span>
        </div>
        <div style="font-size:12px;color:var(--txt3);margin-top:3px;">${fmtSuspSum(dd.price)} · ${escapeHtml(dd.responsible || '')} · ${fmtSuspDate(dd.closed_at || dd.created_at)}</div>
        ${h.note ? `<div style="font-size:12.5px;color:var(--txt2);margin-top:6px;background:var(--card);border-radius:8px;padding:8px 10px;">📝 ${escapeHtml(h.note)}</div>` : ''}
        <div style="font-size:10.5px;color:var(--txt3);margin-top:4px;">${new Date(h.at).toLocaleString('ru-RU')}</div>
      </div>`
    }).join('')
    return
  }
  title.textContent = 'Подозрительные действия'
  histBtn.textContent = 'История'
  const active = suspData.filter((s) => !suspReviewed[s.id])
  if (!active.length) {
    body.innerHTML = '<div style="font-size:13px;color:var(--txt3);padding:20px;text-align:center;">Нет активных подозрительных действий 👍<br><span style="font-size:11.5px;">Проверенные — в «Истории»</span></div>'
    return
  }
  const cats = [
    { key: 'money', title: '💰 По продажам и деньгам' },
    { key: 'calls', title: '📞 По звонкам и активности' },
    { key: 'funnel', title: '🔀 По воронке' },
    { key: 'tasks', title: '✓ По задачам' },
  ]
  const showCats = suspCatFilter ? cats.filter((c) => c.key === suspCatFilter) : cats
  if (suspCatFilter) { const cinfo = cats.find((c) => c.key === suspCatFilter); if (cinfo) title.textContent = cinfo.title }
  let html = ''
  let totalShown = 0
  for (const c of showCats) {
    const items = active.filter((s) => (s.cat || 'money') === c.key)
    if (!items.length) continue
    totalShown += items.length
    if (!suspCatFilter) html += `<div style="font-size:12px;font-weight:700;color:var(--txt2);text-transform:uppercase;letter-spacing:.3px;margin:16px 0 6px;">${c.title} <span style="color:var(--red);">(${items.length})</span></div>`
    html += items.map((s) => suspCardHtml(s)).join('')
  }
  if (!totalShown) { body.innerHTML = '<div style="font-size:13px;color:var(--txt3);padding:20px;text-align:center;">В этой категории нет активных 👍</div>'; return }
  body.innerHTML = html
}
function suspCardHtml(s) {
  const priceStr = s.price == null ? '' : `<span style="font-size:13px;font-weight:700;color:var(--red);white-space:nowrap;">${fmtSuspSum(s.price)}</span>`
  const amoLink = String(s.id).match(/^\d+$/) ? `<a href="${AMO_BASE}${s.id}" target="_blank" style="display:inline-block;margin-top:8px;font-size:12.5px;color:var(--accent);text-decoration:none;">Открыть в amoCRM →</a>` : (s.leadId ? `<a href="${AMO_BASE}${s.leadId}" target="_blank" style="display:inline-block;margin-top:8px;font-size:12.5px;color:var(--accent);text-decoration:none;">Открыть сделку →</a>` : '')
  return `<div style="padding:14px 0;border-bottom:1px solid var(--line);" id="susp-${s.id}">
    <div style="display:flex;justify-content:space-between;gap:8px;">
      <b style="font-size:13.5px;">${escapeHtml(s.name || ('Сделка ' + s.id))}</b>
      ${priceStr}
    </div>
    ${s.label ? `<div style="font-size:11px;color:var(--gold);margin-top:2px;">${escapeHtml(s.label)}</div>` : ''}
    <div style="font-size:12px;color:var(--txt3);margin-top:3px;">${escapeHtml(s.responsible || '')} · ${fmtSuspDate(s.closed_at || s.created_at)}</div>
    ${amoLink}
    <div style="margin-top:10px;">
      <textarea id="note-${s.id}" placeholder="Примечание (что выяснилось)..." style="width:100%;box-sizing:border-box;padding:8px 10px;border-radius:8px;border:1px solid var(--line2);background:var(--card);color:var(--txt);font-size:12.5px;resize:vertical;min-height:38px;"></textarea>
    </div>
    <div style="display:flex;gap:8px;margin-top:8px;">
      <button onclick="reviewSusp('${s.id}','checked')" style="flex:1;padding:9px;border-radius:8px;background:var(--green);border:none;color:#fff;font-size:12.5px;font-weight:600;cursor:pointer;">Проверено</button>
      <button onclick="reviewSusp('${s.id}','rejected')" style="flex:1;padding:9px;border-radius:8px;background:var(--card);border:1px solid var(--line2);color:var(--txt2);font-size:12.5px;font-weight:600;cursor:pointer;">Отклонить</button>
    </div>
  </div>`
}
async function reviewSusp(id, status) {
  const note = (document.getElementById('note-' + id) || {}).value || ''
  const deal = suspData.find((s) => String(s.id) === String(id)) || null
  suspReviewed[id] = { status, note, at: Date.now(), by: getRole(), deal }
  const row = document.getElementById('susp-' + id); if (row) row.style.display = 'none'
  updateSuspCount(); renderSuspModal()
  try {
    await fetch('/api/user-data', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ action: 'susp-review', session: getSession(), dealId: id, status, note, deal }) })
  } catch (e) { /* ignore */ }
}

// ===== МОДАЛКА: РАБОЧИЕ ДНИ =====
const DAY_NAMES_RU = ['Воскресенье', 'Понедельник', 'Вторник', 'Среда', 'Четверг', 'Пятница', 'Суббота']
const DAY_NAMES_UZ = ['Yakshanba', 'Dushanba', 'Seshanba', 'Chorshanba', 'Payshanba', 'Juma', 'Shanba']
const DAY_ORDER = [1, 2, 3, 4, 5, 6, 0]
function openWorkdaysModal() {
  const uz = state.lang === 'uz'
  document.getElementById('wdTitle').textContent = uz ? 'Ish kunlari' : 'Рабочие дни'
  document.getElementById('wdHint').textContent = uz ? 'Ish kunlarini belgilang — prognoz faqat shularni hisobga oladi.' : 'Отметьте рабочие дни — прогноз будет учитывать только их.'
  document.getElementById('wdSaveBtn').textContent = uz ? 'Saqlash' : 'Сохранить'
  const names = uz ? DAY_NAMES_UZ : DAY_NAMES_RU
  const wd = orgSettings.workdays || []
  document.getElementById('wdDays').innerHTML = DAY_ORDER.map((dn) => `
    <label style="display:flex;align-items:center;gap:10px;padding:9px 12px;border-radius:9px;border:1px solid var(--line2);background:var(--card);cursor:pointer;font-size:13.5px;">
      <input type="checkbox" value="${dn}" ${wd.includes(dn) ? 'checked' : ''} style="width:17px;height:17px;cursor:pointer;accent-color:var(--accent);">
      <span>${names[dn]}</span>
    </label>`).join('')
  document.getElementById('whStart').value = orgSettings.workStart || '10:00'
  document.getElementById('whEnd').value = orgSettings.workEnd || '20:00'
  document.getElementById('workdaysOverlay').style.display = 'block'
}
function closeWorkdaysModal() { document.getElementById('workdaysOverlay').style.display = 'none' }
async function saveWorkdays() {
  const checks = document.querySelectorAll('#wdDays input[type=checkbox]:checked')
  const days = Array.from(checks).map((c) => parseInt(c.value, 10))
  if (!days.length) { alert(state.lang === 'uz' ? 'Kamida bitta kun tanlang' : 'Выберите хотя бы один день'); return }
  orgSettings.workdays = days
  const ws = document.getElementById('whStart').value || '10:00'
  const we = document.getElementById('whEnd').value || '20:00'
  orgSettings.workStart = ws; orgSettings.workEnd = we
  await saveOrgSettings({ workdays: days, workStart: ws, workEnd: we })
  closeWorkdaysModal()
  renderForecast(_lastDashData)
}

// ===== СИНХРОНИЗАЦИЯ С amoCRM =====
let syncingAll = false
async function syncAll() {
  if (syncingAll) return
  syncingAll = true
  const icon = document.getElementById('dashSyncIcon')
  const lbl = document.getElementById('topSyncLbl')
  if (icon) icon.classList.add('spinning')
  if (lbl) lbl.textContent = 'Обновляю...'
  try {
    // unified-org (кастомная CRM): данные приходят не из amoCRM, а через ingest — тянем Pull из мостика клиента.
    const unified = !!(window._dashData && window._dashData.speed && window._dashData.speed._source === 'unified')
    if (unified) {
      const r = await fetch('/api/ingest?action=ingest_pull&org=' + encodeURIComponent(getOrg()) + '&session=' + encodeURIComponent(getSession()))
      const d = await r.json()
      if (d && d.ok) {
        if (typeof window.__reloadDashboard === 'function') await window.__reloadDashboard()
        if (lbl) lbl.textContent = d.isComplete ? 'Готово ✓' : 'Частично: мостик отдал неполные данные'
      } else {
        if (lbl) lbl.textContent = (d && d.error) ? ('Мостик: ' + d.error) : 'Нет связи с мостиком'
      }
      if (icon) icon.classList.remove('spinning')
      setTimeout(() => { if (lbl) lbl.textContent = 'Обновить'; syncingAll = false }, 2500)
      return
    }
    const r = await fetch('/api/sync' + orgQ())
    const d = await r.json()
    if (d && d.ok && typeof window.__reloadDashboard === 'function') await window.__reloadDashboard()
    if (lbl) lbl.textContent = 'Дисциплина...'
    const r2 = await fetch('/api/sync-speed' + orgQ())
    const d2 = await r2.json()
    if (d2 && d2.ok) {
      renderDiscipline(d2)
      if (window._dashData) { window._dashData.speed = d2; renderSignals(window._dashData) }
      if (d2.suspicious2) {
        const fromSync = suspData.filter((s) => ['money', 'tasks'].includes(s.cat) || s.type === 'same_day_sale' || s.type === 'wrong_number_abuse')
        suspData = fromSync.concat(d2.suspicious2); updateSuspCount()
      }
    }
    if (lbl) lbl.textContent = 'Готово ✓'
  } catch (e) {
    if (lbl) lbl.textContent = 'Нет связи'
  }
  if (icon) icon.classList.remove('spinning')
  setTimeout(() => { if (lbl) lbl.textContent = 'Обновить'; syncingAll = false }, 2500)
}

// ===== МАРКЕТИНГ: ИСТОЧНИКИ РЕКЛАМЫ (adset) + ROI/ROAS из Meta =====
let _adsetsExpanded = false
let _metaSpend = null
let _autoMargin = null
let _autoMarginTried = false
function toggleAdsets() { _adsetsExpanded = !_adsetsExpanded; renderAdsets(_lastDashData) }
async function loadMetaSpend() {
  try {
    const r = await fetch('/api/meta-ads?action=get')
    const d = await r.json()
    if (d && d.ok) { _metaSpend = d; renderAdsets(_lastDashData) }
  } catch (e) { /* ignore */ }
}
async function refreshMetaSpend() {
  const btn = document.getElementById('metaRefreshBtn')
  const uz = state.lang === 'uz'
  if (btn) { btn.disabled = true; btn.textContent = uz ? 'Yuklanmoqda...' : 'Загрузка...' }
  try {
    const r = await fetch('/api/meta-ads?action=refresh')
    const d = await r.json()
    if (d && d.ok) { _metaSpend = d; renderAdsets(_lastDashData) }
    else alert((uz ? 'Xatolik: ' : 'Ошибка: ') + ((d && d.error) || '—'))
  } catch (e) { alert(String(e)) }
  if (btn) { btn.disabled = false; btn.textContent = uz ? 'Xarajatlarni yangilash' : 'Обновить расходы' }
}
function fmtRoi(rev, spend) { if (!spend || spend <= 0) return null; return (rev / spend) }
function editMargin() {
  const uz = state.lang === 'uz'
  const cur = orgSettings.margin != null ? orgSettings.margin : ''
  const inp = prompt(uz ? 'Sof foyda marjasi (%): sotuvdan necha % foyda qoladi?' : 'Маржа прибыли (%): сколько % прибыли остаётся с продажи?', cur)
  if (inp === null) return
  const m = parseFloat(String(inp).replace(/[^0-9.]/g, ''))
  if (isNaN(m) || m < 0 || m > 100) { alert(uz ? '0 dan 100 gacha son kiriting' : 'Введите число от 0 до 100'); return }
  orgSettings.margin = m
  saveOrgSettings({ margin: m })
  renderAdsets(_lastDashData)
}
function editAdSpend() {
  const uz = state.lang === 'uz'
  const per = window._dashPeriod || 'month'
  const isAll = per === 'all'
  const cur = isAll ? (orgSettings.adSpendAll || '') : (orgSettings.adSpendMonth || '')
  const label = isAll ? (uz ? 'Reklama xarajati (BUTUN DAVR, soʻm):' : 'Расход на рекламу (ВСЁ ВРЕМЯ, сум):')
    : (uz ? 'Reklama xarajati (SHU OY, soʻm):' : 'Расход на рекламу (ТЕКУЩИЙ МЕСЯЦ, сум):')
  const inp = prompt(label, cur)
  if (inp === null) return
  const s = parseInt(String(inp).replace(/[^0-9]/g, ''), 10)
  if (!s || s <= 0) { alert(uz ? 'Nol emas' : 'Введите число больше нуля'); return }
  if (isAll) { orgSettings.adSpendAll = s; saveOrgSettings({ adSpendAll: s }) }
  else { orgSettings.adSpendMonth = s; saveOrgSettings({ adSpendMonth: s }) }
  renderAdsets(_lastDashData)
}
function getAdSpendForPeriod(isAll) {
  const v = isAll ? orgSettings.adSpendAll : orgSettings.adSpendMonth
  if (v != null && v > 0) return v
  if (orgSettings.adSpend != null && orgSettings.adSpend > 0) return orgSettings.adSpend
  return null
}
async function autoLoadMargin() {
  if (_autoMarginTried) return
  _autoMarginTried = true
  if (orgSettings.margin != null) return
  try {
    const r = await fetch('/api/finance' + orgQ(), { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ session: getSession() }) })
    const d = await r.json()
    if (d && d.ok && d.revenue > 0 && d.profit != null) {
      const m = +(d.profit / d.revenue * 100).toFixed(1)
      _autoMargin = m
      renderAdsets(_lastDashData)
    }
  } catch (e) { /* ignore */ }
}
function getMargin() {
  if (orgSettings.margin != null) return { val: orgSettings.margin, auto: false }
  if (_autoMargin != null) return { val: _autoMargin, auto: true }
  return { val: null, auto: false }
}
function renderAdsets(d) {
  const box = document.getElementById('adsetsChart'); if (!box) return
  const uz = state.lang === 'uz'
  const isAdmin = getRole() === 'admin'
  if (isAdmin && !_autoMarginTried && orgSettings.margin == null) autoLoadMargin()
  const per = window._dashPeriod || 'month'
  const isAll = per === 'all'
  const arrRaw = (d && d.adsets) || []
  const arr = arrRaw.map((a) => ({
    name: a.name,
    leads: isAll ? a.leads : (a.leadsMonth != null ? a.leadsMonth : a.leads),
    sold: isAll ? a.sold : (a.soldMonth != null ? a.soldMonth : a.sold),
    revenue: isAll ? a.revenue : (a.revenueMonth != null ? a.revenueMonth : a.revenue),
    conv: isAll ? a.conv : (a.convMonth != null ? a.convMonth : a.conv),
    avgCheck: isAll ? a.avgCheck : (a.avgCheckMonth != null ? a.avgCheckMonth : a.avgCheck),
  })).filter((a) => a.leads > 0 || a.revenue > 0).sort((x, y) => y.revenue - x.revenue)
  const spendMap = {}
  if (_metaSpend && _metaSpend.adsets) for (const s of _metaSpend.adsets) spendMap[s.name] = s.spend
  const hasSpend = _metaSpend && _metaSpend.adsets && _metaSpend.adsets.length
  if (!arr.length) {
    box.innerHTML = '<div style="font-size:12px;color:var(--txt3);">' + (uz ? 'Bu davr uchun manba maʼlumoti yoʻq' : 'Нет данных об источниках за этот период') + '</div>'
    return
  }
  let summaryHtml = ''
  if (isAdmin) {
    const adRevenue = arr.reduce((s, a) => s + (a.revenue || 0), 0)
    const adSpend = getAdSpendForPeriod(isAll)
    const marginInfo = getMargin()
    const margin = marginInfo.val
    const roas = (adSpend > 0) ? adRevenue / adSpend : null
    let roi = null
    if (adSpend > 0 && margin != null) { const profit = adRevenue * (margin / 100); roi = (profit - adSpend) / adSpend * 100 }
    const spendTxt = adSpend > 0 ? fmtSum(adSpend) : (uz ? 'kiriting' : 'укажите')
    const marginSrc = margin == null ? (uz ? 'marjani kiriting' : 'укажите маржу') : (marginInfo.auto ? (uz ? 'moliyadan · sof foyda' : 'из финансов · чистая прибыль') : (uz ? 'sof foyda' : 'чистая прибыль'))
    const marginLbl = margin != null ? ` (${uz ? 'marja' : 'маржа'} ${String(margin).replace('.', ',')}%) ✏️` : ' ✏️'
    const perLabel = isAll ? (uz ? 'butun davr' : 'всё время') : (uz ? 'shu oy' : 'текущий месяц')
    summaryHtml = `<div style="background:var(--card);border:1px solid var(--line2);border-radius:11px;padding:13px;margin-bottom:14px;">
      <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:10px;">
        <div style="font-size:12.5px;font-weight:700;">${uz ? 'Reklama qoplanishi' : 'Окупаемость рекламы'} · ${perLabel}</div>
        <span style="font-size:10px;color:var(--gold);border:1px solid var(--gold);border-radius:6px;padding:1px 6px;">${uz ? 'faqat admin' : 'только админ'}</span>
      </div>
      <div style="display:grid;grid-template-columns:repeat(2,1fr);gap:10px;margin-bottom:10px;">
        <div style="background:var(--bg2);border-radius:9px;padding:9px 11px;cursor:pointer;" onclick="editAdSpend()" title="${uz ? 'Oʻzgartirish' : 'Изменить'}">
          <div style="font-size:10.5px;color:var(--txt2);">${uz ? 'Reklama xarajati ✏️' : 'Расход на рекламу ✏️'}</div>
          <div style="font-size:16px;font-weight:700;color:var(--red);">${spendTxt}</div>
          <div style="font-size:9.5px;color:var(--txt3);">${uz ? 'qoʻlda kiritiladi' : 'вводится вручную'}</div>
        </div>
        <div style="background:var(--bg2);border-radius:9px;padding:9px 11px;">
          <div style="font-size:10.5px;color:var(--txt2);">${uz ? 'Reklamadan tushum' : 'Выручка с рекламы'}</div>
          <div style="font-size:16px;font-weight:700;color:var(--green);">${fmtSum(adRevenue)}</div>
          <div style="font-size:9.5px;color:var(--txt3);">${arr.reduce((s, a) => s + (a.sold || 0), 0)} ${uz ? 'sotuv' : 'продаж'}</div>
        </div>
      </div>
      <div style="display:grid;grid-template-columns:repeat(2,1fr);gap:10px;">
        <div style="background:var(--bg2);border-radius:9px;padding:9px 11px;">
          <div style="font-size:10.5px;color:var(--txt2);">ROAS ${hintIcon('roas')}</div>
          <div style="font-size:19px;font-weight:800;color:${roas == null ? 'var(--txt3)' : (roas >= 1 ? 'var(--green)' : 'var(--red)')};">${roas != null ? roas.toFixed(1) + 'x' : '—'}</div>
          <div style="font-size:9.5px;color:var(--txt3);">${uz ? 'tushum ÷ xarajat' : 'выручка ÷ расход'}</div>
        </div>
        <div style="background:var(--bg2);border-radius:9px;padding:9px 11px;cursor:pointer;" onclick="editMargin()" title="${uz ? 'Marjani oʻzgartirish' : 'Изменить маржу'}">
          <div style="font-size:10.5px;color:var(--txt2);">ROI${marginLbl}</div>
          <div style="font-size:19px;font-weight:800;color:${roi == null ? 'var(--txt3)' : (roi >= 0 ? 'var(--green)' : 'var(--red)')};">${roi != null ? (roi > 0 ? '+' : '') + Math.round(roi) + '%' : '—'}</div>
          <div style="font-size:9.5px;color:var(--txt3);">${marginSrc}</div>
        </div>
      </div>
    </div>`
  }
  const maxRev = Math.max(1, ...arr.map((a) => a.revenue))
  const LIMIT = 5
  const shown = _adsetsExpanded ? arr : arr.slice(0, LIMIT)
  let html = summaryHtml
  html += `<div style="display:flex;justify-content:space-between;align-items:center;gap:8px;margin-bottom:10px;flex-wrap:wrap;">
    <div style="font-size:11px;color:var(--txt3);flex:1;min-width:150px;">${hasSpend ? (uz ? 'Har auditoriya ROI (Meta’dan)' : 'ROI по каждой аудитории (из Meta)') : (uz ? 'Auditoriyalar boʻyicha tushum' : 'Выручка по аудиториям')}</div>
    ${isAdmin ? `<button id="metaRefreshBtn" onclick="refreshMetaSpend()" style="padding:7px 12px;border-radius:8px;background:var(--accent);border:none;color:#fff;font-size:12px;font-weight:600;cursor:pointer;white-space:nowrap;">${uz ? 'Meta xarajati' : 'Расходы Meta'}</button>` : ''}
  </div>`
  html += shown.map((a) => {
    const spend = spendMap[a.name]
    const roi = fmtRoi(a.revenue, spend)
    let roiTag = ''
    if (hasSpend) {
      if (spend > 0 && roi != null) {
        const roiColor = roi >= 2 ? 'var(--green)' : (roi >= 1 ? 'var(--gold)' : 'var(--red)')
        roiTag = `<span style="font-size:12px;font-weight:700;color:${roiColor};white-space:nowrap;">ROAS ${roi.toFixed(1)}x</span>`
      } else if (spend > 0) {
        roiTag = `<span style="font-size:11px;color:var(--red);white-space:nowrap;">${uz ? '0 sotuv' : '0 продаж'}</span>`
      }
    }
    return `
    <div style="padding:11px 0;border-bottom:1px solid var(--line);">
      <div style="display:flex;justify-content:space-between;gap:8px;margin-bottom:5px;align-items:center;">
        <b style="font-size:13px;">${escapeHtml(a.name)}</b>
        <div style="display:flex;gap:10px;align-items:center;">
          ${roiTag}
          <span style="font-size:13px;font-weight:700;color:var(--green);white-space:nowrap;">${fmtSum(a.revenue)}</span>
        </div>
      </div>
      <div style="height:6px;background:var(--card2);border-radius:5px;overflow:hidden;margin-bottom:5px;">
        <div style="height:100%;width:${Math.round(a.revenue / maxRev * 100)}%;background:var(--accent);border-radius:5px;"></div>
      </div>
      <div style="font-size:11.5px;color:var(--txt3);">
        ${a.leads} ${uz ? 'lid' : 'лидов'} · ${a.sold} ${uz ? 'sotuv' : 'продаж'} · ${uz ? 'konv' : 'конв'}. ${String(a.conv).replace('.', ',')}%${hasSpend && spend > 0 ? ` · ${uz ? 'xarajat' : 'расход'} ${fmtSum(spend)}` : ''}
      </div>
    </div>`
  }).join('')
  if (arr.length > LIMIT) {
    const rest = arr.length - LIMIT
    html += `<button onclick="toggleAdsets()" style="margin-top:12px;width:100%;padding:9px;border-radius:8px;background:var(--card);border:1px solid var(--line2);color:var(--txt2);font-size:12.5px;font-weight:600;cursor:pointer;">
      ${_adsetsExpanded ? (uz ? 'Yigʻish' : 'Свернуть') : (uz ? `Yana ${rest} ta koʻrsatish` : `Показать ещё ${rest}`)}
    </button>`
  }
  box.innerHTML = html
}

export function initDashModals() {
  Object.assign(window, {
    openSuspModal, closeSuspModal, toggleSuspHistory, reviewSusp,
    openWorkdaysModal, closeWorkdaysModal, saveWorkdays,
    editForecastGoal, syncAll, saveOrgSettings,
    toggleAdsets, refreshMetaSpend, editMargin, editAdSpend,
  })
}
