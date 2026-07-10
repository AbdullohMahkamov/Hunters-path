import React, { useEffect, useState, useSyncExternalStore } from 'react'
import { mop as mopApi } from '../lib/api.js'
import { getSnapshot, subscribe } from '../lib/session.js'
import { mt, getMopLang, subscribeMopLang, toggleMopLang } from '../lib/i18n.js'
import { escapeHtml } from '../lib/format.js'
import { renderTempoBar } from '../components/mop/mopRender.js'
import MopEarnings from '../components/mop/MopEarnings.jsx'
import MopStats from '../components/mop/MopStats.jsx'
import MopTeam from '../components/mop/MopTeam.jsx'

// Кабинет МОПа — 1:1 перенос #mopCabinet + bootMopCabinet/mopTab/toggleMopLang.
export default function MopCabinet({ onLogout }) {
  const sess = useSyncExternalStore(subscribe, getSnapshot, getSnapshot)
  const lang = useSyncExternalStore(subscribeMopLang, getMopLang, getMopLang)
  const [data, setData] = useState(null) // _mopData
  const [tab, setTab] = useState('mine') // _mopCurTab
  const [loading, setLoading] = useState(true)

  // loadMopData — 1:1
  useEffect(() => {
    let cancelled = false
    ;(async function loadMopData() {
      try {
        const d = await mopApi.cabinet()
        if (cancelled) return
        if (d && d.ok && !d.empty) setData(d)
        else setData({ empty: true, message: (d && (d.message || d.error)) || 'Данные не загружены' })
      } catch (e) {
        if (!cancelled) setData({ empty: true, message: 'Ошибка загрузки: ' + String(e).slice(0, 80) })
      } finally {
        if (!cancelled) setLoading(false)
      }
    })()
    return () => { cancelled = true }
  }, [])

  const uz = lang === 'uz'
  const nm = (data && data.mopName) || sess.mopName || 'Менеджер'
  const avatar = (nm[0] || 'М').toUpperCase()
  const greet = (uz ? 'Salom' : 'Привет') + ', ' + nm + ' 👋'
  // greetSub — логика mopTab()
  let greetSub
  if (tab === 'team') greetSub = mt('rankTitle')
  else if (tab === 'stats') greetSub = uz ? 'Ishing ko‘rsatkichlari' : 'Показатели твоей работы'
  else greetSub = uz ? 'Daromad va maqsadlaring' : 'Твой заработок и цели'

  function handleLang() {
    toggleMopLang() // обновит подписку -> перерисовка
  }

  const empty = !data || data.empty
  const emptyMsg = escapeHtml((data && data.message) || mt('noData'))

  return (
    <div id="mopCabinet" style={{ display: 'block', position: 'fixed', inset: 0, zIndex: 400, background: 'var(--bg)', overflowY: 'auto' }}>
      <div className="mop-shell">
        {/* САЙДБАР */}
        <div className="mop-side">
          <div className="mop-side-prof">
            <div style={{ width: 40, height: 40, borderRadius: 11, background: 'var(--accent)', display: 'flex', alignItems: 'center', justifyContent: 'center', color: '#fff', fontWeight: 700, fontSize: 17 }}>{avatar}</div>
            <div>
              <div style={{ fontSize: 14, fontWeight: 700 }}>{nm}</div>
              <div style={{ fontSize: 12, color: 'var(--txt3)' }}>{mt('cabinet')}</div>
            </div>
          </div>
          <div className="mop-side-nav">
            <div className="mop-nav-group">{uz ? 'Shaxsiy' : 'Личное'}</div>
            <button onClick={() => setTab('mine')} className={tab === 'mine' ? 'active' : ''}>
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M12 1v22M17 5H9.5a3.5 3.5 0 0 0 0 7h5a3.5 3.5 0 0 1 0 7H6" /></svg><span>{mt('mine')}</span>
            </button>
            <button onClick={() => setTab('stats')} className={tab === 'stats' ? 'active' : ''}>
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M3 3v18h18" /><rect x="7" y="10" width="3" height="7" /><rect x="12" y="6" width="3" height="11" /><rect x="17" y="13" width="3" height="4" /></svg><span>{mt('stats')}</span>
            </button>
            <div className="mop-nav-group sep">{uz ? 'Boʻlim' : 'Отдел'}</div>
            <button onClick={() => setTab('team')} className={tab === 'team' ? 'active' : ''}>
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2" /><circle cx="9" cy="7" r="4" /><path d="M23 21v-2a4 4 0 0 0-3-3.87" /></svg><span>{mt('team')}</span>
            </button>
          </div>
          <div className="mop-side-foot">
            <button onClick={handleLang}>{lang === 'ru' ? "🌐 O'zbekcha" : '🌐 Русский'}</button>
            <button onClick={onLogout}>{mt('logout')}</button>
          </div>
        </div>
        {/* КОНТЕНТ */}
        <div className="mop-main">
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 14, marginBottom: 22, flexWrap: 'wrap' }}>
            <div style={{ flex: '0 0 auto' }}>
              <div className="mop-main-h" style={{ marginBottom: 3 }}>{greet}</div>
              <div className="mop-main-sub" style={{ marginBottom: 0 }}>{greetSub}</div>
            </div>
            {/* прогресс темпа — между приветствием и призом (не показываем на «Команде») */}
            {!empty && !loading && tab !== 'team' && (
              <div style={{ flex: '1 1 260px', minWidth: 240, maxWidth: 470 }} dangerouslySetInnerHTML={{ __html: renderTempoBar(data) }} />
            )}
            {/* розыгрыш — компактный, вровень с приветствием */}
            <div style={{ flex: '0 0 auto', display: 'flex', alignItems: 'center', gap: 10, background: 'var(--gold-bg)', border: '1px solid var(--gold)', borderRadius: 12, padding: '8px 13px', maxWidth: 320 }}>
              <div style={{ fontSize: 22, lineHeight: 1, flex: '0 0 auto' }}>🎁</div>
              <div style={{ lineHeight: 1.3 }}>
                <div style={{ fontSize: 12, fontWeight: 700, color: 'var(--gold)' }}>{mt('raffleCTA')}</div>
                <div style={{ fontSize: 11.5, color: 'var(--txt)' }}><b style={{ color: 'var(--gold)' }}>{mt('specialPrize')}</b></div>
              </div>
            </div>
          </div>
          <div id="mopContent">
            {loading ? (
              <div style={{ textAlign: 'center', color: 'var(--txt3)', padding: 40 }}>Загрузка...</div>
            ) : empty ? (
              <div className="mop-card" style={{ textAlign: 'center', color: 'var(--txt3)' }} dangerouslySetInnerHTML={{ __html: emptyMsg }} />
            ) : tab === 'mine' ? (
              <MopEarnings data={data} />
            ) : tab === 'stats' ? (
              <MopStats data={data} />
            ) : (
              <MopTeam data={data} />
            )}
          </div>
        </div>
      </div>
    </div>
  )
}
