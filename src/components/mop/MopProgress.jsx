import React, { useEffect, useRef, useState, useSyncExternalStore } from 'react'
import { gami } from '../../lib/api.js'
import { mt, getMopLang, subscribeMopLang } from '../../lib/i18n.js'
import { prizeArt } from './prizeArt.js'

// Раздел «Прогресс» кабинета МОПа: уровень, карта 12 уровней, прогресс месяца,
// кейс с рулеткой, инвентарь. Данные и рандом — с сервера (api/gamification.js).

function fmtVal(v) {
  if (!v) return ''
  if (v >= 1000000) return (v % 1000000 === 0 ? v / 1000000 : (v / 1000000).toFixed(1)) + ' млн'
  return v.toLocaleString('ru-RU')
}
const fmtN = (n) => (n || 0).toLocaleString('ru-RU')

// Редкость приза по стоимости — 4 группы: зелёный (обычный) → синий → фиолет → золото (лучший).
const RARITY = [
  { min: 50000, key: 'gold', c: '#f2b134' },    // лучший
  { min: 25000, key: 'purple', c: '#a274ff' },
  { min: 12000, key: 'blue', c: '#3b9eff' },
  { min: 0, key: 'green', c: '#2ec46b' },        // обычный
]
// Категории по названию поверх ценовой редкости:
// деньги (ваучер/бонус/сум) — золото; снеки/перекусы — красный.
const MONEY_RE = /ваучер|бонус|сум|деньг|cash|money/i
const SNACK_RE = /кола|чипс|шоколад|кофе|энергетик|обед|снек|перекус|twix|snick|sniker|baunty|bounty|qurt|coca|pepsi|chips|ermak|shokolad|конфет|батончик/i
const MONEY_RC = { key: 'money', c: '#f2b134' }
const SNACK_RC = { key: 'snack', c: '#ff5a5f' }
const rarityOf = (v, name) => {
  if (name) {
    if (MONEY_RE.test(name)) return MONEY_RC
    if (SNACK_RE.test(name)) return SNACK_RC
  }
  return RARITY.find((r) => (v || 0) >= r.min) || RARITY[RARITY.length - 1]
}
// Прикольная подпись под дропом (узбекский, пара слов) по категории приза.
const CAPTIONS = {
  money: [
    'Choʻntak toʻldi, endi mazza qiling!',
    'Pul tushdi — bugun sizniki kun!',
    'Omad kulib boqdi, sizni tabriklaymiz!',
    'Zoʻr! Bu pulni aql bilan ishlating!',
    'Byudjet oʻsdi, shu ruhda davom eting!',
  ],
  snack: [
    'Gazak tayyor, choy damlashni unutmang!',
    'Mazza qiling, buni siz zabt etdingiz!',
    'Kichik, lekin qorinni xursand qiladi!',
    'Shirinlik vaqti — kayfiyat balandga koʻtarildi!',
    'Tanaffusda yeng, keyin yana zabt eting!',
  ],
  sticker: [
    'Kichik, lekin kayfiyatni koʻtaradigan zoʻr sovgʻa!',
    'Kolleksiyaga qoʻshildi — keyingisi kattaroq boʻladi!',
    'Boshlanishi yaxshi, katta yutuqlar hali oldinda!',
    'Mayli, bugun shu — ertaga jekpot sizniki!',
    'Kulgu kafolatlangan, endi jamoaga ulashing buni!',
  ],
  tech: [
    'Voy, texnika! Bu haqiqiy daraja, tabriklaymiz!',
    'Katta yutuq — mehnatingiz behuda ketmadi, zoʻr!',
    'Ura, gadjet qoʻlda! Buni halol ishlab oldingiz!',
    'Zoʻr sovgʻa, hasadchilar koʻpayadi endi!',
  ],
  def: [
    'Zoʻr drop! Omad siz bilan, davom eting!',
    'Tabriklaymiz, bu sovgʻani halol yutib oldingiz!',
    'Omad kulib boqdi — keyingisi yanada zoʻr!',
  ],
}
function prizeCaption(name, value) {
  const s = (name || '').toLowerCase()
  let key = 'def'
  if (MONEY_RE.test(s)) key = 'money'
  else if (SNACK_RE.test(s)) key = 'snack'
  else if (/стикер|наклей/.test(s)) key = 'sticker'
  else if (/airpods|наушник|iphone|смартфон|redmi|ipad|час|колонка|jbl|playstation|ps5|клав|мыш|пауэрбанк|power/.test(s)) key = 'tech'
  const arr = CAPTIONS[key]
  return arr[Math.floor(Math.random() * arr.length)]
}

const ICONS = {
  coin: '<circle cx="12" cy="12" r="9"/><path d="M12 8v8M9.5 10a2.5 2 0 0 1 5 0M9.5 14a2.5 2 0 0 0 5 0"/>',
  gift: '<rect x="4" y="10" width="16" height="10" rx="1.5"/><path d="M3 7h18v3H3zM12 7v13"/><path d="M12 7S10.5 3 8 4s4 3 4 3zM12 7s1.5-4 4-3-4 3-4 3z"/>',
  lock: '<rect x="4" y="10" width="16" height="11" rx="2"/><path d="M8 10V7a4 4 0 0 1 8 0v3"/>',
  check: '<path d="M20 6 9 17l-5-5"/>',
  cross: '<path d="M6 6l12 12M18 6L6 18"/>',
  dot: '<circle cx="12" cy="12" r="3.4" fill="currentColor" stroke="none"/>',
  chev: '<path d="M6 9l6 6 6-6"/>',
  bolt: '<path d="M13 2 4 14h7l-1 8 9-12h-7z"/>',
  rank: '<path d="M12 2l2.5 4.5L20 8l-4 4 1 6-5-3-5 3 1-6-4-4 5.5-1.5z"/>',
  phone: '<rect x="7" y="2" width="10" height="20" rx="2.5"/><path d="M11 18h2"/>',
  tablet: '<rect x="5" y="2" width="14" height="20" rx="2.5"/><path d="M11 18h2"/>',
  headphone: '<path d="M4 14v-2a8 8 0 0 1 16 0v2"/><rect x="3" y="14" width="4" height="6" rx="1.4"/><rect x="17" y="14" width="4" height="6" rx="1.4"/>',
  airpods: '<path d="M9 3v10a3 3 0 0 1-6 0 3 3 0 0 1 3-3h3z"/><path d="M15 3v10a3 3 0 0 0 6 0 3 3 0 0 0-3-3h-3z"/>',
  watch: '<rect x="7" y="6" width="10" height="12" rx="3"/><path d="M9 6l1-3h4l1 3M9 18l1 3h4l1-3"/>',
  speaker: '<rect x="6" y="2" width="12" height="20" rx="2.5"/><circle cx="12" cy="15" r="3.5"/><circle cx="12" cy="6" r="1"/>',
  gamepad: '<path d="M7 8h10a5 5 0 0 1 5 5 4 4 0 0 1-7 2.5L13 14h-2l-2 1.5A4 4 0 0 1 2 13a5 5 0 0 1 5-5z"/><path d="M6.5 11v2M5.5 12h2M15.5 11.5h.01M17.5 13.5h.01"/>',
  keyboard: '<rect x="2" y="6" width="20" height="12" rx="2"/><path d="M6 10h.01M10 10h.01M14 10h.01M18 10h.01M7 14h10"/>',
  mug: '<path d="M4 6h12v8a4 4 0 0 1-4 4H8a4 4 0 0 1-4-4z"/><path d="M16 8h2.5a2.5 2.5 0 0 1 0 5H16"/>',
  cap: '<path d="M3 15a9 9 0 0 1 18 0z"/><path d="M12 15a6 6 0 0 1 9-3"/>',
  sticker: '<path d="M14.5 3H6a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h6l8-8V5a2 2 0 0 0-2-2z"/><path d="M13 21v-6a1 1 0 0 1 1-1h6"/>',
  snack: '<path d="M6 8h12l-1.2 12.2A2 2 0 0 1 14.8 22H9.2a2 2 0 0 1-2-1.8z"/><path d="M8 8V5a4 4 0 0 1 8 0v3"/>',
  play: '<circle cx="12" cy="12" r="9"/><path d="M10 8.5l6 3.5-6 3.5z"/>',
  battery: '<rect x="3" y="8" width="16" height="9" rx="2"/><path d="M21 11v3M8 10l-1 2h2l-1 2"/>',
  cert: '<rect x="4" y="4" width="16" height="13" rx="2"/><path d="M8 20l2-3M16 20l-2-3M9 9h6M9 12h4"/>',
}
function pickIcon(name) {
  const s = (name || '').toLowerCase()
  if (/бонус|ваучер|сум|000/.test(s)) return 'coin'
  if (/airpods/.test(s)) return 'airpods'
  if (/наушник/.test(s)) return 'headphone'
  if (/iphone|смартфон|redmi|телефон/.test(s)) return 'phone'
  if (/ipad|планшет/.test(s)) return 'tablet'
  if (/playstation|ps5|консоль/.test(s)) return 'gamepad'
  if (/час/.test(s)) return 'watch'
  if (/колонка|jbl|bluetooth/.test(s)) return 'speaker'
  if (/клав|мыш/.test(s)) return 'keyboard'
  if (/кружк/.test(s)) return 'mug'
  if (/кепк|шоппер/.test(s)) return 'cap'
  if (/стикер/.test(s)) return 'sticker'
  if (/кола|чипс|шоколад|кофе|энергетик|обед|снек/.test(s)) return 'snack'
  if (/подписк|spotify|netflix|youtube/.test(s)) return 'play'
  if (/пауэрбанк|power/.test(s)) return 'battery'
  if (/сертификат|мерч|поездк|набор/.test(s)) return 'cert'
  return 'gift'
}
function Ic({ n, size = 16, color, style }) {
  return <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" style={{ color, flex: '0 0 auto', ...style }} dangerouslySetInnerHTML={{ __html: ICONS[n] || '' }} />
}
// Визуал приза: живое фото (если задан URL) или контурная иллюстрация по категории.
function PrizeVisual({ item, size = 30, className }) {
  const r = rarityOf(item && item.value, item && item.name)
  if (item && item.image) {
    return <img src={item.image} alt={item.name || ''} loading="lazy" className={'gami-photo ' + (className || '')} style={{ '--rc': r.c, width: size, height: size }} />
  }
  const s = Math.round(size * 1.45)
  return <svg viewBox="0 0 64 64" width={s} height={s} className={'gami-art ' + (className || '')} style={{ flex: '0 0 auto' }} dangerouslySetInnerHTML={{ __html: prizeArt(item && item.name) }} />
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
  const [invShown, setInvShown] = useState(10)
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

  const freeOpens = st.freeOpens || 0
  const noOpensLeft = st.opensLeft != null && st.opensLeft <= 0
  const canOpen = !spinning && (freeOpens > 0 || (st.balance >= st.case.price && !noOpensLeft))
  const pct = st.metCount != null && st.normsCount ? Math.round(st.metCount / st.normsCount * 100) : 0

  async function openCase() {
    if (spinning || (freeOpens <= 0 && (st.balance < st.case.price || noOpensLeft))) return
    setSpinning(true); setResult(null); setMsg('')
    let r
    try { r = await gami.openCase() } catch (e) { r = { ok: false, error: 'Ошибка сети' } }
    if (!r || !r.ok) { setSpinning(false); setMsg((r && r.error) || 'Ошибка'); return }

    const items = st.case.items || []
    const LEN = 60, WIN = 50
    const arr = []
    for (let i = 0; i < LEN; i++) arr.push(i === WIN ? { name: r.prize.name, value: r.prize.value, image: r.prize.image } : (items[Math.floor(Math.random() * items.length)] || { name: '' }))
    setStrip(arr)

    const PITCH = 118 // ячейка 106 + gap 12
    const SPIN = 6.2 // одна плавная фаза с затянутым замедлением в конце (интрига)
    // ждём, пока React отрендерит новую ленту (двойной rAF), затем стартуем прокрутку
    requestAnimationFrame(() => requestAnimationFrame(() => {
      const track = trackRef.current
      if (!track) return
      Array.from(track.children).forEach((c) => c.classList.remove('landed')) // сброс подсветки прошлого приза
      const vp = track.parentElement
      const center = vp.clientWidth / 2
      const jitter = (Math.random() * 2 - 1) * 24
      const target = WIN * PITCH + PITCH / 2 - center + jitter
      track.style.transition = 'none'
      track.style.transform = 'translateX(0)'
      void track.offsetWidth // форс-рефлоу
      requestAnimationFrame(() => {
        // хвост безье очень пологий (0.06) → в конце еле-еле доползает до приза
        track.style.transition = `transform ${SPIN}s cubic-bezier(.14,.66,.06,1)`
        track.style.transform = `translateX(${-target}px)`
      })
      setTimeout(() => { const c = track.children[WIN]; if (c) c.classList.add('landed') }, SPIN * 1000 + 60)
    }))
    setTimeout(async () => {
      setResult({ ...r.prize, caption: prizeCaption(r.prize.name, r.prize.value) }); setSpinning(false)
      const rr = rarityOf(r.prize.value, r.prize.name)
      if ((r.prize.value || 0) >= 25000) setTimeout(() => burst(rr.c), 80) // конфетти на дорогих дропах
      await load()
    }, SPIN * 1000 + 380)
  }

  const drops = (st.recentDrops && st.recentDrops.length) ? st.recentDrops : (st.case.items || []).map((it) => ({ name: it.name, value: it.value, image: it.image }))
  // повторяем до заполнения ширины, чтобы прокрутка была бесшовной и без пустот
  const dropsBase = []
  if (drops.length) { while (dropsBase.length < 16) dropsBase.push(...drops) }
  const tickerDur = Math.max(18, dropsBase.length * 2.6) // сек — скорость от числа плиток

  return (
    <div className="gami-wrap">
      {/* ── ЖИВАЯ ЛЕНТА ДРОПОВ ── */}
      {view === 'cases' && drops.length > 0 && (
        <div className="gami-ticker">
          <div className="gami-ticker-lbl"><span className="gami-live-dot" />{mt('gLiveDrops')}</div>
          <div className="gami-ticker-vp"><div className="gami-ticker-track" style={{ animationDuration: tickerDur + 's' }}>
            {[...dropsBase, ...dropsBase].map((d, i) => {
              const r = rarityOf(d.value, d.name)
              return (
                <div className="gami-ticker-item" style={{ '--rc': r.c }} key={i} title={d.who ? `${d.name} — ${d.who}` : d.name}>
                  <div className="gami-ti-vis"><PrizeVisual item={d} size={38} /></div>
                  <div className="gami-ti-meta">
                    <div className="gami-ti-name">{d.name}</div>
                    {d.who ? <div className="gami-ti-who">{d.who}</div> : null}
                  </div>
                </div>
              )
            })}
          </div></div>
        </div>
      )}
      {/* ── ШАПКА: уровень (только на «Уровнях») + баллы ── */}
      <div className={'mop-card gami-hero' + (view === 'cases' ? ' pts-only' : '')}>
        {view !== 'cases' && (
          <div className="gami-rank">
            <div className="gami-rank-badge"><Ic n="rank" size={26} color="var(--gold)" /><b>{st.level || '—'}</b></div>
            <div>
              <div className="gami-rank-name">{st.level > 0 ? st.levelName : mt('gNewbie')}</div>
              <div className="gami-rank-sub">{mt('gLevel')} {st.level || 0} / 12</div>
            </div>
          </div>
        )}
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
            const pr = rarityOf(l.prizeValue, l.prizeName)
            const milestone = l.n % 3 === 0
            return (
              <div key={l.n} className={'gami-node' + (l.done ? ' done' : '') + (l.current ? ' current' : '') + (milestone ? ' milestone' : '')} style={{ '--rc': pr.c }}>
                <div className="gami-node-top">
                  <div className="gami-node-badge">{l.done ? <Ic n="check" size={16} /> : (l.current ? l.n : <Ic n="lock" size={14} />)}</div>
                  <div className="gami-node-thumb"><PrizeVisual item={{ name: l.prizeName, value: l.prizeValue, image: l.prizeImage }} size={l.prizeImage ? 40 : 26} /></div>
                </div>
                <div className="gami-node-lv">{mt('gLevel')} {l.n}</div>
                <div className="gami-node-name">{l.name}</div>
                <div className="gami-node-prize">{l.prizeName}</div>
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
            {st.case.image
              ? <img className="gami-case-photo" src={st.case.image} alt="" />
              : (
                <svg className="gami-chest-svg" viewBox="0 0 120 100" fill="none" xmlns="http://www.w3.org/2000/svg">
                  <ellipse cx="60" cy="93" rx="42" ry="5" fill="#000" opacity=".25" />
                  <rect x="20" y="42" width="80" height="46" rx="9" fill="#26304d" />
                  <rect x="24" y="46" width="12" height="38" rx="3" fill="#31456e" />
                  <rect x="84" y="46" width="12" height="38" rx="3" fill="#31456e" />
                  <rect x="20" y="58" width="80" height="9" fill="#f2b134" />
                  <rect x="20" y="58" width="80" height="3" fill="#ffd772" />
                  <rect x="15" y="32" width="90" height="15" rx="6" fill="#33406a" />
                  <rect x="15" y="32" width="90" height="4" rx="2" fill="#4a5f92" />
                  <rect x="22" y="45" width="76" height="3" rx="1.5" fill="#8fd0ff" opacity=".9" />
                  <rect x="20" y="42" width="80" height="46" rx="9" fill="none" stroke="#3b9eff" strokeWidth="1.4" opacity=".5" />
                  <circle cx="60" cy="63" r="10" fill="#1a2138" />
                  <circle cx="60" cy="63" r="10" fill="none" stroke="#f2b134" strokeWidth="2" />
                  <circle cx="60" cy="63" r="4.5" fill="none" stroke="#ffd772" strokeWidth="2" />
                  <circle cx="60" cy="63" r="1.6" fill="#ffd772" />
                </svg>
              )}
          </div>
          <div className="gami-arena-title">{mt('gCase')}</div>
          <div className="gami-arena-price"><Ic n="coin" size={16} color="var(--gold)" />{fmtN(st.case.price)} {mt('gPts')}</div>
          {st.case.perDay != null && (
            <div className="gami-arena-limit">{mt('gLimitToday')}: <b>{st.opensToday || 0}/{st.case.perDay}</b>{freeOpens > 0 ? <span className="gami-free-badge">{mt('gFreeOpens')}: {freeOpens}</span> : null}</div>
          )}
        </div>
        <div className="gami-reel-vp">
          <div className="gami-marker" />
          <div className="gami-track" ref={trackRef}>
            {(strip.length ? strip : (st.case.items || [])).map((it, i) => {
              const r = rarityOf(it.value, it.name)
              return (
                <div className="gami-cell" key={i} style={{ '--rc': r.c }}>
                  <div className="gami-cell-vis"><PrizeVisual item={it} size={it.image ? 56 : 34} /></div>
                  <span className="gami-cell-n">{it.name}</span>
                  {it.value ? <span className="gami-cell-v">{fmtVal(it.value)}</span> : null}
                </div>
              )
            })}
          </div>
        </div>
        <button className="gami-open-btn" disabled={!canOpen} onClick={openCase}>
          {spinning ? '…' : (freeOpens > 0 ? `${mt('gOpenFree')} (${freeOpens})` : mt('gOpen'))}
          {!spinning && freeOpens <= 0 && (noOpensLeft ? <small>{mt('gLimitReached')}</small> : st.balance < st.case.price ? <small>{mt('gNotEnough')}</small> : null)}
        </button>
        {msg && <div className="gami-msg">{msg}</div>}
        {/* как копятся баллы — чек-лист с прогрессом */}
        <div className="gami-rules">
          <div className="gami-rules-h">{mt('gHowEarn')}</div>
          {st.earn ? (() => {
            const e = st.earn
            const uz = getMopLang() === 'uz'
            const pctOf = (x, y) => y > 0 ? Math.min(100, Math.round(x / y * 100)) : 0
            const doneTxt = uz ? 'Bajarildi ✓' : 'Выполнено ✓'
            const coefPct = Math.round((st.dozvonCoef || 0.6) * 100)
            const rows = [
              {
                g: e.dozvon, label: (uz ? 'Aloqa (dozvon)' : 'Дозвон') + ` · ${uz ? 'kamida' : 'мин.'} ${coefPct}%`,
                idle: e.dozvon.y <= 0, counter: e.dozvon.y > 0 ? `${e.dozvon.x} / ${e.dozvon.y}` : `0 / ~${e.dozvon.est}`, pct: pctOf(e.dozvon.x, e.dozvon.y),
                action: e.dozvon.done ? doneTxt
                  : (e.dozvon.y > 0 ? (uz ? `Yana ${e.dozvon.remain} ta lidga aloqa qiling` : `Дозвонитесь ещё до ${e.dozvon.remain} лидов`)
                    : (uz ? `Odatda ~${e.dozvon.estLeads} lid → ${e.dozvon.est} ta aloqa kerak` : `Обычно ~${e.dozvon.estLeads} лидов → нужно ${e.dozvon.est} дозвонов`)),
              },
              {
                g: e.speed, label: uz ? '1-qoʻngʻiroq tezligi' : 'Скорость 1-го звонка',
                idle: e.speed.y <= 0, counter: e.speed.y > 0 ? `${e.speed.x} / ${e.speed.y}` : '—', pct: pctOf(e.speed.x, e.speed.y),
                action: e.speed.done ? doneTxt
                  : (e.speed.y > 0 ? (uz ? `Yana ${e.speed.remain} lidni ${e.speed.sla} daqiqada oling` : `Возьмите ещё ${e.speed.remain} лидов за ${e.speed.sla} мин`)
                    : (uz ? `Lid kelishi bilan ${e.speed.sla} daqiqada oling` : `Берите за ${e.speed.sla} мин по мере поступления`)),
              },
              {
                g: e.task, label: (uz ? 'Vazifalar' : 'Задачи') + ` · ${uz ? 'kamida' : 'мин.'} ${e.task.goalPct}%`,
                idle: (e.task.x || 0) <= 0, counter: e.task.y > 0 ? `${e.task.x} / ${e.task.y}` : '0 / —', pct: pctOf(e.task.x, e.task.y),
                action: e.task.done ? doneTxt
                  : ((e.task.x || 0) <= 0 ? (e.task.y > 0 ? (uz ? `${e.task.y} ta vazifa kutmoqda` : `${e.task.y} задач ждут`) : (uz ? 'Vazifa qoʻying va bajaring' : 'Ставьте и закрывайте задачи'))
                    : (uz ? `Yana ${e.task.remain} ta vazifa bajaring` : `Выполните ещё ${e.task.remain} задач`)),
              },
              {
                g: e.plan, label: uz ? 'Reja' : 'План',
                idle: (e.plan.cur || 0) <= 0, counter: `${fmtVal(e.plan.cur) || '0'} / ${fmtVal(e.plan.target)}`, pct: pctOf(e.plan.cur, e.plan.target),
                action: e.plan.done ? doneTxt
                  : (uz ? `Yana ${fmtVal(e.plan.remain)} ga soting` : `Продайте ещё на ${fmtVal(e.plan.remain)}`),
              },
            ]
            return (
              <div className="gami-checklist">
                <div className="gami-maxrow">{uz ? 'Bugun maksimal' : 'Сегодня максимум'}: <b>{fmtN(st.maxPoints || 0)} {uz ? 'ball' : 'баллов'}</b></div>
                <div className="gami-creditnote">{uz ? 'Bugun yigʻildi' : 'Сегодня набрано'}: <b>{fmtN(st.earnedTodayLive || 0)}</b> · {st.todayCredited ? (uz ? 'hisobga oʻtdi ✓' : 'зачислено ✓') : (uz ? `${st.calcTime || '18:00'} da hisobga oʻtadi` : `зачислим в ${st.calcTime || '18:00'}`)}</div>
                {rows.map((row, i) => (
                  <div key={i} className={'gami-goal daily ' + (row.g.done ? 'done' : row.idle ? 'idle' : 'fail')}>
                    <span className="gami-goal-ic">{row.g.done ? <Ic n="check" size={13} /> : row.idle ? <Ic n="dot" size={13} /> : <Ic n="cross" size={13} />}</span>
                    <div className="gami-goal-body">
                      <div className="gami-goal-lbl"><span className="gami-goal-name">{row.label}</span>{row.counter ? <span className="gami-goal-sub">{row.counter}</span> : null}</div>
                      <div className="gami-goal-bar"><i style={{ width: (row.idle ? 0 : row.pct) + '%' }} /></div>
                      <div className="gami-goal-action">{row.action}</div>
                    </div>
                    <span className="gami-goal-pts">+{row.g.pts}</span>
                  </div>
                ))}
              </div>
            )
          })() : (
            <div className="gami-rules-grid">
              <span><b>+{st.points.reach}</b> {mt('gRuleReach')}</span>
              <span><b>+{st.points.fastCall}</b> {mt('gRuleFast')}</span>
              <span><b>+{st.points.taskDone}</b> {mt('gRuleTask')}</span>
              <span><b>+{st.points.dailyPlan}</b> {mt('gRulePlan')}</span>
            </div>
          )}
        </div>
      </div>
      )}

      {/* ── ИНВЕНТАРЬ ── */}
      {view === 'cases' && (
      <div className="mop-card">
        <div className="mop-ct">{mt('gInv')}</div>
        {(!st.inventory || !st.inventory.length)
          ? <div style={{ color: 'var(--txt3)', fontSize: 13, padding: '4px 0' }}>{mt('gEmptyInv')}</div>
          : <>
            <div className="gami-inv">
              {st.inventory.slice(0, invShown).map((it) => (
                <div key={it.id} className="gami-inv-item" style={{ '--rc': rarityOf(it.value, it.name).c }}>
                  <div className="gami-inv-vis"><PrizeVisual item={it} size={it.image ? 42 : 26} /></div>
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div className="gami-inv-name">{it.name}{it.type === 'level' ? ` · ${mt('gLevel')} ${it.level}` : ''}</div>
                    {it.cashback ? <div className="gami-inv-val" style={{ color: 'var(--gold)' }}>+{it.cashback} {mt('gPts')} {mt('gToAccount')}</div> : it.value ? <div className="gami-inv-val">{fmtVal(it.value)}</div> : null}
                  </div>
                  {it.status === 'cashback'
                    ? <span className="gami-status done">+{it.cashback}</span>
                    : <span className={'gami-status ' + (it.status === 'delivered' ? 'done' : 'pend')}>{it.status === 'delivered' ? mt('gDelivered') : mt('gPending')}</span>}
                </div>
              ))}
            </div>
            {st.inventory.length > invShown && (
              <button className="gami-more-btn" onClick={() => setInvShown(invShown + 10)}>{mt('gMore')} ({st.inventory.length - invShown})</button>
            )}
          </>}
      </div>
      )}

      {/* ── РЕЗУЛЬТАТ ОТКРЫТИЯ ── */}
      {result && (
        <div className="gami-modal-ov" onClick={() => setResult(null)}>
          <div className="gami-modal" style={{ '--rc': rarityOf(result.value, result.name).c }} onClick={(e) => e.stopPropagation()}>
            <canvas ref={confRef} className="gami-conf" />
            <div className="gami-modal-glow" />
            <div className="gami-modal-lbl">{mt('gWon')}</div>
            <div className="gami-modal-ic"><PrizeVisual item={result} size={result.image ? 130 : 62} className="gami-photo-lg" /></div>
            <h3 className="gami-modal-name">{result.name}</h3>
            {result.caption ? <div className="gami-modal-cap">{result.caption}</div> : null}
            {result.value ? <div className="gami-modal-val">{fmtVal(result.value)}</div> : null}
            {result.cashback > 0 ? <div className="gami-modal-cashback"><Ic n="coin" size={16} color="var(--gold)" /> +{result.cashback} {getMopLang() === 'uz' ? 'ball keshbek' : 'баллов кэшбек'}</div> : null}
            <button className="gami-open-btn gami-open-btn--lg" style={{ marginTop: 20 }} onClick={() => setResult(null)}>{mt('gTake')}</button>
          </div>
        </div>
      )}
    </div>
  )
}
