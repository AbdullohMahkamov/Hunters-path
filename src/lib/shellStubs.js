// Временный мост миграции: статические скелеты вьюх (дашборд/telegram/задачи) вставляются
// дословно из монолита и содержат инлайновые onclick=... на глобальные функции. Пока
// соответствующие разделы не перенесены (Этапы 4б–6), вешаем на window безопасные заглушки,
// чтобы клики не бросали ReferenceError. Навигация под-вкладок дашборда работает по-настоящему.
// По мере переноса каждая заглушка заменяется реальной реализацией.

let installed = false

export function installShellStubs() {
  if (installed) return
  installed = true

  // dashTab — реальное переключение под-вкладок дашборда (визуально, без загрузки данных)
  window.dashTab = function (tab) {
    ['overview', 'trends', 'finance', 'marketing', 'sales'].forEach((t) => {
      const btn = document.getElementById('dtab-' + t)
      const grp = document.getElementById('dg-' + t)
      if (btn) btn.classList.toggle('on', t === tab)
      if (grp) grp.style.display = (t === tab) ? 'block' : 'none'
    })
  }

  // setDashPeriod — визуальное переключение периодов (данные подключатся позже)
  window.setDashPeriod = function (per) {
    ['per', 'tr-per', 'mk-per', 'sl-per'].forEach((pfx) => {
      const m = document.getElementById(pfx + '-month'), a = document.getElementById(pfx + '-all')
      if (m) m.classList.toggle('on', per === 'month')
      if (a) a.classList.toggle('on', per === 'all')
    })
  }
  window.setActPeriod = function (per) {
    ['act-month', 'act-today'].forEach((id) => { const el = document.getElementById(id); if (el) el.classList.toggle('on', id === 'act-' + per) })
  }
  window.setDiscPeriod = function (per) {
    const m = document.getElementById('disc-per-month'), t = document.getElementById('disc-per-today')
    if (m) m.classList.toggle('on', per === 'month'); if (t) t.classList.toggle('on', per === 'today')
  }

  // Заглушки загрузки данных / модалок — реальные реализации в следующих этапах.
  const noop = () => { /* раздел переносится в следующем этапе */ }
  ;['syncAll', 'openWorkdaysModal', 'closeWorkdaysModal', 'saveWorkdays', 'showHint',
    'loadActivity', 'loadFinance', 'openSuspModal', 'closeSuspModal', 'toggleSuspHistory',
    'loadTelegramChats', 'segmentActiveChats', 'analyzeTgHistory',
    'openGenerator', 'askNext', 'resetHunt', 'openClientForm'].forEach((fn) => {
    if (typeof window[fn] !== 'function') window[fn] = noop
  })
  // finView используется как присваивание глобальной переменной (finView='year')
  if (typeof window.finView === 'undefined') window.finView = 'month'
}
