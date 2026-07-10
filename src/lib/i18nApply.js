// Перевод статических частей основного приложения (дашборд-скелет, плейсхолдеры чата).
// Дословный перенос applyStaticI18n + части applyShellI18n из монолита, работает по DOM.
// JSX-хром (вкладки/меню/настройки) переводится реактивно через tr()/ti() в самом React.
import { state } from './appState.js'
import { tr, ti } from './shellI18n.js'

export function applyStaticI18n() {
  const uz = state.lang === 'uz'
  const finRem = document.getElementById('finReminder')
  if (finRem) {
    const txt = finRem.querySelector('div')
    if (txt) txt.innerHTML = uz
      ? '<b>Moliya avtomatik yangilanmaydi</b> — jadvalni AI o‘qishiga ortiqcha sarflamaslik uchun. Ma‘lumot saqlangan nusxadan ko‘rsatiladi. <b>Yangi raqamlar kerakmi? «Yangilash»ni bosing.</b>'
      : '<b>Финансы не обновляются автоматически</b> — чтобы не тратить лишнее на ИИ-чтение таблицы. Данные показываются из сохранённой копии. <b>Нужны свежие цифры? Нажмите «Обновить».</b>'
  }
  document.querySelectorAll('[data-t]').forEach((el) => {
    const k = el.getAttribute('data-t'); const v = ti(k); if (v) el.textContent = v
  })
  const setTxt = (id, val) => { const e = document.getElementById(id); if (e) e.textContent = val }
  const setSecLabel = (id, val, hintKey) => {
    const e = document.getElementById(id); if (!e) return
    const icon = e.querySelector('svg'); const iconHtml = icon ? icon.outerHTML : ''
    const hint = hintKey ? ` <span class="hint" onclick="showHint('${hintKey}',event)">?</span>` : ''
    e.innerHTML = iconHtml + ' ' + val + hint
  }
  setTxt('goalTitle', tr('goalTitle'))
  const uzTd = state.lang === 'uz'
  const setT2 = (id, v) => { const e = document.getElementById(id); if (e) e.textContent = v }
  const tdLblEl = document.getElementById('todayLbl')
  if (tdLblEl) { const svg = tdLblEl.querySelector('svg'); tdLblEl.textContent = uzTd ? ' Bugun' : ' Сегодня'; if (svg) tdLblEl.prepend(svg) }
  setT2('tdLeadsLbl', uzTd ? 'Yangi ishlangan lidlar' : 'Новые обработанные лиды')
  setT2('tdSoldLbl', uzTd ? 'Bugungi sotuvlar' : 'Сегодняшние продажи')
  setT2('tdRevLbl', uzTd ? 'Bugungi tushum' : 'Сегодняшняя выручка')
  setSecLabel('secTop', tr('secTop'))
  setSecLabel('secMop', tr('secMop'), 'reach')
  setSecLabel('secProb', tr('secProb'), 'problems')
  setSecLabel('secDisc', tr('secDisc'), 'early')
  setTxt('dtab-overview', tr('dtOverview'))
  setTxt('dtab-trends', tr('dtTrends'))
  setTxt('dtab-finance', tr('dtFinance'))
  setTxt('dtab-marketing', tr('dtMarketing'))
  setTxt('dtab-sales', tr('dtSales'))
  const mkCards = document.querySelectorAll('#dg-marketing .dcard')
  if (mkCards.length >= 2) {
    mkCards[0].querySelector('.dl').innerHTML = tr('mkLeads')
    mkCards[0].querySelector('.dh').textContent = tr('mkLeadsH')
    mkCards[1].querySelector('.dl').innerHTML = tr('mkNoContact') + ' <span class="hint" onclick="showHint(\'reach\',event)">?</span>'
    mkCards[1].querySelector('.dh').textContent = tr('mkNoContactH')
  }
  const gb = document.getElementById('genBtn'); if (gb) gb.textContent = tr('genBtn')
  const nb = document.getElementById('nextBtn'); if (nb) nb.textContent = tr('nextBtn')
  const rb = document.getElementById('resetBtn'); if (rb) rb.textContent = tr('resetBtn')
  setTxt('dopSecTitle', tr('dopSec'))
  const qr = document.getElementById('quickRow')
  if (qr) { const bs = qr.querySelectorAll('button'); if (bs[0]) bs[0].textContent = tr('q1'); if (bs[1]) bs[1].textContent = tr('q2'); if (bs[2]) bs[2].textContent = tr('q3') }
  const dcards = document.querySelectorAll('#ovKpiGrid .dcard')
  if (dcards.length >= 3) {
    dcards[0].querySelector('.dl').innerHTML = tr('kSold')
    dcards[0].querySelector('.dh').textContent = tr('kSoldH')
    dcards[1].querySelector('.dl').innerHTML = tr('kConv') + '<span class="hint" onclick="showHint(\'conv\',event)">?</span>'
    dcards[2].querySelector('.dl').innerHTML = tr('kCheck') + '<span class="hint" onclick="showHint(\'check\',event)">?</span>'
  }
  const setById = (id, v) => { const e = document.getElementById(id); if (e) e.textContent = v }
  ;['per-month', 'tr-per-month', 'mk-per-month'].forEach((id) => setById(id, tr('pMonth')))
  ;['per-all', 'tr-per-all', 'mk-per-all'].forEach((id) => setById(id, tr('pAll')))
  setById('disc-per-month', tr('pMonthShort'))
  setById('disc-per-today', tr('pTodayShort'))
  const setSec2 = (id, v, hintKey) => { const e = document.getElementById(id); if (!e) return; const svg = e.querySelector('svg'); const hint = hintKey ? ` <span class="hint" onclick="showHint('${hintKey}',event)">?</span>` : ''; e.innerHTML = (svg ? svg.outerHTML : '') + ' ' + v + hint }
  setSec2('secAdsets', tr('secAdsets'))
  setSec2('secActivity', tr('secActivity'))
  setSec2('secPlanFact', tr('secPlanFact'))
  setSec2('secVelocity', tr('secVelocity'))
  setSec2('secSusp', tr('secSusp'))
  setSec2('fcLbl', tr('secForecast'))
  setById('finYearBtn', tr('finYear'))
  setById('dashNote', tr('dashNote2'))
}

// Плейсхолдеры/приветствие в raw-разметке чата (не под React).
export function applyChatI18n() {
  const uz = state.lang === 'uz'
  const box = document.getElementById('chatBox'); if (box) box.placeholder = uz ? 'Biznes haqida so‘rang...' : 'Спросите о бизнесе...'
  const boxC = document.getElementById('chatBoxC'); if (boxC) boxC.placeholder = uz ? 'Biznes haqida so‘rang...' : 'Спросите о бизнесе...'
  const ceTitle = document.getElementById('ceTitle'); if (ceTitle) ceTitle.textContent = uz ? 'Sotuv bo‘yicha nimaga yordam beray?' : 'Чем помочь по продажам?'
}

export function applyI18n() { applyStaticI18n(); applyChatI18n() }
