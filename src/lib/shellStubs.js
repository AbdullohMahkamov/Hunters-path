// Временный мост миграции: статические скелеты вьюх (дашборд/telegram/задачи) вставляются
// дословно из монолита и содержат инлайновые onclick=... на глобальные функции. Пока
// соответствующие разделы не перенесены (Этапы 4б–6), вешаем на window безопасные заглушки,
// чтобы клики не бросали ReferenceError. Навигация под-вкладок дашборда работает по-настоящему.
// По мере переноса каждая заглушка заменяется реальной реализацией.

import { setDashPeriodReal, setDiscPeriodReal } from './dashRender.js'
import { state, getGoal, save } from './appState.js'

let installed = false

export function installShellStubs() {
  if (installed) return
  installed = true

  // dashTab — реальное переключение под-вкладок дашборда
  window.dashTab = function (tab) {
    state.dashTab = tab; save()
    ;['overview', 'trends', 'finance', 'marketing', 'sales'].forEach((t) => {
      const btn = document.getElementById('dtab-' + t)
      const grp = document.getElementById('dg-' + t)
      if (btn) btn.classList.toggle('on', t === tab)
      if (grp) grp.style.display = (t === tab) ? 'block' : 'none'
    })
  }

  // setDashPeriod / setDiscPeriod — реальные (перерисовка по данным)
  window.setDashPeriod = setDashPeriodReal
  window.setDiscPeriod = setDiscPeriodReal
  window.setActPeriod = function (per) {
    ['act-month', 'act-today'].forEach((id) => { const el = document.getElementById(id); if (el) el.classList.toggle('on', id === 'act-' + per) })
  }

  // editForecastGoal — изменить цель месяца (prompt → state.goal → перерисовка прогноза)
  window.editForecastGoal = function () {
    const uz = state.lang === 'uz'
    const cur = getGoal() || ''
    const inp = window.prompt(uz ? 'Oylik maqsad (soʻm):' : 'Цель на месяц (сум):', String(cur))
    if (inp == null) return
    const n = parseInt(String(inp).replace(/[^0-9]/g, ''), 10)
    if (!n || n <= 0) return
    state.goal = n; save()
    if (window._dashData && typeof window.__applyLiveDash === 'function') window.__applyLiveDash(window._dashData)
  }

  // Заглушки загрузки данных / модалок — реальные реализации в следующих этапах.
  const noop = () => { /* раздел переносится в следующем этапе */ }
  ;['syncAll', 'openWorkdaysModal', 'closeWorkdaysModal', 'saveWorkdays', 'showHint',
    'loadActivity', 'loadFinance', 'openSuspModal', 'closeSuspModal', 'toggleSuspHistory',
    'loadTelegramChats', 'segmentActiveChats', 'analyzeTgHistory', 'askForecastHelp',
    'openGenerator', 'askNext', 'resetHunt', 'openClientForm', 'toggleAdsets', 'refreshMetaSpend',
    'editMargin', 'editAdSpend'].forEach((fn) => {
    if (typeof window[fn] !== 'function') window[fn] = noop
  })
  if (typeof window.finView === 'undefined') window.finView = 'month'
}
