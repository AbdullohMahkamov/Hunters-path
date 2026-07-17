// Временный мост миграции: статические скелеты вьюх (дашборд/telegram/задачи) вставляются
// дословно из монолита и содержат инлайновые onclick=... на глобальные функции. Пока
// соответствующие разделы не перенесены (Этапы 4б–6), вешаем на window безопасные заглушки,
// чтобы клики не бросали ReferenceError. Навигация под-вкладок дашборда работает по-настоящему.
// По мере переноса каждая заглушка заменяется реальной реализацией.

import { setDashPeriodReal, setDiscPeriodReal } from './dashRender.js'
import { loadActivity, setActPeriod } from './activityRender.js'
import { state, save } from './appState.js'

let installed = false

export function installShellStubs() {
  if (installed) return
  installed = true

  // dashTab — реальное переключение под-вкладок дашборда (+ загрузка данных, как в монолите)
  window.dashTab = function (tab) {
    state.dashTab = tab; save()
    ;['overview', 'trends', 'finance', 'marketing', 'sales'].forEach((t) => {
      const btn = document.getElementById('dtab-' + t)
      const grp = document.getElementById('dg-' + t)
      if (btn) btn.classList.toggle('on', t === tab)
      if (grp) grp.style.display = (t === tab) ? 'block' : 'none'
    })
    if (tab === 'trends' && typeof window.loadTrends === 'function') window.loadTrends()
    if (tab === 'finance' && typeof window.loadFinance === 'function') window.loadFinance()
    if (tab === 'sales') { loadActivity(); if (typeof window.loadCallAnalysis === 'function') window.loadCallAnalysis() } // активность + разборы звонков
  }

  // setDashPeriod / setDiscPeriod / setActPeriod / loadActivity — реальные (перерисовка по данным)
  window.setDashPeriod = setDashPeriodReal
  window.setDiscPeriod = setDiscPeriodReal
  window.setActPeriod = setActPeriod
  window.loadActivity = loadActivity

  // Заглушки загрузки данных / модалок — реальные реализации в следующих этапах.
  // (syncAll/openSuspModal/…/editForecastGoal ставит initDashModals; квесты — initQuests и т.д.)
  const noop = () => { /* раздел переносится в следующем этапе */ }
  ;['showHint', 'askForecastHelp'].forEach((fn) => {
    if (typeof window[fn] !== 'function') window[fn] = noop
  })
  if (typeof window.finView === 'undefined') window.finView = 'month'
}
