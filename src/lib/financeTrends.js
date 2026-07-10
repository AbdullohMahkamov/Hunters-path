// Финансы (Google Sheets через ИИ) и Динамика (тренды) — дословный перенос из public/index.html.
// Императивные (innerHTML в #financeBox/#trendsBox). Эндпоинты /api/finance, /api/trends не менялись.
import { state } from './appState.js'
import { getSession } from './session.js'
import { escapeHtml } from './format.js'
import { mdToHtml } from './chat.js'

const $ = (id) => document.getElementById(id)
function svg(name, size) { const s = size || 18; const ic = name === 'sparkle' ? '<path d="M12 3l1.5 5.5L19 10l-5.5 1.5L12 17l-1.5-5.5L5 10l5.5-1.5z"/>' : ''; return `<svg class="ic" width="${s}" height="${s}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round">${ic}</svg>` }

function lineChart(values, labels, color, unit) {
  const W = 640, H = 170, padL = 42, padR = 14, padT = 14, padB = 26
  if (!values.length) return ''
  const max = Math.max(...values, 1), min = Math.min(...values, 0)
  const range = max - min || 1
  const n = values.length
  const x = (i) => n === 1 ? W / 2 : padL + (i * (W - padL - padR) / (n - 1))
  const y = (v) => H - padB - ((v - min) / range) * (H - padT - padB)
  const pts = values.map((v, i) => `${x(i)},${y(v)}`).join(' ')
  const dots = values.map((v, i) => `<circle cx="${x(i)}" cy="${y(v)}" r="3.5" fill="${color}"/><text x="${x(i)}" y="${y(v) - 8}" font-size="10" fill="var(--txt2)" text-anchor="middle">${v}${unit === '%' ? '%' : ''}</text>`).join('')
  const step = Math.ceil(n / 7)
  const xlabels = labels.map((l, i) => i % step === 0 || i === n - 1 ? `<text x="${x(i)}" y="${H - 8}" font-size="9.5" fill="var(--txt3)" text-anchor="middle">${l}</text>` : '').join('')
  return `<div style="overflow-x:auto;"><svg viewBox="0 0 ${W} ${H}" style="width:100%;min-width:300px;height:auto;background:var(--card);border:1px solid var(--line);border-radius:11px;">
    <polyline points="${pts}" fill="none" stroke="${color}" stroke-width="2.5" stroke-linejoin="round" stroke-linecap="round"/>
    ${dots}${xlabels}
  </svg></div>`
}

// ===== ФИНАНСЫ =====
let financeMonths = null
let financeLoaded = false
const finCache = {}

async function loadFinance(force) {
  const box = $('financeBox'); if (!box) return
  const uz = state.lang === 'uz'
  const sel = $('finMonth')
  const finView = window.finView || 'month'
  if (financeMonths === null) {
    try {
      const lr = await fetch('/api/finance', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ action: 'list', session: getSession() }) })
      const ld = await lr.json()
      financeMonths = (ld && ld.months) || []
    } catch (e) { financeMonths = [] }
    if (sel && financeMonths.length) {
      sel.innerHTML = financeMonths.map((mo) => `<option value="${escapeHtml(mo.tab)}"${mo.current ? ' selected' : ''}>${escapeHtml(uz ? mo.labelUz : mo.label)}</option>`).join('')
    }
  }
  const yb = $('finYearBtn')
  if (yb) { yb.style.background = finView === 'year' ? 'var(--accent)' : 'var(--card)'; yb.style.color = finView === 'year' ? '#fff' : 'var(--txt2)'; yb.style.borderColor = finView === 'year' ? 'var(--accent)' : 'var(--line2)' }
  box.innerHTML = `<div style="font-size:12px;color:var(--txt3);padding:14px;">${uz ? "O'qilmoqda..." : 'Читаю...'}</div>`
  try {
    if (finView === 'year') {
      const r = await fetch('/api/finance', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ action: 'year', session: getSession() }) })
      const d = await r.json(); financeLoaded = true
      if (d && d.ok) { renderFinanceYear(d.year || []) }
      else if (d && d.error === 'no_access') { box.innerHTML = noAccessMsg(uz) }
      else { box.innerHTML = `<div style="font-size:12px;color:var(--red);padding:14px;">${(d && d.error) || 'Ошибка'}</div>` }
    } else {
      const month = sel ? sel.value : ''
      if (force && month) delete finCache[month]
      if (!force && finCache[month]) { renderFinance(finCache[month]); return }
      const r = await fetch('/api/finance', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ month, force: !!force, session: getSession() }) })
      const d = await r.json(); financeLoaded = true
      if (d && d.ok) { finCache[month] = d; renderFinance(d) }
      else if (d && d.error === 'no_access') { box.innerHTML = noAccessMsg(uz) }
      else { box.innerHTML = `<div style="font-size:12px;color:var(--red);padding:14px;">${(d && d.error) || 'Ошибка'}</div>` }
    }
  } catch (e) {
    box.innerHTML = `<div style="font-size:12px;color:var(--red);padding:14px;">${uz ? "Ma'lumot olinmadi" : 'Не удалось загрузить'}</div>`
  }
}
function noAccessMsg(uz) {
  return `<div style="background:var(--red-bg);border:1px solid var(--red);border-radius:11px;padding:14px;font-size:13px;color:var(--txt);">${uz ? "Jadval yopiq. Google Sheets'da «Havola orqali — ko'rish» ruxsatini yoqing." : 'Таблица закрыта. Откройте в Google Sheets доступ «по ссылке — просмотр».'}</div>`
}
function renderFinanceYear(year) {
  const box = $('financeBox'); if (!box) return
  const uz = state.lang === 'uz'
  if (!year.length) { box.innerHTML = `<div style="font-size:12px;color:var(--txt3);padding:14px;">${uz ? "Ma'lumot yo'q" : 'Нет данных'}</div>`; return }
  const fmtShort = (n) => n == null ? '—' : (Math.abs(n) >= 1000000 ? (n / 1000000).toFixed(1) + 'M' : new Intl.NumberFormat('ru-RU').format(Math.round(n)))
  const profits = year.map((y) => y.profit || 0)
  const labels = year.map((y) => (uz ? y.monthUz : y.month).slice(0, 3))
  const totalProfit = profits.reduce((a, b) => a + b, 0)
  const totalRev = year.reduce((a, y) => a + (y.revenue || 0), 0)
  const rows = year.map((y) => {
    const pc = y.profit == null ? 'var(--txt)' : (y.profit >= 0 ? 'var(--green)' : 'var(--red)')
    return `<div style="display:flex;align-items:center;gap:10px;padding:9px 0;border-top:1px solid var(--line);">
      <div style="width:75px;font-size:13px;">${escapeHtml(uz ? y.monthUz : y.month)}</div>
      <div style="flex:1;font-size:12px;color:var(--txt3);">${uz ? 'tushum' : 'выручка'} ${fmtShort(y.revenue)}</div>
      <div style="font-weight:600;font-size:13px;color:${pc};white-space:nowrap;">${fmtShort(y.profit)}</div>
    </div>`
  }).join('')
  const totalColor = totalProfit >= 0 ? 'var(--green)' : 'var(--red)'
  box.innerHTML = `
    <div style="background:var(--card);border:1px solid var(--line);border-radius:12px;padding:16px;margin-bottom:14px;">
      <div style="font-size:12px;color:var(--txt2);margin-bottom:4px;">${uz ? 'Yil boshidan sof foyda' : 'Чистая прибыль с начала года'}</div>
      <div style="font-size:24px;font-weight:700;color:${totalColor};">${new Intl.NumberFormat('ru-RU').format(Math.round(totalProfit))} ${uz ? "so'm" : 'сум'}</div>
      <div style="font-size:12px;color:var(--txt3);margin-top:4px;">${uz ? 'jami tushum' : 'всего выручка'}: ${new Intl.NumberFormat('ru-RU').format(Math.round(totalRev))} ${uz ? "so'm" : 'сум'}</div>
    </div>
    <div class="dsect">${uz ? "Oylar bo'yicha foyda" : 'Прибыль по месяцам'}</div>
    ${lineChart(profits.map((p) => Math.round(p / 1000000)), labels, 'var(--accent)', uz ? 'M' : 'M')}
    <div style="margin-top:14px;">${rows}</div>`
}
function renderFinance(d) {
  const box = $('financeBox'); if (!box) return
  const uz = state.lang === 'uz'
  const fmt = (n) => n == null ? '—' : new Intl.NumberFormat('ru-RU').format(Math.round(n)) + ' ' + (uz ? "so'm" : 'сум')
  const profitColor = d.profit == null ? 'var(--txt)' : (d.profit >= 0 ? 'var(--green)' : 'var(--red)')
  let breakdownHtml = ''
  const bd = (d.breakdown || []).filter((x) => x && x.amount != null).sort((a, b) => Math.abs(b.amount) - Math.abs(a.amount))
  if (bd.length) {
    const totalBd = bd.reduce((a, x) => a + Math.abs(x.amount), 0) || 1
    breakdownHtml = `
      <div class="dsect" style="margin-top:20px;">${uz ? 'Xarajatlar taqsimoti' : 'На что ушли деньги'}</div>
      <div style="background:var(--card);border:1px solid var(--line);border-radius:12px;padding:6px 14px;">
        ${bd.map((x) => {
          const pct = Math.round(Math.abs(x.amount) / totalBd * 100)
          return `<div style="padding:9px 0;border-top:1px solid var(--line);">
            <div style="display:flex;justify-content:space-between;gap:10px;font-size:13px;">
              <span style="color:var(--txt);">${escapeHtml(x.name)}</span>
              <b style="white-space:nowrap;">${fmt(x.amount)}</b>
            </div>
            <div style="height:5px;background:var(--card2);border-radius:3px;margin-top:5px;overflow:hidden;"><div style="height:100%;width:${pct}%;background:var(--accent);"></div></div>
          </div>`
        }).join('')}
      </div>`
  }
  let afterHtml = ''
  if (d.profitAfterShares != null) {
    const ac = d.profitAfterShares >= 0 ? 'var(--green)' : 'var(--red)'
    afterHtml = `<div style="background:var(--card);border:1px solid var(--line);border-radius:12px;padding:14px 16px;margin-top:12px;">
      <div style="font-size:12px;color:var(--txt2);margin-bottom:3px;">${uz ? 'Ulushlardan keyin qoldiq' : 'Остаток после долей учредителей'}</div>
      <div style="font-size:20px;font-weight:700;color:${ac};">${fmt(d.profitAfterShares)}</div>
    </div>`
  }
  box.innerHTML = `
    <div style="font-size:12px;color:var(--txt3);margin-bottom:10px;">${uz ? 'Oy' : 'Месяц'}: ${escapeHtml(d.month)}</div>
    <div class="dash-grid">
      <div class="dcard"><div class="dl">${uz ? 'Tushum (daromad)' : 'Выручка'}</div><div class="dv" style="color:var(--accent);">${fmt(d.revenue)}</div></div>
      <div class="dcard"><div class="dl">${uz ? 'Umumiy xarajatlar' : 'Расходы'}</div><div class="dv" style="color:var(--red);">${fmt(d.expenses)}</div></div>
    </div>
    <div style="background:var(--card);border:1px solid var(--line);border-radius:12px;padding:16px;margin-top:12px;">
      <div style="font-size:12px;color:var(--txt2);margin-bottom:4px;">${uz ? 'Sof foyda (ulushlardan oldin)' : 'Чистая прибыль (до долей)'}</div>
      <div style="font-size:26px;font-weight:700;color:${profitColor};">${fmt(d.profit)}</div>
      ${d.margin != null ? `<div style="font-size:12.5px;color:var(--txt2);margin-top:6px;">${uz ? 'Rentabellik' : 'Рентабельность'}: <b style="color:${profitColor};">${d.margin}%</b></div>` : ''}
      ${d.tax != null ? `<div style="font-size:12px;color:var(--txt3);margin-top:3px;">${uz ? 'Soliq' : 'Налог'}: ${fmt(d.tax)}</div>` : ''}
    </div>
    ${afterHtml}
    ${breakdownHtml}
    <button onclick="runFinanceAnalysis()" id="finAnalyzeBtn" style="width:100%;margin-top:16px;padding:13px;border-radius:11px;background:var(--accent);border:none;color:#fff;font-size:14px;font-weight:600;cursor:pointer;display:flex;align-items:center;justify-content:center;gap:8px;">${svg('sparkle', 16)} ${uz ? 'AI tahlili' : 'Анализ ИИ'}</button>
    <div id="finAnalysis" style="margin-top:14px;"></div>
    <div style="font-size:11px;color:var(--txt3);margin-top:12px;line-height:1.5;">${uz ? "Ma'lumot Google Sheets'dan AI orqali o'qiladi va keshlanadi." : 'Данные читаются из Google Sheets через ИИ и кэшируются.'}</div>`
  window._finLast = d
}
async function runFinanceAnalysis(force) {
  const uz = state.lang === 'uz'
  const box = $('finAnalysis')
  const btn = $('finAnalyzeBtn')
  const d = window._finLast
  if (!box || !d) return
  const key = 'v2_' + (d.month || '') + '_' + state.lang
  if (!window._finAnalysisCache) window._finAnalysisCache = {}
  if (!force && window._finAnalysisCache[key]) { box.innerHTML = analysisHtml(window._finAnalysisCache[key], uz); return }
  if (btn) { btn.disabled = true; btn.style.opacity = '0.6' }
  box.innerHTML = `<div style="background:var(--card);border:1px solid var(--line);border-radius:12px;padding:14px;font-size:13px;color:var(--txt3);">${uz ? 'AI moliyani tahlil qilyapti...' : 'ИИ анализирует финансы...'}</div>`
  try {
    const r = await fetch('/api/finance', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ action: 'analyze', fin: d, lang: state.lang || 'ru', force: !!force, session: getSession() }) })
    const j = await r.json()
    if (j && j.ok && j.analysis) { window._finAnalysisCache[key] = j.analysis; box.innerHTML = analysisHtml(j.analysis, uz) }
    else { box.innerHTML = `<div style="font-size:12px;color:var(--red);padding:10px;">${(j && j.error) || (uz ? 'Tahlil qilinmadi' : 'Не удалось проанализировать')}</div>` }
  } catch (e) {
    box.innerHTML = `<div style="font-size:12px;color:var(--red);padding:10px;">${uz ? "Aloqa yo'q" : 'Нет связи'}</div>`
  }
  if (btn) { btn.disabled = false; btn.style.opacity = '1' }
}
function analysisHtml(text, uz) {
  return `<div style="background:var(--card);border:1px solid var(--accent);border-radius:12px;padding:16px;font-size:13.5px;line-height:1.6;">${mdToHtml(text)}
    <button onclick="runFinanceAnalysis(true)" style="margin-top:12px;padding:7px 12px;border-radius:8px;background:none;border:1px solid var(--line2);color:var(--txt2);font-size:12px;cursor:pointer;">${uz ? 'Qayta tahlil' : 'Пересчитать заново'}</button></div>`
}

// ===== ДИНАМИКА / ТРЕНДЫ =====
let trendsLoaded = false
async function loadTrends() {
  const box = $('trendsBox'); if (!box) return
  const uz = state.lang === 'uz'
  if (!trendsLoaded) box.innerHTML = `<div style="font-size:12px;color:var(--txt3);padding:14px;">${uz ? 'Yuklanmoqda...' : 'Загрузка динамики...'}</div>`
  try {
    const r = await fetch('/api/trends')
    const d = await r.json()
    trendsLoaded = true
    window._allSnaps = d.snaps || []
    renderTrendsPeriod()
  } catch (e) {
    box.innerHTML = `<div style="font-size:12px;color:var(--red);padding:14px;">${uz ? "Ma'lumot olinmadi" : 'Не удалось загрузить'}</div>`
  }
}
function renderTrendsPeriod() {
  const all = window._allSnaps || []
  const per = window._dashPeriod || 'month'
  let snaps = all
  if (per === 'month') {
    const now = new Date(); const ym = now.toISOString().slice(0, 7)
    snaps = all.filter((s) => (s.date || '').slice(0, 7) === ym)
    if (!snaps.length) snaps = all
  }
  renderTrends(snaps)
}
function renderTrends(snaps) {
  const box = $('trendsBox'); if (!box) return
  const uz = state.lang === 'uz'
  if (!snaps.length) {
    box.innerHTML = `<div style="background:var(--card);border:1px solid var(--line);border-radius:12px;padding:18px;text-align:center;">
      <div style="font-size:14px;font-weight:600;margin-bottom:6px;">${uz ? "Dinamika hali to'planmoqda" : 'Динамика ещё копится'}</div>
      <div style="font-size:12.5px;color:var(--txt2);line-height:1.5;">${uz ? "Har kuni tizim ma'lumotni saqlaydi. 1-2 hafta ichida grafik to'ladi." : 'Каждый день система сохраняет данные. График наполнится за 1-2 недели.'}</div>
    </div>`
    return
  }
  const soldSeries = snaps.map((s) => s.soldPeriod != null ? s.soldPeriod : (s.sold || 0))
  const convSeries = snaps.map((s) => s.conv || 0)
  const dfmt = (iso) => { const p = iso.split('-'); return p[2] + '.' + p[1] }
  const labels = snaps.map((s) => dfmt(s.date))
  if (snaps.length < 3) {
    box.innerHTML = `
      <div style="background:var(--card);border:1px solid var(--line);border-radius:12px;padding:16px;margin-bottom:12px;">
        <div style="font-size:13px;color:var(--txt2);margin-bottom:10px;">${uz ? 'Bugungi holat' : 'Текущие показатели'} (${labels[labels.length - 1]})</div>
        <div style="display:flex;gap:20px;flex-wrap:wrap;">
          <div><div style="font-size:11px;color:var(--txt3);">${uz ? 'Sotuvlar (davr)' : 'Продаж (за период)'}</div><div style="font-size:22px;font-weight:700;color:var(--accent);">${soldSeries[soldSeries.length - 1]}</div></div>
          <div><div style="font-size:11px;color:var(--txt3);">${uz ? 'Konversiya' : 'Конверсия'}</div><div style="font-size:22px;font-weight:700;">${convSeries[convSeries.length - 1]}%</div></div>
        </div>
      </div>
      <div style="font-size:12.5px;color:var(--txt3);line-height:1.5;">${uz ? `Hozircha ${snaps.length} ta nuqta. Grafik ${snaps.length === 1 ? 'ertaga ikkinchi nuqta bilan' : 'bir necha kundan keyin'} paydo bo'ladi — o'sish yoki pasayishni ko'rsatadi.` : `Пока ${snaps.length} ${snaps.length === 1 ? 'точка' : 'точки'}. График появится ${snaps.length === 1 ? 'завтра со второй точкой' : 'через несколько дней'} — покажет рост или падение.`}</div>`
    return
  }
  const first = soldSeries[0], last = soldSeries[soldSeries.length - 1]
  const diff = last - first
  const trendTxt = diff > 0 ? (uz ? `o'sdi +${diff}` : `выросли на +${diff}`) : diff < 0 ? (uz ? `pasaydi ${diff}` : `упали на ${diff}`) : (uz ? "o'zgarishsiz" : 'без изменений')
  const trendColor = diff > 0 ? 'var(--green)' : diff < 0 ? 'var(--red)' : 'var(--txt2)'
  box.innerHTML = `
    <div class="dsect">${uz ? 'Sotuvlar (davr uchun)' : 'Продажи (за период)'}</div>
    <div style="font-size:13px;margin-bottom:10px;">${uz ? "So'nggi kunlarda" : 'За последние дни'}: <b style="color:${trendColor};">${trendTxt}</b> ${uz ? `(${first} → ${last})` : `(было ${first}, стало ${last})`}</div>
    ${lineChart(soldSeries, labels, 'var(--accent)', uz ? 'sotuv' : 'продаж')}
    <div class="dsect" style="margin-top:22px;">${uz ? 'Konversiya' : 'Конверсия'} (%)</div>
    ${lineChart(convSeries, labels, 'var(--green)', '%')}
    <div style="font-size:11px;color:var(--txt3);margin-top:12px;">${uz ? `${snaps.length} kunlik ma'lumot` : `Данные за ${snaps.length} дней`}</div>`
}

export { renderTrendsPeriod }

let _inited = false
export function initFinanceTrends() {
  if (_inited) return
  _inited = true
  Object.assign(window, { loadFinance, runFinanceAnalysis, loadTrends, renderTrendsPeriod })
}
