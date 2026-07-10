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
      return `<div style="display:flex;align-items:center;gap:11px;padding:10px 11px;border-radius:10px;${cur ? 'background:var(--accent-bg);border:1px solid var(--accent);' : ''}margin-bottom:5px;">
        <span style="font-size:14px;">${icon}</span>
        <div style="flex:1;"><div style="font-size:13px;font-weight:${cur ? '700' : '600'};">${s.pct}% ${mt('plan')} · ${mt('rate')} ${s.rate}%</div>
        <div style="font-size:11px;color:var(--txt3);">${mt('revenueW')} ${fmtS(s.targetRevenue)} → ${mt('salaryW')} ~${fmtS(s.earnAtStep)}</div></div>
      </div>`
    }).join('')
    const ns = e.nextStep
    const ladderCard = `<div class="mop-card">
      <div class="mop-ct">🪜 ${mt('ladder')}</div>${steps}
      ${ns ? `<div style="margin-top:9px;padding:12px;background:var(--gold-bg);border-radius:10px;border:1px solid var(--gold);">
        <div style="font-size:13px;font-weight:600;">${mt('toStep')} ${ns.pct}% ${mt('sellOn')} <b>${fmtS(ns.revenueNeeded)}</b></div>
        <div style="font-size:12px;color:var(--txt2);margin-top:3px;">${mt('rateOpens')} ${ns.newRate}% → ${mt('salaryW')} <b style="color:var(--green)">${fmtS(ns.newEarn)}</b> 🔥</div>
      </div>` : `<div style="margin-top:9px;padding:12px;background:var(--accent-bg);border-radius:10px;text-align:center;font-size:13px;font-weight:600;color:var(--green);">${mt('maxStep')}</div>`}
    </div>`
    let scenCard = ''
    if (e.scenarios && e.scenarios.length) {
      scenCard = `<div class="mop-card" style="border-color:var(--gold);">
        <div class="mop-ct" style="color:var(--gold);">🎯 ${mt('whatToDo')}</div>
        ${e.scenarios.map((s) => {
          let title = s.title
          if (s.kind === 'plan100') title = mt('closePlan')
          else if (s.kind === 'step') title = `${mt('reachStep')} ${s.pct}% ${mt('planWord')}`
          else if (s.kind === 'first') title = `${mt('takeFirst')} ${s.leaderName})`
          return `<div style="padding:12px;background:var(--bg);border:1px solid var(--line2);border-radius:11px;margin-bottom:8px;">
            <div style="font-size:14px;font-weight:700;margin-bottom:5px;">${s.icon} ${escapeHtml(title)}</div>
            <div style="font-size:13px;color:var(--txt2);line-height:1.6;">${mt('sellMore')} <b style="color:var(--accent)">${fmtS(s.sellMore)}</b> → ${mt('willEarn')} <b style="color:var(--green)">${fmtS(s.willEarn)}</b> <span style="color:var(--gold);font-size:12px;">(+${fmtS(s.delta)})</span>${s.topBonusNote ? `<br><span style="font-size:12px;color:var(--gold)">🎁 ${mt('forFirst')}</span>` : ''}</div>
          </div>`
        }).join('')}
      </div>`
    }
    // до следующего бонуса — под «Что тебе сделать»
    let bonusCard = ''
    if (e.nextTempoBonus) {
      const nb = e.nextTempoBonus
      bonusCard = `<div class="mop-card" style="margin-top:16px;margin-bottom:0;"><div class="mop-ct">⚡ ${mt('nextBonus')} +$15</div>
        <div style="display:flex;justify-content:space-between;font-size:13px;margin-bottom:7px;"><span>${nb.pct}% ${mt('by')} ${nb.byDay}${mt('dayShort')}</span><b>${nb.progress}%</b></div>
        <div style="height:9px;background:var(--bg);border:1px solid var(--line2);border-radius:6px;overflow:hidden;"><div style="height:100%;width:${nb.progress}%;background:var(--gold);"></div></div>
        <div style="font-size:12px;color:var(--txt3);margin-top:7px;">${mt('sellMore')} <b>${fmtS(nb.revenueNeeded)}</b> · ${nb.daysLeft} ${mt('daysWord')}</div></div>`
    }
    out += `<div class="mop-row2" style="align-items:start;">${ladderCard}<div>${scenCard || ''}${bonusCard}</div></div>`
  }
  return out
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

// === РАЗДЕЛ 3: КОМАНДА (рейтинг) ===
export function renderMopTeam(_mopData) {
  const team = _mopData.team || []
  const meId = _mopData.me ? _mopData.me.id : null
  const rows = team.map((m) => {
    const isMe = String(m.id) === String(meId)
    const medal = m.rank === 1 ? '🥇' : m.rank === 2 ? '🥈' : m.rank === 3 ? '🥉' : m.rank
    const topB = m.rank === 1 ? ' · 🎁 +1млн' : (m.rank === 2 ? ' · 🎁 +500к' : '')
    return `<div class="mop-rank-row${isMe ? ' me' : ''}">
      <div class="mop-rank-num">${medal}</div>
      <div style="flex:1;"><div style="font-weight:${isMe ? '700' : '600'};font-size:14px;">${escapeHtml(m.name)}${isMe ? ' ' + mt('you') : ''}<span style="font-size:11px;color:var(--gold);">${topB}</span></div>
        <div style="font-size:12px;color:var(--txt3);">${m.leads} ${mt('leads')} · ${mt('reach')} ${m.reachPct}% · ${mt('conv')} ${m.conv}%</div></div>
      <div style="text-align:right;"><div style="font-weight:700;">${m.sold} ${mt('salesW')}</div><div style="font-size:12px;color:var(--green);">${fmtSumM(m.revenue)}</div></div>
    </div>`
  }).join('')
  const tn = _mopData.toNext
  return `<div class="mop-team-wrap">
    ${tn ? `<div class="mop-card" style="background:var(--accent-bg);border-color:var(--accent);">
      <div style="font-size:14px;">${mt('toLeader')} ${escapeHtml(tn.name)} ${mt('aboveYou')} — <b>${tn.soldDiff} ${mt('salesW')}</b>. ${mt('catchUp')} 🔥</div>
    </div>` : (_mopData.me && _mopData.me.rank === 1 ? `<div class="mop-card" style="background:var(--accent-bg);border-color:var(--accent);"><div style="font-size:14px;">${mt('first')}</div></div>` : '')}
    <div class="mop-card">
      <div class="mop-ct">🏆 ${mt('rankTitle')}</div>
      ${rows}
    </div>
  </div>`
}
