// Render-функции кабинета МОПа — дословный перенос из public/index.html
// (renderMopEarnings / renderMopStats / renderMopTeam). Возвращают HTML-строку,
// компоненты вставляют её через dangerouslySetInnerHTML для 1:1 внешнего вида.
import { mt, getMopLang } from '../../lib/i18n.js'
import { escapeHtml, fmtSumM } from '../../lib/format.js'

// Цвет метрики относительно нормы: зелёный ≥ нормы, жёлтый чуть ниже, красный сильно ниже.
// higherBetter=false для «меньше — лучше» (скорость 1-го звонка: норма — максимум).
function metricColor(v, norm, higherBetter) {
  if (v == null) return 'var(--txt)'
  if (higherBetter) return v >= norm ? 'var(--green)' : (v >= norm * 0.7 ? 'var(--gold)' : 'var(--red)')
  return v <= norm ? 'var(--green)' : (v <= norm * 3 ? 'var(--gold)' : 'var(--red)')
}

// Минималистичные контурные иконки (в стиле приложения) вместо эмодзи.
const _ICONS = {
  wallet: '<path d="M3 8a2 2 0 0 1 2-2h12a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/><path d="M16 12h3"/><path d="M3 8h13"/>',
  trendUp: '<path d="M3 17l6-6 4 4 8-8"/><path d="M21 7v5h-5"/>',
  bolt: '<path d="M13 2 4 14h7l-1 8 9-12h-7z"/>',
  award: '<circle cx="12" cy="9" r="5"/><path d="M9 13.5 7 22l5-3 5 3-2-8.5"/>',
  gift: '<path d="M4 11h16v9a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1z"/><path d="M3 7h18v4H3z"/><path d="M12 7v14"/><path d="M12 7S10.5 3 8 4s4 3 4 3zM12 7s1.5-4 4-3-4 3-4 3z"/>',
  target: '<circle cx="12" cy="12" r="8"/><circle cx="12" cy="12" r="4"/><circle cx="12" cy="12" r="1"/>',
  chart: '<path d="M3 3v18h18"/><rect x="7" y="11" width="3" height="7" rx="1"/><rect x="12" y="7" width="3" height="11" rx="1"/><rect x="17" y="13" width="3" height="5" rx="1"/>',
  clock: '<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/>',
  trendDown: '<path d="M3 7l6 6 4-4 8 8"/><path d="M21 17v-5h-5"/>',
  ladder: '<path d="M8 3v18M16 3v18M8 7h8M8 12h8M8 17h8"/>',
  pin: '<path d="M12 21s-6-5.5-6-10a6 6 0 0 1 12 0c0 4.5-6 10-6 10z"/><circle cx="12" cy="11" r="2.2"/>',
  ruler: '<path d="M4 15 15 4l5 5L9 20z"/><path d="M8 11l1.5 1.5M11 8l1.5 1.5M5 14l1.5 1.5"/>',
  phone: '<path d="M22 16.9v3a2 2 0 0 1-2.2 2 19.8 19.8 0 0 1-8.6-3 19.5 19.5 0 0 1-6-6A19.8 19.8 0 0 1 2 4.2 2 2 0 0 1 4 2h3a2 2 0 0 1 2 1.7c.1.9.3 1.8.6 2.6a2 2 0 0 1-.5 2.1L8 9.6a16 16 0 0 0 6 6l1.2-1.1a2 2 0 0 1 2.1-.5c.8.3 1.7.5 2.6.6a2 2 0 0 1 1.7 2z"/>',
  calendar: '<rect x="3" y="5" width="18" height="16" rx="2"/><path d="M3 9h18M8 3v4M16 3v4"/>',
  check: '<path d="M20 6 9 17l-5-5"/>',
  circle: '<circle cx="12" cy="12" r="7"/>',
  dot: '<circle cx="12" cy="12" r="5" fill="currentColor" stroke="none"/>',
}
function ic(name, size = 15, color) {
  return `<svg width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" style="vertical-align:-3px;flex:0 0 auto;${color ? `color:${color};` : ''}">${_ICONS[name] || ''}</svg>`
}

// «Топ-5 советов, чтобы закрыть план» — аналитические выводы из состояния МОПа:
// диагноз узкого места воронки + денежная оценка рычагов + реалистичный прогноз (правила, без ИИ).
function renderPlanTips(me, e, _mopData) {
  if (!me) return ''
  const uz = getMopLang() === 'uz'
  const fmtS = (n) => (n || 0).toLocaleString('ru')
  const fmtMin = (n) => n == null ? '—' : (n >= 60 ? (Math.round(n / 6) / 10 + ' ' + mt('hour')) : n + ' ' + mt('min'))
  const avgCheck = me.sold > 0 ? me.revenue / me.sold : 1800000
  const gap = me.plan > 0 ? Math.max(0, me.plan - me.revenue) : 0
  const losing = e && e.losing
  const nb = e && e.nextTempoBonus
  const di = e && e.daysInfo
  const reachWeak = me.reachPct != null && me.reachPct < 60
  const speedWeak = me.firstCallMin != null && me.firstCallMin > 30
  const convWeak = me.conv != null && me.conv < 3
  const convStrong = me.conv != null && me.conv >= 3
  const tips = [] // [priority, html]

  // 1) Диагноз: дозвон — обычно главный денежный рычаг
  if (losing && losing.noContact > 0) {
    const money = Math.round((losing.potentialSales || 0) * avgCheck)
    tips.push([100, uz
      ? `<b>Asosiy zaif nuqta — aloqa (${me.reachPct}%, norma 60%).</b> ${losing.noContact} ta lid suhbatsiz yoʻqolgan${losing.potentialSales > 0 ? ` — bu ~${losing.potentialSales} sotuv ≈ <b>${fmtSumM(money)}</b>` : ''}. Bugun aynan shularga qoʻngʻiroq qiling — eng tez pul shu yerda.`
      : `<b>Главная утечка — дозвон (${me.reachPct}%, норма 60%).</b> ${losing.noContact} лидов умерли без разговора${losing.potentialSales > 0 ? ` — это ~${losing.potentialSales} продаж ≈ <b>${fmtSumM(money)}</b>` : ''}. Прозвоните сегодня именно их — это самые быстрые деньги.`])
  }

  // 2) Скорость как причина низкого дозвона (связываем метрики)
  if (speedWeak && reachWeak) {
    tips.push([80, uz
      ? `Aloqa pastligining sababi — sekin 1-qoʻngʻiroq (${fmtMin(me.firstCallMin)}). Lidga birinchi 30 daqiqada qoʻngʻiroq qiling, u hali «qaynoq» — aloqa oʻz-oʻzidan oshadi.`
      : `Причина низкого дозвона — медленный первый звонок (${fmtMin(me.firstCallMin)}). Звоните в первые 30 минут, пока лид «горячий» — дозвон вырастет сам.`])
  } else if (speedWeak) {
    tips.push([55, uz
      ? `1-qoʻngʻiroq ${fmtMin(me.firstCallMin)} — sekin. Birinchi 30 daqiqada qoʻngʻiroq qilsangiz, mijoz sovib ketmaydi.`
      : `Первый звонок ${fmtMin(me.firstCallMin)} — долго. В первые 30 минут клиент ещё не остыл — успевайте.`])
  }

  // 3) Конверсия: сильная сторона → жать на объём; слабая → отработка возражений с деньгами
  if (convStrong) {
    tips.push([50, uz
      ? `Konversiyangiz <b>${me.conv}%</b> — kuchli tomoningiz (norma 3%). Demak muammo sotib yopishda emas, aloqa hajmida. Koʻproq gaplashsangiz — shu konversiyada toʻgʻridan-toʻgʻri sotuv.`
      : `Ваша конверсия <b>${me.conv}%</b> — сильная сторона (норма 3%). Значит проблема не в закрытии, а в объёме контактов. Больше разговоров → при вашей конверсии это прямые продажи.`])
  } else if (convWeak) {
    const extra = Math.max(1, Math.round((me.leads || 0) * (0.03 - me.conv / 100)))
    tips.push([70, uz
      ? `Konversiya <b>${me.conv}%</b> (norma 3%). 3% ga chiqsangiz — bu ~${extra} qoʻshimcha sotuv ≈ <b>${fmtSumM(extra * avgCheck)}</b>. «Qimmat / oʻylab koʻraman»ga tayyor javob tuzing.`
      : `Конверсия <b>${me.conv}%</b> (норма 3%). Дотянув до 3%, добавите ~${extra} продаж ≈ <b>${fmtSumM(extra * avgCheck)}</b>. Сделайте готовые ответы на «дорого / подумаю».`])
  }

  // 4) План — реальность и требуемый темп
  if (gap > 0 && di && di.workLeft > 0) {
    const gapSales = Math.ceil(gap / avgCheck)
    tips.push([40, uz
      ? `Rejagacha <b>${fmtSumM(gap)}</b> (~${gapSales} sotuv). Qolgan ${di.workLeft} ish kunida kuniga <b>${fmtS(di.perDayNeeded)}</b> kerak — yuqoridagi nuqtalarni tuzatib, shu sur'atga chiqing.`
      : `До плана <b>${fmtSumM(gap)}</b> (~${gapSales} продаж). За ${di.workLeft} раб. дней нужно по <b>${fmtS(di.perDayNeeded)}</b>/день — закрыв точки выше, вы выйдете на этот темп.`])
  }

  // 5) Ближняя измеримая цель — бонус за темп
  if (nb) {
    tips.push([30, uz
      ? `Yaqin maqsad: <b>${nb.byDay}</b>-sanagacha <b>${nb.pct}%</b> ga yeting → <b>+$15</b> bonus (${nb.daysLeft} kun qoldi).`
      : `Ближняя цель: до <b>${nb.byDay}</b> числа доберите <b>${nb.pct}%</b> плана → <b>+$15</b> бонус (осталось ${nb.daysLeft} дн).`])
  }

  const top = tips.sort((a, b) => b[0] - a[0]).slice(0, 5)
  if (!top.length) return ''
  return `<div class="mop-card" style="border-color:var(--accent);margin-top:16px;margin-bottom:0;">
    <div class="mop-ct" style="color:var(--accent);">${ic('target')} ${mt('planTips')}</div>
    ${top.map(([, html], i) => `<div style="display:flex;align-items:flex-start;gap:12px;padding:11px 0;${i ? 'border-top:1px solid var(--line);' : ''}">
      <div style="flex:0 0 auto;width:24px;height:24px;border-radius:7px;background:var(--accent-bg);color:var(--accent);font-weight:800;font-size:13px;display:flex;align-items:center;justify-content:center;">${i + 1}</div>
      <div style="flex:1;font-size:13.5px;line-height:1.55;">${html}</div>
    </div>`).join('')}
  </div>`
}

// === РАЗДЕЛ 1: МОЙ ЗАРАБОТОК (деньги + цели) ===
export function renderMopEarnings(_mopData) {
  const me = _mopData.me
  if (!me) return `<div class="mop-card">${mt('notFound')}</div>`
  const planPct = me.plan > 0 ? Math.round(me.revenue / me.plan * 100) : null
  const e = _mopData.earnings
  const fmtS = (n) => (n || 0).toLocaleString('ru')

  const heroCard = e ? `<div class="mop-card" style="margin-bottom:0;">
    <div class="mop-ct">${ic('wallet')} ${mt('earnings')} · ${e.role === 'presales' ? 'Pre-Sales' : 'Sales'}</div>
    <div class="mop-hero-big">${fmtS(e.total)}</div>
    <div style="font-size:12px;color:var(--txt3);margin:5px 0 14px;">${mt('sumMonth')}</div>
    <div style="display:flex;flex-direction:column;gap:6px;font-size:13px;">
      <div style="display:flex;justify-content:space-between;"><span style="color:var(--txt2);">${mt('fix')}</span><b>${fmtS(e.fix)}</b></div>
      <div style="display:flex;justify-content:space-between;"><span style="color:var(--txt2);">${mt('kpi')} ${e.rate}%</span><b>${fmtS(e.kpiSum)}</b></div>
      ${e.tempoBonusSum > 0 ? `<div style="display:flex;justify-content:space-between;"><span style="color:var(--txt2);">${mt('tempoBonus')}</span><b style="color:var(--gold)">+${fmtS(e.tempoBonusSum)}</b></div>` : ''}
      ${e.topBonus > 0 ? `<div style="display:flex;justify-content:space-between;"><span style="color:var(--txt2);">${e.topLabel}</span><b style="color:var(--gold)">+${fmtS(e.topBonus)}</b></div>` : ''}
    </div>
  </div>` : ''

  const planCard = me.plan > 0 ? `<div class="mop-card" style="margin-bottom:0;">
    <div class="mop-ct">${ic('target')} ${mt('myPlan')}</div>
    <div style="display:flex;justify-content:space-between;align-items:baseline;margin-bottom:9px;"><span style="font-size:14px;color:var(--txt2);">${mt('goal')}: <b style="color:var(--txt);">${fmtSumM(me.plan)}</b></span><span style="font-size:26px;font-weight:800;color:${planPct >= 100 ? 'var(--green)' : (planPct >= 50 ? 'var(--accent)' : 'var(--gold)')}">${planPct}%</span></div>
    <div style="height:10px;background:var(--bg);border:1px solid var(--line2);border-radius:6px;overflow:hidden;margin-bottom:10px;"><div style="height:100%;width:${Math.min(100, planPct)}%;background:${planPct >= 100 ? 'var(--green)' : 'var(--accent)'};"></div></div>
    <div style="font-size:13px;color:var(--txt2);">${me.revenue < me.plan ? mt('leftToPlan') + ' <b>' + fmtSumM(me.plan - me.revenue) + '</b> ' + mt('toPlan') : mt('planDone')}</div>
    <div style="margin-top:12px;padding-top:12px;border-top:1px solid var(--line);">
      <div style="display:flex;justify-content:space-between;align-items:center;"><span style="font-size:13px;color:var(--txt2);">${mt('mySales')}</span><b style="font-size:14px;color:var(--green);">${me.sold} ${mt('pcs')} · ${fmtSumM(me.revenue)}</b></div>
      <div style="display:flex;justify-content:space-between;align-items:center;margin-top:8px;"><span style="font-size:13px;color:var(--txt2);display:inline-flex;align-items:center;gap:6px;">${ic('calendar', 14, 'var(--accent)')} ${mt('today')}</span>${(me.soldToday || 0) > 0 ? `<b style="font-size:14px;color:var(--green);">${me.soldToday} ${mt('pcs')} · ${fmtSumM(me.revenueToday)}</b>` : `<span style="font-size:12.5px;color:var(--txt3);">${mt('noSalesToday')}</span>`}</div>
    </div>
  </div>` : ''

  const daysCard = (e && e.daysInfo && e.daysInfo.gapToPlan > 0) ? `<div class="mop-card" style="margin-bottom:0;">
    <div class="mop-ct">${ic('calendar')} ${mt('daysLeft')}</div>
    <div style="font-size:38px;font-weight:800;color:var(--accent);line-height:1;">${e.daysInfo.workLeft}</div>
    <div style="font-size:13px;color:var(--txt2);margin-top:10px;">${mt('perDay')}</div>
    <div style="font-size:18px;font-weight:700;color:var(--green);">${fmtS(e.daysInfo.perDayNeeded)}</div>
    <div style="font-size:11px;color:var(--txt3);">${mt('perDayEnd')}</div>
  </div>` : ''

  let out = `<div class="mop-row3" style="margin-bottom:16px;align-items:stretch;">${heroCard}${planCard}${daysCard}</div>`

  if (e) {
    const steps = e.ladder.map((s) => {
      const cur = s.isCurrent, done = s.reached
      const icon = cur ? ic('dot', 14, 'var(--accent)') : (done ? ic('check', 14, 'var(--green)') : ic('circle', 14, 'var(--txt3)'))
      return `<div style="display:flex;align-items:center;gap:11px;padding:11px 12px;border-radius:11px;border:1px solid ${cur ? 'var(--accent)' : 'var(--line)'};background:${cur ? 'var(--accent-bg)' : 'var(--bg)'};${done && !cur ? 'opacity:.72;' : ''}">
        <span style="font-size:15px;flex:0 0 auto;">${icon}</span>
        <div style="flex:1;min-width:0;"><div style="font-size:13px;font-weight:${cur ? '700' : '600'};">${s.pct}% ${mt('plan')} · ${mt('rate')} ${s.rate}%</div>
        <div style="font-size:11px;color:var(--txt3);margin-top:2px;">${mt('revenueW')} ${fmtS(s.targetRevenue)} → ${mt('salaryW')} <b style="color:var(--txt2);">~${fmtS(s.earnAtStep + (e.tempoBonusSum || 0) + (e.topBonus || 0))}</b></div></div>
      </div>`
    }).join('')
    const ns = e.nextStep
    const ladderCard = `<div class="mop-card">
      <div class="mop-ct">${ic('ladder')} ${mt('ladder')}</div>
      <div style="flex:1;"><div class="mop-ladder-grid">${steps}</div></div>
      ${ns ? `<div style="margin-top:11px;padding:13px 14px;background:var(--gold-bg);border-radius:11px;border:1px solid var(--gold);">
        <div style="font-size:13px;font-weight:600;">${mt('toStep')} ${ns.pct}% ${mt('sellOn')} <b>${fmtS(ns.revenueNeeded)}</b></div>
        <div style="font-size:12px;color:var(--txt2);margin-top:3px;">${mt('rateOpens')} ${ns.newRate}% → ${mt('salaryW')} <b style="color:var(--green)">${fmtS(ns.newEarn + (e.tempoBonusSum || 0) + (e.topBonus || 0))}</b></div>
      </div>` : `<div style="margin-top:11px;padding:13px;background:var(--accent-bg);border-radius:11px;text-align:center;font-size:13px;font-weight:600;color:var(--green);">${mt('maxStep')}</div>`}
    </div>`
    // «Что тебе сделать» (сценарии) убрано; бонус за темп вынесен в шапку (renderTempoBar).
    // Лестница + «Способы заработка» рядом (50/50)
    out += `<div class="mop-earn-row">${ladderCard}${renderMopEarnWays(me, e)}</div>`
  }
  return out
}

// Полоса «до следующего бонуса за темп» — компактная, для шапки (между приветствием и призом).
export function renderTempoBar(_mopData) {
  const e = _mopData && _mopData.earnings
  const nb = e && e.nextTempoBonus
  if (!nb) return ''
  const fmtS = (n) => (n || 0).toLocaleString('ru')
  return `<div style="background:var(--card);border:1px solid var(--line2);border-radius:11px;padding:7px 12px;height:100%;box-sizing:border-box;display:flex;flex-direction:column;justify-content:center;">
    <div style="display:flex;justify-content:space-between;align-items:baseline;gap:10px;font-size:11.5px;margin-bottom:4px;">
      <span>${ic('bolt')} ${mt('nextBonus')} <b style="color:var(--gold);">+$15</b> · <b>${nb.pct}%</b> ${mt('by')} <b>${nb.byDay}${mt('dayShort')}</b></span>
      <b style="color:var(--gold);font-size:13px;">${nb.progress}%</b>
    </div>
    <div style="height:6px;background:var(--bg);border:1px solid var(--line2);border-radius:5px;overflow:hidden;"><div style="height:100%;width:${nb.progress}%;background:var(--gold);"></div></div>
    <div style="font-size:10.5px;color:var(--txt3);margin-top:4px;">${mt('sellMore')} <b style="color:var(--gold);">${fmtS(nb.revenueNeeded)}</b> · <b>${nb.daysLeft}</b> ${mt('daysWord')}</div>
  </div>`
}

// «Способы заработка» — из чего складываются деньги МОПа и сколько ещё можно поднять.
// Всё считается из реального объекта earnings (бэкенд не меняется).
function renderMopEarnWays(me, e) {
  const fmtS = (n) => (n || 0).toLocaleString('ru')
  const usd = e.usd || 0
  const bonus15 = Math.round(15 * usd)
  const maxRate = (e.ladder && e.ladder.length) ? e.ladder[e.ladder.length - 1].rate : e.rate
  const kpiAt100 = me.plan > 0 ? Math.round(me.plan * maxRate / 100) : e.kpiSum
  const tempoMax = 3 * bonus15
  const tempoLeft = Math.max(0, tempoMax - (e.tempoBonusSum || 0))
  const roleLabel = e.role === 'presales' ? 'Pre-Sales' : 'Sales'
  const tb = e.tempoBonuses || []
  const _uzTb = getMopLang() === 'uz'
  // Подпись чипа строим от данных бэкенда (byDay может меняться — напр. исключение «до 12»).
  const tbLabel = (b) => (b.byDay >= 28)
    ? (_uzTb ? `Oy oxirigacha ${b.need}%` : `${b.need}% до конца месяца`)
    : (_uzTb ? `${b.byDay}-sanagacha ${b.need}%` : `${b.need}% до ${b.byDay} числа`)
  const tempoChips = tb.map((b) => `<span style="display:inline-flex;align-items:center;gap:3px;font-size:10.5px;background:var(--bg);border:1px solid var(--line2);border-radius:999px;padding:2px 7px;margin:2px 3px 0 0;">${b.got ? ic('check', 12, 'var(--green)') : ic('circle', 12, 'var(--txt3)')} ${tbLabel(b)}</span>`).join('')

  // строка источника дохода (компактная)
  const row = (icon, name, value, note, valColor) => `
    <div style="display:flex;align-items:flex-start;gap:9px;padding:9px 0;border-top:1px solid var(--line);">
      <div style="font-size:15px;line-height:1.2;flex:0 0 auto;">${icon}</div>
      <div style="flex:1;min-width:0;">
        <div style="display:flex;justify-content:space-between;gap:8px;align-items:baseline;">
          <span style="font-size:12.5px;font-weight:600;">${name}</span>
          <b style="font-size:12.5px;white-space:nowrap;color:${valColor || 'var(--txt)'};">${value}</b>
        </div>
        ${note ? `<div style="font-size:11px;color:var(--txt3);margin-top:2px;line-height:1.4;">${note}</div>` : ''}
      </div>
    </div>`

  const kpiNote = me.plan > 0
    ? `${mt('ewKpiUpTo')} <b>${maxRate}%</b> → <b style="color:var(--green)">${fmtS(kpiAt100)}</b> ${mt('ewAtPlan100')}`
    : `${mt('ofRevenue')} · ${mt('ewKpiUpTo')} ${maxRate}%`
  const tempoNote = `${tempoChips}${tempoLeft > 0 ? `<div style="margin-top:5px;">${mt('ewCanMore')} <b style="color:var(--gold)">+${fmtS(tempoLeft)}</b></div>` : ''}`
  const topValue = e.topBonus > 0 ? `+${fmtS(e.topBonus)}` : ''
  const topNote = e.topBonus > 0 ? `${mt('ewTopGet')} <b>${e.topLabel}</b> · ${mt('ewTopVals')}` : `${mt('ewTopBecome')} · ${mt('ewTopVals')}`

  return `<div class="mop-card" style="border-color:var(--gold);margin:0;padding:15px 16px;">
    <div class="mop-ct" style="color:var(--gold);margin-bottom:8px;">${ic('wallet')} ${mt('ewTitle')}</div>
    ${row(ic('wallet'), `${mt('fix')} · ${roleLabel}`, fmtS(e.fix), mt('ewGuaranteed'))}
    ${row(ic('trendUp'), `${mt('kpi')} ${e.rate}% ${mt('ofRevenue')}`, fmtS(e.kpiSum), kpiNote, 'var(--accent)')}
    ${row(ic('bolt'), `${mt('tempoBonus')} (${mt('ewTempoEach')})`, fmtS(e.tempoBonusSum), tempoNote, 'var(--gold)')}
    ${row(ic('award'), mt('ewTop'), topValue, topNote, 'var(--gold)')}
    ${row(ic('gift'), mt('raffle').replace('🎁 ', ''), '', mt('ewRaffleNote'))}
  </div>`
}

// === РАЗДЕЛ 2: МОЯ СТАТИСТИКА (работа) ===
export function renderMopStats(_mopData) {
  const me = _mopData.me
  if (!me) return `<div class="mop-card">${mt('notFound')}</div>`
  const fcm = me.firstCallMin != null ? (me.firstCallMin >= 60 ? (Math.round(me.firstCallMin / 6) / 10 + ' ' + mt('hour')) : me.firstCallMin + ' ' + mt('min')) : '—'
  const e = _mopData.earnings
  const losing = (e && e.losing && e.losing.noContact > 0) ? e.losing : null
  const tile = (v, l, color, red) => `<div class="mop-stat"${red ? ' style="border-color:var(--red);"' : ''}><b${color ? ` style="color:${color};"` : ''}>${v}</b><span>${l}</span></div>`
  // карточка с заголовком; плитки центрируются по вертикали → равная высота без пустот
  const card = (title, inner, red, tail) => `<div class="mop-card" style="margin-bottom:0;display:flex;flex-direction:column;${red ? 'border-color:var(--red);' : ''}">
    <div class="mop-ct"${red ? ' style="color:var(--red);"' : ''}>${title}</div>
    <div class="mop-stat-grid" style="flex:1;align-content:center;">${inner}</div>
    ${tail || ''}
  </div>`

  const cards = []
  cards.push(card(`${ic('chart')} ${mt('myFunnel')}`,
    tile(me.leads, mt('leads')) + tile(me.reachPct + '%' + (me.fakeNums ? ` <span style="font-size:9px;color:var(--txt3);font-weight:400;" title="${mt('fakeNums')}">·${me.fakeNums}</span>` : ''), mt('reach'), metricColor(me.reachPct, 60, true)) + tile(me.sold + ' ' + mt('pcs'), mt('salesW')) + tile(me.conv + '%', mt('conv'), metricColor(me.conv, 3, true))))
  cards.push(card(`${ic('clock')} ${mt('myDiscipline')}`,
    tile(fcm, mt('firstCall'), metricColor(me.firstCallMin, 30, false)) + tile(me.taskRate != null ? me.taskRate + '%' : '—', mt('tasks'), metricColor(me.taskRate, 70, true))))
  if (losing) {
    cards.push(card(`${ic('trendDown')} ${mt('losing')}`,
      tile(losing.noContact, mt('noReach'), 'var(--red)', true) + (losing.potentialSales > 0 ? tile('~' + losing.potentialSales, mt('lostSales')) : ''),
      true,
      `<div style="font-size:13px;color:var(--gold);font-weight:600;margin-top:12px;">${mt('losingTip')}</div>`))
  }
  return `<div class="mop-row3" style="align-items:stretch;">${cards.join('')}</div>${renderPlanTips(me, e, _mopData)}`
}

// === РАЗДЕЛ 3: КОМАНДА (метрики + топы по каждой) ===
export function renderMopTeam(_mopData) {
  const team = _mopData.team || []
  const me = _mopData.me
  const meId = me ? me.id : null
  const fmtMin = (n) => n == null ? '—' : (n >= 60 ? (Math.round(n / 6) / 10 + ' ' + mt('hour')) : n + ' ' + mt('min'))

  // ── Кто в чём лучший (лидер по каждой метрике) ──
  const best = (fn, higher) => {
    let b = null
    team.forEach((m) => { const v = fn(m); if (v == null) return; if (b == null || (higher ? v > fn(b) : v < fn(b))) b = m })
    return b
  }
  const noms = []
  const bsl = best((m) => m.sold, true); if (bsl) noms.push([ic('award'), mt('salesW'), bsl, bsl.sold + ' ' + mt('pcs') + ' · ' + fmtSumM(bsl.revenue)])
  const bcv = best((m) => m.conv, true); if (bcv) noms.push([ic('target'), mt('conv'), bcv, bcv.conv + '%'])
  const br = best((m) => m.reachPct, true); if (br) noms.push([ic('phone'), mt('reach'), br, br.reachPct + '%'])
  const bs = best((m) => m.firstCallMin, false); if (bs) noms.push([ic('bolt'), mt('firstCall'), bs, fmtMin(bs.firstCallMin)])
  const nomCard = noms.length ? `<div class="mop-card">
    <div class="mop-ct">${ic('award')} ${mt('tmBest')}</div>
    <div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(130px,1fr));gap:10px;">
      ${noms.map(([ic, lbl, m, val]) => { const isMe = String(m.id) === String(meId); return `<div style="background:var(--bg);border:1px solid ${isMe ? 'var(--gold)' : 'var(--line2)'};border-radius:11px;padding:10px 12px;">
        <div style="font-size:11px;color:var(--txt3);">${ic} ${lbl}</div>
        <div style="font-size:14px;font-weight:700;margin-top:2px;">${escapeHtml(m.name)}${isMe ? ' ' + mt('you') : ''}</div>
        <div style="font-size:13px;color:var(--gold);font-weight:700;">${val}</div>
      </div>` }).join('')}
    </div>
  </div>` : ''

  // ── Твои места по метрикам (без ср.чека) ──
  const rankBy = (fn, higher) => {
    const arr = team.filter((m) => fn(m) != null).slice().sort((a, b) => higher ? fn(b) - fn(a) : fn(a) - fn(b))
    const i = arr.findIndex((m) => String(m.id) === String(meId))
    return i >= 0 ? i + 1 : null
  }
  let placesCard = ''
  if (me) {
    const places = [
      [mt('salesW'), rankBy((m) => m.sold, true), `${me.sold} ${mt('pcs')} · ${fmtSumM(me.revenue)}`],
      [mt('conv'), rankBy((m) => m.conv, true), me.conv + '%'],
      [mt('reach'), rankBy((m) => m.reachPct, true), me.reachPct + '%'],
      [mt('firstCall'), rankBy((m) => m.firstCallMin, false), fmtMin(me.firstCallMin)],
    ].filter((p) => p[1] != null)
    placesCard = `<div class="mop-card">
      <div class="mop-ct">${ic('pin')} ${mt('tmYourPlaces')}</div>
      <div style="display:grid;grid-template-columns:1fr 1fr;gap:10px;">
        ${places.map(([lbl, r, val]) => { const col = r === 1 ? 'var(--green)' : (r <= 3 ? 'var(--gold)' : 'var(--txt2)'); return `<div class="mop-stat"><b style="color:${col};">№${r} <span style="color:var(--txt3);font-weight:400;">—</span> <span style="font-size:16px;color:var(--accent);font-weight:800;">${val}</span></b><span>${lbl}</span></div>` }).join('')}
      </div>
    </div>`
  }

  // ── Отдельный ТОП по каждой метрике ──
  const topList = (icon, title, fn, higher, valFn, valColor, badges) => {
    const arr = team.filter((m) => fn(m) != null).slice().sort((a, b) => higher ? fn(b) - fn(a) : fn(a) - fn(b))
    if (!arr.length) return ''
    const list = arr.map((m, i) => {
      const isMe = String(m.id) === String(meId)
      const rank = i + 1
      const medal = rank === 1 ? '🥇' : rank === 2 ? '🥈' : rank === 3 ? '🥉' : rank
      const badge = badges ? (rank === 1 ? ' 🎁+1млн' : rank === 2 ? ' 🎁+500к' : '') : ''
      return `<div class="mop-rank-row${isMe ? ' me' : ''}" style="padding-top:8px;padding-bottom:8px;">
        <div class="mop-rank-num" style="font-size:14px;">${medal}</div>
        <div style="flex:1;min-width:0;font-weight:${isMe ? '700' : '600'};font-size:13.5px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;">${escapeHtml(m.name)}${isMe ? ' ' + mt('you') : ''}<span style="font-size:11px;color:var(--gold);">${badge}</span></div>
        <b style="font-size:13.5px;color:${(typeof valColor === 'function' ? valColor(m) : valColor) || 'var(--txt)'};white-space:nowrap;">${valFn(m)}</b>
      </div>`
    }).join('')
    return `<div class="mop-card"><div class="mop-ct">${icon} ${title}</div>${list}</div>`
  }
  // норма продаж «на сегодня» = план × (прошедшие раб. дни / всего раб. дней месяца, Пн–Сб)
  const _now = new Date()
  const _y = _now.getFullYear(), _mo = _now.getMonth()
  const _dim = new Date(_y, _mo + 1, 0).getDate()
  let _passed = 0, _total = 0
  for (let d = 1; d <= _dim; d++) { const dow = new Date(_y, _mo, d).getDay(); if (dow === 0) continue; _total++; if (d <= _now.getDate()) _passed++ }
  const paceFrac = _total > 0 ? _passed / _total : 1
  const tSold_ = team.reduce((s, m) => s + (m.sold || 0), 0)
  const tRev_ = team.reduce((s, m) => s + (m.revenue || 0), 0)
  const teamAvgCheck = tSold_ > 0 ? tRev_ / tSold_ : 1800000
  const salesColor = (m) => (m.plan > 0) ? metricColor(m.sold, (m.plan / teamAvgCheck) * paceFrac, true) : 'var(--green)'
  const topSales = topList(ic('award'), mt('salesW'), (m) => m.sold, true, (m) => `${m.sold} ${mt('pcs')} · ${fmtSumM(m.revenue)}`, salesColor, true)
  const topConv = topList(ic('target'), mt('conv'), (m) => m.conv, true, (m) => m.conv + '%', (m) => metricColor(m.conv, 3, true))
  const topReach = topList(ic('phone'), mt('reach'), (m) => m.reachPct, true, (m) => m.reachPct + '%', (m) => metricColor(m.reachPct, 60, true))
  const topSpeed = topList(ic('bolt'), mt('firstCall'), (m) => m.firstCallMin, false, (m) => fmtMin(m.firstCallMin), (m) => metricColor(m.firstCallMin, 30, false))

  // ── Нормы: целевые значения по 4 отслеживаемым метрикам ──
  const normTile = (val, ic, lbl) => `<div class="mop-stat"><b style="color:var(--green);">${val}</b><span>${ic} ${lbl}</span></div>`
  const normsCard = `<div class="mop-card">
    <div class="mop-ct">${ic('ruler')} ${mt('tmNorms')}</div>
    <div style="display:grid;grid-template-columns:1fr 1fr;gap:10px;">
      ${normTile('≥ 3%', ic('target'), mt('conv'))}
      ${normTile('≥ 60%', ic('phone'), mt('reach'))}
      ${normTile('≤ 30 ' + mt('min'), ic('bolt'), mt('firstCall'))}
      ${normTile('≥ 70%', ic('check'), mt('tasks'))}
    </div>
  </div>`

  const tn = _mopData.toNext
  const banner = tn ? `<div class="mop-card" style="background:var(--accent-bg);border-color:var(--accent);">
      <div style="font-size:14px;">${mt('toLeader')} ${escapeHtml(tn.name)} ${mt('aboveYou')} — <b>${tn.soldDiff} ${mt('salesW')}</b>. ${mt('catchUp')}</div>
    </div>` : (me && me.rank === 1 ? `<div class="mop-card" style="background:var(--accent-bg);border-color:var(--accent);"><div style="font-size:14px;">${mt('first')}</div></div>` : '')

  return `<div class="mop-team-wrap">
    ${banner}
    <div class="mop-team-top">${nomCard}${placesCard}${normsCard}</div>
    <div class="mop-team-grid">${topSales}${topConv}${topReach}${topSpeed}</div>
  </div>`
}
