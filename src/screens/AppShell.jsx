import React, { useEffect, useRef, useState, useSyncExternalStore } from 'react'
import { getSnapshot, subscribe, orgQ, getSession } from '../lib/session.js'
import { state, save, loadCloud, ensureChats, setLang } from '../lib/appState.js'
import { applyTheme } from '../lib/theme.js'
import { installShellStubs } from '../lib/shellStubs.js'
import { applyLiveDash, applySuspicious, initDashModals } from '../lib/dashRender.js'
import { initChat, renderChat, scrollChatBottom, sendMsg } from '../lib/chat.js'
import { initAdminModals } from '../lib/adminModals.js'
import { initTelegram, loadTelegramChats } from '../lib/telegram.js'
import { initFinanceTrends } from '../lib/financeTrends.js'
import { initQuests, renderStages, renderDopQuests } from '../lib/quests.js'
import { applyI18n } from '../lib/i18nApply.js'
import { ti } from '../lib/shellI18n.js'
import { initAuditWizard, maybeShowWelcome } from '../lib/auditWizard.js'
import mapViewHtml from './viewsHtml/mapView.html?raw'
import dashViewHtml from './viewsHtml/dashView.html?raw'
import tgViewHtml from './viewsHtml/tgView.html?raw'
import chatMainInnerHtml from './viewsHtml/chatMainInner.html?raw'
import askModeHtml from './viewsHtml/askModeModal.html?raw'
import adminModalsHtml from './viewsHtml/adminModals.html?raw'
import genOverlayHtml from './viewsHtml/genOverlay.html?raw'
import dashModalsHtml from './viewsHtml/dashModals.html?raw'
import wizardOverlayHtml from './viewsHtml/wizardOverlay.html?raw'

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
  const secWrapRef = useRef(null)
  const notifWrapRef = useRef(null)
  const [notifs, setNotifs] = useState([]) // ожидающие выдачи призы МОПов
  const [notifOpen, setNotifOpen] = useState(false)

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
      initTelegram()
      initFinanceTrends()
      initQuests()
      initDashModals()
      initAuditWizard()
      window.__reloadDashboard = () => { dashLoadedRef.current = false; return loadDashboard() }
      window.__switchToTab = applyTab
      // мосты для императивных модулей (чат/скелеты) → React
      window.__forceShellRender = () => force((n) => n + 1)
      window.__switchToChat = () => applyTab('chat')
      window.__changeLang = changeLang
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
      // Диплинк из «Hunter AI Digest»: ?advisor=<token> → НОВЫЙ чат в Советнике с полным контекстом находки
      if (role !== 'rop') {
        try {
          const advToken = new URLSearchParams(location.search).get('advisor')
          if (advToken) {
            history.replaceState(null, '', location.pathname) // чтобы F5 не повторял отправку
            const rr = await fetch('/api/digest?action=handoff&token=' + encodeURIComponent(advToken) + '&session=' + encodeURIComponent(getSession()))
            const dd = await rr.json()
            if (!cancelled && dd && dd.ok && dd.seed) {
              ensureChats()
              const c = { id: 'c' + Date.now(), title: dd.title || 'Находка', messages: [], pinned: false, projectId: '' }
              state.chats.unshift(c); state.activeChatId = c.id; save()
              applyTab('chat')
              setTimeout(() => { renderChat(); sendMsg(dd.seed) }, 120)
            }
          }
        } catch (e) { /* диплинк не критичен — просто откроется приложение */ }
      }
      setTimeout(() => { applyI18n(); maybeShowWelcome() }, 30)
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
    if (t === 'tg') { setTimeout(() => loadTelegramChats(), 0) }
    if (t === 'map') { setTimeout(() => { renderStages(); renderDopQuests() }, 0) }
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

  // закрывать выпадашку «Меню» по клику в любое место вне неё
  useEffect(() => {
    if (!secOpen) return
    const onDown = (e) => { if (secWrapRef.current && !secWrapRef.current.contains(e.target)) setSecOpen(false) }
    document.addEventListener('mousedown', onDown)
    return () => document.removeEventListener('mousedown', onDown)
  }, [secOpen])

  // уведомления (админ): призы МОПов, ожидающие выдачи. Опрос раз в минуту.
  async function loadNotifs() {
    try {
      const r = await fetch('/api/gamification?action=list_inventory&session=' + encodeURIComponent(getSession()))
      const d = await r.json()
      if (d && d.ok) setNotifs((d.inventory || []).filter((x) => x.status !== 'delivered' && x.status !== 'cashback'))
    } catch (e) { /* ignore */ }
  }
  useEffect(() => {
    if (!isAdmin) return
    loadNotifs()
    const iv = setInterval(loadNotifs, 60000)
    return () => clearInterval(iv)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isAdmin])
  useEffect(() => {
    if (!notifOpen) return
    const onDown = (e) => { if (notifWrapRef.current && !notifWrapRef.current.contains(e.target)) setNotifOpen(false) }
    document.addEventListener('mousedown', onDown)
    return () => document.removeEventListener('mousedown', onDown)
  }, [notifOpen])

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

  // смена языка основного приложения (1:1 setLang: перевод статики + перерисовка вьюх)
  function changeLang(l) {
    setLang(l)
    applyI18n()
    if (window._dashData && typeof window.__applyLiveDash === 'function') window.__applyLiveDash(window._dashData)
    renderStages(); renderDopQuests(); renderChat()
    force((n) => n + 1)
  }

  const uz = state.lang === 'uz'
  const roleLabel = isRop ? (uz ? 'ROP' : 'РОП') : (role === 'demo' ? 'Demo' : (uz ? 'Egasi' : 'Владелец'))
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
            <button className={!uz ? 'on' : ''} onClick={() => changeLang('ru')}>РУ</button>
            <button className={uz ? 'on' : ''} onClick={() => changeLang('uz')}>UZ</button>
          </div>
          <button onClick={onLogout} title="Выйти" style={{ marginLeft: 8, background: 'var(--card)', border: '1px solid var(--line2)', color: 'var(--txt2)', borderRadius: 8, padding: '5px 10px', fontSize: 12.5, cursor: 'pointer', flex: '0 0 auto' }} className="ic-btn">
            <svg className="ic" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round"><path d="M9 4H5v16h4M16 12H9M13 8l4 4-4 4" /></svg>Выйти
          </button>
        </div>
      </header>

      <div className="tabs">
        <button className={'tab' + (tab === 'chat' ? ' active' : '')} onClick={() => applyTab('chat')} style={{ display: isRop ? 'none' : '' }}>
          <span className="ic-btn"><svg className="ic" width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round"><path d="M8 10h8M8 14h5" /><path d="M21 12a9 9 0 0 1-9 9 8.7 8.7 0 0 1-4-1l-4 1 1-4a8.7 8.7 0 0 1-1-4 9 9 0 0 1 18 0z" /></svg> <span>{ti('tab_chat')}</span></span>
        </button>
        <button className={'tab' + (tab === 'map' ? ' active' : '')} onClick={() => applyTab('map')}>
          <span className="ic-btn"><svg className="ic" width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round"><path d="M9 6h11M9 12h11M9 18h11" /><path d="M4 6l1 1 2-2M4 12l1 1 2-2M4 18l1 1 2-2" /></svg> <span>{ti('tab_map')}</span></span>
        </button>
        <button className={'tab' + (tab === 'dash' ? ' active' : '')} onClick={() => applyTab('dash')}>
          <span className="ic-btn"><svg className="ic" width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round"><path d="M3 3v18h18" /><rect x="7" y="10" width="3" height="8" /><rect x="12" y="6" width="3" height="12" /><rect x="17" y="13" width="3" height="5" /></svg> <span>{ti('tab_dash')}</span></span>
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
                <div className="sec-dropdown-wrap" ref={secWrapRef}>
                  <button className={'sec-dropdown-btn burger' + (secOpen ? ' open' : '') + (tab !== 'chat' ? ' active' : '')} onClick={(e) => { e.stopPropagation(); setSecOpen((v) => !v) }} title={uz ? 'Menyu' : 'Меню'} aria-label="menu">
                    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round"><line x1="3" y1="6" x2="21" y2="6" /><line x1="3" y1="12" x2="21" y2="12" /><line x1="3" y1="18" x2="21" y2="18" /></svg>
                  </button>
                  <div className={'sec-dropdown' + (secOpen ? ' open' : '')} id="secDropdown">
                    <button className={'menu-item' + (tab === 'dash' ? ' active' : '')} onClick={() => goSection('dash')}><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><path d="M3 3v18h18" /><rect x="7" y="10" width="3" height="8" /><rect x="12" y="6" width="3" height="12" /><rect x="17" y="13" width="3" height="5" /></svg>{uz ? 'Dashboard' : 'Дашборд'}</button>
                    <button className={'menu-item' + (tab === 'tg' ? ' active' : '')} onClick={() => goSection('tg')}><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><path d="M21 3L3 10l6 2 2 6 3-4 5 4z" /></svg>Telegram</button>
                    {isAdmin && <button className="menu-item" onClick={() => { setSecOpen(false); window.openClientsModal && window.openClientsModal() }}><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2" /><circle cx="9" cy="7" r="4" /><path d="M23 21v-2a4 4 0 0 0-3-3.87M16 3.13a4 4 0 0 1 0 7.75" /></svg>{uz ? 'Mijozlar' : 'Клиенты'}</button>}
                    {isAdmin && <button className="menu-item" onClick={() => { setSecOpen(false); window.openMopsModal && window.openMopsModal() }}><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><circle cx="12" cy="8" r="4" /><path d="M4 20a8 8 0 0 1 16 0" /></svg>{uz ? 'MOPlar (kabinetlar)' : 'МОПы (кабинеты)'}</button>}
                    {isAdmin && <button className="menu-item" onClick={() => { setSecOpen(false); window.openMetricsModal && window.openMetricsModal() }}><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><path d="M3 3v18h18" /><path d="M7 15l3-4 3 3 5-7" /><circle cx="7" cy="15" r="1" /><circle cx="18" cy="7" r="1" /></svg>{uz ? 'Metrikalar' : 'Метрики'}</button>}
                    {isAdmin && <button className="menu-item" onClick={() => { setSecOpen(false); window.openGamiModal && window.openGamiModal() }}><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><path d="M12 2l2.5 4.5L20 8l-4 4 1 6-5-3-5 3 1-6-4-4 5.5-1.5z" /></svg>{uz ? 'Geymifikatsiya' : 'Геймификация'}</button>}
                    {/* Внутренние ИИ-агенты (Dev / Growth / Task) — отдельный защищённый маршрут /dev-agent, только админ */}
                    {isAdmin && <a className="menu-item" href="/dev-agent" onClick={() => setSecOpen(false)}><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><rect x="4" y="8" width="16" height="12" rx="2" /><path d="M12 8V4M9 4h6" /><circle cx="9" cy="14" r="1" /><circle cx="15" cy="14" r="1" /><path d="M2 13v3M22 13v3" /></svg>{uz ? 'Agentlar' : 'Агенты'}</a>}
                  </div>
                </div>
                <div className="side-brand" onClick={() => applyTab('chat')} style={{ cursor: 'pointer' }} title="Hunter AI"><div className="side-logo">H</div><span>Hunter AI</span></div>
                {isAdmin && (
                  <div className="notif-wrap" ref={notifWrapRef} style={{ marginLeft: 'auto', marginRight: '-4px', position: 'relative', flex: '0 0 auto' }}>
                    <button className="side-nav-ic notif-bell" onClick={(e) => { e.stopPropagation(); setNotifOpen((v) => !v) }} title={uz ? 'Bildirishnomalar' : 'Уведомления'}>
                      <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round"><path d="M18 8a6 6 0 0 0-12 0c0 7-3 9-3 9h18s-3-2-3-9" /><path d="M13.7 21a2 2 0 0 1-3.4 0" /></svg>
                      {notifs.length > 0 && <span className="notif-badge">{notifs.length}</span>}
                    </button>
                    {notifOpen && (
                      <div className="notif-panel">
                        <div className="notif-head">{uz ? 'Bildirishnomalar' : 'Уведомления'}</div>
                        {notifs.length === 0
                          ? <div className="notif-empty">{uz ? 'Yangi bildirishnoma yoʻq' : 'Новых уведомлений нет'}</div>
                          : notifs.map((n) => (
                            <button key={n.id} className="notif-item" onClick={() => { setNotifOpen(false); window.openGamiModal && window.openGamiModal('inventory') }}>
                              <span className="notif-dot" />
                              <div style={{ minWidth: 0 }}>
                                <div className="notif-t">🎁 {n.mopName}</div>
                                <div className="notif-d">{(uz ? 'yutdi: ' : 'выиграл: ') + (n.name || '')} — {uz ? 'berish kerak' : 'нужно выдать'}</div>
                                {n.wonAt && <div className="notif-time">{new Date(n.wonAt).toLocaleString('ru-RU', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' })}</div>}
                              </div>
                            </button>
                          ))}
                      </div>
                    )}
                  </div>
                )}
              </div>

              <button className={'side-chat-home' + (tab === 'chat' ? ' active' : '')} onClick={() => goSection('chat')}>
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M8 10h8M8 14h5" /><path d="M21 12a9 9 0 0 1-9 9 8.7 8.7 0 0 1-4-1l-4 1 1-4a8.7 8.7 0 0 1-1-4 9 9 0 0 1 18 0z" /></svg>
                <span>{ti('tab_chat')}</span>
              </button>
              <button className={'side-chat-home' + (tab === 'map' ? ' active' : '')} onClick={() => goSection('map')}>
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M9 11l3 3L22 4" /><path d="M21 12v7a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11" /></svg>
                <span>{uz ? 'Vazifalar' : 'Задачи'}</span>
              </button>
              <div className="side-div" />
              <button className="side-new" onClick={newChat}><svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><line x1="12" y1="5" x2="12" y2="19" /><line x1="5" y1="12" x2="19" y2="12" /></svg>{uz ? 'Yangi chat' : 'Новый чат'}</button>

              <div className="side-group-lbl">{uz ? 'So‘nggi chatlar' : 'Недавние чаты'}</div>
              <div className="side-list" id="sideList">
                {chats.map((c) => {
                  // Вёрстка — через CSS .side-item/.si-t (как в эталоне): ровный flex, gap у .side-list,
                  // обрезка троеточием на .si-t (по одной строке, без вертикального реза). Активный — класс .on.
                  const isActive = c.id === state.activeChatId && tab === 'chat'
                  return (
                    <button key={c.id} className={'side-item' + (isActive ? ' on' : '')} onClick={() => { state.activeChatId = c.id; save(); force((n) => n + 1); applyTab('chat') }}>
                      <svg className="si-ic" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round"><path d="M21 11.5a8.38 8.38 0 0 1-.9 3.8 8.5 8.5 0 0 1-7.6 4.7 8.38 8.38 0 0 1-3.8-.9L3 21l1.9-5.7a8.38 8.38 0 0 1-.9-3.8 8.5 8.5 0 0 1 4.7-7.6 8.38 8.38 0 0 1 3.8-.9h.5a8.48 8.48 0 0 1 8 8v.5z" /></svg>
                      <span className="si-t">{c.title || 'Чат'}</span>
                    </button>
                  )
                })}
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
        <div dangerouslySetInnerHTML={{ __html: genOverlayHtml }} />
        <div dangerouslySetInnerHTML={{ __html: dashModalsHtml }} />
        <div dangerouslySetInnerHTML={{ __html: wizardOverlayHtml }} />
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
                <button onClick={() => changeLang('ru')} style={{ flex: 1, padding: 9, borderRadius: 9, border: '1px solid var(--line2)', background: !uz ? 'var(--accent-bg)' : 'var(--card)', color: 'var(--txt)', fontSize: 14, fontWeight: 600, cursor: 'pointer' }}>Русский</button>
                <button onClick={() => changeLang('uz')} style={{ flex: 1, padding: 9, borderRadius: 9, border: '1px solid var(--line2)', background: uz ? 'var(--accent-bg)' : 'var(--card)', color: 'var(--txt)', fontSize: 14, fontWeight: 600, cursor: 'pointer' }}>O'zbek</button>
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
