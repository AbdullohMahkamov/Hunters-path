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
  const [tab, setTabRaw] = useState(() => localStorage.getItem('mop_tab') || 'mine') // _mopCurTab (сохраняется при F5)
  const setTab = (t) => { try { localStorage.setItem('mop_tab', t) } catch (e) { /* ignore */ }; setTabRaw(t) }
  const [loading, setLoading] = useState(true)
  // смена собственного пароля
  const [pwOpen, setPwOpen] = useState(false)
  const [pwOld, setPwOld] = useState('')
  const [pwNew, setPwNew] = useState('')
  const [pwNew2, setPwNew2] = useState('')
  const [pwBusy, setPwBusy] = useState(false)
  const [pwMsg, setPwMsg] = useState(null) // {ok, text}
  function openPw() { setPwOld(''); setPwNew(''); setPwNew2(''); setPwMsg(null); setPwOpen(true) }
  async function submitPw() {
    setPwMsg(null)
    if (pwNew.length < 4) { setPwMsg({ ok: false, text: mt('passTooShort') }); return }
    if (pwNew !== pwNew2) { setPwMsg({ ok: false, text: mt('passMismatch') }); return }
    setPwBusy(true)
    try {
      const r = await mopApi.changePassword(pwOld, pwNew)
      if (r && r.ok) {
        setPwMsg({ ok: true, text: mt('passChanged') })
        setPwOld(''); setPwNew(''); setPwNew2('')
        setTimeout(() => setPwOpen(false), 1200)
      } else {
        setPwMsg({ ok: false, text: (r && r.error) || 'Ошибка' })
      }
    } catch (e) {
      setPwMsg({ ok: false, text: 'Ошибка сети' })
    } finally {
      setPwBusy(false)
    }
  }

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
  else if (tab === 'stats') greetSub = uz ? 'Ishingiz koʻrsatkichlari' : 'Показатели твоей работы'
  else greetSub = uz ? 'Daromad va maqsadlaringiz' : 'Твой заработок и цели'

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
            <button onClick={openPw} className="mop-foot-pass">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><rect x="4" y="10" width="16" height="11" rx="2" /><path d="M8 10V7a4 4 0 0 1 8 0v3" /><circle cx="12" cy="15.5" r="1.4" /></svg>
              <span>{mt('changePass')}</span>
            </button>
            <button onClick={handleLang} className="mop-foot-lang">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><circle cx="12" cy="12" r="9" /><path d="M3 12h18M12 3a14 14 0 0 1 0 18M12 3a14 14 0 0 0 0 18" /></svg>
              <span>{lang === 'ru' ? "O'zbekcha" : 'Русский'}</span>
            </button>
            <button onClick={onLogout} className="mop-foot-logout">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><path d="M9 4H5v16h4M16 12H9M13 8l4 4-4 4" /></svg>
              <span>{mt('logout')}</span>
            </button>
          </div>
        </div>
        {/* КОНТЕНТ */}
        <div className="mop-main">
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'stretch', gap: 14, marginBottom: 22, flexWrap: 'wrap' }}>
            <div style={{ flex: '0 0 auto', alignSelf: 'center' }}>
              <div className="mop-main-h" style={{ marginBottom: 3 }}>{greet}</div>
              <div className="mop-main-sub" style={{ marginBottom: 0 }}>{greetSub}</div>
            </div>
            {/* прогресс темпа — между приветствием и призом (не показываем на «Команде») */}
            {!empty && !loading && tab !== 'team' && (
              <div style={{ flex: '1 1 400px', minWidth: 240 }} dangerouslySetInnerHTML={{ __html: renderTempoBar(data) }} />
            )}
            {/* розыгрыш — компактный, вровень с приветствием (не показываем на «Команде») */}
            {tab !== 'team' && (
              <div style={{ flex: '0 0 auto', display: 'flex', alignItems: 'center', gap: 10, background: 'var(--gold-bg)', border: '1px solid var(--gold)', borderRadius: 12, padding: '8px 13px', maxWidth: 320 }}>
                <svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="var(--gold)" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" style={{ flex: '0 0 auto' }}><path d="M4 11h16v9a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1z" /><path d="M3 7h18v4H3z" /><path d="M12 7v14" /><path d="M12 7S10.5 3 8 4s4 3 4 3zM12 7s1.5-4 4-3-4 3-4 3z" /></svg>
                <div style={{ lineHeight: 1.3 }}>
                  <div style={{ fontSize: 12, fontWeight: 700, color: 'var(--gold)' }}>{mt('raffleCTA')}</div>
                  <div style={{ fontSize: 11.5, color: 'var(--txt)' }}><b style={{ color: 'var(--gold)' }}>{mt('specialPrize')}</b></div>
                </div>
              </div>
            )}
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

      {/* Модалка смены пароля */}
      {pwOpen && (
        <div onClick={() => !pwBusy && setPwOpen(false)} style={{ position: 'fixed', inset: 0, zIndex: 500, background: 'rgba(0,0,0,.55)', display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 16 }}>
          <div onClick={(e) => e.stopPropagation()} style={{ width: '100%', maxWidth: 360, background: 'var(--card)', border: '1px solid var(--line)', borderRadius: 16, padding: 22 }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 9, marginBottom: 16 }}>
              <svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="var(--accent)" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><rect x="4" y="10" width="16" height="11" rx="2" /><path d="M8 10V7a4 4 0 0 1 8 0v3" /><circle cx="12" cy="15.5" r="1.4" /></svg>
              <b style={{ fontSize: 16 }}>{mt('changePass')}</b>
            </div>
            <input type="password" value={pwOld} onChange={(e) => setPwOld(e.target.value)} placeholder={mt('curPass')} autoComplete="current-password" style={pwInputStyle} />
            <input type="password" value={pwNew} onChange={(e) => setPwNew(e.target.value)} placeholder={mt('newPass')} autoComplete="new-password" style={pwInputStyle} />
            <input type="password" value={pwNew2} onChange={(e) => setPwNew2(e.target.value)} placeholder={mt('repeatPass')} autoComplete="new-password" onKeyDown={(e) => { if (e.key === 'Enter') submitPw() }} style={pwInputStyle} />
            {pwMsg && (
              <div style={{ fontSize: 13, margin: '2px 0 12px', color: pwMsg.ok ? 'var(--green)' : 'var(--red)' }}>{pwMsg.text}</div>
            )}
            <div style={{ display: 'flex', gap: 9, marginTop: 6 }}>
              <button onClick={() => setPwOpen(false)} disabled={pwBusy} style={{ flex: 1, padding: '11px', borderRadius: 10, border: '1px solid var(--line2)', background: 'var(--bg2)', color: 'var(--txt2)', fontSize: 14, fontWeight: 600, cursor: 'pointer', fontFamily: 'inherit' }}>{mt('cancel')}</button>
              <button onClick={submitPw} disabled={pwBusy} style={{ flex: 1, padding: '11px', borderRadius: 10, border: 'none', background: 'var(--accent)', color: '#fff', fontSize: 14, fontWeight: 600, cursor: pwBusy ? 'default' : 'pointer', opacity: pwBusy ? 0.6 : 1, fontFamily: 'inherit' }}>{mt('save')}</button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}

const pwInputStyle = { width: '100%', padding: '11px 12px', borderRadius: 10, border: '1px solid var(--line2)', background: 'var(--bg2)', color: 'var(--txt)', fontSize: 14, marginBottom: 10, fontFamily: 'inherit', boxSizing: 'border-box' }
