// Мастер аудита (demo-аккаунты) — дословный перенос из public/index.html.
// Флоу: аудит из CRM → проблемы → текущие продажи → цель → генерация плана (/api/audit-plan).
// Императивный: рендер в #wizTitle/#wizBody. Эндпоинты /api/dashboard, /api/sync, /api/audit-plan не менялись.
import { state, save } from './appState.js'
import { getRole, orgQ } from './session.js'
import { escapeHtml } from './format.js'
import { tr } from './shellI18n.js'
import { renderStages } from './quests.js'

const $ = (id) => document.getElementById(id)

function needsWizard() { return getRole() === 'demo' && !state.customPlan }
function maybeShowWelcome() { const b = $('wizBanner'); if (!b) return; b.style.display = needsWizard() ? 'block' : 'none' }

function openWizard() { $('wizardOverlay').style.display = 'flex'; wizStep1() }
function closeWizard() { $('wizardOverlay').style.display = 'none' }

function wizStep1() {
  $('wizTitle').textContent = tr('wizStep1T')
  $('wizBody').innerHTML = `
    <div style="font-size:14px;line-height:1.6;color:var(--txt2);margin-bottom:18px;">
      ${tr('wizStep1Body')}
    </div>
    <button onclick="wizRunAudit()" style="width:100%;padding:14px;border-radius:11px;background:var(--accent);border:none;color:#fff;font-size:15px;font-weight:600;cursor:pointer;">${tr('wizStep1Btn')}</button>`
}
let wizAuditData = null
let wizCurrentSales = ''
let wizGoalText = ''
async function wizRunAudit() {
  $('wizBody').innerHTML = '<div class="gen-loading">⏳ Анализирую ваш бизнес по данным CRM за последние 3-4 месяца...</div>'
  try {
    let d = await (await fetch('/api/dashboard' + orgQ())).json()
    const stale = !d || !d.totals || d.totals.soldPeriod == null || !(d.problems && d.problems.length)
    if (stale) {
      $('wizBody').innerHTML = '<div class="gen-loading">⏳ Собираю свежие данные из CRM за 3-4 месяца... (10-20 сек)</div>'
      try {
        const sr = await fetch('/api/sync' + orgQ())
        const sd = await sr.json()
        if (sd && sd.totals) { d = sd } else { d = await (await fetch('/api/dashboard' + orgQ())).json() }
      } catch (e) { /* работаем с тем что есть */ }
    }
    wizAuditData = d
    wizShowProblems(d)
  } catch (e) {
    $('wizBody').innerHTML = '<div class="gen-loading">⚠️ Не удалось получить данные. Попробуйте ещё раз.</div>'
  }
}
function wizShowProblems(d) {
  $('wizTitle').textContent = tr('wizProblT')
  let probs = ''
  const wp = (d && d.problemsAll && d.problemsAll.length) ? d.problemsAll : (d && d.problems)
  if (wp && wp.length) {
    probs = wp.map((p) => `<div style="display:flex;justify-content:space-between;padding:9px 0;border-top:1px solid var(--line);font-size:13.5px;"><span>${escapeHtml(p.name)}</span><b style="color:var(--red);">${p.count}</b></div>`).join('')
  } else {
    probs = '<div style="font-size:13px;color:var(--txt3);padding:10px 0;">Данных о проблемах пока мало. План составим по общей логике роста.</div>'
  }
  let kpi = ''
  if (d && d.totals) {
    const t = d.totals
    const soldShow = (t.soldPeriod != null) ? t.soldPeriod : t.sold
    kpi = `<div style="font-size:13px;color:var(--txt2);margin-bottom:10px;">Продаж за период: <b style="color:var(--txt);">${soldShow}</b> · конверсия <b style="color:var(--txt);">${t.conv}%</b> · потеря до контакта <b style="color:var(--red);">${t.noContactPct}%</b></div>`
  }
  $('wizBody').innerHTML = `
    <div style="font-size:12px;color:var(--txt3);margin-bottom:8px;">${tr('wizPeriod')}</div>
    ${kpi}
    <div style="font-size:13px;font-weight:600;margin:6px 0 2px;">${tr('wizWhereBurn')}</div>
    ${probs}
    <button onclick="wizStepSales()" style="width:100%;padding:14px;border-radius:11px;background:var(--accent);border:none;color:#fff;font-size:15px;font-weight:600;cursor:pointer;margin-top:18px;">Дальше →</button>`
}
function wizStepSales() {
  $('wizTitle').textContent = tr('wizSalesT')
  $('wizBody').innerHTML = `
    <div style="font-size:14px;line-height:1.6;color:var(--txt2);margin-bottom:14px;">
      ${tr('wizSalesBody')}
    </div>
    <input id="wizSalesInput" type="text" value="${escapeHtml(wizCurrentSales || '')}" placeholder="Например: 150 млн сум в месяц"
      style="width:100%;padding:13px 15px;border-radius:11px;border:1px solid var(--line2);background:var(--card);color:var(--txt);font-size:14.5px;margin-bottom:14px;" />
    <button onclick="wizSaveSalesNext()" style="width:100%;padding:14px;border-radius:11px;background:var(--accent);border:none;color:#fff;font-size:15px;font-weight:600;cursor:pointer;">Дальше → цель</button>
    <button onclick="wizShowProblems2()" style="width:100%;padding:11px;border-radius:11px;background:none;border:none;color:var(--txt2);font-size:13px;cursor:pointer;margin-top:8px;">${tr('wizBack')}</button>`
  setTimeout(() => { const i = $('wizSalesInput'); if (i) i.focus() }, 100)
}
function wizShowProblems2() { wizShowProblems(wizAuditData) }
function wizSaveSalesNext() { const el = $('wizSalesInput'); if (el) wizCurrentSales = el.value.trim(); wizStep2() }
function wizStep2() {
  $('wizTitle').textContent = tr('wizGoalT')
  $('wizBody').innerHTML = `
    <div style="font-size:14px;line-height:1.6;color:var(--txt2);margin-bottom:14px;">
      ${tr('wizGoalBody')}
    </div>
    <input id="wizGoalInput" type="text" value="${escapeHtml(wizGoalText || '')}" placeholder="Например: сейчас 150М, хочу 250М в месяц"
      style="width:100%;padding:13px 15px;border-radius:11px;border:1px solid var(--line2);background:var(--card);color:var(--txt);font-size:14.5px;margin-bottom:14px;" />
    <button onclick="wizGeneratePlan()" style="width:100%;padding:14px;border-radius:11px;background:var(--accent);border:none;color:#fff;font-size:15px;font-weight:600;cursor:pointer;">Составить план задач</button>
    <button onclick="wizSaveGoalBack()" style="width:100%;padding:11px;border-radius:11px;background:none;border:none;color:var(--txt2);font-size:13px;cursor:pointer;margin-top:8px;">${tr('wizBack')}</button>`
  setTimeout(() => { const i = $('wizGoalInput'); if (i) i.focus() }, 100)
}
function wizSaveGoalBack() { const el = $('wizGoalInput'); if (el) wizGoalText = el.value.trim(); wizStepSales() }
async function wizGeneratePlan() {
  const goal = $('wizGoalInput').value.trim()
  wizGoalText = goal
  const salesEl = $('wizSalesInput')
  const currentSales = salesEl ? salesEl.value.trim() : (wizCurrentSales || '')
  wizCurrentSales = currentSales
  $('wizTitle').textContent = tr('wizGenT')
  $('wizBody').innerHTML = '<div class="gen-loading">⏳ Составляю персональный план задач под ваш аудит и цель...</div>'
  try {
    const r = await fetch('/api/audit-plan', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ goal, currentSales, lang: state.lang || 'ru' }) })
    const d = await r.json()
    if (d && d.ok && d.plan && ((d.plan.marketing && d.plan.marketing.length) || (d.plan.sales && d.plan.sales.length))) {
      wizApplyPlan(d.plan, goal, currentSales)
    } else {
      $('wizBody').innerHTML = '<div class="gen-loading">⚠️ Не удалось составить план. Попробуйте ещё раз.</div>'
    }
  } catch (e) {
    $('wizBody').innerHTML = '<div class="gen-loading">⚠️ Нет связи. Попробуйте ещё раз.</div>'
  }
}
function parseGoalSum(txt) {
  const s = String(txt).toLowerCase().replace(/\s/g, '')
  const matches = [...s.matchAll(/(\d+(?:[.,]\d+)?)(млрд|млн|м|k|к|000000|000)?/g)]
  if (!matches.length) return 0
  let best = 0
  matches.forEach((m) => {
    let n = parseFloat(m[1].replace(',', '.'))
    const suf = m[2] || ''
    if (suf === 'млрд') n *= 1000000000
    else if (suf === 'млн' || suf === 'м') n *= 1000000
    else if (suf === 'k' || suf === 'к') n *= 1000
    else if (suf === '000000') n *= 1000000
    else if (suf === '000') n *= 1000
    if (n > best) best = n
  })
  return Math.round(best)
}
function wizApplyPlan(plan, goal, currentSales) {
  state.customPlan = {
    goal, currentSales: currentSales || '', createdAt: Date.now(),
    marketing: (plan.marketing || []).map((q, i) => ({ id: 'cm' + i, t: q.t, d: q.d || '', steps: q.steps || [] })),
    sales: (plan.sales || []).map((q, i) => ({ id: 'cs' + i, t: q.t, d: q.d || '', steps: q.steps || [] })),
  }
  const parsedGoal = parseGoalSum(goal)
  if (parsedGoal > 0) { state.goal = parsedGoal }
  save()
  const mkt = (plan.marketing || []).map((q) => `<div class="wiz-task">📣 ${escapeHtml(q.t)}</div>`).join('')
  const sls = (plan.sales || []).map((q) => `<div class="wiz-task">💼 ${escapeHtml(q.t)}</div>`).join('')
  $('wizTitle').textContent = tr('wizDoneT')
  $('wizBody').innerHTML = `
    <div style="font-size:13.5px;color:var(--txt2);margin-bottom:14px;">План зафиксирован. Задачи появились во вкладке «Задачи». Идите по ним — когда всё выполните, сделаем аудит заново.</div>
    ${mkt}${sls}
    <button onclick="wizGoToTasks()" style="width:100%;padding:14px;border-radius:11px;background:var(--green);border:none;color:#fff;font-size:15px;font-weight:600;cursor:pointer;margin-top:16px;">Перейти к задачам →</button>`
  renderStages(); maybeShowWelcome()
}
function wizGoToTasks() { closeWizard(); if (typeof window.__switchToTab === 'function') window.__switchToTab('map') }

let _inited = false
export function initAuditWizard() {
  if (_inited) return
  _inited = true
  Object.assign(window, {
    openWizard, closeWizard, wizRunAudit, wizShowProblems, wizShowProblems2, wizStepSales,
    wizSaveSalesNext, wizStep2, wizSaveGoalBack, wizGeneratePlan, wizGoToTasks, maybeShowWelcome,
  })
}
export { maybeShowWelcome }
