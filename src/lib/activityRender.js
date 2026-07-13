// Активность менеджеров — перенос loadActivity/renderActivity/setActPeriod из монолита.
// Рендерит #activityChart по данным /api/activity: mops={name:{calls,moves,tasks,closes,leads}},
// где каждое поле — объект {YYYY-MM-DD: счётчик}. Активность = звонки+движение+задачи+закрытия.
import { state } from './appState.js'
import { escapeHtml } from './format.js'
import { activity } from './api.js'

let activityData = null
let actPeriod = 'month'
let loading = false

// YYYY-MM-DD в локальной таймзоне (как в монолите)
function todayStr() {
  const d = new Date()
  return new Date(d.getTime() - d.getTimezoneOffset() * 60000).toISOString().slice(0, 10)
}

export async function loadActivity(force) {
  const box = document.getElementById('activityChart')
  if (!box) return
  const uz = state.lang === 'uz'
  if (loading) return
  if (!activityData || force) {
    loading = true
    box.innerHTML = `<div style="font-size:12px;color:var(--txt3);padding:10px;">${force ? (uz ? 'Yangilanmoqda (20-40s)...' : 'Обновляю (20-40 сек)...') : (uz ? 'Yuklanmoqda...' : 'Загрузка активности...')}</div>`
    try {
      const d = await activity.get(force)
      if (d && d.ok) { activityData = d }
      else { box.innerHTML = `<div style="font-size:12px;color:var(--red);padding:10px;">${(d && d.error) || 'Ошибка'}</div>`; loading = false; return }
    } catch (e) {
      box.innerHTML = `<div style="font-size:12px;color:var(--red);padding:10px;">${uz ? "Aloqa yo'q" : 'Нет связи'}</div>`; loading = false; return
    }
    loading = false
  }
  renderActivity()
}

export function setActPeriod(p) {
  actPeriod = p
  const m = document.getElementById('act-month'), t = document.getElementById('act-today')
  if (m) m.classList.toggle('on', p === 'month')
  if (t) t.classList.toggle('on', p === 'today')
  if (p === 'day') { if (m) m.classList.remove('on'); if (t) t.classList.remove('on') }
  renderActivity()
}

export function renderActivity() {
  const box = document.getElementById('activityChart')
  if (!box || !activityData) return
  const uz = state.lang === 'uz'
  const mops = activityData.mops || {}
  let dayFilter = null
  if (actPeriod === 'today') dayFilter = todayStr()
  else if (actPeriod === 'day') { const di = document.getElementById('actDate'); dayFilter = di && di.value ? di.value : todayStr() }
  const sumK = (obj) => {
    if (!obj) return 0
    if (dayFilter) return obj[dayFilter] || 0
    return Object.values(obj).reduce((a, b) => a + b, 0)
  }
  const rows = Object.entries(mops).map(([name, m]) => {
    const calls = sumK(m.calls), moves = sumK(m.moves), tasks = sumK(m.tasks), closes = sumK(m.closes), leads = sumK(m.leads)
    return { name, calls, moves, tasks, closes, leads, total: calls + moves + tasks + closes }
  }).sort((a, b) => b.total - a.total)
  const periodLbl = actPeriod === 'today' ? (uz ? 'bugun' : 'сегодня') : actPeriod === 'day' ? dayFilter : (uz ? 'oy' : 'месяц')
  box.innerHTML = `<div style="font-size:11px;color:var(--txt3);margin-bottom:8px;">${uz ? 'Davr' : 'Период'}: ${periodLbl}</div>` +
    rows.map((r) => {
      const dead = r.total === 0
      return `<div style="padding:10px 0;border-top:1px solid var(--line);">
        <div style="display:flex;justify-content:space-between;align-items:center;gap:8px;">
          <div style="font-weight:600;font-size:13.5px;color:${dead ? 'var(--red)' : 'var(--txt)'};">${escapeHtml(r.name)}${dead ? ` · <span style="font-weight:400;font-size:11px;">${uz ? 'faol emas' : 'нет активности'}</span>` : ''}</div>
          <div style="font-size:11px;color:var(--txt3);">${uz ? 'faollik' : 'активность'}: <b style="color:${dead ? 'var(--red)' : 'var(--accent)'};">${r.total}</b></div>
        </div>
        <div style="display:flex;gap:12px;flex-wrap:wrap;margin-top:6px;font-size:11.5px;color:var(--txt2);">
          <span>📞 ${r.calls} ${uz ? "qo'ng'." : 'звон.'}</span>
          <span>↕ ${r.moves} ${uz ? 'harakat' : 'движ.'}</span>
          <span>✓ ${r.tasks} ${uz ? 'vazifa' : 'задач'}</span>
          <span>🎯 ${r.closes} ${uz ? 'yopildi' : 'закрыто'}</span>
          <span style="color:var(--txt3);">+${r.leads} ${uz ? 'yangi lid' : 'нов. лид'}</span>
        </div>
      </div>`
    }).join('') +
    `<div style="font-size:10.5px;color:var(--txt3);margin-top:10px;line-height:1.5;">${uz ? "Faollik = qo'ng'iroq + voronka + vazifa + yopish. Bazani yopish ham faollik." : 'Активность = звонки + движение + задачи + закрытия. Работа со старой базой тоже считается.'}${activityData.ageSec != null ? ` · ${uz ? 'yangilangan' : 'обновлено'} ${Math.round((activityData.ageSec || 0) / 60)} ${uz ? 'daq oldin' : 'мин назад'}` : ''}</div>`
}
