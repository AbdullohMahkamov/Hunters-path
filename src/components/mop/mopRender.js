// Render-функции кабинета МОПа — дословный перенос из public/index.html
// (renderMopEarnings / renderMopStats / renderMopTeam). Возвращают HTML-строку,
// компоненты вставляют её через dangerouslySetInnerHTML для 1:1 внешнего вида.
import { mt } from '../../lib/i18n.js'
import { escapeHtml, fmtSumM } from '../../lib/format.js'

// === РАЗДЕЛ 1: МОЙ ЗАРАБОТОК (деньги + цели) ===
export function renderMopEarnings(_mopData) {
  const me = _mopData.me
  if (!me) return `<div class="mop-card">${mt('notFound')}</div>`
  const planPct = me.plan > 0 ? Math.round(me.revenue / me.plan * 100) : null
  const e = _mopData.earnings
  const fmtS = (n) => (n || 0).toLocaleString('ru')

  const heroCard = e ? `<div class="mop-card" style="margin-bottom:0;">
    <div class="mop-ct">💵 ${mt('earnings')} · ${e.role === 'presales' ? 'Pre-Sales' : 'Sales'}</div>
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
    <div class="mop-ct">🎯 ${mt('myPlan')}</div>
    <div style="display:flex;justify-content:space-between;align-items:baseline;margin-bottom:9px;"><span style="font-size:14px;color:var(--txt2);">${mt('goal')}: <b style="color:var(--txt);">${fmtSumM(me.plan)}</b></span><span style="font-size:26px;font-weight:800;color:${planPct >= 100 ? 'var(--green)' : (planPct >= 50 ? 'var(--accent)' : 'var(--gold)')}">${planPct}%</span></div>
    <div style="height:10px;background:var(--bg);border:1px solid var(--line2);border-radius:6px;overflow:hidden;margin-bottom:10px;"><div style="height:100%;width:${Math.min(100, planPct)}%;background:${planPct >= 100 ? 'var(--green)' : 'var(--accent)'};"></div></div>
    <div style="font-size:13px;color:var(--txt2);">${me.revenue < me.plan ? mt('leftToPlan') + ' <b>' + fmtSumM(me.plan - me.revenue) + '</b> ' + mt('toPlan') : mt('planDone')}</div>
    <div style="display:flex;justify-content:space-between;margin-top:12px;padding-top:12px;border-top:1px solid var(--line);"><span style="font-size:13px;color:var(--txt2);">${mt('mySales')}</span><b style="font-size:14px;color:var(--green);">${me.sold} · ${fmtSumM(me.revenue)}</b></div>
  </div>` : ''

  const daysCard = (e && e.daysInfo && e.daysInfo.gapToPlan > 0) ? `<div class="mop-card" style="margin-bottom:0;">
    <div class="mop-ct">📅 ${mt('daysLeft')}</div>
    <div style="font-size:38px;font-weight:800;color:var(--accent);line-height:1;">${e.daysInfo.workLeft}</div>
    <div style="font-size:13px;color:var(--txt2);margin-top:10px;">${mt('perDay')}</div>
    <div style="font-size:18px;font-weight:700;color:var(--green);">${fmtS(e.daysInfo.perDayNeeded)}</div>
    <div style="font-size:11px;color:var(--txt3);">${mt('perDayEnd')}</div>
  </div>` : ''

  let out = `<div class="mop-row3" style="margin-bottom:16px;align-items:stretch;">${heroCard}${planCard}${daysCard}</div>`

  if (e) {
    const steps = e.ladder.map((s) => {
      const cur = s.isCurrent, done = s.reached
      const icon = cur ? '📍' : (done ? '✅' : '⬜')
      return `<div style="display:flex;align-items:center;gap:11px;padding:11px 12px;border-radius:11px;border:1px solid ${cur ? 'var(--accent)' : 'var(--line)'};background:${cur ? 'var(--accent-bg)' : 'var(--bg)'};${done && !cur ? 'opacity:.72;' : ''}">
        <span style="font-size:15px;flex:0 0 auto;">${icon}</span>
        <div style="flex:1;min-width:0;"><div style="font-size:13px;font-weight:${cur ? '700' : '600'};">${s.pct}% ${mt('plan')} · ${mt('rate')} ${s.rate}%</div>
        <div style="font-size:11px;color:var(--txt3);margin-top:2px;">${mt('revenueW')} ${fmtS(s.targetRevenue)} → ${mt('salaryW')} <b style="color:var(--txt2);">~${fmtS(s.earnAtStep + (e.tempoBonusSum || 0) + (e.topBonus || 0))}</b></div></div>
      </div>`
    }).join('')
    const ns = e.nextStep
    const ladderCard = `<div class="mop-card">
      <div class="mop-ct">🪜 ${mt('ladder')}</div>
      <div class="mop-ladder-grid">${steps}</div>
      ${ns ? `<div style="margin-top:11px;padding:13px 14px;background:var(--gold-bg);border-radius:11px;border:1px solid var(--gold);">
        <div style="font-size:13px;font-weight:600;">${mt('toStep')} ${ns.pct}% ${mt('sellOn')} <b>${fmtS(ns.revenueNeeded)}</b></div>
        <div style="font-size:12px;color:var(--txt2);margin-top:3px;">${mt('rateOpens')} ${ns.newRate}% → ${mt('salaryW')} <b style="color:var(--green)">${fmtS(ns.newEarn + (e.tempoBonusSum || 0) + (e.topBonus || 0))}</b> 🔥</div>
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
  return `<div style="background:var(--card);border:1px solid var(--line2);border-radius:12px;padding:9px 14px;">
    <div style="display:flex;justify-content:space-between;align-items:baseline;gap:10px;font-size:11.5px;margin-bottom:5px;">
      <span style="font-weight:600;">⚡ ${mt('nextBonus')} +$15 · ${nb.pct}% ${mt('by')} ${nb.byDay}${mt('dayShort')}</span>
      <b>${nb.progress}%</b>
    </div>
    <div style="height:8px;background:var(--bg);border:1px solid var(--line2);border-radius:6px;overflow:hidden;"><div style="height:100%;width:${nb.progress}%;background:var(--gold);"></div></div>
    <div style="font-size:10.5px;color:var(--txt3);margin-top:5px;">${mt('sellMore')} <b>${fmtS(nb.revenueNeeded)}</b> · ${nb.daysLeft} ${mt('daysWord')}</div>
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
  const tbKeys = ['by10', 'by20', 'by30']
  const tempoChips = tb.map((b, i) => `<span style="display:inline-flex;align-items:center;gap:3px;font-size:10.5px;background:var(--bg);border:1px solid var(--line2);border-radius:999px;padding:2px 7px;margin:2px 3px 0 0;">${b.got ? '✅' : '⬜'} ${mt(tbKeys[i])}</span>`).join('')

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
    <div class="mop-ct" style="color:var(--gold);margin-bottom:8px;">💰 ${mt('ewTitle')}</div>
    ${row('💵', `${mt('fix')} · ${roleLabel}`, fmtS(e.fix), mt('ewGuaranteed'))}
    ${row('📈', `${mt('kpi')} ${e.rate}% ${mt('ofRevenue')}`, fmtS(e.kpiSum), kpiNote, 'var(--accent)')}
    ${row('⚡', `${mt('tempoBonus')} (${mt('ewTempoEach')})`, fmtS(e.tempoBonusSum), tempoNote, 'var(--gold)')}
    ${row('🏆', mt('ewTop'), topValue, topNote, 'var(--gold)')}
    ${row('🎁', mt('raffle').replace('🎁 ', ''), '', mt('ewRaffleNote'))}
  </div>`
}

// === РАЗДЕЛ 2: МОЯ СТАТИСТИКА (работа) ===
export function renderMopStats(_mopData) {
  const me = _mopData.me
  if (!me) return `<div class="mop-card">${mt('notFound')}</div>`
  const fcm = me.firstCallMin != null ? (me.firstCallMin >= 60 ? (Math.round(me.firstCallMin / 6) / 10 + ' ' + mt('hour')) : me.firstCallMin + ' ' + mt('min')) : '—'
  const e = _mopData.earnings
  const fmtS = (n) => (n || 0).toLocaleString('ru')
  const cards = []
  cards.push(`<div class="mop-card" style="margin-bottom:0;">
    <div class="mop-ct">📊 ${mt('myFunnel')}</div>
    <div class="mop-stat-grid">
      <div class="mop-stat"><b>${me.leads}</b><span>${mt('leads')}</span></div>
      <div class="mop-stat"><b>${me.reachPct}%</b><span>${mt('reach')}</span></div>
      <div class="mop-stat"><b>${me.sold}</b><span>${mt('salesW')}</span></div>
      <div class="mop-stat"><b>${me.conv}%</b><span>${mt('conv')}</span></div>
    </div>
  </div>`)
  cards.push(`<div class="mop-card" style="margin-bottom:0;">
    <div class="mop-ct">⏱️ ${mt('myDiscipline')}</div>
    <div class="mop-stat-grid">
      <div class="mop-stat"><b>${fcm}</b><span>${mt('firstCall')}</span></div>
      <div class="mop-stat"><b>${me.taskRate != null ? me.taskRate + '%' : '—'}</b><span>${mt('tasks')}</span></div>
    </div>
  </div>`)
  if (e && e.losing && e.losing.noContact > 0) {
    cards.push(`<div class="mop-card" style="margin-bottom:0;border-color:var(--red);"><div class="mop-ct" style="color:var(--red);">📉 ${mt('losing')}</div>
      <div style="font-size:14px;"><b style="font-size:34px;color:var(--red);">${e.losing.noContact}</b> ${mt('noReach')}</div>
      ${e.losing.potentialSales > 0 ? `<div style="font-size:13px;color:var(--txt2);margin-top:6px;">${mt('potentialLost')}${e.losing.potentialSales} ${mt('lostSales')}</div>` : ''}
      <div style="font-size:14px;color:var(--gold);margin-top:10px;font-weight:600;">${mt('losingTip')}</div></div>`)
  }
  return `<div class="mop-row3" style="align-items:start;">${cards.join('')}</div>`
}

// === РАЗДЕЛ 3: КОМАНДА (рейтинг + метрики) ===
export function renderMopTeam(_mopData) {
  const team = _mopData.team || []
  const me = _mopData.me
  const meId = me ? me.id : null
  const fmtMin = (n) => n == null ? '—' : (n >= 60 ? (Math.round(n / 6) / 10 + ' ' + mt('hour')) : n + ' ' + mt('min'))
  const avgCheck = (m) => m.sold > 0 ? Math.round(m.revenue / m.sold) : 0

  // ── строки рейтинга (обогащённые: + средний чек и скорость 1-го звонка) ──
  const rows = team.map((m) => {
    const isMe = String(m.id) === String(meId)
    const medal = m.rank === 1 ? '🥇' : m.rank === 2 ? '🥈' : m.rank === 3 ? '🥉' : m.rank
    const topB = m.rank === 1 ? ' · 🎁 +1млн' : (m.rank === 2 ? ' · 🎁 +500к' : '')
    const extra = `${m.sold > 0 ? ` · ${mt('tmAvgCheck')} ${fmtSumM(avgCheck(m))}` : ''}${m.firstCallMin != null ? ` · ${mt('firstCall')} ${fmtMin(m.firstCallMin)}` : ''}`
    return `<div class="mop-rank-row${isMe ? ' me' : ''}">
      <div class="mop-rank-num">${medal}</div>
      <div style="flex:1;min-width:0;"><div style="font-weight:${isMe ? '700' : '600'};font-size:14px;">${escapeHtml(m.name)}${isMe ? ' ' + mt('you') : ''}<span style="font-size:11px;color:var(--gold);">${topB}</span></div>
        <div style="font-size:12px;color:var(--txt3);">${m.leads} ${mt('leads')} · ${mt('reach')} ${m.reachPct}% · ${mt('conv')} ${m.conv}%${extra}</div></div>
      <div style="text-align:right;"><div style="font-weight:700;">${m.sold} ${mt('salesW')}</div><div style="font-size:12px;color:var(--green);">${fmtSumM(m.revenue)}</div></div>
    </div>`
  }).join('')

  // ── Итоги команды ──
  const totSold = team.reduce((s, m) => s + (m.sold || 0), 0)
  const totRev = team.reduce((s, m) => s + (m.revenue || 0), 0)
  const totLeads = team.reduce((s, m) => s + (m.leads || 0), 0)
  const avgConv = totLeads > 0 ? +(totSold / totLeads * 100).toFixed(1) : 0
  const tile = (v, l, color) => `<div style="background:var(--bg);border:1px solid var(--line2);border-radius:11px;padding:11px 12px;">
    <div style="font-size:20px;font-weight:800;${color ? `color:${color};` : ''}">${v}</div><div style="font-size:11px;color:var(--txt3);">${l}</div></div>`
  const totalsCard = `<div class="mop-card">
    <div class="mop-ct">📊 ${mt('tmTotals')}</div>
    <div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(120px,1fr));gap:10px;">
      ${tile(totSold, mt('salesW'), 'var(--accent)')}
      ${tile(fmtSumM(totRev), mt('revW'), 'var(--green)')}
      ${tile(avgConv + '%', mt('tmConvAvg'))}
      ${tile(totLeads, mt('leads'))}
    </div>
  </div>`

  // ── Кто в чём лучший (номинации) ──
  const best = (fn, higher) => {
    let b = null
    team.forEach((m) => { const v = fn(m); if (v == null) return; if (b == null || (higher ? v > fn(b) : v < fn(b))) b = m })
    return b
  }
  const noms = []
  const bc = best(avgCheck, true); if (bc && avgCheck(bc) > 0) noms.push(['💰', mt('tmAvgCheck'), bc, fmtSumM(avgCheck(bc))])
  const br = best((m) => m.reachPct, true); if (br) noms.push(['📞', mt('reach'), br, br.reachPct + '%'])
  const bcv = best((m) => m.conv, true); if (bcv) noms.push(['🎯', mt('conv'), bcv, bcv.conv + '%'])
  const bs = best((m) => m.firstCallMin, false); if (bs) noms.push(['⚡', mt('firstCall'), bs, fmtMin(bs.firstCallMin)])
  const nomCard = noms.length ? `<div class="mop-card">
    <div class="mop-ct">🏅 ${mt('tmBest')}</div>
    <div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(150px,1fr));gap:10px;">
      ${noms.map(([ic, lbl, m, val]) => { const isMe = String(m.id) === String(meId); return `<div style="background:var(--bg);border:1px solid ${isMe ? 'var(--gold)' : 'var(--line2)'};border-radius:11px;padding:10px 12px;">
        <div style="font-size:11px;color:var(--txt3);">${ic} ${lbl}</div>
        <div style="font-size:14px;font-weight:700;margin-top:2px;">${escapeHtml(m.name)}${isMe ? ' ' + mt('you') : ''}</div>
        <div style="font-size:13px;color:var(--gold);font-weight:700;">${val}</div>
      </div>` }).join('')}
    </div>
  </div>` : ''

  // ── Твои места по метрикам ──
  let placesCard = ''
  if (me) {
    const rankBy = (fn, higher) => {
      const arr = team.filter((m) => fn(m) != null).slice().sort((a, b) => higher ? fn(b) - fn(a) : fn(a) - fn(b))
      const i = arr.findIndex((m) => String(m.id) === String(meId))
      return i >= 0 ? i + 1 : null
    }
    const places = [
      [mt('salesW'), rankBy((m) => m.sold, true)],
      [mt('conv'), rankBy((m) => m.conv, true)],
      [mt('tmAvgCheck'), rankBy((m) => avgCheck(m), true)],
      [mt('reach'), rankBy((m) => m.reachPct, true)],
      [mt('firstCall'), rankBy((m) => m.firstCallMin, false)],
    ].filter((p) => p[1] != null)
    placesCard = `<div class="mop-card">
      <div class="mop-ct">📌 ${mt('tmYourPlaces')}</div>
      <div style="display:flex;flex-wrap:wrap;gap:8px;">
        ${places.map(([lbl, r]) => { const col = r === 1 ? 'var(--green)' : (r <= 3 ? 'var(--gold)' : 'var(--txt2)'); return `<span style="display:inline-flex;align-items:center;gap:6px;background:var(--bg);border:1px solid var(--line2);border-radius:999px;padding:5px 11px;font-size:12.5px;"><b style="color:${col};">№${r}</b> ${lbl}</span>` }).join('')}
      </div>
    </div>`
  }

  const tn = _mopData.toNext
  const banner = tn ? `<div class="mop-card" style="background:var(--accent-bg);border-color:var(--accent);">
      <div style="font-size:14px;">${mt('toLeader')} ${escapeHtml(tn.name)} ${mt('aboveYou')} — <b>${tn.soldDiff} ${mt('salesW')}</b>. ${mt('catchUp')} 🔥</div>
    </div>` : (me && me.rank === 1 ? `<div class="mop-card" style="background:var(--accent-bg);border-color:var(--accent);"><div style="font-size:14px;">${mt('first')}</div></div>` : '')

  return `<div class="mop-team-wrap">
    ${banner}
    ${totalsCard}
    ${placesCard}
    ${nomCard}
    <div class="mop-card">
      <div class="mop-ct">🏆 ${mt('rankTitle')}</div>
      ${rows}
    </div>
  </div>`
}
