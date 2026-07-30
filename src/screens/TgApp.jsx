// Telegram Mini App — УРЕЗАННЫЙ интерфейс владельца: чат советника + очередь решений.
// Тяжёлая аналитика остаётся в вебе на десктопе. Вход — по Telegram initData (сервер валидирует подпись
// и allow-list по owner chatId; см. api/auth.js action:"tg"). Чат переиспользуем целиком (chat.js), так что
// стриминг, кнопки [[ACT]] и межканальная идемпотентность (pt2) работают без дублирования логики.
import React, { useEffect, useRef, useState } from 'react'
import { setSession, setRoleOrg, getSession } from '../lib/session.js'
import { auth } from '../lib/api.js'
import { applyTheme } from '../lib/theme.js'
import { loadCloud, ensureChats } from '../lib/appState.js'
import { initChat, renderChat, scrollChatBottom } from '../lib/chat.js'
import { loadTgSdk, initTgChrome, tgBackButton } from '../lib/tgwebapp.js'
import chatMainInnerHtml from './viewsHtml/chatMainInner.html?raw'

const num = (n) => (n == null ? '—' : Number(Math.round(n)).toLocaleString('ru-RU'))

const CSS = `
.tgroot{position:fixed;inset:0;height:var(--tg-vh,100vh);display:flex;flex-direction:column;background:var(--bg,#fff);overflow:hidden}
.tgbar{display:flex;gap:6px;padding:calc(var(--tg-safe-top,0px) + 8px) 10px 8px;border-bottom:1px solid var(--line,#eee);flex:0 0 auto;background:var(--bg,#fff)}
.tgtab{flex:1;padding:9px 8px;border-radius:10px;border:1px solid var(--line2,#ddd);background:var(--card,#fafafa);font-weight:600;font-size:14px;color:var(--txt2,#555);cursor:pointer}
.tgtab.on{background:var(--accent,#17694e);color:#fff;border-color:var(--accent,#17694e)}
.tgtab .b{display:inline-block;min-width:18px;padding:0 5px;margin-left:6px;border-radius:9px;background:#d9463b;color:#fff;font-size:11px;line-height:18px}
.tgcontent{flex:1;min-height:0;position:relative}
.tgcontent > .pane{position:absolute;inset:0;display:none}
.tgcontent > .pane.on{display:block}
.tgroot .chat-topbar{display:none}
.tgroot .chat-layout{height:100%}
.tgroot .chat-main{width:100%;height:100%;padding-bottom:var(--tg-safe-bottom,0px)}
.tgdec{height:100%;overflow:auto;padding:14px;padding-bottom:calc(var(--tg-safe-bottom,0px) + 24px);box-sizing:border-box}
.tgcard{border:1px solid var(--line2,#e3e3e3);border-radius:14px;padding:14px;margin-bottom:12px;background:var(--card,#fff)}
.tgcard h4{margin:0 0 6px;font-size:15px}
.tgcard .muted{color:var(--txt3,#888);font-size:12.5px;line-height:1.5}
.tgacts{display:flex;flex-wrap:wrap;gap:8px;margin-top:12px}
.tgbtn{flex:1;min-width:120px;padding:10px;border-radius:10px;border:1px solid var(--accent,#17694e);background:transparent;color:var(--accent,#17694e);font-weight:600;font-size:13.5px;cursor:pointer}
.tgbtn.warn{border-color:#d9463b;color:#d9463b}
.tgbtn.busy{opacity:.6}
.tgstate{padding:34px 18px;text-align:center;color:var(--txt2,#555)}
.tgstate .big{font-size:16px;font-weight:700;margin-bottom:8px;color:var(--txt,#222)}
`

// Кнопка действия с подтверждением в два тапа (защита от случайного «раздать задачи»).
function ActBtn({ label, warn, onRun }) {
  const [st, setSt] = useState('') // '' | 'confirm' | 'busy' | 'done' | 'err'
  const tRef = useRef(null)
  async function click() {
    if (st === 'busy' || st === 'done') return
    if (st !== 'confirm') { setSt('confirm'); clearTimeout(tRef.current); tRef.current = setTimeout(() => setSt(''), 3500); return }
    clearTimeout(tRef.current); setSt('busy')
    try { const ok = await onRun(); setSt(ok ? 'done' : 'err') } catch (e) { setSt('err') }
  }
  const txt = st === 'confirm' ? 'Точно? Нажмите ещё' : st === 'busy' ? '…' : st === 'done' ? '✓ Готово' : st === 'err' ? 'Ошибка — ещё раз' : label
  return <button className={'tgbtn' + (warn ? ' warn' : '') + (st === 'busy' ? ' busy' : '')} onClick={click}>{txt}</button>
}

function DecisionQueue({ onCount }) {
  const [data, setData] = useState(null)
  const [loading, setLoading] = useState(true)

  async function load() {
    const s = getSession()
    const [pl, mb] = await Promise.all([
      fetch('/api/planner?action=state&session=' + encodeURIComponent(s)).then((r) => r.json()).catch(() => null),
      fetch('/api/meta-brain?action=state&session=' + encodeURIComponent(s)).then((r) => r.json()).catch(() => null),
    ])
    const pending = pl && pl.pending ? pl.pending : null
    const goal = pl && pl.goal ? pl.goal : null
    // предложения мозга: форма ответа может отличаться — берём массив защитно, показываем только ожидающие
    const rawP = mb && (mb.proposals || (mb.state && mb.state.proposals) || mb.pending)
    const proposals = Array.isArray(rawP) ? rawP.filter((p) => !p.status || p.status === 'pending') : []
    const d = { pending, goal, proposals }
    setData(d); setLoading(false)
    if (onCount) onCount((pending ? 1 : 0) + proposals.length)
  }
  useEffect(() => { load(); const iv = setInterval(load, 45000); return () => clearInterval(iv) }, []) // eslint-disable-line

  async function act(payload) {
    const r = await fetch('/api/advisor-act', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ action: 'act', session: getSession(), ...payload }) })
    const d = await r.json().catch(() => null)
    setTimeout(load, 400)
    return !!(d && d.ok)
  }

  if (loading) return <div className="tgstate">Загрузка…</div>
  const { pending, proposals } = data
  const empty = !pending && (!proposals || proposals.length === 0)
  if (empty) return <div className="tgstate"><div className="big">Всё под контролем</div>Сейчас ничего не ждёт решения. Свободные вопросы — в чате советника.</div>

  const f = pending && pending.plan && pending.plan.facts
  const od = f && f.ownerDecision
  return (
    <div className="tgdec">
      {pending && (
        <div className="tgcard">
          <h4>🎯 План под цель «{pending.periodKey || ''}»</h4>
          {f && <div className="muted">Разрыв до цели: <b>{num(f.gap)} сум</b>{f.gapPct != null ? ` (${f.gapPct}%)` : ''}. Осталось раб. дней: {f.workdays ? f.workdays.left : '—'}.</div>}
          {od && <div className="muted" style={{ marginTop: 6, color: '#b45309' }}>Задачи — под достижимую часть (~{num(od.feasibleGoalUZS)} сум). Разрыв сверх (<b>{num(od.unreachableUZS)} сум</b>) — ваше решение{od.addManagers ? `: +${od.addManagers} менеджер(ов)` : ''}, не задача людям.</div>}
          <div className="tgacts">
            <ActBtn label="✅ Подтвердить и раздать" onRun={() => act({ type: 'plan_confirm' })} />
            <ActBtn label="🔄 Пересчитать" onRun={() => act({ type: 'plan_recalc' })} />
            <ActBtn label="❌ Отклонить" warn onRun={() => act({ type: 'plan_reject' })} />
          </div>
        </div>
      )}
      {(proposals || []).map((p) => (
        <div className="tgcard" key={p.id}>
          <h4>🧠 {p.title || 'Предложение'}</h4>
          {(p.why || p.summary || (p.proposedTask && p.proposedTask.title)) && <div className="muted">{p.why || p.summary || p.proposedTask.title}</div>}
          <div className="tgacts">
            <ActBtn label="✅ Принять" onRun={() => act({ type: 'mb_confirm', id: p.id })} />
            <ActBtn label="❌ Отклонить" warn onRun={() => act({ type: 'mb_reject', id: p.id })} />
          </div>
        </div>
      ))}
    </div>
  )
}

export default function TgApp() {
  const [phase, setPhase] = useState('loading') // 'loading' | 'denied' | 'ready'
  const [err, setErr] = useState('')
  const [tab, setTab] = useState('chat')
  const [decCount, setDecCount] = useState(0)
  const waRef = useRef(null)
  const bootedRef = useRef(false)

  useEffect(() => {
    let cancelled = false
    ;(async () => {
      applyTheme()
      const wa = await loadTgSdk()
      waRef.current = wa
      initTgChrome(wa)
      const initData = (wa && wa.initData) || ''
      let d = null
      try { d = await auth.tg(initData) } catch (e) { /* сеть */ }
      if (cancelled) return
      if (!d || !d.ok) { setErr(d && d.error ? d.error : 'Не удалось войти'); setPhase('denied'); return }
      setSession(d.session, d)
      setRoleOrg(d.role || 'admin', d.org || 'hunter')
      // старт чата (тот же путь, что в вебе): облако настроек → чаты → инициализация модуля чата
      window.toggleSidebar = () => {}      // в Mini App сайдбара нет — заглушки, чтобы inline-onclick не падали
      window.openWizard = () => {}
      window.newChat = () => {}
      try { await loadCloud() } catch (e) { /* настройки не критичны для чата */ }
      if (cancelled) return
      ensureChats()
      initChat()
      bootedRef.current = true
      setPhase('ready')
      setTimeout(() => { renderChat(); scrollChatBottom() }, 60)
    })()
    return () => { cancelled = true }
  }, [])

  // Кнопка «Назад» в шапке Telegram: на «Решениях» → вернуться в чат.
  useEffect(() => {
    const wa = waRef.current
    if (phase !== 'ready') return
    const back = () => setTab('chat')
    tgBackButton(wa, tab === 'decisions', back)
    return () => tgBackButton(wa, false, back)
  }, [tab, phase])

  function go(t) {
    setTab(t)
    if (t === 'chat') setTimeout(() => { renderChat(); scrollChatBottom() }, 30)
  }

  if (phase === 'loading') return <div className="tgroot"><div className="tgstate">Загрузка…</div></div>
  if (phase === 'denied') {
    return (
      <div className="tgroot">
        <style>{CSS}</style>
        <div className="tgstate">
          <div className="big">Вход недоступен</div>
          {/no_initdata|авторизаци/i.test(err)
            ? 'Откройте это приложение через кнопку в вашем Telegram-боте владельца.'
            : err}
        </div>
      </div>
    )
  }
  return (
    <div className="tgroot">
      <style>{CSS}</style>
      <div className="tgbar">
        <button className={'tgtab' + (tab === 'chat' ? ' on' : '')} onClick={() => go('chat')}>Советник</button>
        <button className={'tgtab' + (tab === 'decisions' ? ' on' : '')} onClick={() => go('decisions')}>
          Решения{decCount > 0 && <span className="b">{decCount}</span>}
        </button>
      </div>
      <div className="tgcontent">
        {/* ЧАТ — переиспользуем скелет и chat.js целиком (тот же поток, что в вебе) */}
        <div className={'pane' + (tab === 'chat' ? ' on' : '')}>
          <div className="view active" id="chatView">
            <div className="chat-layout">
              <div className="chat-main" dangerouslySetInnerHTML={{ __html: chatMainInnerHtml }} />
            </div>
          </div>
        </div>
        {/* ОЧЕРЕДЬ РЕШЕНИЙ — смонтирована всегда (опрос + бейдж на вкладке), показывается когда активна */}
        <div className={'pane' + (tab === 'decisions' ? ' on' : '')}>
          {phase === 'ready' && <DecisionQueue onCount={setDecCount} />}
        </div>
      </div>
    </div>
  )
}
