// src/components/ScenePanel.jsx — «живой офис» на спрайтах LimeZu, вкладка «Сцена» в /dev-agent.
// Порт накопленного превью в React: 3 комнаты (room.png), 4 агента + 5 МОПов + РОП, движение
// агентов + working/waiting, статичные МОПы у столов, пузыри из РЕАЛЬНЫХ данных, встречи у дверей
// по реальному logFlow. Движок построен императивно в useEffect (rAF + прямые мутации DOM) —
// как в ванильной версии, чтобы поведение не изменилось и React не перерисовывался на каждый кадр.
//
// ДАННЫЕ — ЖИВЫЕ, НЕ ВБИТЫЕ:
//   агенты (statusLine/находки)  → SCENE_AGENTS.load() (те же state()-эндпоинты)
//   пузыри МОПов                 → /api/scene-bubbles?action=state (факты, trust-гейт, кэш 5 мин)
//   встречи у дверей             → /api/task-agent state.flows (реальные события logFlow)
import React, { useEffect, useRef } from 'react'
import { getSession } from '../lib/session.js'
import { SCENE_AGENTS } from '../lib/sceneAdapters.js'

const RW = 352, RH = 224
const NAME = { dev: 'Менеджер по аналитике', growth: 'Агент по развитию', task: 'Тренер', mop: 'Супервайзер' }
const ACC = { dev: '#3b9eff', growth: '#27c08a', task: '#f2b134', mop: '#9b8cff' }
const ZONES = {
  dev: { pts: [[52, 95], [95, 90], [115, 100]], att: [128, 66] },
  growth: { pts: [[52, 190], [95, 185], [115, 195]], att: [128, 178] },
  task: { pts: [[186, 155], [178, 182], [200, 165]], att: [212, 180] },
  mop: { pts: [[288, 150], [278, 182], [298, 162]], att: [290, 178] },
}
// МОПы — статичны у столов вдоль стен; РОП — без метрик/пузыря
const DECOR = [
  { id: 'mop1', name: 'Komiljon', home: [196, 80], dir: 'up' },
  { id: 'mop2', name: 'Samandar', home: [244, 80], dir: 'up' },
  { id: 'mop3', name: 'Begoyim', home: [292, 80], dir: 'up' },
  { id: 'mop4', name: 'Abdulla-Legenda', home: [302, 110], dir: 'left' },
  { id: 'mop5', name: 'Abulbositxon', home: [302, 164], dir: 'left' },
  { id: 'rop', name: 'РОП', home: [214, 208], dir: 'up' },
]
const FLOWS = {
  d2g: { from: 'dev', to: 'growth', sHand: [128, 66], rHand: [128, 178], label: 'воронка' },
  m2t: { from: 'mop', to: 'task', sHand: [262, 180], rHand: [238, 180], label: 'находки' },
}
// точки «отлучки» для состояния away (кулер / принтер отдела продаж)
const AMENITY = [[176, 150], [316, 196]]
const ROOM_LABELS = [{ t: 'Техническая', x: 78, y: 42 }, { t: 'Аналитика', x: 78, y: 138 }, { t: 'Отдел продаж', x: 250, y: 42 }]
const DIRCOL = { left: 0, up: 6, right: 12, down: 18 }
// logFlow (from>to) → ключ FLOWS
const FLOW_KEY = { 'dev-agent>growth-agent': 'd2g', 'mop-agent>task-agent': 'm2t' }
// декоративные — mop1..5 и rop (в /decor/); агенты — dev/growth/task/mop (в /characters/).
// ВАЖНО: агент 'mop' (Супервайзер) НЕ decor — иначе тянулся бы несуществующий decor/mop.png и спрайт пропадал.
const imgFor = (id) => (/^mop[1-5]$/.test(id) || id === 'rop') ? `/assets/scene/characters/decor/${id}.png` : `/assets/scene/characters/${id}.png`

export default function ScenePanel({ active = true }) {
  const hostRef = useRef(null)
  useEffect(() => {
    const host = hostRef.current
    if (!host || !active) return
    let raf = 0; const timers = []
    // ── разметка ──
    host.innerHTML = '<div class="scn-scaler"><img class="scn-room" src="/assets/scene/room.png" width="352" height="224" alt="office"></div>'
    const scaler = host.querySelector('.scn-scaler')
    // на всю доступную область: масштаб по min(ширина, высота), центрирование даёт flex у .scn-host
    function fit() { const availW = (host.clientWidth || 640) - 16, availH = (host.clientHeight || 400) - 16; const s = Math.max(1, Math.min(availW / RW, availH / RH)); scaler.style.transform = 'scale(' + s + ')' }
    const onResize = () => fit(); window.addEventListener('resize', onResize)
    for (const L of ROOM_LABELS) { const d = document.createElement('div'); d.className = 'scn-rlabel'; d.textContent = L.t; d.style.left = L.x + 'px'; d.style.top = L.y + 'px'; scaler.appendChild(d) }

    const A = {}, agentIds = Object.keys(ZONES)
    function mk(id, x, y, decorative, disp, border) {
      const el = document.createElement('div'); el.className = 'scn-actor'
      el.innerHTML = '<div class="scn-bub"></div><div class="scn-zzz"></div><div class="scn-fsign"><span>✉</span><i></i></div><div class="scn-spr"></div><div class="scn-name" style="--nc:' + border + '">' + disp + '</div>'
      scaler.appendChild(el)
      const a = {
        id, el, spr: el.querySelector('.scn-spr'), bub: el.querySelector('.scn-bub'), zzz: el.querySelector('.scn-zzz'), fsign: el.querySelector('.scn-fsign'), flab: el.querySelector('.scn-fsign i'),
        decorative, x, y, tx: x, ty: y, dir: 'down', walking: false, frame: 0, ft: 0, waiting: false, queue: [], nextPause: 0, nextFlag: 0, curFlag: 0, arrived: false, pauseUntil: 0,
        bubOn: false, bubUntil: 0, bubHideUntil: 1500 + Math.random() * 3000, pts: null, home: null, homeDir: 'down',
        sayWork: '', sayWait: '', phrase: null, actState: 'loading', exitY: 240, hidden: false, // loading(нейтр. до 1-го ответа)|active|inactive|absent|unknown
      }
      a.spr.style.backgroundImage = 'url(' + imgFor(id) + ')'
      return a
    }
    for (const id of agentIds) { const z = ZONES[id]; A[id] = mk(id, z.pts[0][0], z.pts[0][1], false, NAME[id], ACC[id]); A[id].pts = z.pts; A[id].sayWork = NAME[id] }
    DECOR.forEach((d, i) => { const a = mk(d.id, d.home[0], d.home[1], true, d.name, '#b0aa9c'); a.home = d.home; a.homeDir = d.dir; a.dir = d.dir; a.bubHideUntil = 2500 + i * 2500; A[d.id] = a })
    const ALL = Object.values(A)

    function draw(a) {
      const blockY = a.walking ? 64 : 32 // ПОЛНЫЙ лист LimeZu: idle=y32, walk=y64
      const col = DIRCOL[a.dir] + (a.walking ? a.frame : 0)
      a.spr.style.backgroundPosition = (-(col * 16)) + 'px ' + (-blockY) + 'px'
      a.el.style.left = (a.x - 8) + 'px'; a.el.style.top = (a.y - 32) + 'px'; a.el.style.zIndex = Math.round(a.y)
      a.el.classList.toggle('idle', !a.walking)
      // покачивание ТОЛЬКО в active; inactive/unknown/idle — стоит спокойно
      a.el.classList.toggle('scn-still', a.decorative && a.actState !== 'active')
      if (a.zzz) { // значок над головой: НЕ АКТИВЕН → «zzz»; неизвестно → «?»; иначе скрыт
        const icon = a.decorative && !a.walking ? (a.actState === 'inactive' ? 'zzz' : a.actState === 'unknown' ? 'unknown' : '') : ''
        a.zzz.className = 'scn-zzz' + (icon ? ' on scn-zzz-' + icon : '')
        if (icon) a.zzz.textContent = icon === 'zzz' ? '💤' : '?'
      }
      a.fsign.classList.toggle('on', !a.walking && a.curFlag === 'flow' && performance.now() < a.pauseUntil)
    }
    for (const a of ALL) draw(a)

    const goPath = (a, steps) => { const f = steps[0]; a.tx = f[0]; a.ty = f[1]; a.nextPause = f[2] || 0; a.nextFlag = f[3] || 0; a.arrived = false; a.queue = steps.slice(1) }
    const randWP = (a) => { const p = a.pts; let w; do { w = p[(Math.random() * p.length) | 0] } while (w[0] === a.tx && w[1] === a.ty && p.length > 1); return w }
    function decide(a) { if (a.waiting) { goPath(a, [[...ZONES[a.id].att, 900]]); return } goPath(a, [[...randWP(a), 1400 + Math.random() * 2600]]) }
    // МОП: absent → уходит к выходу (вниз за пределы комнаты) и скрывается; остальные — стоит у стола
    function decideDecor(a) {
      if (a.actState === 'absent') goPath(a, [[a.home[0], a.exitY, 0]])
      else goPath(a, [[a.home[0], a.home[1], 4000 + Math.random() * 4000]])
    }
    function bubble(a, t) {
      if (a.decorative) { // ФАКТИЧЕСКИЙ пузырь МОПа (scene-bubbles) — независимо от позы
        if (!a.phrase) return
        if (a.bubOn) { if (t > a.bubUntil) { a.bubOn = false; a.bub.classList.remove('on'); a.bubHideUntil = t + 10000 + Math.random() * 8000 } }
        else if (t > a.bubHideUntil) { a.bubOn = true; a.bub.textContent = a.phrase; a.bub.classList.remove('wait'); a.bub.classList.add('on'); a.bubUntil = t + 4200 }
        return
      }
      if (a.bubOn) { if (t > a.bubUntil) { a.bubOn = false; a.bub.classList.remove('on'); a.bubHideUntil = t + 5000 + Math.random() * 5000 } }
      else if (t > a.bubHideUntil) {
        const txt = a.waiting ? (a.sayWait || a.sayWork) : a.sayWork
        if (!txt) { a.bubHideUntil = t + 3000; return }
        a.bubOn = true; a.bub.textContent = txt; a.bub.classList.toggle('wait', !!a.waiting); a.bub.classList.add('on'); a.bubUntil = t + 3800
      }
    }
    const SPEED = 40, FRAME_MS = 120, ARR = 1.2; let last = 0
    function tick(t) {
      if (!last) last = t; const dt = Math.min(50, t - last); last = t
      for (const a of ALL) {
        const dx = a.tx - a.x, dy = a.ty - a.y, d = Math.hypot(dx, dy)
        if (d > ARR) { const s = SPEED * dt / 1000, k = Math.min(1, s / d); a.x += dx * k; a.y += dy * k; a.walking = true; a.arrived = false; a.dir = Math.abs(dx) > Math.abs(dy) ? (dx < 0 ? 'left' : 'right') : (dy < 0 ? 'up' : 'down'); a.ft += dt; if (a.ft > FRAME_MS) { a.ft = 0; a.frame = (a.frame + 1) % 6 } }
        else {
          a.walking = false; a.frame = 0
          if (!a.arrived) { a.arrived = true; a.pauseUntil = t + (a.nextPause || 0); a.curFlag = a.nextFlag; a.nextFlag = 0; if (a.waiting && a.curFlag !== 'flow') a.dir = 'down' }
          // МОП у своего стола — лицом к монитору
          if (a.decorative && a.curFlag !== 'flow' && Math.abs(a.x - a.home[0]) < 2 && Math.abs(a.y - a.home[1]) < 2) a.dir = a.homeDir
          // absent дошёл до выхода → скрыть (за дверью, не отображается до след. действия в CRM)
          if (a.decorative && a.actState === 'absent' && a.y >= a.exitY - 2 && !a.hidden) { a.hidden = true; a.el.style.display = 'none' }
          if (t >= a.pauseUntil) { if (a.queue.length) { const n = a.queue.shift(); a.tx = n[0]; a.ty = n[1]; a.nextPause = n[2] || 0; a.nextFlag = n[3] || 0; a.arrived = false } else (a.decorative ? decideDecor(a) : decide(a)) }
        }
        bubble(a, t); draw(a)
      }
      raf = requestAnimationFrame(tick)
    }
    raf = requestAnimationFrame(tick)

    function setWait(a, v) { if (a.decorative || a.waiting === v) return; a.waiting = v; a.queue = []; a.bubHideUntil = 0; if (v) goPath(a, [[...ZONES[a.id].att, 900]]); else goPath(a, [[...a.pts[0], 1200]]) }
    function flowGo(a, hand, label) { a.flab.textContent = label; const back = a.waiting ? [...ZONES[a.id].att, 900] : [...a.pts[0], 1000]; a.queue = []; goPath(a, [[hand[0], hand[1], 2200, 'flow'], back]) }
    function triggerFlow(key) { const f = FLOWS[key]; if (f) { flowGo(A[f.from], f.sHand, f.label); flowGo(A[f.to], f.rHand, f.label) } }

    // ── ЖИВЫЕ ДАННЫЕ ──
    let stopped = false
    async function pollAgents() {
      try {
        const rs = await Promise.all(SCENE_AGENTS.map((ad) => ad.load().catch(() => null)))
        SCENE_AGENTS.forEach((ad, i) => { const r = rs[i], a = A[ad.id]; if (!r || !a) return; a.waiting = !!r.waiting; a.sayWork = r.statusLine || NAME[ad.id]; a.sayWait = (r.pending && r.pending[0] && (r.pending[0].title || r.pending[0].body)) || r.statusLine })
      } catch (e) { /* сеть — оставляем прошлое */ }
    }
    async function pollBubbles() {
      try {
        const r = await fetch('/api/scene-bubbles?action=state&session=' + encodeURIComponent(getSession()))
        const d = await r.json(); if (!d || !d.items) return
        for (const it of d.items) { const a = DECOR.find((x) => x.name === it.name); if (a && A[a.id]) A[a.id].phrase = it.phrase }
      } catch (e) { /* нет данных — пузыря просто нет */ }
    }
    let lastFlowAt = Date.now() // старые события до открытия сцены не проигрываем
    async function pollFlows() {
      try {
        const r = await fetch('/api/task-agent?action=state&session=' + encodeURIComponent(getSession()))
        const d = await r.json(); const flows = (d && d.flows) || []
        for (const f of flows) { if (f.at > lastFlowAt) { const key = FLOW_KEY[`${f.from}>${f.to}`]; if (key) triggerFlow(key); lastFlowAt = Math.max(lastFlowAt, f.at) } }
      } catch (e) { /* нет события — нет встречи */ }
    }
    // ПОЗА МОПов из активности в CRM (scene-activity) — читаем it.POSE (не state; state идёт в журнал).
    // pose: active(покачивание) / inactive(💤) / leave(выход за дверь) / unknown(«?» у стола).
    async function pollActivity() {
      try {
        const r = await fetch('/api/scene-activity?action=state&session=' + encodeURIComponent(getSession()))
        const d = await r.json(); if (!d || !d.items) return
        for (const it of d.items) {
          const dec = DECOR.find((x) => x.name === it.name); if (!dec || !A[dec.id]) continue
          const st = it.pose === 'leave' ? 'absent' : (it.pose || it.state) // leave → сценовый actState 'absent' (уход из комнаты)
          const a = A[dec.id], prev = a.actState; a.actState = st
          if (prev === 'absent' && it.state !== 'absent') { a.hidden = false; a.el.style.display = ''; a.x = a.home[0]; a.y = a.exitY; a.arrived = false; goPath(a, [[a.home[0], a.home[1], 4000]]) } // вернулся → входит и идёт к столу
          else if (it.state === 'absent' && prev !== 'absent') { a.arrived = false; goPath(a, [[a.home[0], a.exitY, 0]]) } // уходит к выходу немедленно
        }
      } catch (e) { /* нет данных — поза не меняется */ }
    }
    pollAgents(); pollBubbles(); pollFlows(); pollActivity()
    timers.push(setInterval(pollAgents, 15000))   // статус/находки агентов
    timers.push(setInterval(pollBubbles, 5 * 60000)) // пузыри МОПов (кэш 5 мин)
    timers.push(setInterval(pollFlows, 12000))     // события передачи данных
    timers.push(setInterval(pollActivity, 5 * 60000)) // активность → поза (кэш 5 мин)

    fit()
    return () => { stopped = true; cancelAnimationFrame(raf); timers.forEach(clearInterval); window.removeEventListener('resize', onResize); if (host) host.innerHTML = '' }
  }, [active])

  return <div className="scn-host" ref={hostRef} />
}
