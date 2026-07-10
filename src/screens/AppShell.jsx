import React, { useEffect, useRef, useState, useSyncExternalStore } from 'react'
import { getSnapshot, subscribe, orgQ } from '../lib/session.js'
import { state, save, loadCloud, ensureChats, setLang } from '../lib/appState.js'
import { applyTheme } from '../lib/theme.js'
import { installShellStubs } from '../lib/shellStubs.js'
import { applyLiveDash, applySuspicious } from '../lib/dashRender.js'
import { initChat, renderChat, scrollChatBottom } from '../lib/chat.js'
import { initAdminModals } from '../lib/adminModals.js'
import mapViewHtml from './viewsHtml/mapView.html?raw'
import dashViewHtml from './viewsHtml/dashView.html?raw'
import tgViewHtml from './viewsHtml/tgView.html?raw'
import chatMainInnerHtml from './viewsHtml/chatMainInner.html?raw'
import askModeHtml from './viewsHtml/askModeModal.html?raw'
import adminModalsHtml from './viewsHtml/adminModals.html?raw'

// Backbone основного приложения (админ/РОП/демо) — 1:1 shell-хром монолита.
// Тяжёлые вьюхи (дашборд/telegram/задачи) смонтированы дословными скелетами;
// загрузка данных для них — в следующих этапах (см. MIGRATION.md).
export default function AppShell({ onLogout }) {
  const sess = useSyncExternalStore(subscribe, getSnapshot, getSnapshot)
  const role = sess.role
  const org = sess.org
  const isRop = role === 'rop'
  const isAdmin = role === 'admin'

  const [tab, setTab] = useState('chat')
  const [secOpen, setSecOpen] = useState(false) // выпадашка «Меню»
  const [settingsOpen, setSettingsOpen] = useState(false)
  const [, force] = useState(0)
  const bootedRef = useRef(false)
  const dashLoadedRef = useRef(false)

  // renderDashboard — загрузка живых данных дашборда (1:1 по поведению монолита)
  async function loadDashboard() {
    if (dashLoadedRef.current) return
    const note = document.getElementById('dashNote')
    try {
      const r = await fetch('/api/dashboard' + orgQ())
      const d = await r.json()
      if (d && !d.empty && !d.error && d.totals) {
        window.__applyLiveDash = applyLiveDash
        applyLiveDash(d)
        applySuspicious(d)
        dashLoadedRef.current = true
      } else if (d && d.empty) {
        if (note) note.textContent = '⚪ Живые данные ещё не загружены. Нажми «Обновить из amoCRM» ниже.'
      } else if (d && d.error) {
        if (note) note.textContent = '⚠️ ' + d.error + ' ' + (d.detail || '')
      }
    } catch (e) {
      if (note) note.textContent = '⚠️ Нет связи с сервером.'
    }
  }

  // boot: подтянуть облако, восстановить вкладку, стартовая вкладка по роли
  useEffect(() => {
    let cancelled = false
    ;(async () => {
      applyTheme()
      installShellStubs()
      initChat()
      initAdminModals()
      // мосты для императивных модулей (чат/скелеты) → React
      window.__forceShellRender = () => force((n) => n + 1)
      window.__switchToChat = () => applyTab('chat')
      window.toggleSidebar = toggleSidebar
      window.newChat = newChat
      window.openSettings = () => setSettingsOpen(true)
      if (typeof window.openWizard !== 'function') window.openWizard = () => { /* мастер аудита — Этап 5 */ }
      document.body.classList.add('shell')
      await loadCloud()
      if (cancelled) return
      ensureChats()
      let start
      if (role === 'rop') start = 'dash'
      else if (state.tab && ['chat', 'dash', 'map', 'tg'].includes(state.tab)) start = state.tab
      else start = 'chat'
      bootedRef.current = true
      applyTab(start)
    })()
    return () => { cancelled = true; document.body.classList.remove('shell', 'sec-open', 'chat-open') }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // switchTab — 1:1: .active на вьюхах управляется React (className по `tab`),
  // здесь только классы body (sec-open/chat-open), как в оболочке монолита.
  function applyTab(t) {
    state.tab = t; save()
    setTab(t)
    document.body.classList.toggle('sec-open', t !== 'chat')
    document.body.classList.toggle('chat-open', t === 'chat')
    if (t === 'dash') { const dt = state.dashTab || 'overview'; window.dashTab && window.dashTab(dt); loadDashboard() }
    if (t === 'chat') { setTimeout(() => { renderChat(); scrollChatBottom() }, 0) }
  }

  // роль РОПа: скрыть чувствительные блоки внутри дашборда (applyRole, 1:1 по IDs)
  useEffect(() => {
    if (!bootedRef.current) return
    const finTab = document.getElementById('dtab-finance')
    if (finTab) finTab.style.display = isRop ? 'none' : ''
    const prof = document.getElementById('kpiProfit')
    if (prof && prof.closest('.dcard')) prof.closest('.dcard').style.display = isRop ? 'none' : ''
    const salesSum = document.getElementById('overviewSalesSum')
    if (salesSum && salesSum.closest('.block')) salesSum.closest('.block').style.display = isRop ? 'none' : ''
    const adsets = document.getElementById('adsetsBlock')
    if (adsets) adsets.style.display = isRop ? 'none' : ''
    ;['genBtn', 'nextBtn'].forEach((id) => { const el = document.getElementById(id); if (el) el.style.display = isRop ? 'none' : '' })
  }, [tab, isRop])

  function goSection(sec) {
    toggleSidebar(false)
    setSecOpen(false)
    if (sec === 'finance') { applyTab('dash'); window.dashTab && window.dashTab('finance') }
    else applyTab(sec)
  }

  function toggleSidebar(open) {
    document.getElementById('chatSidebar')?.classList.toggle('open', open)
    document.getElementById('sideBackdrop')?.classList.toggle('show', open)
  }
  function collapseSidebar() {
    if (window.matchMedia('(max-width:700px)').matches) { toggleSidebar(false); return }
    document.body.classList.toggle('sidebar-collapsed')
  }
  function openSidebar() {
    if (window.matchMedia('(max-width:700px)').matches) { toggleSidebar(true); return }
    document.body.classList.remove('sidebar-collapsed')
  }

  function newChat() {
    ensureChats()
    const c = { id: 'c' + Date.now(), title: 'Новый чат', messages: [], pinned: false, projectId: '' }
    state.chats.unshift(c); state.activeChatId = c.id; save()
    force((n) => n + 1)
    applyTab('chat')
  }

  const roleLabel = isRop ? 'РОП' : (role === 'demo' ? 'Демо' : 'Владелец')
  const chats = Array.isArray(state.chats) ? state.chats : []

  return (
    <>
      <header>
        <div className="h-top">
          <div className="h-logo" onClick={() => applyTab('map')} style={{ cursor: 'pointer' }}>
            <svg className="ic" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round"><path d="M4 20L20 4M7 4H4v3M17 20h3v-3M12 12l4-1-1 4z" /></svg>
          </div>
          <div className="h-title">Hunter AI</div>
          <div style={{ flex: 1 }} />
          <div className="lang">
            <button className={state.lang !== 'uz' ? 'on' : ''} onClick={() => { setLang('ru'); force((n) => n + 1) }}>РУ</button>
            <button className={state.lang === 'uz' ? 'on' : ''} onClick={() => { setLang('uz'); force((n) => n + 1) }}>UZ</button>
          </div>
          <button onClick={onLogout} title="Выйти" style={{ marginLeft: 8, background: 'var(--card)', border: '1px solid var(--line2)', color: 'var(--txt2)', borderRadius: 8, padding: '5px 10px', fontSize: 12.5, cursor: 'pointer', flex: '0 0 auto' }} className="ic-btn">
            <svg className="ic" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round"><path d="M9 4H5v16h4M16 12H9M13 8l4 4-4 4" /></svg>Выйти
          </button>
        </div>
      </header>

      <div className="tabs">
        <button className={'tab' + (tab === 'chat' ? ' active' : '')} onClick={() => applyTab('chat')} style={{ display: isRop ? 'none' : '' }}>
          <span className="ic-btn"><svg className="ic" width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round"><path d="M8 10h8M8 14h5" /><path d="M21 12a9 9 0 0 1-9 9 8.7 8.7 0 0 1-4-1l-4 1 1-4a8.7 8.7 0 0 1-1-4 9 9 0 0 1 18 0z" /></svg> <span>Советник</span></span>
        </button>
        <button className={'tab' + (tab === 'map' ? ' active' : '')} onClick={() => applyTab('map')}>
          <span className="ic-btn"><svg className="ic" width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round"><path d="M9 6h11M9 12h11M9 18h11" /><path d="M4 6l1 1 2-2M4 12l1 1 2-2M4 18l1 1 2-2" /></svg> <span>Задачи</span></span>
        </button>
        <button className={'tab' + (tab === 'dash' ? ' active' : '')} onClick={() => applyTab('dash')}>
          <span className="ic-btn"><svg className="ic" width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round"><path d="M3 3v18h18" /><rect x="7" y="10" width="3" height="8" /><rect x="12" y="6" width="3" height="12" /><rect x="17" y="13" width="3" height="5" /></svg> <span>Дашборд</span></span>
        </button>
      </div>

      <main>
        <button id="openSidebarBtn" onClick={openSidebar} title="Показать панель">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeLinecap="round" strokeLinejoin="round"><rect x="3" y="3" width="18" height="18" rx="2" /><line x1="9" y1="3" x2="9" y2="21" /></svg>
        </button>

        {/* MAP / TASKS — статический скелет 1:1 */}
        <div className={'view' + (tab === 'map' ? ' active' : '')} id="mapView" dangerouslySetInnerHTML={{ __html: mapViewHtml }} />

        {/* DASHBOARD — статический скелет 1:1 (данные подключаются в след. этапе) */}
        <div className={'view' + (tab === 'dash' ? ' active' : '')} id="dashView">
          <div dangerouslySetInnerHTML={{ __html: dashViewHtml }} />
        </div>

        {/* TELEGRAM — статический скелет 1:1 */}
        <div className={'view' + (tab === 'tg' ? ' active' : '')} id="tgView" dangerouslySetInnerHTML={{ __html: tgViewHtml }} />

        {/* CHAT VIEW со встроенным сайдбаром оболочки (в оболочке всегда active) */}
        <div className="view active" id="chatView">
          <div className="chat-layout">
            <div className="chat-sidebar" id="chatSidebar">
              <div className="side-nav">
                <button className="side-nav-ic" onClick={collapseSidebar} title="Свернуть панель"><svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><rect x="3" y="3" width="18" height="18" rx="2" /><line x1="9" y1="3" x2="9" y2="21" /></svg></button>
                <div className="sec-dropdown-wrap">
                  <button className={'sec-dropdown-btn' + (secOpen ? ' open' : '') + (tab !== 'chat' ? ' active' : '')} onClick={(e) => { e.stopPropagation(); setSecOpen((v) => !v) }}>
                    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><line x1="3" y1="6" x2="21" y2="6" /><line x1="3" y1="12" x2="21" y2="12" /><line x1="3" y1="18" x2="21" y2="18" /></svg>
                    <span>Меню</span>
                    <svg className="chev" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><polyline points="6 9 12 15 18 9" /></svg>
                  </button>
                  <div className={'sec-dropdown' + (secOpen ? ' open' : '')} id="secDropdown">
                    <button className={'menu-item' + (tab === 'dash' ? ' active' : '')} onClick={() => goSection('dash')}><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><path d="M3 3v18h18" /><rect x="7" y="10" width="3" height="8" /><rect x="12" y="6" width="3" height="12" /><rect x="17" y="13" width="3" height="5" /></svg>Дашборд</button>
                    <button className={'menu-item' + (tab === 'map' ? ' active' : '')} onClick={() => goSection('map')}><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><path d="M9 11l3 3L22 4" /><path d="M21 12v7a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11" /></svg>Задачи</button>
                    <button className={'menu-item' + (tab === 'tg' ? ' active' : '')} onClick={() => goSection('tg')}><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><path d="M21 3L3 10l6 2 2 6 3-4 5 4z" /></svg>Telegram</button>
                    {isAdmin && <button className="menu-item" onClick={() => { setSecOpen(false); window.openClientsModal && window.openClientsModal() }}><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2" /><circle cx="9" cy="7" r="4" /><path d="M23 21v-2a4 4 0 0 0-3-3.87M16 3.13a4 4 0 0 1 0 7.75" /></svg>Клиенты</button>}
                    {isAdmin && <button className="menu-item" onClick={() => { setSecOpen(false); window.openMopsModal && window.openMopsModal() }}><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><circle cx="12" cy="8" r="4" /><path d="M4 20a8 8 0 0 1 16 0" /></svg>МОПы (кабинеты)</button>}
                  </div>
                </div>
                <div className="side-brand" onClick={() => applyTab('chat')} style={{ cursor: 'pointer' }}><div className="side-logo">H</div><span>Hunter AI</span></div>
              </div>

              <button className={'side-chat-home' + (tab === 'chat' ? ' active' : '')} onClick={() => goSection('chat')}>
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M8 10h8M8 14h5" /><path d="M21 12a9 9 0 0 1-9 9 8.7 8.7 0 0 1-4-1l-4 1 1-4a8.7 8.7 0 0 1-1-4 9 9 0 0 1 18 0z" /></svg>
                <span>Советник</span>
              </button>
              <button className="side-new" onClick={newChat}><svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><line x1="12" y1="5" x2="12" y2="19" /><line x1="5" y1="12" x2="19" y2="12" /></svg>Новый чат</button>

              <div className="side-div" />
              <div className="side-group-lbl">Недавние чаты</div>
              <div className="side-list" id="sideList">
                {chats.map((c) => (
                  <button key={c.id} className={'side-item' + (c.id === state.activeChatId ? ' active' : '')} onClick={() => { state.activeChatId = c.id; save(); force((n) => n + 1); applyTab('chat') }} style={{ display: 'block', width: '100%', textAlign: 'left', border: 'none', background: 'none', color: 'inherit', cursor: 'pointer', padding: '7px 10px', borderRadius: 8, fontSize: 13, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                    {c.title || 'Чат'}
                  </button>
                ))}
              </div>

              <div className="side-user">
                <button className="user-btn" onClick={() => setSettingsOpen(true)}>
                  <div className="user-av">{(sess.demoName || sess.clientName || 'А')[0].toUpperCase()}</div>
                  <div className="user-meta"><div className="user-name">{sess.demoName || sess.clientName || 'Абдуллох'}</div><div className="user-role">{roleLabel}</div></div>
                  <svg className="gear" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><circle cx="12" cy="12" r="3" /><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z" /></svg>
                </button>
              </div>
            </div>
            <div className="side-backdrop" id="sideBackdrop" onClick={() => toggleSidebar(false)} />

            <div className="chat-main" dangerouslySetInnerHTML={{ __html: chatMainInnerHtml }} />
          </div>
        </div>

        <div id="aiToast" />
        <div dangerouslySetInnerHTML={{ __html: askModeHtml }} />
        <div dangerouslySetInnerHTML={{ __html: adminModalsHtml }} />
      </main>

      {/* НАСТРОЙКИ */}
      {settingsOpen && (
        <div id="settingsOverlay" style={{ display: 'block', position: 'fixed', inset: 0, background: 'rgba(0,0,0,.5)', zIndex: 110, padding: 20 }} onClick={(e) => { if (e.target === e.currentTarget) setSettingsOpen(false) }}>
          <div style={{ maxWidth: 400, margin: '60px auto', background: 'var(--bg)', border: '1px solid var(--line2)', borderRadius: 16, overflow: 'hidden', boxShadow: '0 12px 40px rgba(0,0,0,.18)' }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '16px 18px', borderBottom: '1px solid var(--line)' }}>
              <div style={{ fontSize: 16, fontWeight: 700 }}>{state.lang === 'uz' ? 'Sozlamalar' : 'Настройки'}</div>
              <button onClick={() => setSettingsOpen(false)} style={{ width: 30, height: 30, borderRadius: 8, background: 'var(--card)', border: '1px solid var(--line2)', color: 'var(--txt)', fontSize: 15, cursor: 'pointer' }}>✕</button>
            </div>
            <div style={{ padding: 18 }}>
              <div style={{ fontSize: 13, fontWeight: 600, color: 'var(--txt2)', marginBottom: 8 }}>Til / Язык</div>
              <div style={{ display: 'flex', gap: 8, marginBottom: 20 }}>
                <button onClick={() => { setLang('ru'); force((n) => n + 1) }} style={{ flex: 1, padding: 9, borderRadius: 9, border: '1px solid var(--line2)', background: state.lang !== 'uz' ? 'var(--accent-bg)' : 'var(--card)', color: 'var(--txt)', fontSize: 14, fontWeight: 600, cursor: 'pointer' }}>Русский</button>
                <button onClick={() => { setLang('uz'); force((n) => n + 1) }} style={{ flex: 1, padding: 9, borderRadius: 9, border: '1px solid var(--line2)', background: state.lang === 'uz' ? 'var(--accent-bg)' : 'var(--card)', color: 'var(--txt)', fontSize: 14, fontWeight: 600, cursor: 'pointer' }}>O'zbek</button>
              </div>
              <div style={{ fontSize: 13, fontWeight: 600, color: 'var(--txt2)', marginBottom: 8 }}>Hisob / Аккаунт</div>
              <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 14, padding: '6px 0' }}><span style={{ color: 'var(--txt2)' }}>Роль</span><b>{roleLabel}</b></div>
              <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 14, padding: '6px 0 16px' }}><span style={{ color: 'var(--txt2)' }}>Организация</span><b>{org || 'hunter'}</b></div>
              <button onClick={onLogout} style={{ width: '100%', padding: 11, borderRadius: 10, border: '1px solid var(--red)', background: 'var(--red-bg)', color: 'var(--red)', fontSize: 14, fontWeight: 600, cursor: 'pointer' }}>Выйти</button>
            </div>
          </div>
        </div>
      )}
    </>
  )
}
