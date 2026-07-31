// Telegram Mini App — УРЕЗАННЫЙ интерфейс владельца: чат советника + очередь решений.
// Тяжёлая аналитика остаётся в вебе на десктопе. Вход — по Telegram initData (сервер валидирует подпись
// и allow-list по owner chatId; см. api/auth.js action:"tg"). Чат переиспользуем целиком (chat.js), так что
// стриминг, кнопки [[ACT]] и межканальная идемпотентность (pt2) работают без дублирования логики.
import React, { useEffect, useRef, useState } from 'react'
import { setSession, setRoleOrg, getSession } from '../lib/session.js'
import { auth } from '../lib/api.js'
import { applyTheme } from '../lib/theme.js'
import { loadCloud, ensureChats, state, save, setLang } from '../lib/appState.js'
import { initChat, renderChat, scrollChatBottom, sendMsg } from '../lib/chat.js'
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
/* Гасим десктоп-shell раскладку чата (body.shell #chatView position:fixed left:256px top:0), которая иначе
   накрывает вкладки и сдвигает чат. В Mini App своя flex-раскладка. */
.tgroot #chatView{position:static!important;left:auto!important;right:auto!important;top:auto!important;bottom:auto!important;height:100%!important;display:flex;flex-direction:column;flex:1;min-height:0}
.tgroot .chat-layout{height:100%}
.tgroot .chat-main{width:100%;height:100%;padding-bottom:var(--tg-safe-bottom,0px)}
.tgburger{flex:0 0 auto;width:40px;border-radius:10px;border:1px solid var(--line2,#ddd);background:var(--card,#fafafa);color:var(--txt2,#555);cursor:pointer;font-size:17px;line-height:1}
.tgdrawer-ov{position:fixed;inset:0;z-index:60;background:rgba(0,0,0,.4);display:flex}
.tgdrawer{width:84%;max-width:320px;height:100%;background:var(--bg,#fff);display:flex;flex-direction:column;padding:calc(var(--tg-safe-top,0px) + 10px) 0 calc(var(--tg-safe-bottom,0px) + 10px);box-shadow:2px 0 18px rgba(0,0,0,.25)}
.tgdrawer h5{margin:0;padding:10px 16px 4px;font-size:12px;color:var(--txt3,#888);text-transform:uppercase;letter-spacing:.04em}
.tgdrawer-new{margin:6px 14px 8px;padding:11px;border-radius:10px;border:1px solid var(--accent,#17694e);background:transparent;color:var(--accent,#17694e);font-weight:600;font-size:14px;cursor:pointer}
.tgdrawer-list{flex:1;overflow:auto}
.tgchat-item{display:block;width:100%;text-align:left;padding:12px 16px;border:0;border-bottom:1px solid var(--line,#f1f1f1);background:transparent;font:inherit;font-size:14px;color:var(--txt,#222);cursor:pointer;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.tgchat-item.on{background:var(--accent-bg,#eaf5ef);font-weight:600}
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

const KIND_ICON = { plan: '🎯', meta: '🧠', meta_more: '🧠', deepsales: '🎧', ownerdecision: '⚠️', goal: '📝' }

function DecisionQueue({ onCount, onGoChat }) {
  const [items, setItems] = useState(null)

  async function load() {
    // ЕДИНЫЙ источник — тот же, что кормит отчёт по команде. Все типы: план, meta-brain, DeepSales, ownerDecision, цель.
    const r = await fetch('/api/reports?action=decisions&session=' + encodeURIComponent(getSession())).then((x) => x.json()).catch(() => null)
    const list = (r && r.ok && Array.isArray(r.items)) ? r.items : []
    setItems(list)
    if (onCount) onCount(list.filter((it) => it.kind !== 'meta_more').length)
  }
  useEffect(() => { load(); const iv = setInterval(load, 45000); return () => clearInterval(iv) }, []) // eslint-disable-line

  async function act(payload) {
    const r = await fetch('/api/advisor-act', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ action: 'act', session: getSession(), ...payload }) })
    const d = await r.json().catch(() => null)
    setTimeout(load, 400)
    return !!(d && d.ok)
  }

  if (items == null) return <div className="tgstate">Загрузка…</div>
  if (!items.length) return <div className="tgstate"><div className="big">Всё под контролем</div>Сейчас ничего не ждёт решения. Свободные вопросы — в чате советника.</div>

  return (
    <div className="tgdec">
      {items.map((it, i) => (
        <div className="tgcard" key={it.kind + (it.id || i)}>
          <h4>{KIND_ICON[it.kind] || '•'} {it.title}</h4>
          {it.detail && <div className="muted" style={it.kind === 'ownerdecision' ? { color: '#b45309' } : null}>{it.detail}</div>}
          {it.actions && it.actions.length > 0 && (
            <div className="tgacts">
              {it.actions.map((a, j) => a.type === '__goto_chat'
                ? <button key={j} className="tgbtn" onClick={() => onGoChat && onGoChat()}>{a.label}</button>
                : <ActBtn key={j} label={a.label} warn={a.warn} onRun={() => act(a.id ? { type: a.type, id: a.id } : { type: a.type })} />)}
            </div>
          )}
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
  const [menuOpen, setMenuOpen] = useState(false)
  const [, force] = useState(0)
  const waRef = useRef(null)
  const bootedRef = useRef(false)

  useEffect(() => {
    let cancelled = false
    ;(async () => {
      applyTheme()
      // index.html держит <body class="shell"> для десктоп-веба; в Mini App эта раскладка (position:fixed
      // #chatView, сайдбар 256px) ломает вёрстку — снимаем, у нас своя flex-раскладка.
      document.body.classList.remove('shell', 'sec-open', 'chat-open')
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
      // ЯЗЫК СОВЕТНИКА = язык ВЛАДЕЛЬЦА (из taskagent:people.owner.lang, пришёл в d.lang), а НЕ язык клиента
      // Telegram и не то, что подтянулось из облака. Ставим ПОСЛЕ loadCloud (он переустанавливает state).
      if (d.lang === 'uz' || d.lang === 'ru') setLang(d.lang)
      initChat()
      bootedRef.current = true
      setPhase('ready')
      setTimeout(() => { renderChat(); scrollChatBottom() }, 60)
      // HANDOFF из отчёта: ?advisor=token (web_app URL) ИЛИ start_param (прямая ссылка Mini App) → засеять
      // НОВЫЙ чат контекстом находки/отчёта (тот же механизм, что в вебе через /api/digest?action=handoff).
      try {
        const q = new URLSearchParams(location.search)
        const token = q.get('advisor') || q.get('hf') || (wa && wa.initDataUnsafe && wa.initDataUnsafe.start_param) || ''
        if (token) {
          const dd = await fetch('/api/digest?action=handoff&token=' + encodeURIComponent(token) + '&session=' + encodeURIComponent(getSession())).then((r) => r.json()).catch(() => null)
          if (!cancelled && dd && dd.ok && dd.seed) {
            const c = { id: 'c' + Date.now(), title: dd.title || 'Разбор', messages: [], pinned: false, projectId: '' }
            state.chats.unshift(c); state.activeChatId = c.id; save()
            setTimeout(() => { renderChat(); sendMsg(dd.seed) }, 160)
          }
        }
      } catch (e) { /* handoff не критичен — просто откроется чистый чат */ }
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
  // ИСТОРИЯ ЧАТОВ — та же, что в вебе (state.chats, грузится loadCloud'ом). Не второй механизм — тот же.
  function openChat(id) {
    ensureChats(); state.activeChatId = id; save(); force((n) => n + 1)
    setMenuOpen(false); setTab('chat'); setTimeout(() => { renderChat(); scrollChatBottom() }, 30)
  }
  function newChat() {
    ensureChats()
    const c = { id: 'c' + Date.now(), title: 'Новый чат', messages: [], pinned: false, projectId: '' }
    state.chats.unshift(c); state.activeChatId = c.id; save(); force((n) => n + 1)
    setMenuOpen(false); setTab('chat'); setTimeout(() => { renderChat(); scrollChatBottom() }, 30)
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
        <button className="tgburger" onClick={() => setMenuOpen(true)} aria-label="Чаты" title="Чаты">☰</button>
        <button className={'tgtab' + (tab === 'chat' ? ' on' : '')} onClick={() => go('chat')}>Советник</button>
        <button className={'tgtab' + (tab === 'decisions' ? ' on' : '')} onClick={() => go('decisions')}>
          Решения{decCount > 0 && <span className="b">{decCount}</span>}
        </button>
      </div>
      {menuOpen && (
        <div className="tgdrawer-ov" onClick={() => setMenuOpen(false)}>
          <div className="tgdrawer" onClick={(e) => e.stopPropagation()}>
            <button className="tgdrawer-new" onClick={newChat}>+ Новый чат</button>
            <h5>Недавние чаты</h5>
            <div className="tgdrawer-list">
              {(Array.isArray(state.chats) ? state.chats : []).map((c) => (
                <button key={c.id} className={'tgchat-item' + (c.id === state.activeChatId ? ' on' : '')} onClick={() => openChat(c.id)}>{c.title || 'Чат'}</button>
              ))}
            </div>
          </div>
        </div>
      )}
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
          {phase === 'ready' && <DecisionQueue onCount={setDecCount} onGoChat={() => go('chat')} />}
        </div>
      </div>
    </div>
  )
}
