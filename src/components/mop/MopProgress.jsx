import React, { useEffect, useRef, useState, useSyncExternalStore } from 'react'
import { gami } from '../../lib/api.js'
import { mt, getMopLang, subscribeMopLang } from '../../lib/i18n.js'

// Раздел «Прогресс» кабинета МОПа: уровень, карта 12 уровней, прогресс месяца,
// кейс с рулеткой, инвентарь. Данные и рандом — с сервера (api/gamification.js).

function fmtVal(v) {
  if (!v) return ''
  if (v >= 1000000) return (v % 1000000 === 0 ? v / 1000000 : (v / 1000000).toFixed(1)) + ' млн'
  return v.toLocaleString('ru-RU')
}
const fmtN = (n) => (n || 0).toLocaleString('ru-RU')

// Редкость приза по стоимости (в стиле CS-кейсов, но в палитре Hunter).
const RARITY = [
  { min: 1000000, key: 'legendary', c: 'var(--gold)' },
  { min: 300000, key: 'epic', c: '#a274ff' },
  { min: 100000, key: 'rare', c: 'var(--accent)' },
  { min: 30000, key: 'uncommon', c: 'var(--green)' },
  { min: 0, key: 'common', c: 'var(--txt3)' },
]
const rarityOf = (v) => RARITY.find((r) => (v || 0) >= r.min) || RARITY[RARITY.length - 1]
const RANK = { common: 0, uncommon: 1, rare: 2, epic: 3, legendary: 4 }

const ICONS = {
  coin: '<circle cx="12" cy="12" r="9"/><path d="M12 8v8M9.5 10a2.5 2 0 0 1 5 0M9.5 14a2.5 2 0 0 0 5 0"/>',
  gift: '<rect x="4" y="10" width="16" height="10" rx="1.5"/><path d="M3 7h18v3H3zM12 7v13"/><path d="M12 7S10.5 3 8 4s4 3 4 3zM12 7s1.5-4 4-3-4 3-4 3z"/>',
  lock: '<rect x="4" y="10" width="16" height="11" rx="2"/><path d="M8 10V7a4 4 0 0 1 8 0v3"/>',
  check: '<path d="M20 6 9 17l-5-5"/>',
  chev: '<path d="M6 9l6 6 6-6"/>',
  bolt: '<path d="M13 2 4 14h7l-1 8 9-12h-7z"/>',
  rank: '<path d="M12 2l2.5 4.5L20 8l-4 4 1 6-5-3-5 3 1-6-4-4 5.5-1.5z"/>',
}
function Ic({ n, size = 16, color, style }) {
  return <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" style={{ color, flex: '0 0 auto', ...style }} dangerouslySetInnerHTML={{ __html: ICONS[n] || '' }} />
}

const METRIC_KEY = { reach: 'gReach', conv: 'gConv', tasks: 'gTasks', call: 'gCall', plan: 'gPlan' }

export default function MopProgress({ view = 'levels' }) {
  useSyncExternalStore(subscribeMopLang, getMopLang, getMopLang) // перерисовка при смене языка
  const [st, setSt] = useState(null)
  const [loading, setLoading] = useState(true)
  const [spinning, setSpinning] = useState(false)
  const [strip, setStrip] = useState([])
  const [result, setResult] = useState(null)
  const [msg, setMsg] = useState('')
  const trackRef = useRef(null)
  const confRef = useRef(null)

  // Лёгкое конфетти (canvas, без библиотек) — только для редких дропов.
  function burst(color) {
    const cv = confRef.current
    if (!cv || matchMedia('(prefers-reduced-motion: reduce)').matches) return
    cv.style.display = 'block'
    const ctx = cv.getContext('2d')
    cv.width = cv.offsetWidth; cv.height = cv.offsetHeight
    const accent = getComputedStyle(document.documentElement).getPropertyValue('--accent').trim() || '#3b9eff'
    const gold = getComputedStyle(document.documentElement).getPropertyValue('--gold').trim() || '#f2b134'
    const cols = [color === 'var(--gold)' ? gold : accent, gold, '#fff']
    const P = Array.from({ length: 90 }, () => ({
      x: cv.width / 2, y: cv.height * 0.4, vx: (Math.random() * 2 - 1) * 7, vy: (Math.random() * -1 - 0.3) * 9,
      g: 0.32, s: 4 + Math.random() * 4, c: cols[(Math.random() * cols.length) | 0], rot: Math.random() * 6, vr: (Math.random() * 2 - 1) * 0.3, life: 0,
    }))
    let t = 0
    ;(function anim() {
      ctx.clearRect(0, 0, cv.width, cv.height); t++
      let alive = false
      for (const p of P) {
        p.vy += p.g; p.x += p.vx; p.y += p.vy; p.rot += p.vr; p.life++
        if (p.y < cv.height + 20) alive = true
        ctx.save(); ctx.translate(p.x, p.y); ctx.rotate(p.rot); ctx.globalAlpha = Math.max(0, 1 - p.life / 80)
        ctx.fillStyle = p.c; ctx.fillRect(-p.s / 2, -p.s / 2, p.s, p.s * 0.6); ctx.restore()
      }
      if (alive && t < 100) requestAnimationFrame(anim); else cv.style.display = 'none'
    })()
  }

  async function load() {
    try { const d = await gami.state(); if (d && d.ok) setSt(d) } catch (e) { /* ignore */ } finally { setLoading(false) }
  }
  useEffect(() => { load() }, [])

  if (loading) return <div className="mop-card" style={{ textAlign: 'center', color: 'var(--txt3)', padding: 30 }}>…</div>
  if (!st || st.enabled === false) return null

  const noOpensLeft = st.opensLeft != null && st.opensLeft <= 0
  const canOpen = st.balance >= st.case.price && !spinning && !noOpensLeft
  const pct = st.metCount != null && st.normsCount ? Math.round(st.metCount / st.normsCount * 100) : 0

  async function openCase() {
    if (spinning || st.balance < st.case.price || noOpensLeft) return
    setSpinning(true); setResult(null); setMsg('')
    let r
    try { r = await gami.openCase() } catch (e) { r = { ok: false, error: 'Ошибка сети' } }
    if (!r || !r.ok) { setSpinning(false); setMsg((r && r.error) || 'Ошибка'); return }

    const items = st.case.items || []
    const reduce = matchMedia('(prefers-reduced-motion: reduce)').matches
    const LEN = reduce ? 10 : 56, WIN = reduce ? 5 : 48
    const arr = []
    for (let i = 0; i < LEN; i++) arr.push(i === WIN ? { name: r.prize.name, value: r.prize.value } : (items[Math.floor(Math.random() * items.length)] || { name: '' }))
    setStrip(arr)

    const PITCH = 108 // ячейка 96 + gap 12
    requestAnimationFrame(() => {
      const track = trackRef.current
      if (!track) return
      const vp = track.parentElement
      const center = vp.clientWidth / 2
      const jitter = (Math.random() * 2 - 1) * 26
      const target = WIN * PITCH + PITCH / 2 - center + jitter
      track.style.transition = 'none'
      track.style.transform = 'translateX(0)'
      void track.offsetWidth
      if (reduce) { track.style.transform = `translateX(${-target}px)` }
      else {
        requestAnimationFrame(() => {
          track.style.transition = 'transform 5s cubic-bezier(.12,.62,.15,1)'
          track.style.transform = `translateX(${-target}px)`
        })
      }
    })
    setTimeout(async () => {
      setResult(r.prize); setSpinning(false)
      const rr = rarityOf(r.prize.value)
      if (RANK[rr.key] >= 3) setTimeout(() => burst(rr.c), 80) // epic/legendary
      await load()
    }, reduce ? 400 : 5200)
  }

  const drops = (st.recentDrops && st.recentDrops.length) ? st.recentDrops : (st.case.items || []).map((it) => ({ name: it.name, value: it.value }))

  return (
    <div className="gami-wrap">
      {/* ── ЖИВАЯ ЛЕНТА ДРОПОВ ── */}
      {view === 'cases' && drops.length > 0 && (
        <div className="gami-ticker">
          <div className="gami-ticker-lbl"><span className="gami-live-dot" />{mt('gLiveDrops')}</div>
          <div className="gami-ticker-vp"><div className="gami-ticker-track">
            {[...drops, ...drops].map((d, i) => {
              const r = rarityOf(d.value)
              return (
                <div className="gami-ticker-item" style={{ '--rc': r.c }} key={i}>
                  <Ic n={/бонус|ваучер|000/i.test(d.name) ? 'coin' : 'gift'} size={18} color={r.c} />
                  <div style={{ minWidth: 0 }}>
                    <div className="gami-ti-name">{d.name}</div>
                    {d.who ? <div className="gami-ti-who">{d.who}</div> : null}
                  </div>
                </div>
              )
            })}
          </div></div>
        </div>
      )}
      {/* ── ШАПКА: уровень + баллы ── */}
      <div className="mop-card gami-hero">
        <div className="gami-rank">
          <div className="gami-rank-badge"><Ic n="rank" size={26} color="var(--gold)" /><b>{st.level || '—'}</b></div>
          <div>
            <div className="gami-rank-name">{st.level > 0 ? st.levelName : mt('gNewbie')}</div>
            <div className="gami-rank-sub">{mt('gLevel')} {st.level || 0} / 12</div>
          </div>
        </div>
        <div className="gami-hero-pts">
          <div className="gami-pts-n"><Ic n="coin" size={20} color="var(--gold)" />{fmtN(st.balance)}</div>
          <div className="gami-pts-lbl">{mt('gYourPts')} · +{fmtN(st.earnedMonth)} {mt('gEarnedMonth')}</div>
        </div>
      </div>

      {/* ── ПРОГРЕСС ТЕКУЩЕГО МЕСЯЦА ── */}
      {view === 'levels' && st.progress && st.progress.length > 0 && (
        <div className="mop-card">
          <div className="mop-ct" style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline' }}>
            <span>{mt('gMonthProg')}{st.nextLevelName ? ` → ${st.nextLevelName}` : ''}</span>
            <span style={{ fontSize: 12, color: pct === 100 ? 'var(--green)' : 'var(--txt3)' }}>{st.metCount}/{st.normsCount} {mt('gMet')}</span>
          </div>
          {st.lockedThisMonth
            ? <div className="gami-locked"><Ic n="check" size={15} color="var(--green)" /> {mt('gLocked')}</div>
            : st.progress.map((p) => {
              const isCall = p.key === 'call'
              const fill = p.fact == null ? 0 : (isCall
                ? Math.min(100, p.fact > 0 ? Math.round(p.norm / p.fact * 100) : 100)
                : Math.min(100, p.norm > 0 ? Math.round(p.fact / p.norm * 100) : 0))
              const col = p.met ? 'var(--green)' : (fill >= 70 ? 'var(--gold)' : 'var(--red)')
              const factTxt = p.fact == null ? '—' : (isCall ? `${p.fact} ${mt('min')}` : `${p.fact}${p.unit === '%' ? '%' : ''}`)
              const normTxt = isCall ? `≤ ${p.norm} ${mt('min')}` : `${mt('gNorm')} ${p.norm}${p.unit === '%' ? '%' : ''}`
              return (
                <div key={p.key} className="gami-metric">
                  <div className="gami-metric-top">
                    <span className="gami-metric-lbl">{mt(METRIC_KEY[p.key])}</span>
                    <span className="gami-metric-val" style={{ color: col }}>{factTxt}<span className="gami-metric-norm">{normTxt}</span></span>
                  </div>
                  <div className="gami-bar"><i style={{ width: fill + '%', background: col }} /></div>
                </div>
              )
            })}
        </div>
      )}

      {/* ── КАРТА УРОВНЕЙ ── */}
      {view === 'levels' && (
      <div className="mop-card">
        <div className="mop-ct">{mt('gMap')}</div>
        <div className="gami-levelmap">
          {(st.levels || []).map((l) => {
            const pr = rarityOf(l.prizeValue)
            const milestone = l.n % 3 === 0
            return (
              <div key={l.n} className={'gami-node' + (l.done ? ' done' : '') + (l.current ? ' current' : '') + (milestone ? ' milestone' : '')} style={{ '--rc': pr.c }}>
                <div className="gami-node-badge">{l.done ? <Ic n="check" size={16} /> : (l.current ? l.n : <Ic n="lock" size={14} />)}</div>
                <div className="gami-node-lv">{mt('gLevel')} {l.n}</div>
                <div className="gami-node-name">{l.name}</div>
                <div className="gami-node-prize"><Ic n="gift" size={12} color="var(--rc)" /> {l.prizeName}</div>
              </div>
            )
          })}
        </div>
      </div>
      )}

      {/* ── АРЕНА КЕЙСА ── */}
      {view === 'cases' && (
      <div className="gami-arena">
        <div className="gami-arena-head">
          <div className="gami-chest">
            <div className="gami-rays" />
            <svg className="gami-chest-svg" viewBox="0 0 120 96" fill="none" xmlns="http://www.w3.org/2000/svg">
              <defs>
                <linearGradient id="gchG" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stopColor="#ffe08a" /><stop offset="1" stopColor="#d6931f" /></linearGradient>
                <linearGradient id="gchW" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stopColor="#c07f2e" /><stop offset="1" stopColor="#7e4c18" /></linearGradient>
              </defs>
              <ellipse cx="60" cy="90" rx="42" ry="5" fill="#000" opacity=".28" />
              <rect x="16" y="50" width="88" height="38" rx="6" fill="url(#gchW)" stroke="#f2b134" strokeWidth="2" />
              <path d="M16 52 V44 C16 27 104 27 104 44 V52 Z" fill="url(#gchW)" stroke="#f2b134" strokeWidth="2" />
              <rect x="14" y="48" width="92" height="8" rx="2" fill="url(#gchG)" stroke="#a9741f" strokeWidth="1" />
              <rect x="52" y="30" width="16" height="58" rx="3" fill="url(#gchG)" stroke="#a9741f" strokeWidth="1" />
              <rect x="53" y="56" width="14" height="14" rx="3" fill="#3a2a10" stroke="#f2b134" strokeWidth="1.6" />
              <circle cx="60" cy="62" r="2.4" fill="#ffe08a" /><rect x="59" y="63" width="2" height="4" fill="#ffe08a" />
              <circle cx="22" cy="82" r="2" fill="#ffe08a" /><circle cx="98" cy="82" r="2" fill="#ffe08a" />
            </svg>
          </div>
          <div className="gami-arena-title">{mt('gCase')}</div>
          <div className="gami-arena-price"><Ic n="coin" size={16} color="var(--gold)" />{fmtN(st.case.price)} {mt('gPts')}</div>
          {st.case.perDay != null && (
            <div className="gami-arena-limit">{mt('gLimitToday')}: <b>{st.opensToday || 0}/{st.case.perDay}</b></div>
          )}
        </div>
        <div className="gami-reel-vp">
          <div className="gami-marker" />
          <div className="gami-track" ref={trackRef}>
            {(strip.length ? strip : (st.case.items || [])).map((it, i) => {
              const r = rarityOf(it.value)
              return (
                <div className="gami-cell" key={i} style={{ '--rc': r.c }}>
                  <Ic n={/бонус|ваучер|000/i.test(it.name) ? 'coin' : 'gift'} size={30} color={r.c} />
                  <span className="gami-cell-n">{it.name}</span>
                  {it.value ? <span className="gami-cell-v">{fmtVal(it.value)}</span> : null}
                </div>
              )
            })}
          </div>
        </div>
        <button className="gami-open-btn" disabled={!canOpen} onClick={openCase}>
          {spinning ? '…' : mt('gOpen')}
          {!spinning && (noOpensLeft ? <small>{mt('gLimitReached')}</small> : st.balance < st.case.price ? <small>{mt('gNotEnough')}</small> : null)}
        </button>
        {msg && <div className="gami-msg">{msg}</div>}
        {/* как копить баллы */}
        <div className="gami-rules">
          <div className="gami-rules-h">{mt('gHowEarn')}</div>
          <div className="gami-rules-grid">
            <span><b>+{st.points.reach}</b> {mt('gRuleReach')}</span>
            <span><b>+{st.points.fastCall}</b> {mt('gRuleFast')}</span>
            <span><b>+{st.points.taskDone}</b> {mt('gRuleTask')}</span>
            <span><b>+{st.points.noOverdueDay}</b> {mt('gRuleDay')}</span>
          </div>
        </div>
      </div>
      )}

      {/* ── ИНВЕНТАРЬ ── */}
      {view === 'cases' && (
      <div className="mop-card">
        <div className="mop-ct">{mt('gInv')}</div>
        {(!st.inventory || !st.inventory.length)
          ? <div style={{ color: 'var(--txt3)', fontSize: 13, padding: '4px 0' }}>{mt('gEmptyInv')}</div>
          : <div className="gami-inv">
            {st.inventory.map((it) => (
              <div key={it.id} className="gami-inv-item">
                <Ic n={it.type === 'level' ? 'rank' : 'gift'} size={20} color={it.type === 'level' ? 'var(--gold)' : 'var(--accent)'} />
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div className="gami-inv-name">{it.name}{it.type === 'level' ? ` · ${mt('gLevel')} ${it.level}` : ''}</div>
                  {it.value ? <div className="gami-inv-val">{fmtVal(it.value)}</div> : null}
                </div>
                <span className={'gami-status ' + (it.status === 'delivered' ? 'done' : 'pend')}>{it.status === 'delivered' ? mt('gDelivered') : mt('gPending')}</span>
              </div>
            ))}
          </div>}
      </div>
      )}

      {/* ── РЕЗУЛЬТАТ ОТКРЫТИЯ ── */}
      {result && (
        <div className="gami-modal-ov" onClick={() => setResult(null)}>
          <div className="gami-modal" style={{ '--rc': rarityOf(result.value).c }} onClick={(e) => e.stopPropagation()}>
            <canvas ref={confRef} className="gami-conf" />
            <div className="gami-modal-glow" />
            <div className="gami-modal-lbl">{mt('gWon')}</div>
            <div className="gami-modal-ic"><Ic n={/бонус|ваучер|000/i.test(result.name) ? 'coin' : 'gift'} size={62} color="var(--rc)" /></div>
            <h3 className="gami-modal-name">{result.name}</h3>
            {result.value ? <div className="gami-modal-val">{fmtVal(result.value)}</div> : null}
            <button className="gami-open-btn gami-open-btn--lg" style={{ marginTop: 20 }} onClick={() => setResult(null)}>{mt('gTake')}</button>
          </div>
        </div>
      )}
    </div>
  )
}
